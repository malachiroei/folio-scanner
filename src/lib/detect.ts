import type { Corners, Point } from '../types'

const DETECT_WIDTH = 240
const MIN_AREA = 0.08
const MAX_AREA = 0.88
const MARGIN = 0.12

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
  sampleCtx.imageSmoothingEnabled = false
  sampleCtx.drawImage(source, 0, 0, width, height)
  return sampleCtx.getImageData(0, 0, width, height)
}

function toUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x / width, y: point.y / height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

export function cornersFromUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x * width, y: point.y * height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

function expand(corners: Corners, width: number, height: number, amount: number): Corners {
  const cx = (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4
  const cy = (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4
  const push = (point: Point): Point => ({
    x: Math.min(width - 1, Math.max(0, cx + (point.x - cx) * (1 + amount))),
    y: Math.min(height - 1, Math.max(0, cy + (point.y - cy) * (1 + amount))),
  })
  return { tl: push(corners.tl), tr: push(corners.tr), br: push(corners.br), bl: push(corners.bl) }
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
  let threshold = 160
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

type BlobHit = {
  count: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  corners: Corners
}

function extrema() {
  return {
    tl: { x: 0, y: 0 },
    tr: { x: 0, y: 0 },
    br: { x: 0, y: 0 },
    bl: { x: 0, y: 0 },
    minSum: Number.POSITIVE_INFINITY,
    maxSum: Number.NEGATIVE_INFINITY,
    minDiff: Number.POSITIVE_INFINITY,
    maxDiff: Number.NEGATIVE_INFINITY,
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: 0,
    maxY: 0,
    count: 0,
  }
}

function addPoint(acc: ReturnType<typeof extrema>, x: number, y: number) {
  acc.count += 1
  if (x < acc.minX) acc.minX = x
  if (y < acc.minY) acc.minY = y
  if (x > acc.maxX) acc.maxX = x
  if (y > acc.maxY) acc.maxY = y
  const sum = x + y
  const diff = x - y
  if (sum < acc.minSum) {
    acc.minSum = sum
    acc.tl = { x, y }
  }
  if (sum > acc.maxSum) {
    acc.maxSum = sum
    acc.br = { x, y }
  }
  if (diff > acc.maxDiff) {
    acc.maxDiff = diff
    acc.tr = { x, y }
  }
  if (diff < acc.minDiff) {
    acc.minDiff = diff
    acc.bl = { x, y }
  }
}

function largestBrightBlob(gray: Uint8Array, width: number, height: number, threshold: number): BlobHit | null {
  const frame = width * height
  const seen = new Uint8Array(gray.length)
  const stack = new Int32Array(gray.length)
  let best: BlobHit | null = null

  for (let start = 0; start < gray.length; start += 1) {
    if ((gray[start] ?? 0) <= threshold || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    const acc = extrema()
    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      const x = index % width
      const y = (index - x) / width
      addPoint(acc, x, y)
      if (x > 0 && !seen[index - 1] && (gray[index - 1] ?? 0) > threshold) {
        seen[index - 1] = 1
        stack[top] = index - 1
        top += 1
      }
      if (x < width - 1 && !seen[index + 1] && (gray[index + 1] ?? 0) > threshold) {
        seen[index + 1] = 1
        stack[top] = index + 1
        top += 1
      }
      if (y > 0 && !seen[index - width] && (gray[index - width] ?? 0) > threshold) {
        seen[index - width] = 1
        stack[top] = index - width
        top += 1
      }
      if (y < height - 1 && !seen[index + width] && (gray[index + width] ?? 0) > threshold) {
        seen[index + width] = 1
        stack[top] = index + width
        top += 1
      }
    }
    const frac = acc.count / frame
    if (frac < MIN_AREA || frac > MAX_AREA || (best && acc.count <= best.count)) continue
    const touch =
      Number(acc.minX <= 1) + Number(acc.minY <= 1) + Number(acc.maxX >= width - 2) + Number(acc.maxY >= height - 2)
    if (touch >= 4) continue
    best = {
      count: acc.count,
      minX: acc.minX,
      minY: acc.minY,
      maxX: acc.maxX,
      maxY: acc.maxY,
      corners: { tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl },
    }
  }
  return best
}

function inkCorners(
  gray: Uint8Array,
  width: number,
  height: number,
  blob: BlobHit,
  paperThreshold: number,
): Corners | null {
  const darkCut = Math.min(paperThreshold - 6, 170)
  const acc = extrema()
  for (let y = blob.minY; y <= blob.maxY; y += 1) {
    const row = y * width
    for (let x = blob.minX; x <= blob.maxX; x += 1) {
      const g = gray[row + x] ?? 0
      if (g < 48 || g > darkCut) continue
      const right = x < width - 1 ? (gray[row + x + 1] ?? g) : g
      const down = y < height - 1 ? (gray[row + width + x] ?? g) : g
      if (Math.abs(g - right) < 10 && Math.abs(g - down) < 10) continue
      addPoint(acc, x, y)
    }
  }
  if (acc.count < 40) return null
  return expand({ tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl }, width, height, MARGIN)
}

/**
 * Bright page blob, then the printed content inside it so the quad follows the paper
 * (not the desk AABB). Warp later maps this trapezoid onto a flat A4.
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  try {
    const image = grabFrame(source)
    if (!image) return null
    const { width, height, data } = image
    const gray = new Uint8Array(width * height)
    let sum = 0
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const value = (0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)) | 0
      gray[i] = value
      sum += value
    }
    if (sum / gray.length < 12) return null
    const threshold = Math.min(210, Math.max(90, otsu(gray)))
    const blob = largestBrightBlob(gray, width, height, threshold)
    if (!blob) return null
    const printed = inkCorners(gray, width, height, blob, threshold)
    return toUnit(printed ?? blob.corners, width, height)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
