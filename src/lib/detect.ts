import type { Corners, Point } from '../types'
import { cornersArea, orderCorners, quadIsConvex, quadKeystone } from './geometry'

const DETECT_WIDTH = 240
const SNAP_WIDTH = 320
const MIN_AREA = 0.08
const MAX_AREA = 0.88
const MARGIN = 0.06
const DARK_ROW = 85

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
  maxWidth = DETECT_WIDTH,
  smooth = false,
): ImageData | null {
  if (!sampleCtx) return null
  const { width: sw, height: sh } = sourceSize(source)
  if (sw < 8 || sh < 8) return null
  const scale = Math.min(1, maxWidth / sw)
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  if (sample.width !== width) sample.width = width
  if (sample.height !== height) sample.height = height
  sampleCtx.imageSmoothingEnabled = smooth
  if (smooth) sampleCtx.imageSmoothingQuality = 'high'
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
      corners: { tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl },
    }
  }
  return best
}

/**
 * Largest bright page (the white sheet), not the printed ink. Ink extrema lock onto
 * handwriting and cut the table; the paper blob is the orange frame and the warp quad.
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
    const otsuT = Math.min(210, Math.max(130, otsu(gray)))
    const paperT = Math.max(otsuT, 162)
    const blob = largestBrightBlob(gray, width, height, paperT) ?? largestBrightBlob(gray, width, height, otsuT)
    if (!blob) return null
    return toUnit(expand(blob.corners, width, height, MARGIN), width, height)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}

type Box = { minX: number; minY: number; maxX: number; maxY: number }

function seedBox(seed: Corners, width: number, height: number): Box {
  const xs = [seed.tl.x, seed.tr.x, seed.br.x, seed.bl.x]
  const ys = [seed.tl.y, seed.tr.y, seed.br.y, seed.bl.y]
  const padX = Math.max(2, (Math.max(...xs) - Math.min(...xs)) * 0.02)
  const padY = Math.max(2, (Math.max(...ys) - Math.min(...ys)) * 0.02)
  return {
    minX: Math.max(0, Math.floor(Math.min(...xs) - padX)),
    minY: Math.max(0, Math.floor(Math.min(...ys) - padY)),
    maxX: Math.min(width - 1, Math.ceil(Math.max(...xs) + padX)),
    maxY: Math.min(height - 1, Math.ceil(Math.max(...ys) + padY)),
  }
}

function blurGray(gray: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          sum += gray[row + xx] ?? 0
          count += 1
        }
      }
      out[y * width + x] = count ? (sum / count) | 0 : (gray[y * width + x] ?? 0)
    }
  }
  return out
}

function fitLinear(indep: number[], dep: number[]): { a: number; b: number } | null {
  const fit = (idx: number[]) => {
    const n = idx.length
    if (n < 8) return null
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
  const keep = ranked.slice(0, Math.max(8, Math.floor(ranked.length * 0.8))).map((item) => item.i)
  return fit(keep) ?? first
}

function intersectEdge(vert: { a: number; b: number }, horz: { a: number; b: number }): Point | null {
  const denom = 1 - vert.a * horz.a
  if (Math.abs(denom) < 1e-6) return null
  const x = (vert.a * horz.b + vert.b) / denom
  const y = horz.a * x + horz.b
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * White-sheet edges inside the crop pins (not ink). Their trapezoid is what the warp
 * stretches until the page faces the camera — without cutting to handwriting.
 */
export function snapToPaperCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  seed: Corners,
): Corners | null {
  try {
    const { width: sw, height: sh } = sourceSize(source)
    if (sw < 8 || sh < 8) return null
    const image = grabFrame(source, SNAP_WIDTH, true)
    if (!image) return null
    const { width, height, data } = image
    const raw = new Uint8Array(width * height)
    for (let i = 0, p = 0; i < raw.length; i += 1, p += 4) {
      raw[i] = (0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)) | 0
    }
    const gray = blurGray(raw, width, height)
    const seedPx = toUnit(seed, sw, sh)
    const seedQuad = cornersFromUnit(seedPx, width, height)
    const seedKeystone = quadKeystone(seedQuad)
    const roi = seedBox(seedQuad, width, height)
    const roiW = roi.maxX - roi.minX + 1
    const roiH = roi.maxY - roi.minY + 1
    if (roiW < 24 || roiH < 24) return null
    const threshold = Math.min(210, Math.max(162, otsu(gray)))
    const minSpanX = Math.max(8, roiW * 0.28)
    const minSpanY = Math.max(8, roiH * 0.28)

    const leftX: number[] = []
    const leftY: number[] = []
    const rightX: number[] = []
    const rightY: number[] = []
    for (let y = roi.minY; y <= roi.maxY; y += 1) {
      const row = y * width
      let luma = 0
      let lo = -1
      let hi = -1
      let bright = 0
      for (let x = roi.minX; x <= roi.maxX; x += 1) {
        const g = gray[row + x] ?? 0
        luma += g
        if (g <= threshold) continue
        if (lo < 0) lo = x
        hi = x
        bright += 1
      }
      if (bright < minSpanX || luma / roiW < DARK_ROW || lo < 0) continue
      leftX.push(lo)
      leftY.push(y)
      rightX.push(hi)
      rightY.push(y)
    }

    const topX: number[] = []
    const topY: number[] = []
    const botX: number[] = []
    const botY: number[] = []
    for (let x = roi.minX; x <= roi.maxX; x += 1) {
      let lo = -1
      let hi = -1
      let bright = 0
      for (let y = roi.minY; y <= roi.maxY; y += 1) {
        const g = gray[y * width + x] ?? 0
        if (g <= threshold) continue
        if (lo < 0) lo = y
        hi = y
        bright += 1
      }
      if (bright < minSpanY || lo < 0) continue
      topX.push(x)
      topY.push(lo)
      botX.push(x)
      botY.push(hi)
    }

    const left = fitLinear(leftY, leftX)
    const right = fitLinear(rightY, rightX)
    const top = fitLinear(topX, topY)
    const bottom = fitLinear(botX, botY)
    if (!left || !right) return null

    const atY = (edge: { a: number; b: number }, y: number) => ({ x: edge.a * y + edge.b, y })
    let tl: Point | null = null
    let tr: Point | null = null
    let br: Point | null = null
    let bl: Point | null = null
    if (top && bottom) {
      tl = intersectEdge(left, top)
      tr = intersectEdge(right, top)
      br = intersectEdge(right, bottom)
      bl = intersectEdge(left, bottom)
    }
    if (!tl || !tr || !br || !bl) {
      const y0 = leftY[Math.floor(leftY.length * 0.04)] ?? roi.minY
      const y1 = leftY[Math.floor(leftY.length * 0.96)] ?? roi.maxY
      tl = atY(left, y0)
      tr = atY(right, y0)
      br = atY(right, y1)
      bl = atY(left, y1)
    }

    let ordered: Corners
    try {
      ordered = orderCorners([tl, tr, br, bl])
    } catch {
      return null
    }
    if (!quadIsConvex(ordered)) return null
    const seedArea = cornersArea(seedQuad)
    const area = cornersArea(ordered)
    if (area < seedArea * 0.55 || area > seedArea * 1.2) return null
    if (quadKeystone(ordered) + 0.02 < seedKeystone) return null
    const xs = [ordered.tl.x, ordered.tr.x, ordered.br.x, ordered.bl.x]
    const ys = [ordered.tl.y, ordered.tr.y, ordered.br.y, ordered.bl.y]
    if (
      xs.some((x) => x < roi.minX - roiW * 0.08 || x > roi.maxX + roiW * 0.08) ||
      ys.some((y) => y < roi.minY - roiH * 0.08 || y > roi.maxY + roiH * 0.08)
    ) {
      return null
    }
    const grown = expand(ordered, width, height, 0.02)
    return cornersFromUnit(toUnit(grown, width, height), sw, sh)
  } catch (err) {
    console.warn('Paper snap failed:', err)
    return null
  }
}
