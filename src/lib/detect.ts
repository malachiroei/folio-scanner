import type { Corners, Point } from '../types'
import { orderCorners, quadIsConvex } from './geometry'

const DETECT_WIDTH = 240
const REFINE_WIDTH = 420
const MIN_AREA = 0.08
const MAX_AREA = 0.88
const MARGIN = 0.05
const DARK_ROW = 70

const sample = document.createElement('canvas')
const sampleCtx = sample.getContext('2d', { willReadFrequently: true })

function sourceSize(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement) {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
  }
  return { width: source.width, height: source.height }
}

function grabFrame(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  maxWidth: number,
): ImageData | null {
  if (!sampleCtx) return null
  const { width: sw, height: sh } = sourceSize(source)
  if (sw < 8 || sh < 8) return null
  const scale = Math.min(1, maxWidth / sw)
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

type Box = { minX: number; minY: number; maxX: number; maxY: number }

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

function unitBox(seed: Corners | undefined, width: number, height: number): Box {
  if (!seed) return { minX: 0, minY: 0, maxX: width - 1, maxY: height - 1 }
  const xs = [seed.tl.x, seed.tr.x, seed.br.x, seed.bl.x].map((x) => x * width)
  const ys = [seed.tl.y, seed.tr.y, seed.br.y, seed.bl.y].map((y) => y * height)
  const padX = Math.max(2, (Math.max(...xs) - Math.min(...xs)) * 0.04)
  const padY = Math.max(2, (Math.max(...ys) - Math.min(...ys)) * 0.04)
  return {
    minX: Math.max(0, Math.floor(Math.min(...xs) - padX)),
    minY: Math.max(0, Math.floor(Math.min(...ys) - padY)),
    maxX: Math.min(width - 1, Math.ceil(Math.max(...xs) + padX)),
    maxY: Math.min(height - 1, Math.ceil(Math.max(...ys) + padY)),
  }
}

function largestBrightBlob(
  gray: Uint8Array,
  width: number,
  height: number,
  threshold: number,
  roi: Box,
): BlobHit | null {
  const frame = width * height
  const seen = new Uint8Array(gray.length)
  const stack = new Int32Array(gray.length)
  let best: BlobHit | null = null

  for (let y = roi.minY; y <= roi.maxY; y += 1) {
    const row = y * width
    for (let x = roi.minX; x <= roi.maxX; x += 1) {
      const start = row + x
      if ((gray[start] ?? 0) <= threshold || seen[start]) continue
      let top = 0
      stack[top] = start
      top += 1
      seen[start] = 1
      const acc = extrema()
      while (top > 0) {
        top -= 1
        const index = stack[top] ?? 0
        const px = index % width
        const py = (index - px) / width
        addPoint(acc, px, py)
        const tryPush = (nx: number, ny: number) => {
          if (nx < roi.minX || nx > roi.maxX || ny < roi.minY || ny > roi.maxY) return
          const next = ny * width + nx
          if (seen[next] || (gray[next] ?? 0) <= threshold) return
          seen[next] = 1
          stack[top] = next
          top += 1
        }
        tryPush(px - 1, py)
        tryPush(px + 1, py)
        tryPush(px, py - 1)
        tryPush(px, py + 1)
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
  }
  return best
}

function isInk(
  gray: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  darkCut: number,
): boolean {
  const g = gray[y * width + x] ?? 0
  if (g < 48 || g > darkCut) return false
  const right = x < width - 1 ? (gray[y * width + x + 1] ?? g) : g
  const down = y < height - 1 ? (gray[(y + 1) * width + x] ?? g) : g
  return Math.abs(g - right) >= 10 || Math.abs(g - down) >= 10
}

function fitLinear(indep: number[], dep: number[]): { a: number; b: number } | null {
  const fit = (idx: number[]) => {
    const n = idx.length
    if (n < 6) return null
    let sumX = 0
    let sumY = 0
    let sumXX = 0
    let sumXY = 0
    for (const i of idx) {
      const x = indep[i] ?? 0
      const y = dep[i] ?? 0
      sumX += x
      sumY += y
      sumXX += x * x
      sumXY += x * y
    }
    const denom = n * sumXX - sumX * sumX
    if (Math.abs(denom) < 1e-6) return { a: 0, b: sumY / n }
    const a = (n * sumXY - sumX * sumY) / denom
    return { a, b: (sumY - a * sumX) / n }
  }
  const all = indep.map((_, i) => i)
  const first = fit(all)
  if (!first) return null
  const ranked = all
    .map((i) => ({ i, e: Math.abs((dep[i] ?? 0) - (first.a * (indep[i] ?? 0) + first.b)) }))
    .sort((a, b) => a.e - b.e)
  const keep = ranked.slice(0, Math.max(6, Math.floor(ranked.length * 0.8))).map((item) => item.i)
  return fit(keep) ?? first
}

function intersectEdge(
  vert: { a: number; b: number },
  horz: { a: number; b: number },
): Point | null {
  const denom = 1 - vert.a * horz.a
  if (Math.abs(denom) < 1e-6) return null
  const x = (vert.a * horz.b + vert.b) / denom
  const y = horz.a * x + horz.b
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function usableQuad(corners: Corners, width: number, height: number): Corners | null {
  let ordered: Corners
  try {
    ordered = orderCorners([corners.tl, corners.tr, corners.br, corners.bl])
  } catch {
    return null
  }
  if (!quadIsConvex(ordered)) return null
  const xs = [ordered.tl.x, ordered.tr.x, ordered.br.x, ordered.bl.x]
  const ys = [ordered.tl.y, ordered.tr.y, ordered.br.y, ordered.bl.y]
  if (xs.some((x) => !Number.isFinite(x)) || ys.some((y) => !Number.isFinite(y))) return null
  if (
    xs.some((x) => x < -width * 0.1 || x > width * 1.1) ||
    ys.some((y) => y < -height * 0.1 || y > height * 1.1)
  ) {
    return null
  }
  const spanX = Math.max(...xs) - Math.min(...xs)
  const spanY = Math.max(...ys) - Math.min(...ys)
  if (spanX < width * 0.12 || spanY < height * 0.12) return null
  return expand(ordered, width, height, MARGIN)
}

/**
 * Left/right + top/bottom ink envelopes of the printed table. Their intersections are the
 * paper trapezoid: a shorter far (top) edge that the warp stretches until the page faces us.
 */
function tableQuad(
  gray: Uint8Array,
  width: number,
  height: number,
  box: Box,
  paperThreshold: number,
): Corners | null {
  const darkCut = Math.min(paperThreshold - 6, 170)
  const leftX: number[] = []
  const leftY: number[] = []
  const rightX: number[] = []
  const rightY: number[] = []
  const topX: number[] = []
  const topY: number[] = []
  const botX: number[] = []
  const botY: number[] = []
  const acc = extrema()

  for (let y = box.minY; y <= box.maxY; y += 1) {
    const row = y * width
    let luma = 0
    const span = box.maxX - box.minX + 1
    for (let x = box.minX; x <= box.maxX; x += 1) luma += gray[row + x] ?? 0
    if (span < 1 || luma / span < DARK_ROW) continue
    let lo = box.maxX
    let hi = box.minX
    let n = 0
    for (let x = box.minX; x <= box.maxX; x += 1) {
      if (!isInk(gray, width, height, x, y, darkCut)) continue
      addPoint(acc, x, y)
      if (x < lo) lo = x
      if (x > hi) hi = x
      n += 1
    }
    if (n < 3) continue
    leftX.push(lo)
    leftY.push(y)
    rightX.push(hi)
    rightY.push(y)
  }

  for (let x = box.minX; x <= box.maxX; x += 1) {
    let lo = box.maxY
    let hi = box.minY
    let n = 0
    for (let y = box.minY; y <= box.maxY; y += 1) {
      if (!isInk(gray, width, height, x, y, darkCut)) continue
      if (y < lo) lo = y
      if (y > hi) hi = y
      n += 1
    }
    if (n < 3) continue
    topX.push(x)
    topY.push(lo)
    botX.push(x)
    botY.push(hi)
  }

  const left = fitLinear(leftY, leftX)
  const right = fitLinear(rightY, rightX)
  const top = fitLinear(topX, topY)
  const bottom = fitLinear(botX, botY)
  if (left && right && top && bottom) {
    const tl = intersectEdge(left, top)
    const tr = intersectEdge(right, top)
    const br = intersectEdge(right, bottom)
    const bl = intersectEdge(left, bottom)
    if (tl && tr && br && bl) {
      const quad = usableQuad({ tl, tr, br, bl }, width, height)
      if (quad) return quad
    }
  }

  if (acc.count < 40) return null
  return usableQuad({ tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl }, width, height)
}

function lumaImage(image: ImageData): { gray: Uint8Array; mean: number } {
  const { width, height, data } = image
  const gray = new Uint8Array(width * height)
  let sum = 0
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    const value = (0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)) | 0
    gray[i] = value
    sum += value
  }
  return { gray, mean: sum / gray.length }
}

function findPageQuad(image: ImageData, seed?: Corners): Corners | null {
  const { width, height } = image
  const { gray, mean } = lumaImage(image)
  if (mean < 12) return null
  const roi = unitBox(seed, width, height)
  const threshold = Math.min(210, Math.max(90, otsu(gray)))
  const blob = largestBrightBlob(gray, width, height, threshold, roi)
  const search: Box = blob
    ? {
        minX: Math.max(roi.minX, blob.minX),
        minY: Math.max(roi.minY, blob.minY),
        maxX: Math.min(roi.maxX, blob.maxX),
        maxY: Math.min(roi.maxY, blob.maxY),
      }
    : roi
  const table = tableQuad(gray, width, height, search, threshold)
  if (table) return table
  if (blob) return expand(blob.corners, width, height, MARGIN)
  return null
}

/**
 * Bright page blob, then the printed table's edge lines so the quad is a perspective
 * trapezoid (far edge shorter). Warp later stretches that top onto a flat A4.
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  try {
    const image = grabFrame(source, DETECT_WIDTH)
    if (!image) return null
    const quad = findPageQuad(image)
    return quad ? toUnit(quad, image.width, image.height) : null
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}

/** Pixel-space trapezoid of the printed page, searched inside the live/crop pins. */
export function refineDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  seed?: Corners,
): Corners | null {
  try {
    const { width: sw, height: sh } = sourceSize(source)
    if (sw < 8 || sh < 8) return null
    const image = grabFrame(source, REFINE_WIDTH)
    if (!image) return null
    const seedUnit = seed ? toUnit(seed, sw, sh) : undefined
    const quad = findPageQuad(image, seedUnit)
    if (!quad) return null
    return cornersFromUnit(toUnit(quad, image.width, image.height), sw, sh)
  } catch (err) {
    console.warn('Refine failed:', err)
    return null
  }
}
