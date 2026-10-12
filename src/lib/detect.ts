import type { Corners, Point } from '../types'
import {
  clampPoint,
  cornersValid,
  distance,
  fullFrameCorners,
  orderCorners,
  polygonArea,
  quadAngles,
  quadIsConvex,
} from './geometry'
import { getCv, isOpenCvReady, MatBin, type Cv, type CvMat } from './opencv'

/**
 * Paper hull on a ~480px copy: Canny → largest external contour → 4-gon.
 * OpenCV when loaded; otherwise a canvas Sobel/Canny stand-in. Never freezes the corner screen.
 */
const DETECT_MAX = 480
const MIN_AREA = 0.12
const MAX_AREA = 0.98
const PAPER_LUMA_MIN = 130
const A4_ASPECT = Math.SQRT2
const CLOSE_RADIUS = 2
const OPEN_RADIUS = 4
const ANGLE_GOOD_MIN = 70
const ANGLE_GOOD_MAX = 110
/** Half an A4 across a fold looks ~square. Full portrait A4 is ~1.41. */
const FOLD_ASPECT_MAX = 1.15
const A4_ASPECT_LO = 1.35
const A4_ASPECT_HI = 1.55

type Sample = { data: Uint8ClampedArray; width: number; height: number; canvas: HTMLCanvasElement }

type Candidate = { points: Point[]; score: number; touching: number }

function sourceSize(image: CanvasImageSource): { width: number; height: number } {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }
  }
  if (image instanceof HTMLVideoElement) return { width: image.videoWidth, height: image.videoHeight }
  if (image instanceof HTMLCanvasElement || image instanceof ImageBitmap) {
    return { width: image.width, height: image.height }
  }
  return { width: 0, height: 0 }
}

function takeSample(image: CanvasImageSource, maxEdge: number): Sample | null {
  const { width, height } = sourceSize(image)
  if (width < 1 || height < 1) return null
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, w, h)
  return { data: context.getImageData(0, 0, w, h).data, width: w, height: h, canvas }
}

/** Bright, low-saturation pixels (V > minValue, S < maxSaturation on a 0–255 scale). */
function paperMask(sample: Sample, minValue: number, maxSaturation: number): Uint8Array {
  const { data, width, height } = sample
  const mask = new Uint8Array(width * height)
  for (let pixel = 0, index = 0; pixel < mask.length; pixel += 1, index += 4) {
    const red = data[index] ?? 0
    const green = data[index + 1] ?? 0
    const blue = data[index + 2] ?? 0
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const saturation = max === 0 ? 0 : ((max - min) / max) * 255
    if (max > minValue && saturation < maxSaturation) mask[pixel] = 1
  }
  return mask
}

/** Otsu split of the gray histogram. The bright side becomes the mask. */
function brightMask(sample: Sample): Uint8Array {
  const { data, width, height } = sample
  const histogram = new Float64Array(256)
  const gray = new Uint8Array(width * height)
  for (let pixel = 0, index = 0; pixel < gray.length; pixel += 1, index += 4) {
    const value = Math.round(0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0))
    gray[pixel] = value
    histogram[value] += 1
  }
  const total = gray.length
  let sumAll = 0
  for (let level = 0; level < 256; level += 1) sumAll += level * (histogram[level] ?? 0)
  let weightBack = 0
  let sumBack = 0
  let best = -1
  let threshold = 128
  for (let level = 0; level < 256; level += 1) {
    weightBack += histogram[level] ?? 0
    if (weightBack === 0) continue
    const weightFront = total - weightBack
    if (weightFront === 0) break
    sumBack += level * (histogram[level] ?? 0)
    const meanBack = sumBack / weightBack
    const meanFront = (sumAll - sumBack) / weightFront
    const between = weightBack * weightFront * (meanBack - meanFront) ** 2
    if (between > best) {
      best = between
      threshold = level
    }
  }
  const mask = new Uint8Array(gray.length)
  for (let pixel = 0; pixel < gray.length; pixel += 1) {
    if ((gray[pixel] ?? 0) > threshold) mask[pixel] = 1
  }
  return mask
}

/** Separable box dilate/erode. Erode treats outside as set so a page touching the edge survives. */
function morph(source: Uint8Array, width: number, height: number, radius: number, erode: boolean): Uint8Array {
  const horizontal = new Uint8Array(source.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let hit = erode ? 1 : 0
      for (let k = -radius; k <= radius; k += 1) {
        const nx = x + k
        const value = nx < 0 || nx >= width ? (erode ? 1 : 0) : (source[row + nx] ?? 0)
        if (erode ? value === 0 : value === 1) {
          hit = erode ? 0 : 1
          break
        }
      }
      horizontal[row + x] = hit
    }
  }
  const output = new Uint8Array(source.length)
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let hit = erode ? 1 : 0
      for (let k = -radius; k <= radius; k += 1) {
        const ny = y + k
        const value = ny < 0 || ny >= height ? (erode ? 1 : 0) : (horizontal[ny * width + x] ?? 0)
        if (erode ? value === 0 : value === 1) {
          hit = erode ? 0 : 1
          break
        }
      }
      output[y * width + x] = hit
    }
  }
  return output
}

/**
 * Closing fills printed text so the sheet stays one solid blob. Opening then cuts thin
 * bridges (tray rims, a bright wall behind the board) so the sheet separates from them.
 */
function close(mask: Uint8Array, width: number, height: number, scale: number): Uint8Array {
  const closeRadius = Math.max(1, Math.round(CLOSE_RADIUS * scale))
  const openRadius = Math.max(2, Math.round(OPEN_RADIUS * scale))
  const closed = morph(morph(mask, width, height, closeRadius, false), width, height, closeRadius, true)
  return morph(morph(closed, width, height, openRadius, true), width, height, openRadius, false)
}

function pageAspect(corners: Corners): number {
  const width = (distance(corners.tl, corners.tr) + distance(corners.bl, corners.br)) / 2
  const height = (distance(corners.tl, corners.bl) + distance(corners.tr, corners.br)) / 2
  const shortSide = Math.min(width, height)
  if (shortSide < 1) return Number.POSITIVE_INFINITY
  return Math.max(width, height) / shortSide
}

function angleFit(corners: Corners): number {
  const angles = quadAngles(corners)
  let score = 0
  for (const angle of angles) {
    if (angle >= ANGLE_GOOD_MIN && angle <= ANGLE_GOOD_MAX) score += 0.55
    else score -= 0.85
  }
  return score
}

function a4AspectScore(aspect: number): number {
  if (aspect < FOLD_ASPECT_MAX) return -1
  if (aspect >= A4_ASPECT_LO && aspect <= A4_ASPECT_HI) return 2.2
  if (aspect >= 1.2 && aspect <= 1.8) return 1.25
  return 0.4
}

/** Convex 4-gon covering a real sheet. Aspect is scored, not used as a hard reject. */
function quadLooksLikeSheet(corners: Corners, width: number, height: number): boolean {
  if (!cornersValid(corners, width, height) || !quadIsConvex(corners)) return false
  const view = width * height
  if (view < 1) return false
  const frac = polygonArea([corners.tl, corners.tr, corners.br, corners.bl]) / view
  return frac >= MIN_AREA && frac <= MAX_AREA
}

/** Live mapped box: trust the preview. Do not reject for A4 aspect. */
export function sheetCornersOk(corners: Corners, width: number, height: number): boolean {
  if (!cornersValid(corners, width, height) || !quadIsConvex(corners)) return false
  const view = width * height
  if (view < 1) return false
  const frac = polygonArea([corners.tl, corners.tr, corners.br, corners.bl]) / view
  return frac >= 0.12 && frac <= 0.98
}

function fallbackFrame(width: number, height: number): Corners {
  return fullFrameCorners(width, height)
}

function cross(o: Point, a: Point, b: Point) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

function convexHull(points: Point[]): Point[] {
  if (points.length < 4) return points
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const lower: Point[] = []
  for (const point of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) lower.pop()
    lower.push(point)
  }
  const upper: Point[] = []
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const point = pts[i]
    if (!point) continue
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) upper.pop()
    upper.push(point)
  }
  lower.pop()
  upper.pop()
  return [...lower, ...upper]
}

function pointLineDistance(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy) || 1
  return Math.abs(dy * point.x - dx * point.y + b.x * a.y - b.y * a.x) / length
}

function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return points
  let maxDist = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i += 1) {
    const dist = pointLineDistance(points[i]!, first, last)
    if (dist > maxDist) {
      maxDist = dist
      index = i
    }
  }
  if (maxDist <= epsilon) return [first, last]
  const left = rdp(points.slice(0, index + 1), epsilon)
  const right = rdp(points.slice(index), epsilon)
  return [...left.slice(0, -1), ...right]
}

function hullPerimeter(points: Point[]) {
  let length = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (a && b) length += distance(a, b)
  }
  return length
}

/**
 * Four extreme corners of a convex hull (min/max x+y and x−y). Folded paper
 * yields 5–8 vertices after approxPolyDP — those still have four extrema.
 */
function getDocumentCornersFromHull(points: Point[]): Point[] | null {
  if (points.length < 4) return null
  let tl = points[0]!
  let tr = points[0]!
  let br = points[0]!
  let bl = points[0]!
  let minSum = Number.POSITIVE_INFINITY
  let maxSum = Number.NEGATIVE_INFINITY
  let minDiff = Number.POSITIVE_INFINITY
  let maxDiff = Number.NEGATIVE_INFINITY
  for (const pt of points) {
    const sum = pt.x + pt.y
    const diff = pt.x - pt.y
    if (sum < minSum) {
      minSum = sum
      tl = pt
    }
    if (sum > maxSum) {
      maxSum = sum
      br = pt
    }
    if (diff > maxDiff) {
      maxDiff = diff
      tr = pt
    }
    if (diff < minDiff) {
      minDiff = diff
      bl = pt
    }
  }
  if (distance(tl, tr) < 8 || distance(tr, br) < 8 || distance(br, bl) < 8 || distance(bl, tl) < 8) return null
  if (distance(tl, br) < 8 || distance(tr, bl) < 8) return null
  return [tl, tr, br, bl]
}

function acceptHullQuad(points: Point[], width: number, height: number): Point[] | null {
  const extracted = getDocumentCornersFromHull(points)
  if (!extracted) return null
  try {
    const corners = orderCorners(extracted)
    if (!cornersValid(corners, width, height) || !quadIsConvex(corners)) return null
    const view = width * height
    if (view < 1) return null
    const frac = polygonArea([corners.tl, corners.tr, corners.br, corners.bl]) / view
    if (frac < MIN_AREA || frac > MAX_AREA) return null
    return [corners.tl, corners.tr, corners.br, corners.bl]
  } catch {
    return null
  }
}

/** Convex hull → 4-gon via RDP when possible, otherwise the four hull extrema. */
function approxQuad(points: Point[]): Point[] | null {
  const hull = convexHull(points)
  if (hull.length < 4) return getDocumentCornersFromHull(points)
  const peri = hullPerimeter(hull)
  if (peri < 8) return getDocumentCornersFromHull(hull)
  const closed = hull[0] && hull[hull.length - 1] && distance(hull[0], hull[hull.length - 1]) > 1 ? [...hull, hull[0]] : hull
  for (const scale of [0.02, 0.03, 0.015, 0.04, 0.01]) {
    const approx = rdp(closed, peri * scale)
    const ring = approx.length > 1 && approx[0] && approx[approx.length - 1] && distance(approx[0], approx[approx.length - 1]) < 2
      ? approx.slice(0, -1)
      : approx
    if (ring.length === 4) return ring
  }
  return getDocumentCornersFromHull(hull)
}

function matPoints(mat: { rows: number; data32S: Int32Array }): Point[] {
  const points: Point[] = []
  const data = mat.data32S
  for (let i = 0; i < mat.rows; i += 1) {
    points.push({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 })
  }
  return points
}

function acceptSampleQuad(points: Point[], width: number, height: number): Point[] | null {
  if (points.length === 4) {
    try {
      const corners = orderCorners(points)
      return quadLooksLikeSheet(corners, width, height) ? [corners.tl, corners.tr, corners.br, corners.bl] : null
    } catch {
      return null
    }
  }
  return acceptHullQuad(points, width, height)
}

function findCannyQuadCv(sample: Sample): Point[] | null {
  const cv = getCv()
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(sample.canvas))
    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)
    const edges = bin.keep(new cv.Mat())
    cv.Canny(blur, edges, 50, 150)
    const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)))
    const thick = bin.keep(new cv.Mat())
    cv.dilate(edges, thick, kernel)
    const contours = bin.keep(new cv.MatVector())
    const hierarchy = bin.keep(new cv.Mat())
    cv.findContours(thick, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const frame = sample.width * sample.height
    let best: Point[] | null = null
    let bestArea = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area < frame * MIN_AREA || area > frame * MAX_AREA || area <= bestArea) continue
      const hull = bin.keep(new cv.Mat())
      cv.convexHull(contour, hull, false, true)
      const peri = cv.arcLength(hull, true)
      const approx = bin.keep(new cv.Mat())
      cv.approxPolyDP(hull, approx, 0.02 * peri, true)
      const accepted =
        acceptSampleQuad(matPoints(approx), sample.width, sample.height) ??
        acceptHullQuad(matPoints(hull), sample.width, sample.height)
      if (!accepted) continue
      best = accepted
      bestArea = area
    }
    return best
  } catch (error) {
    console.error(error)
    return null
  } finally {
    bin.release()
  }
}

function findCannyQuadCanvas(sample: Sample): Point[] | null {
  const { width, height } = sample
  const gray = lumaOf(sample)
  const smooth = boxBlur(boxBlur(gray, width, height, 2), width, height, 1)
  const magnitude = new Float32Array(width * height)
  const bins = new Uint32Array(400)
  let counted = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx: number, dy: number) => smooth[(y + dy) * width + x + dx] ?? 0
      const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / 8
      const gy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / 8
      const value = Math.hypot(gx, gy)
      magnitude[y * width + x] = value
      const bin = Math.min(399, Math.floor(value * 20))
      bins[bin] = (bins[bin] ?? 0) + 1
      counted += 1
    }
  }
  let seen = 0
  let high = 8
  for (let bin = 399; bin >= 0; bin -= 1) {
    seen += bins[bin] ?? 0
    if (seen >= counted * 0.08) {
      high = Math.max(2, bin / 20)
      break
    }
  }
  const low = high * 0.4
  const edges = new Uint8Array(width * height)
  for (let i = 0; i < edges.length; i += 1) edges[i] = (magnitude[i] ?? 0) >= high ? 1 : 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x
      if (edges[i] || (magnitude[i] ?? 0) < low) continue
      if (edges[i - 1] || edges[i + 1] || edges[i - width] || edges[i + width]) edges[i] = 1
    }
  }
  const thick = morph(edges, width, height, 2, false)
  const regions = new Uint8Array(thick.length)
  for (let i = 0; i < regions.length; i += 1) regions[i] = thick[i] ? 0 : 1
  const openRadius = Math.max(2, Math.round((Math.min(width, height) / 480) * 3))
  const mask = morph(morph(regions, width, height, openRadius, true), width, height, openRadius, false)
  const blobs = rankBlobs(mask, width, height, gray)
  const chosen = blobs.find((blob) => blob.touching < 3) ?? blobs[0]
  return chosen?.points ?? null
}

function approxFourCv(cv: Cv, bin: MatBin, hull: CvMat, width: number, height: number): Point[] | null {
  const peri = cv.arcLength(hull, true)
  for (const scale of [0.02, 0.025, 0.03, 0.015, 0.04, 0.012]) {
    const approx = bin.keep(new cv.Mat())
    cv.approxPolyDP(hull, approx, scale * peri, true)
    const accepted = acceptSampleQuad(matPoints(approx), width, height)
    if (accepted) return accepted
  }
  return acceptHullQuad(matPoints(hull), width, height)
}

function scoreBrightQuad(points: Point[], area: number): number {
  const fit = a4AspectScore(pageAspect(orderCorners(points)))
  return area * (fit < 0 ? 0.35 : fit)
}

/** Paper luma > 130 vs black keyboard/desk. Largest hull, four extrema — never requires a 4-gon. */
function findBrightHullCv(sample: Sample): Point[] | null {
  const cv = getCv()
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(sample.canvas))
    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)
    const binary = bin.keep(new cv.Mat())
    cv.threshold(blur, binary, PAPER_LUMA_MIN, 255, cv.THRESH_BINARY)
    const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)))
    const closed = bin.keep(new cv.Mat())
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel)
    const contours = bin.keep(new cv.MatVector())
    const hierarchy = bin.keep(new cv.Mat())
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const frame = sample.width * sample.height
    let best: Point[] | null = null
    let bestScore = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area < frame * MIN_AREA || area > frame * MAX_AREA) continue
      const hull = bin.keep(new cv.Mat())
      cv.convexHull(contour, hull, false, true)
      const accepted = acceptHullQuad(matPoints(hull), sample.width, sample.height)
      if (!accepted) continue
      const score = scoreBrightQuad(accepted, area)
      if (score <= bestScore) continue
      best = accepted
      bestScore = score
    }
    return best
  } catch (error) {
    console.error(error)
    return null
  } finally {
    bin.release()
  }
}

function bestQuadFromBinaryCv(cv: Cv, binary: CvMat, sample: Sample): Point[] | null {
  const bin = new MatBin()
  try {
    const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))
    const closed = bin.keep(new cv.Mat())
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel)
    const contours = bin.keep(new cv.MatVector())
    const hierarchy = bin.keep(new cv.Mat())
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    const frame = sample.width * sample.height
    let best: Point[] | null = null
    let bestScore = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area < frame * MIN_AREA || area > frame * MAX_AREA) continue
      const hull = bin.keep(new cv.Mat())
      cv.convexHull(contour, hull, false, true)
      const accepted = approxFourCv(cv, bin, hull, sample.width, sample.height)
      if (!accepted) continue
      const aspect = pageAspect(orderCorners(accepted))
      const fit = a4AspectScore(aspect)
      if (fit < 0) continue
      const score = area * fit
      if (score <= bestScore) continue
      best = accepted
      bestScore = score
    }
    return best
  } catch (error) {
    console.error(error)
    return null
  } finally {
    bin.release()
  }
}

/** White paper on a light desk: Otsu + adaptive threshold beat Canny's faint gradient. */
function findThresholdQuadCv(sample: Sample): Point[] | null {
  const cv = getCv()
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(sample.canvas))
    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)
    const block = Math.max(11, Math.round(Math.min(sample.width, sample.height) / 16) | 1)
    const adaptive = bin.keep(new cv.Mat())
    cv.adaptiveThreshold(blur, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 4)
    const fromAdaptive = bestQuadFromBinaryCv(cv, adaptive, sample)
    if (fromAdaptive) return fromAdaptive
    const otsu = bin.keep(new cv.Mat())
    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    const fromOtsu = bestQuadFromBinaryCv(cv, otsu, sample)
    if (fromOtsu) return fromOtsu
    const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)))
    const grad = bin.keep(new cv.Mat())
    cv.morphologyEx(blur, grad, cv.MORPH_GRADIENT, kernel)
    const edges = bin.keep(new cv.Mat())
    cv.threshold(grad, edges, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    return bestQuadFromBinaryCv(cv, edges, sample)
  } catch (error) {
    console.error(error)
    return null
  } finally {
    bin.release()
  }
}

function adaptiveMask(gray: Float32Array, width: number, height: number): Uint8Array {
  const radius = Math.max(7, Math.round(Math.min(width, height) / 18))
  const mean = boxBlur(gray, width, height, radius)
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i += 1) {
    mask[i] = (gray[i] ?? 0) > (mean[i] ?? 0) + 3 ? 1 : 0
  }
  return mask
}

function largestQuadFromMask(mask: Uint8Array, sample: Sample, gray: Float32Array): Point[] | null {
  const blobs = rankBlobs(close(mask, sample.width, sample.height, 1), sample.width, sample.height, gray)
  const chosen = blobs.find((blob) => blob.touching < 3) ?? blobs[0]
  return chosen?.points ?? null
}

function findThresholdQuadCanvas(sample: Sample): Point[] | null {
  const gray = lumaOf(sample)
  const fromAdaptive = largestQuadFromMask(adaptiveMask(gray, sample.width, sample.height), sample, gray)
  if (fromAdaptive) return fromAdaptive
  return largestQuadFromMask(brightMask(sample), sample, gray)
}

function lumaPaperMask(sample: Sample): Uint8Array {
  const gray = lumaOf(sample)
  const mask = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i += 1) {
    if ((gray[i] ?? 0) > PAPER_LUMA_MIN) mask[i] = 1
  }
  return mask
}

function largestHullQuadFromMask(mask: Uint8Array, width: number, height: number): Point[] | null {
  const area = width * height
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  let best: Point[] | null = null
  let bestScore = 0

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    const ring: Point[] = []
    let count = 0
    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      const x = index % width
      const y = (index - x) / width
      count += 1
      const edge =
        x <= 0 ||
        y <= 0 ||
        x >= width - 1 ||
        y >= height - 1 ||
        !mask[index - 1] ||
        !mask[index + 1] ||
        !mask[index - width] ||
        !mask[index + width]
      if (edge) ring.push({ x, y })
      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1
        stack[top] = index - 1
        top += 1
      }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1
        stack[top] = index + 1
        top += 1
      }
      if (y > 0 && mask[index - width] && !seen[index - width]) {
        seen[index - width] = 1
        stack[top] = index - width
        top += 1
      }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) {
        seen[index + width] = 1
        stack[top] = index + width
        top += 1
      }
    }
    const ratio = count / area
    if (ratio < MIN_AREA || ratio > MAX_AREA) continue
    const accepted = acceptHullQuad(convexHull(ring), width, height)
    if (!accepted) continue
    const score = scoreBrightQuad(accepted, count)
    if (score <= bestScore) continue
    best = accepted
    bestScore = score
  }
  return best
}

function findBrightHullCanvas(sample: Sample): Point[] | null {
  return largestHullQuadFromMask(close(lumaPaperMask(sample), sample.width, sample.height, 1), sample.width, sample.height)
}

function findPaperQuad(sample: Sample): Point[] | null {
  if (isOpenCvReady()) {
    const found = findBrightHullCv(sample) ?? findThresholdQuadCv(sample) ?? findCannyQuadCv(sample)
    if (found) return found
  }
  return findBrightHullCanvas(sample) ?? findThresholdQuadCanvas(sample) ?? findCannyQuadCanvas(sample)
}

type Line = { slope: number; offset: number }

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Theil–Sen line `value = slope * along + offset`. A bump covering a minority of samples is ignored. */
function robustLine(along: number[], value: number[]): Line | null {
  const count = along.length
  if (count < 8) return null
  const step = Math.max(1, Math.floor(count / 90))
  const slopes: number[] = []
  for (let i = 0; i < count; i += step) {
    for (let j = i + step; j < count; j += step) {
      const run = (along[j] ?? 0) - (along[i] ?? 0)
      if (Math.abs(run) < 1) continue
      slopes.push(((value[j] ?? 0) - (value[i] ?? 0)) / run)
    }
  }
  if (slopes.length < 4) return null
  const slope = median(slopes)
  const offset = median(value.map((v, index) => v - slope * (along[index] ?? 0)))
  return { slope, offset }
}

/**
 * Fits the four sides from the blob's row and column extents, then intersects them.
 * Unlike extreme points, a bright wall touching one corner cannot drag that corner away.
 */
function fitSides(members: Int32Array, count: number, width: number, height: number): Point[] | null {
  const left = new Int32Array(height).fill(width)
  const right = new Int32Array(height).fill(-1)
  const topEdge = new Int32Array(width).fill(height)
  const bottomEdge = new Int32Array(width).fill(-1)
  for (let n = 0; n < count; n += 1) {
    const index = members[n] ?? 0
    const x = index % width
    const y = (index - x) / width
    if (x < (left[y] ?? width)) left[y] = x
    if (x > (right[y] ?? -1)) right[y] = x
    if (y < (topEdge[x] ?? height)) topEdge[x] = y
    if (y > (bottomEdge[x] ?? -1)) bottomEdge[x] = y
  }

  const collect = (low: Int32Array, high: Int32Array, empty: number, size: number) => {
    const first: number[] = []
    const second: number[] = []
    const positions: number[] = []
    for (let i = 0; i < size; i += 1) {
      if ((high[i] ?? -1) < 0 || (low[i] ?? empty) === empty) continue
      positions.push(i)
    }
    const trim = Math.floor(positions.length * 0.1)
    const kept = positions.slice(trim, positions.length - trim)
    const along: number[] = []
    for (const i of kept) {
      along.push(i)
      first.push(low[i] ?? 0)
      second.push(high[i] ?? 0)
    }
    return { along, first, second }
  }

  const rows = collect(left, right, width, height)
  const columns = collect(topEdge, bottomEdge, height, width)
  const leftLine = robustLine(rows.along, rows.first)
  const rightLine = robustLine(rows.along, rows.second)
  const topLine = robustLine(columns.along, columns.first)
  const bottomLine = robustLine(columns.along, columns.second)
  if (!leftLine || !rightLine || !topLine || !bottomLine) return null

  // left/right: x = a*y + b. top/bottom: y = c*x + d.
  const meet = (vertical: Line, horizontal: Line): Point | null => {
    const denominator = 1 - vertical.slope * horizontal.slope
    if (Math.abs(denominator) < 1e-3) return null
    const x = (vertical.slope * horizontal.offset + vertical.offset) / denominator
    return { x, y: horizontal.slope * x + horizontal.offset }
  }
  const points = [
    meet(leftLine, topLine),
    meet(rightLine, topLine),
    meet(rightLine, bottomLine),
    meet(leftLine, bottomLine),
  ]
  if (points.some((point) => !point)) return null
  return points as Point[]
}

/**
 * Connected blobs of the mask. Each large blob is reduced to a quad by its
 * extreme points along the two diagonals, then scored by size, how well the blob
 * fills that quad, and how page-shaped it is.
 */
function sampleGray(gray: Float32Array, width: number, height: number, x: number, y: number) {
  const xx = Math.min(width - 1, Math.max(0, x | 0))
  const yy = Math.min(height - 1, Math.max(0, y | 0))
  return gray[yy * width + xx] ?? 0
}

/** Mean |inside−outside| luma along the four sides — a paper sheet has a strong border. */
function boundaryStrength(gray: Float32Array, width: number, height: number, points: Point[]): number {
  const ordered = orderCorners(points)
  const edges: [Point, Point][] = [
    [ordered.tl, ordered.tr],
    [ordered.tr, ordered.br],
    [ordered.br, ordered.bl],
    [ordered.bl, ordered.tl],
  ]
  let sum = 0
  let count = 0
  for (const [a, b] of edges) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20
      const x = a.x + dx * t
      const y = a.y + dy * t
      sum += Math.abs(sampleGray(gray, width, height, x - nx * 2.2, y - ny * 2.2) - sampleGray(gray, width, height, x + nx * 2.2, y + ny * 2.2))
      count += 1
    }
  }
  return count ? sum / count / 255 : 0
}

function rankBlobs(mask: Uint8Array, width: number, height: number, gray: Float32Array): Candidate[] {
  const area = width * height
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  const members = new Int32Array(mask.length)
  const candidates: Candidate[] = []

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    let count = 0
    let minX = width
    let maxX = 0
    let minY = height
    let maxY = 0

    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      const x = index % width
      const y = (index - x) / width
      members[count] = index
      count += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1
        stack[top] = index - 1
        top += 1
      }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1
        stack[top] = index + 1
        top += 1
      }
      if (y > 0 && mask[index - width] && !seen[index - width]) {
        seen[index - width] = 1
        stack[top] = index - width
        top += 1
      }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) {
        seen[index + width] = 1
        stack[top] = index + width
        top += 1
      }
    }

    const ratio = count / area
    if (ratio < MIN_AREA || ratio > MAX_AREA) continue

    let points: Point[] | null = null
    const fitted = fitSides(members, count, width, height)
    if (fitted) {
      const fittedCorners = orderCorners(fitted)
      const fittedArea = polygonArea([fittedCorners.tl, fittedCorners.tr, fittedCorners.br, fittedCorners.bl])
      if (
        quadLooksLikeSheet(fittedCorners, width, height) &&
        fittedArea > count * 0.8 &&
        fittedArea < count * 1.6
      ) {
        points = [fittedCorners.tl, fittedCorners.tr, fittedCorners.br, fittedCorners.bl]
      }
    }
    if (!points) {
      const ring: Point[] = []
      for (let n = 0; n < count; n += 1) {
        const index = members[n] ?? 0
        const x = index % width
        const y = (index - x) / width
        const edge =
          x <= 0 ||
          y <= 0 ||
          x >= width - 1 ||
          y >= height - 1 ||
          !mask[index - 1] ||
          !mask[index + 1] ||
          !mask[index - width] ||
          !mask[index + width]
        if (edge) ring.push({ x, y })
      }
      const hullQuad = approxQuad(ring)
      if (hullQuad) {
        const hullCorners = orderCorners(hullQuad)
        if (quadLooksLikeSheet(hullCorners, width, height)) {
          points = [hullCorners.tl, hullCorners.tr, hullCorners.br, hullCorners.bl]
        }
      }
      if (!points) {
        const extrema = acceptHullQuad(convexHull(ring), width, height)
        if (extrema) points = extrema
      }
    }
    if (!points) continue
    const quadArea = polygonArea(points)
    if (quadArea < 1) continue
    const fill = Math.min(1, count / quadArea)
    if (fill < 0.7) continue
    const ordered = orderCorners(points)
    if (!quadLooksLikeSheet(ordered, width, height)) continue
    const aspect = pageAspect(ordered)

    // A sheet sits inside the photo; a wall or table runs off the frame.
    const touching =
      Number(minX <= 1) + Number(minY <= 1) + Number(maxX >= width - 2) + Number(maxY >= height - 2)
    const a4 = a4AspectScore(aspect)
    if (a4 < 0) continue
    const edge = boundaryStrength(gray, width, height, points)
    let score = ratio * 2.4 + fill * 1.1 + edge * 1.8 - touching * 1.5 + angleFit(ordered) + a4
    if (Math.abs(aspect - A4_ASPECT) <= 0.16) score += 1.8
    candidates.push({ points: [ordered.tl, ordered.tr, ordered.br, ordered.bl], score, touching })
  }

  candidates.sort((a, b) => b.score - a.score)
  return candidates
}

function scaleUp(point: Point, fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): Point {
  return clampPoint(
    { x: ((point.x + 0.5) / fromWidth) * toWidth, y: ((point.y + 0.5) / fromHeight) * toHeight },
    toWidth,
    toHeight,
  )
}

/* ---------- white paper on a white desk: shadow and edge based detection ---------- */

function lumaOf(sample: Sample): Float32Array {
  const { data, width, height } = sample
  const gray = new Float32Array(width * height)
  for (let pixel = 0, index = 0; pixel < gray.length; pixel += 1, index += 4) {
    gray[pixel] = 0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0)
  }
  return gray
}

/** Separable box max (dilate) or min (erode) on a float image. */
function rankFilter(source: Float32Array, width: number, height: number, radius: number, max: boolean) {
  const pick = max ? Math.max : Math.min
  const horizontal = new Float32Array(source.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let value = source[row + x] ?? 0
      for (let k = -radius; k <= radius; k += 1) {
        const nx = Math.min(width - 1, Math.max(0, x + k))
        value = pick(value, source[row + nx] ?? 0)
      }
      horizontal[row + x] = value
    }
  }
  const output = new Float32Array(source.length)
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let value = horizontal[y * width + x] ?? 0
      for (let k = -radius; k <= radius; k += 1) {
        const ny = Math.min(height - 1, Math.max(0, y + k))
        value = pick(value, horizontal[ny * width + x] ?? 0)
      }
      output[y * width + x] = value
    }
  }
  return output
}

function boxBlur(source: Float32Array, width: number, height: number, radius: number) {
  const span = radius * 2 + 1
  const horizontal = new Float32Array(source.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) sum += source[row + Math.min(width - 1, Math.max(0, k))] ?? 0
    for (let x = 0; x < width; x += 1) {
      horizontal[row + x] = sum / span
      sum += (source[row + Math.min(width - 1, x + radius + 1)] ?? 0) - (source[row + Math.max(0, x - radius)] ?? 0)
    }
  }
  const output = new Float32Array(source.length)
  for (let x = 0; x < width; x += 1) {
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) sum += horizontal[Math.min(height - 1, Math.max(0, k)) * width + x] ?? 0
    for (let y = 0; y < height; y += 1) {
      output[y * width + x] = sum / span
      sum +=
        (horizontal[Math.min(height - 1, y + radius + 1) * width + x] ?? 0) -
        (horizontal[Math.max(0, y - radius) * width + x] ?? 0)
    }
  }
  return output
}

/**
 * Regions enclosed by physical page boundaries, for a sheet that is as white as its desk.
 * A grayscale closing (the bilateral-blur role) erases text and table grids but keeps the
 * sheet's outline. Sobel edges on that flattened image catch the faint step and the shadow along
 * the paper edge; the threshold adapts to the strongest edges in the frame. What remains after
 * removing the dilated edges are closed regions: the sheet is one of them, the desk is another.
 */
function edgeRegions(sample: Sample, scale: number): Uint8Array {
  const { width, height } = sample
  const gray = lumaOf(sample)
  const radius = Math.max(2, Math.round(4 * scale))
  const closed = rankFilter(rankFilter(gray, width, height, radius, true), width, height, radius, false)
  const smooth = boxBlur(boxBlur(closed, width, height, 1), width, height, 1)

  const magnitude = new Float32Array(width * height)
  const bins = new Uint32Array(400)
  let counted = 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx: number, dy: number) => smooth[(y + dy) * width + x + dx] ?? 0
      const gx = (at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1)) / 8
      const gy = (at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1)) / 8
      const value = Math.hypot(gx, gy)
      magnitude[y * width + x] = value
      const bin = Math.min(399, Math.floor(value * 20))
      bins[bin] = (bins[bin] ?? 0) + 1
      counted += 1
    }
  }
  let seen = 0
  let p97 = 0
  for (let bin = 0; bin < 400; bin += 1) {
    seen += bins[bin] ?? 0
    if (seen >= counted * 0.97) {
      p97 = bin / 20
      break
    }
  }
  const threshold = Math.max(0.7, Math.min(p97 * 0.5, 3.5))

  const edges = new Uint8Array(width * height)
  for (let i = 0; i < edges.length; i += 1) edges[i] = (magnitude[i] ?? 0) > threshold ? 1 : 0
  const thick = morph(edges, width, height, 1, false)
  const regions = new Uint8Array(thick.length)
  for (let i = 0; i < regions.length; i += 1) regions[i] = thick[i] ? 0 : 1
  const openRadius = Math.max(2, Math.round(3 * scale))
  return morph(morph(regions, width, height, openRadius, true), width, height, openRadius, false)
}

/** Edge regions lose about the edge thickness on each side; give it back. */
function pushOut(points: Point[], amount: number): Point[] {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length
  return points.map((p) => {
    const length = Math.hypot(p.x - cx, p.y - cy) || 1
    return { x: p.x + ((p.x - cx) / length) * amount, y: p.y + ((p.y - cy) / length) * amount }
  })
}

function insideQuad(points: Point[], x: number, y: number, slack = 0): boolean {
  let sign = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (!a || !b) return false
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1
    if (Math.abs(cross / length) <= slack) continue
    const current = cross > 0 ? 1 : -1
    if (sign === 0) sign = current
    else if (sign !== current) return false
  }
  return true
}

/** Among strong scores, lock onto the largest A4-like sheet — not a keyboard or stapler. */
function lockLargestSheet(candidates: Candidate[]): Candidate | null {
  if (!candidates.length) return null
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  const top = ranked[0]
  if (!top) return null
  const floor = top.score * 0.72
  let chosen = top
  let chosenArea = polygonArea(top.points)
  for (const candidate of ranked) {
    if (candidate.score < floor) continue
    const aspect = pageAspect(orderCorners(candidate.points))
    if (a4AspectScore(aspect) < 0) continue
    if (Math.abs(aspect - A4_ASPECT) > 0.4) continue
    const area = polygonArea(candidate.points)
    if (area > chosenArea * 1.05) {
      chosen = candidate
      chosenArea = area
    }
  }
  return chosen
}

/**
 * A white sheet on a darker board is a bright child inside a darker parent. When a strong
 * candidate sits inside the chosen one and the ring between them is not paper (red board, tray
 * rim, wall), the inner sheet is the page.
 */
function preferNested(sample: Sample, outer: Candidate, others: Candidate[]): Candidate {
  const outerCorners = orderCorners(outer.points)
  if (outer.touching === 0 && Math.abs(pageAspect(outerCorners) - A4_ASPECT) <= 0.2) return outer
  const outerArea = polygonArea(outer.points)
  const { data, width, height } = sample
  let chosen = outer
  let chosenArea = outerArea
  for (const inner of others) {
    if (inner === outer) continue
    const area = polygonArea(inner.points)
    if (area < outerArea * 0.4 || area >= outerArea * 0.97 || area <= chosenArea * 0.4) continue
    if (inner.score < outer.score * 0.7) continue
    const slack = Math.max(2, Math.min(width, height) * 0.01)
    if (!inner.points.every((point) => insideQuad(outer.points, point.x, point.y, slack))) continue
    let ring = 0
    let paper = 0
    const stride = Math.max(1, Math.round(Math.max(width, height) / 120))
    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        if (!insideQuad(outer.points, x, y) || insideQuad(inner.points, x, y)) continue
        const index = (y * width + x) * 4
        const r = data[index] ?? 0
        const g = data[index + 1] ?? 0
        const b = data[index + 2] ?? 0
        const max = Math.max(r, g, b)
        ring += 1
        if (max > 150 && (max - Math.min(r, g, b)) / Math.max(max, 1) < 0.2) paper += 1
      }
    }
    if (ring < 12 || paper / ring > 0.35) continue
    if (chosen === outer || area > chosenArea) {
      chosen = inner
      chosenArea = area
    }
  }
  return chosen
}
function intersect(a: Point, da: Point, b: Point, db: Point): Point | null {
  const denominator = da.x * db.y - da.y * db.x
  if (Math.abs(denominator) < 1e-6) return null
  const t = ((b.x - a.x) * db.y - (b.y - a.y) * db.x) / denominator
  return { x: a.x + da.x * t, y: a.y + da.y * t }
}

/**
 * Pulls each side inward until a thin band just inside it is mostly white paper. This drops a
 * strip of red board, tray rim or table that the blob still included. Sides that never find
 * paper within 8% of the photo are left alone.
 */
function tightenQuad(sample: Sample, points: Point[]): Point[] {
  const corners = orderCorners(points)
  const quad = [corners.tl, corners.tr, corners.br, corners.bl]
  const { data, width, height } = sample
  const mid = {
    x: quad.reduce((sum, p) => sum + p.x, 0) / 4,
    y: quad.reduce((sum, p) => sum + p.y, 0) / 4,
  }

  const read = (x: number, y: number) => {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || py < 0 || px >= width || py >= height) return null
    const index = (py * width + px) * 4
    const r = data[index] ?? 0
    const g = data[index + 1] ?? 0
    const b = data[index + 2] ?? 0
    const max = Math.max(r, g, b)
    return { max, saturation: max === 0 ? 0 : (max - Math.min(r, g, b)) / max }
  }

  let reference = 0
  let referenceSaturation = 0
  let samples = 0
  for (const u of [0.3, 0.5, 0.7]) {
    for (const v of [0.3, 0.5, 0.7]) {
      const top = { x: corners.tl.x + (corners.tr.x - corners.tl.x) * u, y: corners.tl.y + (corners.tr.y - corners.tl.y) * u }
      const bottom = { x: corners.bl.x + (corners.br.x - corners.bl.x) * u, y: corners.bl.y + (corners.br.y - corners.bl.y) * u }
      const pixel = read(top.x + (bottom.x - top.x) * v, top.y + (bottom.y - top.y) * v)
      if (pixel) {
        reference += pixel.max
        referenceSaturation += pixel.saturation
        samples += 1
      }
    }
  }
  if (samples === 0) return points
  reference /= samples
  referenceSaturation /= samples
  const isPaper = (x: number, y: number) => {
    const pixel = read(x, y)
    return Boolean(pixel && pixel.max > reference * 0.62 && pixel.saturation < 0.35)
  }

  // A clip, tab or sticker sitting on the sheet is a mid-bright, more colored patch than the paper
  // (black print is dark, so text and table lines never count). A run of such pixels along a band
  // means the side still touches an obstruction, so the side moves past it.
  const isClean = (x: number, y: number) => {
    const pixel = read(x, y)
    if (!pixel) return false
    return pixel.max <= reference * 0.6 || pixel.saturation < referenceSaturation + 0.07
  }
  const obstructed = (ax: number, ay: number, dx: number, dy: number, nx: number, ny: number, depth: number) => {
    const steps = 48
    let run = 0
    let longest = 0
    for (let step = 0; step <= steps; step += 1) {
      const t = 0.04 + (0.92 * step) / steps
      if (isClean(ax + dx * t + nx * depth, ay + dy * t + ny * depth)) run = 0
      else {
        run += 1
        longest = Math.max(longest, run)
      }
    }
    return longest / steps >= 0.14
  }

  const maxShift = Math.max(2, Math.round(Math.min(width, height) * 0.08))
  const maxClip = Math.max(3, Math.round(Math.min(width, height) * 0.12))
  const origins: Point[] = []
  const directions: Point[] = []
  for (let i = 0; i < 4; i += 1) {
    const a = quad[i]
    const b = quad[(i + 1) % 4]
    if (!a || !b) return points
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (length < 4) return points
    let nx = -dy / length
    let ny = dx / length
    if (nx * (mid.x - a.x) + ny * (mid.y - a.y) < 0) {
      nx = -nx
      ny = -ny
    }
    let shift = 0
    let found = false
    for (let s = 0; s <= maxShift; s += 1) {
      let hits = 0
      let total = 0
      for (let step = 0; step <= 24; step += 1) {
        const t = 0.1 + (0.8 * step) / 24
        total += 1
        if (isPaper(a.x + dx * t + nx * (s + 1.5), a.y + dy * t + ny * (s + 1.5))) hits += 1
      }
      if (hits / total >= 0.6) {
        shift = s
        found = true
        break
      }
    }
    if (!found) shift = 0
    else if (obstructed(a.x, a.y, dx, dy, nx, ny, shift + 1.5)) {
      for (let s = shift + 1; s <= shift + maxClip; s += 1) {
        if (!obstructed(a.x, a.y, dx, dy, nx, ny, s + 1.5)) {
          shift = s
          break
        }
      }
    }
    origins.push({ x: a.x + nx * shift, y: a.y + ny * shift })
    directions.push({ x: dx, y: dy })
  }

  const result: Point[] = []
  for (let i = 0; i < 4; i += 1) {
    const previous = (i + 3) % 4
    const corner = intersect(
      origins[previous] ?? mid,
      directions[previous] ?? mid,
      origins[i] ?? mid,
      directions[i] ?? mid,
    )
    if (!corner) return points
    result.push(corner)
  }
  return cornersValid(orderCorners(result), width, height) ? result : points
}

export type DetectOptions = {
  /** Longest edge of the analysis copy. 480 for a photo and the live camera. */
  maxEdge?: number
  /** Live preview: only the three white-paper passes (no Otsu fallback). */
  live?: boolean
}

/**
 * Bright paper (luma > 130) → largest contour → convex hull → 4 extrema.
 * Folded sheets are 5–8-gons after approxPolyDP; extrema still snap to the paper
 * and cut out a black keyboard. Fallback is a 10% inset, never the viewfinder edge.
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
  options: DetectOptions = {},
): { corners: Corners; detected: boolean } {
  const missed = { corners: fallbackFrame(width, height), detected: false }
  try {
    const maxEdge = options.maxEdge ?? DETECT_MAX
    const sample = takeSample(image, maxEdge)
    if (!sample) return missed
    const paper = findPaperQuad(sample)
    if (paper) {
      const corners = orderCorners(paper.map((point) => scaleUp(point, sample.width, sample.height, width, height)))
      if (sheetCornersOk(corners, width, height)) return { corners, detected: true }
    }
    const gray = lumaOf(sample)
    const scale = maxEdge / DETECT_MAX
    // Strictest first: bright white paper, then looser passes. A passing blob must not run
    // off two or more edges of the photo (that is the room, not the sheet).
    const masks = [
      () => paperMask(sample, 200, 40),
      () => paperMask(sample, 175, 55),
      () => paperMask(sample, 160, 60),
      () => paperMask(sample, 145, 100),
      () => brightMask(sample),
    ]
    const passes = options.live ? masks.slice(0, 3) : masks
    let fallback: Candidate | null = null
    let best: Candidate | null = null
    const inside: Candidate[] = []
    for (const build of passes) {
      const blobs = rankBlobs(close(build(), sample.width, sample.height, scale), sample.width, sample.height, gray)
      for (const blob of blobs) {
        if (blob.touching >= 2) {
          if (!fallback || blob.score > fallback.score) fallback = blob
          continue
        }
        inside.push(blob)
        if (!best || blob.score > best.score) best = blob
      }
    }
    if (best) best = preferNested(sample, lockLargestSheet(inside) ?? best, inside)
    let points: Point[] | null = best ? best.points : null
    if (!points) {
      // White sheet on a white desk: the brightness passes see one big blob touching the frame.
      // Look for the sheet's own boundary instead, and ignore regions that run off the photo.
      const regions = rankBlobs(edgeRegions(sample, scale), sample.width, sample.height, gray)
      const region = regions.find((blob) => blob.touching < 2)
      if (region) points = pushOut(region.points, 2 * scale + 1)
    }
    if (!points && fallback) points = fallback.points
    if (points) {
      const raw = orderCorners(points.map((point) => scaleUp(point, sample.width, sample.height, width, height)))
      const tightened = orderCorners(
        tightenQuad(sample, points).map((point) => scaleUp(point, sample.width, sample.height, width, height)),
      )
      if (sheetCornersOk(tightened, width, height)) return { corners: tightened, detected: true }
      if (sheetCornersOk(raw, width, height)) return { corners: raw, detected: true }
    }
    return missed
  } catch (error) {
    console.error(error)
    return missed
  }
}

/**
 * Snaps approximate corners (for example the outline tracked on the live camera, which may sit
 * on a colored board or on a clip) to the white sheet itself in the full photo. Only moves
 * sides inward; falls back to the given corners when the result would be implausible.
 */
export function refineToPaper(image: CanvasImageSource, width: number, height: number, seed: Corners): Corners {
  try {
    const sample = takeSample(image, DETECT_MAX)
    if (!sample) return seed
    const points = [seed.tl, seed.tr, seed.br, seed.bl].map((point) =>
      scaleUp(point, width, height, sample.width, sample.height),
    )
    const refined = tightenQuad(sample, points)
    const corners = orderCorners(refined.map((point) => scaleUp(point, sample.width, sample.height, width, height)))
    const before = polygonArea([seed.tl, seed.tr, seed.br, seed.bl])
    const after = polygonArea([corners.tl, corners.tr, corners.br, corners.bl])
    if (!quadLooksLikeSheet(corners, width, height) || after < before * 0.6) return seed
    return corners
  } catch (error) {
    console.error(error)
    return seed
  }
}