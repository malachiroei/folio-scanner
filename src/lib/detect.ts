import type { Corners, Point } from '../types'

const DETECT_WIDTH = 240

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

function finish(
  count: number,
  width: number,
  height: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tl: Point,
  tr: Point,
  br: Point,
  bl: Point,
): Corners | null {
  if (count < 24) return null
  const boxW = maxX - minX
  const boxH = maxY - minY
  const boxFrac = (boxW * boxH) / (width * height)
  if (boxFrac < 0.08 || boxFrac > 0.99) return null
  if (boxW < 12 || boxH < 12) return null
  return toUnit({ tl, tr, br, bl }, width, height)
}

function extremaFrom(
  gray: Uint8Array,
  width: number,
  height: number,
  keep: (value: number, index: number) => boolean,
): Corners | null {
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
      if (!keep(gray[i] ?? 0, i)) continue
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
  return finish(count, width, height, minX, minY, maxX, maxY, tl, tr, br, bl)
}

function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p
  let acc = 0
  for (let level = 0; level < 256; level += 1) {
    acc += hist[level] ?? 0
    if (acc >= target) return level
  }
  return 200
}

/**
 * Live page finder: paper edges first (white sheet on a beige desk), then bright pixels.
 * Uses the bounding box of hits, so a page that fills the view is not rejected.
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  try {
    const image = grabFrame(source)
    if (!image) return null
    const { width, height, data } = image
    const gray = new Uint8Array(width * height)
    const hist = new Uint32Array(256)
    let sum = 0
    for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
      const value = (0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)) | 0
      gray[i] = value
      hist[value] += 1
      sum += value
    }
    if (sum / gray.length < 12) return null

    const fromEdges = extremaFrom(gray, width, height, (_value, index) => {
      const x = index % width
      const y = (index - x) / width
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false
      const gx = (gray[index + 1] ?? 0) - (gray[index - 1] ?? 0)
      const gy = (gray[index + width] ?? 0) - (gray[index - width] ?? 0)
      return Math.abs(gx) + Math.abs(gy) > 12
    })
    if (fromEdges) return fromEdges

    const brightCut = Math.max(percentile(hist, gray.length, 0.62), 140)
    return extremaFrom(gray, width, height, (value) => value >= brightCut)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
