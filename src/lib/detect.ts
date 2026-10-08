import type { Corners, Point } from '../types'
import { clampPoint, cornersValid, defaultCorners, distance, orderCorners, polygonArea } from './geometry'

/**
 * Pure canvas detection. No OpenCV, no WebAssembly, no script download:
 * the whole pass works on a ~360px copy and takes a few milliseconds, so the corner
 * screen can never freeze after a photo.
 */
const DETECT_MAX = 360
const MIN_AREA = 0.15
const MAX_AREA = 0.95
const CLOSE_RADIUS = 2
const OPEN_RADIUS = 4

type Sample = { data: Uint8ClampedArray; width: number; height: number }

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

function takeSample(image: CanvasImageSource): Sample | null {
  const { width, height } = sourceSize(image)
  if (width < 1 || height < 1) return null
  const scale = Math.min(1, DETECT_MAX / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0, w, h)
  return { data: context.getImageData(0, 0, w, h).data, width: w, height: h }
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
function close(mask: Uint8Array, width: number, height: number): Uint8Array {
  const closed = morph(morph(mask, width, height, CLOSE_RADIUS, false), width, height, CLOSE_RADIUS, true)
  return morph(morph(closed, width, height, OPEN_RADIUS, true), width, height, OPEN_RADIUS, false)
}

function pageAspect(corners: Corners): number {
  const width = (distance(corners.tl, corners.tr) + distance(corners.bl, corners.br)) / 2
  const height = (distance(corners.tl, corners.bl) + distance(corners.tr, corners.br)) / 2
  const shortSide = Math.min(width, height)
  if (shortSide < 1) return Number.POSITIVE_INFINITY
  return Math.max(width, height) / shortSide
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
function rankBlobs(mask: Uint8Array, width: number, height: number): Candidate[] {
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
    let tl = start
    let tr = start
    let br = start
    let bl = start
    let minSum = Number.POSITIVE_INFINITY
    let maxSum = Number.NEGATIVE_INFINITY
    let minDiff = Number.POSITIVE_INFINITY
    let maxDiff = Number.NEGATIVE_INFINITY
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
      const sum = x + y
      const diff = x - y
      if (sum < minSum) {
        minSum = sum
        tl = index
      }
      if (sum > maxSum) {
        maxSum = sum
        br = index
      }
      if (diff > maxDiff) {
        maxDiff = diff
        tr = index
      }
      if (diff < minDiff) {
        minDiff = diff
        bl = index
      }
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

    const at = (index: number): Point => ({ x: index % width, y: Math.floor(index / width) })
    const extremes = [at(tl), at(tr), at(br), at(bl)]
    let points = extremes
    const fitted = fitSides(members, count, width, height)
    if (fitted) {
      const fittedCorners = orderCorners(fitted)
      const fittedArea = polygonArea([fittedCorners.tl, fittedCorners.tr, fittedCorners.br, fittedCorners.bl])
      // Trust the fit only if it stays close to the blob's own size.
      if (cornersValid(fittedCorners, width, height) && fittedArea > count * 0.8 && fittedArea < count * 1.6) {
        points = [fittedCorners.tl, fittedCorners.tr, fittedCorners.br, fittedCorners.bl]
      }
    }
    const quadArea = polygonArea(points)
    if (quadArea < 1) continue
    const fill = Math.min(1, count / quadArea)
    if (fill < 0.7) continue
    const ordered = orderCorners(points)
    if (!cornersValid(ordered, width, height)) continue
    const aspect = pageAspect(ordered)
    if (aspect > 2.1) continue

    // A sheet sits inside the photo; a wall or table runs off the frame.
    const touching =
      Number(minX <= 1) + Number(minY <= 1) + Number(maxX >= width - 2) + Number(maxY >= height - 2)
    let score = ratio + fill * 1.5 - touching * 1.2
    if (aspect >= 1 && aspect <= 1.6) score += 1
    if (Math.abs(aspect - Math.SQRT2) <= 0.12) score += 0.3
    candidates.push({ points, score, touching })
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

/**
 * Snaps to the bright, low-saturation sheet (white paper on a colored board or clear tray).
 * Falls back to a looser color pass, then to an Otsu brightness split.
 * Corners are returned top-left, top-right, bottom-right, bottom-left.
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
): { corners: Corners; detected: boolean } {
  const missed = { corners: defaultCorners(width, height, 0.1), detected: false }
  try {
    const sample = takeSample(image)
    if (!sample) return missed
    // Strictest first: bright white paper, then looser passes. A passing blob must not run
    // off two or more edges of the photo (that is the room, not the sheet).
    const masks = [
      () => paperMask(sample, 200, 40),
      () => paperMask(sample, 175, 55),
      () => paperMask(sample, 160, 60),
      () => paperMask(sample, 145, 100),
      () => brightMask(sample),
    ]
    let fallback: Candidate | null = null
    let best: Candidate | null = null
    for (const build of masks) {
      const blobs = rankBlobs(close(build(), sample.width, sample.height), sample.width, sample.height)
      for (const blob of blobs) {
        if (blob.touching >= 2) {
          if (!fallback || blob.score > fallback.score) fallback = blob
          continue
        }
        if (!best || blob.score > best.score) best = blob
      }
    }
    if (best) {
      const corners = orderCorners(
        best.points.map((point) => scaleUp(point, sample.width, sample.height, width, height)),
      )
      if (cornersValid(corners, width, height)) return { corners, detected: true }
    }
    if (fallback) {
      const corners = orderCorners(
        fallback.points.map((point) => scaleUp(point, sample.width, sample.height, width, height)),
      )
      if (cornersValid(corners, width, height)) return { corners, detected: true }
    }
    return missed
  } catch (error) {
    console.error(error)
    return missed
  }
}
