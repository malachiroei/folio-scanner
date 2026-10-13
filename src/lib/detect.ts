import type { Corners, Point } from '../types'

const DETECT_WIDTH = 200
const MIN_AREA = 0.1
const MAX_AREA = 0.85

const sample = document.createElement('canvas')
const sampleCtx = sample.getContext('2d', { willReadFrequently: true })

function sourceSize(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement) {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
  }
  return { width: source.width, height: source.height }
}

function grabFrame(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): ImageData | null {
  if (!sampleCtx) return null
  const { width: sw, height: sh } = sourceSize(source)
  if (sw < 8 || sh < 8) return null
  const scale = Math.min(1, DETECT_WIDTH / sw)
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  if (sample.width !== width) sample.width = width
  if (sample.height !== height) sample.height = height
  sampleCtx.drawImage(source, 0, 0, width, height)
  return sampleCtx.getImageData(0, 0, width, height)
}

function orderCorners(points: Point[]): Corners {
  let tl = points[0]!
  let tr = points[0]!
  let br = points[0]!
  let bl = points[0]!
  let minSum = Number.POSITIVE_INFINITY
  let maxSum = Number.NEGATIVE_INFINITY
  let minDiff = Number.POSITIVE_INFINITY
  let maxDiff = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const sum = point.x + point.y
    const diff = point.x - point.y
    if (sum < minSum) {
      minSum = sum
      tl = point
    }
    if (sum > maxSum) {
      maxSum = sum
      br = point
    }
    if (diff > maxDiff) {
      maxDiff = diff
      tr = point
    }
    if (diff < minDiff) {
      minDiff = diff
      bl = point
    }
  }
  return { tl, tr, br, bl }
}

function toUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x / width, y: point.y / height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

export function cornersFromUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x * width, y: point.y * height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

function otsu(gray: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i += 1) hist[gray[i] ?? 0] += 1
  const total = gray.length
  let sumAll = 0
  for (let level = 0; level < 256; level += 1) sumAll += level * (hist[level] ?? 0)
  let weightBack = 0
  let sumBack = 0
  let best = -1
  let threshold = 180
  for (let level = 0; level < 256; level += 1) {
    weightBack += hist[level] ?? 0
    if (weightBack === 0) continue
    const weightFront = total - weightBack
    if (weightFront === 0) break
    sumBack += level * (hist[level] ?? 0)
    const meanBack = sumBack / weightBack
    const meanFront = (sumAll - sumBack) / weightFront
    const between = weightBack * weightFront * (meanBack - meanFront) ** 2
    if (between > best) {
      best = between
      threshold = level
    }
  }
  return threshold
}

/**
 * Cheap bright-sheet finder. No OpenCV, no morph, no flood-fill — safe on the live camera thread.
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  try {
    const image = grabFrame(source)
    if (!image) return null
    const { width, height, data } = image
    const gray = new Uint8Array(width * height)
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      gray[i] = (0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)) | 0
    }
    const threshold = Math.min(245, Math.max(150, otsu(gray)))
    let count = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let tl = { x: 0, y: 0 }
    let tr = { x: 0, y: 0 }
    let br = { x: 0, y: 0 }
    let bl = { x: 0, y: 0 }
    let minSum = Number.POSITIVE_INFINITY
    let maxSum = Number.NEGATIVE_INFINITY
    let minDiff = Number.POSITIVE_INFINITY
    let maxDiff = Number.NEGATIVE_INFINITY
    for (let y = 0, i = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1, i += 1) {
        if ((gray[i] ?? 0) <= threshold) continue
        count += 1
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        const sum = x + y
        const diff = x - y
        if (sum < minSum) {
          minSum = sum
          tl = { x, y }
        }
        if (sum > maxSum) {
          maxSum = sum
          br = { x, y }
        }
        if (diff > maxDiff) {
          maxDiff = diff
          tr = { x, y }
        }
        if (diff < minDiff) {
          minDiff = diff
          bl = { x, y }
        }
      }
    }
    const frac = count / (width * height)
    if (frac < MIN_AREA || frac > MAX_AREA) return null
    const touch = Number(minX <= 1) + Number(minY <= 1) + Number(maxX >= width - 2) + Number(maxY >= height - 2)
    if (touch >= 3) return null
    return toUnit(orderCorners([tl, tr, br, bl]), width, height)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
