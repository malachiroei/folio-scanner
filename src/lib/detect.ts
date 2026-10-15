import type { Corners, Point } from '../types'

const DETECT_WIDTH = 320
const STILL_WIDTH = 720
const MIN_AREA = 0.2
const MAX_AREA = 0.88
const MARGIN = 0.012
const STILL_MARGIN = 0.012
const PAPER_SAT = 34
const A4_ASPECT = Math.SQRT2
const A4_ASPECT_MIN = 1.2
const A4_ASPECT_MAX = 1.6

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

type BlobHit = { corners: Corners; count: number }

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

function quadAspect(corners: Corners) {
  const width =
    (Math.hypot(corners.tr.x - corners.tl.x, corners.tr.y - corners.tl.y) +
      Math.hypot(corners.br.x - corners.bl.x, corners.br.y - corners.bl.y)) /
    2
  const height =
    (Math.hypot(corners.bl.x - corners.tl.x, corners.bl.y - corners.tl.y) +
      Math.hypot(corners.br.x - corners.tr.x, corners.br.y - corners.tr.y)) /
    2
  const short = Math.min(width, height)
  if (short < 1) return 0
  return Math.max(width, height) / short
}

function a4Score(corners: Corners, frac: number) {
  const aspect = quadAspect(corners)
  if (aspect < A4_ASPECT_MIN || aspect > A4_ASPECT_MAX) return 0
  const aspectScore = 1 - Math.abs(aspect - A4_ASPECT) / (A4_ASPECT_MAX - A4_ASPECT_MIN)
  return aspectScore * 2 + frac
}

function largestBrightBlob(gray: Uint8Array, width: number, height: number, threshold: number): BlobHit | null {
  const frame = width * height
  const seen = new Uint8Array(gray.length)
  const stack = new Int32Array(gray.length)
  let best: BlobHit | null = null
  let bestScore = -1

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
    if (frac < MIN_AREA || frac > MAX_AREA) continue
    const touch =
      Number(acc.minX <= 1) + Number(acc.minY <= 1) + Number(acc.maxX >= width - 2) + Number(acc.maxY >= height - 2)
    if (touch >= 4) continue
    const corners = { tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl }
    const score = a4Score(corners, frac)
    if (score <= 0 || score <= bestScore) continue
    bestScore = score
    best = { count: acc.count, corners }
  }
  return best
}

function cornersFromMask(mask: Uint8Array, width: number, height: number): Corners | null {
  const acc = extrema()
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue
    addPoint(acc, i % width, (i - (i % width)) / width)
  }
  if (acc.count < width * height * MIN_AREA) return null
  const touch =
    Number(acc.minX <= 1) + Number(acc.minY <= 1) + Number(acc.maxX >= width - 2) + Number(acc.maxY >= height - 2)
  if (touch >= 4) return null
  return { tl: acc.tl, tr: acc.tr, br: acc.br, bl: acc.bl }
}

function fitLine(independent: number[], dependent: number[]): { a: number; b: number } | null {
  const n = independent.length
  if (n < 12) return null
  let sumI = 0
  let sumD = 0
  let sumII = 0
  let sumID = 0
  for (let i = 0; i < n; i += 1) {
    const x = independent[i] ?? 0
    const y = dependent[i] ?? 0
    sumI += x
    sumD += y
    sumII += x * x
    sumID += x * y
  }
  const den = n * sumII - sumI * sumI
  if (Math.abs(den) < 1e-6) return null
  const a = (n * sumID - sumI * sumD) / den
  const b = (sumD - a * sumI) / n
  return { a, b }
}

function sliceMiddle<T>(items: T[], trim = 0.14): T[] {
  if (items.length < 16) return items
  const start = Math.floor(items.length * trim)
  const end = Math.max(start + 8, Math.ceil(items.length * (1 - trim)))
  return items.slice(start, end)
}

function intersectEdge(xOfY: { a: number; b: number }, yOfX: { a: number; b: number }): Point | null {
  const den = 1 - xOfY.a * yOfX.a
  if (Math.abs(den) < 1e-6) return null
  const x = (xOfY.a * yOfX.b + xOfY.b) / den
  const y = yOfX.a * x + yOfX.b
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/**
 * Least-squares lines on the page's four sides. A desk photo's far edge is shorter;
 * stretching that trapezoid is what CamScanner's "lift" does.
 */
function fitTrapezoid(mask: Uint8Array, width: number, height: number): Corners | null {
  const leftX: number[] = []
  const leftY: number[] = []
  const rightX: number[] = []
  const rightY: number[] = []
  const topX: number[] = []
  const topY: number[] = []
  const bottomX: number[] = []
  const bottomY: number[] = []

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    let minX = -1
    let maxX = -1
    for (let x = 0; x < width; x += 1) {
      if (!mask[row + x]) continue
      if (minX < 0) minX = x
      maxX = x
    }
    if (minX < 0) continue
    leftX.push(minX)
    leftY.push(y)
    rightX.push(maxX)
    rightY.push(y)
  }
  for (let x = 0; x < width; x += 1) {
    let minY = -1
    let maxY = -1
    for (let y = 0; y < height; y += 1) {
      if (!mask[y * width + x]) continue
      if (minY < 0) minY = y
      maxY = y
    }
    if (minY < 0) continue
    topX.push(x)
    topY.push(minY)
    bottomX.push(x)
    bottomY.push(maxY)
  }

  const left = fitLine(sliceMiddle(leftY), sliceMiddle(leftX))
  const right = fitLine(sliceMiddle(rightY), sliceMiddle(rightX))
  const top = fitLine(sliceMiddle(topX), sliceMiddle(topY))
  const bottom = fitLine(sliceMiddle(bottomX), sliceMiddle(bottomY))
  if (!left || !right || !top || !bottom) return null

  const tl = intersectEdge(left, top)
  const tr = intersectEdge(right, top)
  const br = intersectEdge(right, bottom)
  const bl = intersectEdge(left, bottom)
  if (!tl || !tr || !br || !bl) return null

  const pad = 8
  const inside = [tl, tr, br, bl].every(
    (point) => point.x >= -pad && point.y >= -pad && point.x <= width - 1 + pad && point.y <= height - 1 + pad,
  )
  if (!inside) return null
  const clampPt = (point: Point): Point => ({
    x: Math.min(width - 1, Math.max(0, point.x)),
    y: Math.min(height - 1, Math.max(0, point.y)),
  })
  const corners = { tl: clampPt(tl), tr: clampPt(tr), br: clampPt(br), bl: clampPt(bl) }
  const area =
    Math.abs(
      corners.tl.x * corners.tr.y -
        corners.tr.x * corners.tl.y +
        corners.tr.x * corners.br.y -
        corners.br.x * corners.tr.y +
        corners.br.x * corners.bl.y -
        corners.bl.x * corners.br.y +
        corners.bl.x * corners.tl.y -
        corners.tl.x * corners.bl.y,
    ) / 2
  const frac = area / (width * height)
  if (frac < MIN_AREA || frac > MAX_AREA) return null
  return corners
}

function paperPageMask(
  data: Uint8ClampedArray,
  gray: Uint8Array,
  width: number,
  height: number,
  lumaThresh: number,
): Uint8Array | null {
  const n = gray.length
  const paper = new Uint8Array(n)
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    if ((gray[p] ?? 0) > lumaThresh && sat < PAPER_SAT) paper[p] = 1
  }
  const bg = new Uint8Array(n)
  const stack = new Int32Array(n)
  let top = 0
  const push = (index: number) => {
    if (index < 0 || index >= n || bg[index] || paper[index]) return
    bg[index] = 1
    stack[top] = index
    top += 1
  }
  for (let x = 0; x < width; x += 1) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (top > 0) {
    top -= 1
    const index = stack[top] ?? 0
    const x = index % width
    if (x > 0) push(index - 1)
    if (x + 1 < width) push(index + 1)
    if (index >= width) push(index - width)
    if (index + width < n) push(index + width)
  }
  const page = new Uint8Array(n)
  let count = 0
  for (let i = 0; i < n; i += 1) {
    if (bg[i]) continue
    page[i] = 1
    count += 1
  }
  const frac = count / n
  if (frac < MIN_AREA || frac > MAX_AREA) return null
  return page
}

function sheetCorners(
  data: Uint8ClampedArray,
  gray: Uint8Array,
  width: number,
  height: number,
  lumaThresh: number,
  fitEdges: boolean,
) {
  const page = paperPageMask(data, gray, width, height, lumaThresh)
  if (!page) return null
  const corners = (fitEdges ? fitTrapezoid(page, width, height) : null) ?? cornersFromMask(page, width, height)
  if (!corners) return null
  return corners
}

/**
 * White-sheet quadrilateral: ignore keys/desk, keep A4-like hull extrema.
 * Live uses the filled paper mask; stills also fit edge lines for a true trapezoid.
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  try {
    const still = !(source instanceof HTMLVideoElement)
    const image = grabFrame(source, still ? STILL_WIDTH : DETECT_WIDTH)
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
    const threshold = Math.min(210, Math.max(150, otsu(gray)))
    const sheet = sheetCorners(data, gray, width, height, threshold, still)
    if (sheet) return toUnit(expand(sheet, width, height, still ? STILL_MARGIN : MARGIN), width, height)
    const blob = largestBrightBlob(gray, width, height, threshold)
    if (!blob) return null
    return toUnit(expand(blob.corners, width, height, still ? STILL_MARGIN : MARGIN), width, height)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
