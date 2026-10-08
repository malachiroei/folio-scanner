import type { Corners, Point } from '../types'
import { clampPoint, cornersValid, defaultCorners, distance, orderCorners } from './geometry'
import { getCv, MatBin, type Cv, type CvMat } from './opencv'

const DETECT_MAX = 640
const DETECT_BUDGET_MS = 900
const MIN_AREA = 0.15
const MAX_AREA = 0.93
const A4_ASPECT = Math.SQRT2

type WhiteSample = {
  data: Uint8ClampedArray
  width: number
  height: number
}

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

/** Draw a small copy before OpenCV so a photo never enters the contour pass at full size. */
function downscaleForDetection(image: CanvasImageSource): HTMLCanvasElement {
  const { width, height } = sourceSize(image)
  const scale = Math.min(1, DETECT_MAX / Math.max(width, height, 1))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  context.drawImage(image, 0, 0, targetWidth, targetHeight)
  return canvas
}

function readPoints(mat: CvMat): Point[] {
  const points: Point[] = []
  const data = mat.data32S
  for (let i = 0; i < mat.rows; i += 1) {
    points.push({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 })
  }
  return points
}

function scaleUp(
  point: Point,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Point {
  return clampPoint(
    {
      x: (point.x / fromWidth) * toWidth,
      y: (point.y / fromHeight) * toHeight,
    },
    toWidth,
    toHeight,
  )
}

/** Map a quad back to the photo and force Top-Left, Top-Right, Bottom-Right, Bottom-Left. */
function toCorners(
  points: Point[],
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Corners | null {
  if (points.length !== 4) return null
  const corners = orderCorners(
    points.map((point) => scaleUp(point, fromWidth, fromHeight, toWidth, toHeight)),
  )
  return cornersValid(corners, toWidth, toHeight) ? corners : null
}

function pageAspect(points: Point[]): number {
  const corners = orderCorners(points)
  const width = (distance(corners.tl, corners.tr) + distance(corners.bl, corners.br)) / 2
  const height = (distance(corners.tl, corners.bl) + distance(corners.tr, corners.br)) / 2
  const shortSide = Math.min(width, height)
  if (shortSide < 1) return Number.POSITIVE_INFINITY
  return Math.max(width, height) / shortSide
}

function insideConvex(x: number, y: number, ring: Point[]): boolean {
  let sign = 0
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]
    const next = ring[(index + 1) % ring.length]
    if (!current || !next) return false
    const cross = (next.x - current.x) * (y - current.y) - (next.y - current.y) * (x - current.x)
    if (Math.abs(cross) <= 0.5) continue
    const nextSign = cross > 0 ? 1 : -1
    if (sign === 0) sign = nextSign
    else if (sign !== nextSign) return false
  }
  return true
}

/** Share of pixels that are bright and nearly gray: the white sheet, not a colored board. */
function sheetFraction(sample: WhiteSample, points: Point[]): number {
  const corners = orderCorners(points)
  const ring = [corners.tl, corners.tr, corners.br, corners.bl]
  let minX = sample.width
  let minY = sample.height
  let maxX = 0
  let maxY = 0
  for (const point of ring) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  const left = Math.max(0, Math.floor(minX))
  const top = Math.max(0, Math.floor(minY))
  const right = Math.min(sample.width - 1, Math.ceil(maxX))
  const bottom = Math.min(sample.height - 1, Math.ceil(maxY))
  let seen = 0
  let paper = 0
  for (let y = top; y <= bottom; y += 8) {
    for (let x = left; x <= right; x += 8) {
      if (!insideConvex(x, y, ring)) continue
      seen += 1
      const offset = (y * sample.width + x) * 4
      const red = sample.data[offset] ?? 0
      const green = sample.data[offset + 1] ?? 0
      const blue = sample.data[offset + 2] ?? 0
      const max = Math.max(red, green, blue)
      const min = Math.min(red, green, blue)
      const saturation = max === 0 ? 0 : ((max - min) / max) * 255
      if (max > 160 && saturation < 60) paper += 1
    }
  }
  if (seen < 4) return 0
  return paper / seen
}

/**
 * Bright, low-saturation pixels. OpenCV HSV uses 0–255 for S and V:
 * the sheet is V > minValue and S < maxSaturation. Closing fills printed text
 * so the page stays one contour.
 */
function whitePaperMask(cv: Cv, bin: MatBin, src: CvMat, minValue: number, maxSaturation: number): CvMat {
  const rgb = bin.keep(new cv.Mat())
  cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB)
  const hsv = bin.keep(new cv.Mat())
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV)
  const low = bin.keep(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 0, minValue, 0]))
  const high = bin.keep(new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [179, maxSaturation, 255, 255]))
  const mask = bin.keep(new cv.Mat())
  cv.inRange(hsv, low, high, mask)
  const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)))
  const closed = bin.keep(new cv.Mat())
  cv.morphologyEx(mask, closed, cv.MORPH_CLOSE, kernel)
  return closed
}

function cannyEdges(cv: Cv, bin: MatBin, src: CvMat): CvMat {
  const gray = bin.keep(new cv.Mat())
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  const blurred = bin.keep(new cv.Mat())
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
  const edges = bin.keep(new cv.Mat())
  cv.Canny(blurred, edges, 50, 150)
  const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))
  const dilated = bin.keep(new cv.Mat())
  cv.dilate(edges, dilated, kernel)
  return dilated
}

function scoreSheet(ratio: number, quad: boolean, rectangularity: number, aspect: number, paper: number | null): number {
  let score = ratio * 4
  if (quad) score += 2.2
  score += Math.min(1, Math.max(0, rectangularity)) * 1.6
  const pageShaped = quad && aspect >= 1 && aspect <= 1.6
  if (pageShaped) score += 10
  if (Math.abs(aspect - A4_ASPECT) <= 0.12) score += 0.8
  if (paper !== null) score += paper * 8
  return score
}

function rankSheets(
  cv: Cv,
  mask: CvMat,
  imageArea: number,
  mode: number,
  deadline: number,
  white: WhiteSample | null,
): Point[][] {
  if (performance.now() > deadline || imageArea < 1) return []
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  let working: CvMat | null = null
  try {
    working = mask.clone()
    cv.findContours(working, contours, hierarchy, mode, cv.CHAIN_APPROX_SIMPLE)
    const large: { index: number; area: number }[] = []
    for (let index = 0; index < contours.size(); index += 1) {
      const area = cv.contourArea(contours.get(index))
      const ratio = area / imageArea
      if (ratio >= MIN_AREA && ratio <= MAX_AREA) large.push({ index, area })
    }
    large.sort((a, b) => b.area - a.area)

    const ranked: { points: Point[]; score: number }[] = []
    for (const item of large.slice(0, 12)) {
      if (performance.now() > deadline) break
      const contour = contours.get(item.index)
      const perimeter = cv.arcLength(contour, true)
      if (perimeter < 1) continue
      const rect = cv.minAreaRect(contour)
      const rectArea = Math.abs(rect.size.width * rect.size.height)
      const rectangularity = rectArea > 1 ? item.area / rectArea : 0
      const approx = new cv.Mat()
      try {
        cv.approxPolyDP(contour, approx, 0.02 * perimeter, true)
        const isQuad = approx.rows === 4 && cv.isContourConvex(approx)
        let points: Point[] | null = null
        if (isQuad) {
          points = readPoints(approx)
        } else if (rectangularity >= 0.75) {
          const vertices = cv.RotatedRect.points(rect)
          if (vertices.length === 4) {
            points = vertices.map((point) => ({ x: point.x, y: point.y }))
          }
        }
        if (!points || points.length !== 4) continue
        const aspect = pageAspect(points)
        if (aspect < 0.8 || aspect > 2.1) continue
        const paper = white ? sheetFraction(white, points) : null
        if (paper !== null && paper < 0.45) continue
        ranked.push({
          points,
          score: scoreSheet(item.area / imageArea, isQuad, rectangularity, aspect, paper),
        })
      } finally {
        approx.delete()
      }
    }
    ranked.sort((a, b) => b.score - a.score)
    return ranked.map((item) => item.points)
  } finally {
    working?.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function acceptMask(
  cv: Cv,
  mask: CvMat,
  imageArea: number,
  mode: number,
  deadline: number,
  white: WhiteSample | null,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Corners | null {
  const ranked = rankSheets(cv, mask, imageArea, mode, deadline, white)
  for (const points of ranked) {
    const corners = toCorners(points, fromWidth, fromHeight, toWidth, toHeight)
    if (corners) return corners
  }
  return null
}

/**
 * Snaps to a bright, low-saturation sheet (white paper on a colored board or clear tray).
 * If that mask has no page-shaped quad, falls back to blurred Canny edges.
 * Corners come back as top-left, top-right, bottom-right, bottom-left.
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
): { corners: Corners; detected: boolean } {
  const cv = getCv()
  const deadline = performance.now() + DETECT_BUDGET_MS
  const bin = new MatBin()
  const missed = (): { corners: Corners; detected: boolean } => ({
    corners: defaultCorners(width, height, 0.1),
    detected: false,
  })
  try {
    const small = downscaleForDetection(image)
    const src = bin.keep(cv.imread(small))
    const imageArea = src.cols * src.rows
    const run = (mask: CvMat, mode: number, white: WhiteSample | null): Corners | null => {
      try {
        return acceptMask(cv, mask, imageArea, mode, deadline, white, src.cols, src.rows, width, height)
      } catch (error) {
        console.error(error)
        return null
      }
    }

    if (performance.now() <= deadline) {
      const strict = run(whitePaperMask(cv, bin, src, 161, 59), cv.RETR_EXTERNAL, null)
      if (strict) return { corners: strict, detected: true }
    }
    if (performance.now() <= deadline) {
      const shaded = run(whitePaperMask(cv, bin, src, 145, 100), cv.RETR_EXTERNAL, null)
      if (shaded) return { corners: shaded, detected: true }
    }
    if (performance.now() <= deadline) {
      const context = small.getContext('2d', { willReadFrequently: true })
      const pixels = context?.getImageData(0, 0, small.width, small.height).data ?? null
      const white = pixels ? { data: pixels, width: small.width, height: small.height } : null
      const edged = run(cannyEdges(cv, bin, src), cv.RETR_LIST, white)
      if (edged) return { corners: edged, detected: true }
    }
    return missed()
  } catch (error) {
    console.error(error)
    return missed()
  } finally {
    bin.release()
  }
}
