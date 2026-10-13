import type { Corners, Point } from '../types'

const DETECT_WIDTH = 240
const MIN_AREA = 0.08
const MAX_AREA = 0.88

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

function otsu(gray: Uint8Array, minValue = -1): number {
  const hist = new Uint32Array(256)
  let total = 0
  for (let i = 0; i < gray.length; i += 1) {
    const value = gray[i] ?? 0
    if (value <= minValue) continue
    hist[value] += 1
    total += 1
  }
  if (total < 32) return minValue < 0 ? 160 : Math.min(230, minValue + 24)
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

function largestBrightQuad(gray: Uint8Array, width: number, height: number, threshold: number): Corners | null {
  const frame = width * height
  const seen = new Uint8Array(gray.length)
  const stack = new Int32Array(gray.length)
  let bestArea = 0
  let best: Corners | null = null

  for (let start = 0; start < gray.length; start += 1) {
    if ((gray[start] ?? 0) <= threshold || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
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

    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      const x = index % width
      const y = (index - x) / width
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

    const frac = count / frame
    if (frac < MIN_AREA || frac > MAX_AREA || count <= bestArea) continue
    const touch =
      Number(minX <= 1) + Number(minY <= 1) + Number(maxX >= width - 2) + Number(maxY >= height - 2)
    if (touch >= 4) continue
    bestArea = count
    best = { tl, tr, br, bl }
  }

  return best ? toUnit(best, width, height) : null
}

function expandUnit(corners: Corners, amount = 0.04): Corners {
  const cx = (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4
  const cy = (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4
  const grow = (point: Point): Point => ({
    x: Math.min(1, Math.max(0, point.x + (point.x - cx) * amount)),
    y: Math.min(1, Math.max(0, point.y + (point.y - cy) * amount)),
  })
  return { tl: grow(corners.tl), tr: grow(corners.tr), br: grow(corners.br), bl: grow(corners.bl) }
}

/**
 * Largest bright sheet (the page). Two-level Otsu: drop the dark keyboard/fabric, then
 * split paper from a beige desk so the four corners are the page, not an upright crop box.
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
    const room = Math.min(200, Math.max(80, otsu(gray)))
    const paper = Math.min(230, Math.max(room + 8, otsu(gray, room)))
    const found = largestBrightQuad(gray, width, height, paper) ?? largestBrightQuad(gray, width, height, room)
    return found ? expandUnit(found) : null
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
