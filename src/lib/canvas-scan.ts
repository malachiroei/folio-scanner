import type { Corners, FilterMode, Point } from '../types'
import { distance, outputSize } from './geometry'
import { nextFrame } from './image'

/**
 * Strict A4 container (1:1.414). A wider-than-tall quad becomes a landscape page (3508x2480 at
 * most), anything else a portrait page (2480x3508), so a document is never rotated or squeezed
 * into the wrong orientation. Very elongated shapes (receipts) keep their measured size.
 */
function a4Size(
  size: { width: number; height: number },
  landscape: boolean,
): { width: number; height: number } {
  const long = Math.max(size.width, size.height)
  const short = Math.min(size.width, size.height)
  if (short < 1) return size
  const ratio = long / short
  if (ratio > 2.1) return size
  const snapped = Math.round(long / Math.SQRT2)
  return landscape ? { width: long, height: snapped } : { width: snapped, height: long }
}

/**
 * Landscape when the quad is wider than tall, portrait otherwise. Opposite sides are averaged,
 * so perspective (a near edge longer than the far one) cannot flip the decision.
 */
function isLandscape(corners: Corners): boolean {
  const width = (distance(corners.tl, corners.tr) + distance(corners.bl, corners.br)) / 2
  const height = (distance(corners.tl, corners.bl) + distance(corners.tr, corners.br)) / 2
  return width > height
}

/**
 * Long edge of the straightened page: never below 2800px (about 240 DPI on A4), up to full A4 at
 * 300 DPI (3508x2480 landscape, 2480x3508 portrait). Smaller quads are enlarged with bilinear
 * sampling, but never more than 3x, so a tiny source does not blow up memory for nothing.
 */
const MIN_EDGE = 2800
const MAX_EDGE = 3508
const MAX_UPSCALE = 3

/** Uniform page scan: illumination flatten → CLAHE → paper roll-off → unsharp. */
const LIGHT_GRID = 16
const LIGHT_PERCENTILE = 0.9
const LIGHT_BLUR_PASSES = 4
const FLAT_TARGET = 230
const CLAHE_TILES = 8
const CLAHE_BINS = 256
const CLAHE_CLIP = 2.25
const PAPER_LUMA = 218
const PAPER_LUMA_FULL = 236
const PAPER_SAT = 15
const SAT_BOOST = 1.35
const SHARPEN_AMOUNT = 1.2
const SHARPEN_THRESHOLD = 2
const BW_THRESHOLD = 148
const YIELD_MS = 24

function sourceSize(image: CanvasImageSource): { width: number; height: number } {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth, height: image.naturalHeight }
  }
  if (image instanceof HTMLVideoElement) {
    return { width: image.videoWidth, height: image.videoHeight }
  }
  if (image instanceof HTMLCanvasElement || image instanceof ImageBitmap) {
    return { width: image.width, height: image.height }
  }
  return { width: 0, height: 0 }
}

function drawSource(image: CanvasImageSource): HTMLCanvasElement {
  const { width, height } = sourceSize(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('לא ניתן להכין את התמונה.')
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas
}

function solveLinear(matrix: number[][], values: number[]): number[] | null {
  const size = values.length
  const rows = matrix.map((row, index) => [...row, values[index] ?? 0])
  for (let col = 0; col < size; col += 1) {
    let pivot = col
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(rows[row]?.[col] ?? 0) > Math.abs(rows[pivot]?.[col] ?? 0)) pivot = row
    }
    const pivotRow = rows[pivot]
    const colRow = rows[col]
    if (!pivotRow || !colRow || Math.abs(pivotRow[col] ?? 0) < 1e-8) return null
    rows[col] = pivotRow
    rows[pivot] = colRow
    const divisor = rows[col]?.[col] ?? 1
    for (let cell = col; cell <= size; cell += 1) {
      const current = rows[col]
      if (current) current[cell] = (current[cell] ?? 0) / divisor
    }
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue
      const factor = rows[row]?.[col] ?? 0
      for (let cell = col; cell <= size; cell += 1) {
        const current = rows[row]
        const source = rows[col]
        if (current && source) current[cell] = (current[cell] ?? 0) - factor * (source[cell] ?? 0)
      }
    }
  }
  return rows.map((row) => row[size] ?? 0)
}

function homography(from: Point[], to: Point[]): number[] | null {
  const matrix: number[][] = []
  const values: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const src = from[i]
    const dst = to[i]
    if (!src || !dst) return null
    matrix.push([src.x, src.y, 1, 0, 0, 0, -dst.x * src.x, -dst.x * src.y])
    values.push(dst.x)
    matrix.push([0, 0, 0, src.x, src.y, 1, -dst.y * src.x, -dst.y * src.y])
    values.push(dst.y)
  }
  const solved = solveLinear(matrix, values)
  if (!solved) return null
  return [...solved, 1]
}

/** Fast fallback when the time budget runs out: the corners' bounding box, scaled to the page size. */
function paintScaled(
  source: HTMLCanvasElement,
  width: number,
  height: number,
  corners?: Corners,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return canvas
  if (corners) {
    const xs = [corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x]
    const ys = [corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y]
    const left = Math.max(0, Math.min(...xs))
    const top = Math.max(0, Math.min(...ys))
    const right = Math.min(source.width, Math.max(...xs))
    const bottom = Math.min(source.height, Math.max(...ys))
    if (right - left > 8 && bottom - top > 8) {
      context.drawImage(source, left, top, right - left, bottom - top, 0, 0, width, height)
      return canvas
    }
  }
  context.drawImage(source, 0, 0, width, height)
  return canvas
}

async function warpCanvas(
  source: HTMLCanvasElement,
  corners: Corners,
  width: number,
  height: number,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HTMLCanvasElement> {
  if (performance.now() > deadlineAt) return paintScaled(source, width, height, corners)
  const context = source.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('לא ניתן לקרוא את התמונה.')
  const pixels = context.getImageData(0, 0, source.width, source.height)
  const from = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  const to = [corners.tl, corners.tr, corners.br, corners.bl]
  const map = homography(from, to)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const output = canvas.getContext('2d', { willReadFrequently: true })
  if (!output) throw new Error('לא ניתן ליישר את העמוד.')
  if (!map) {
    output.drawImage(source, 0, 0, width, height)
    return canvas
  }

  if (performance.now() > deadlineAt) return paintScaled(source, width, height, corners)

  const dest = output.createImageData(width, height)
  const data = dest.data
  const src = pixels.data
  const sw = source.width
  const sh = source.height
  const [h0 = 1, h1 = 0, h2 = 0, h3 = 0, h4 = 1, h5 = 0, h6 = 0, h7 = 0, h8 = 1] = map
  const maxX = sw - 1
  const maxY = sh - 1
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) {
      await nextFrame()
      if (performance.now() > deadlineAt) return paintScaled(source, width, height, corners)
    }
    let out = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const w = h6 * x + h7 * y + h8
      const safe = Math.abs(w) < 1e-6 ? 1e-6 : w
      let px = (h0 * x + h1 * y + h2) / safe
      let py = (h3 * x + h4 * y + h5) / safe
      if (px < 0) px = 0
      else if (px > maxX) px = maxX
      if (py < 0) py = 0
      else if (py > maxY) py = maxY
      const x0 = px | 0
      const y0 = py | 0
      const x1 = x0 < maxX ? x0 + 1 : x0
      const y1 = y0 < maxY ? y0 + 1 : y0
      const dx = px - x0
      const dy = py - y0
      const i00 = (y0 * sw + x0) * 4
      const i10 = (y0 * sw + x1) * 4
      const i01 = (y1 * sw + x0) * 4
      const i11 = (y1 * sw + x1) * 4
      const w00 = (1 - dx) * (1 - dy)
      const w10 = dx * (1 - dy)
      const w01 = (1 - dx) * dy
      const w11 = dx * dy
      data[out] = (src[i00] ?? 0) * w00 + (src[i10] ?? 0) * w10 + (src[i01] ?? 0) * w01 + (src[i11] ?? 0) * w11
      data[out + 1] =
        (src[i00 + 1] ?? 0) * w00 + (src[i10 + 1] ?? 0) * w10 + (src[i01 + 1] ?? 0) * w01 + (src[i11 + 1] ?? 0) * w11
      data[out + 2] =
        (src[i00 + 2] ?? 0) * w00 + (src[i10 + 2] ?? 0) * w10 + (src[i01 + 2] ?? 0) * w01 + (src[i11 + 2] ?? 0) * w11
      data[out + 3] = 255
      out += 4
    }
  }
  sharpen3x3(dest, 0.35)
  output.putImageData(dest, 0, 0)
  return canvas
}

/* ---------- Uniform mathematical scan: flatten → CLAHE → roll-off → unsharp ---------- */

async function yieldBusy(clock: { last: number }) {
  if (performance.now() - clock.last < YIELD_MS) return
  await nextFrame()
  clock.last = performance.now()
}

function clamp255(value: number) {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const span = edge1 - edge0
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (x - edge0) / span))
  return t * t * (3 - 2 * t)
}

function extractLumaSat(data: Uint8ClampedArray, count: number) {
  const luma = new Float32Array(count)
  const sat = new Float32Array(count)
  for (let p = 0, i = 0; p < count; p += 1, i += 4) {
    const red = data[i] ?? 0
    const green = data[i + 1] ?? 0
    const blue = data[i + 2] ?? 0
    luma[p] = 0.299 * red + 0.587 * green + 0.114 * blue
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    sat[p] = max < 1 ? 0 : ((max - min) / max) * 255
  }
  return { luma, sat }
}

function histPercentile(hist: Uint32Array, total: number, q: number) {
  const target = total * q
  let acc = 0
  for (let value = 0; value < 256; value += 1) {
    acc += hist[value] ?? 0
    if (acc >= target) return value
  }
  return 255
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const value = max / 255
  const delta = max - min
  const saturation = max < 1e-6 ? 0 : delta / max
  if (delta < 1e-6) return [0, saturation, value]
  let hue = 0
  if (max === r) hue = ((g - b) / delta + (g < b ? 6 : 0)) / 6
  else if (max === g) hue = ((b - r) / delta + 2) / 6
  else hue = ((r - g) / delta + 4) / 6
  return [hue, saturation, value]
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const sector = h * 6
  const i = Math.floor(sector)
  const f = sector - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return [v * 255, t * 255, p * 255]
    case 1:
      return [q * 255, v * 255, p * 255]
    case 2:
      return [p * 255, v * 255, t * 255]
    case 3:
      return [p * 255, q * 255, v * 255]
    case 4:
      return [t * 255, p * 255, v * 255]
    default:
      return [v * 255, p * 255, q * 255]
  }
}

function blurGrid3x3(grid: Float32Array, size: number) {
  const next = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let sum = 0
      let count = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        const row = yy * size
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= size) continue
          sum += grid[row + xx] ?? 0
          count += 1
        }
      }
      next[y * size + x] = count > 0 ? sum / count : 1
    }
  }
  return next
}

/**
 * Slow illumination surface: 16×16 grid of 90th-percentile luma, then a heavy
 * box filter so page shadows stay and local photo dips do not become holes.
 */
function illuminationGrid(luma: Float32Array, width: number, height: number) {
  const grid = new Float32Array(LIGHT_GRID * LIGHT_GRID)
  const cellW = width / LIGHT_GRID
  const cellH = height / LIGHT_GRID

  for (let gy = 0; gy < LIGHT_GRID; gy += 1) {
    for (let gx = 0; gx < LIGHT_GRID; gx += 1) {
      const x0 = Math.floor(gx * cellW)
      const y0 = Math.floor(gy * cellH)
      const x1 = Math.min(width, Math.floor((gx + 1) * cellW))
      const y1 = Math.min(height, Math.floor((gy + 1) * cellH))
      const hist = new Uint32Array(256)
      let count = 0
      for (let y = y0; y < y1; y += 1) {
        const row = y * width
        for (let x = x0; x < x1; x += 1) {
          hist[Math.min(255, Math.max(0, Math.round(luma[row + x] ?? 0)))] += 1
          count += 1
        }
      }
      grid[gy * LIGHT_GRID + gx] = Math.max(1, count > 0 ? histPercentile(hist, count, LIGHT_PERCENTILE) : 1)
    }
  }

  let smooth = grid
  for (let pass = 0; pass < LIGHT_BLUR_PASSES; pass += 1) {
    smooth = blurGrid3x3(smooth, LIGHT_GRID)
  }
  return smooth
}

function sampleGrid(grid: Float32Array, x: number, y: number, width: number, height: number) {
  const fx = ((x + 0.5) / width) * (LIGHT_GRID - 1)
  const fy = ((y + 0.5) / height) * (LIGHT_GRID - 1)
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(LIGHT_GRID - 1, x0 + 1)
  const y1 = Math.min(LIGHT_GRID - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const a = grid[y0 * LIGHT_GRID + x0] ?? 1
  const b = grid[y0 * LIGHT_GRID + x1] ?? 1
  const c = grid[y1 * LIGHT_GRID + x0] ?? 1
  const d = grid[y1 * LIGHT_GRID + x1] ?? 1
  return Math.max(1, (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)
}

function flattenLuma(luma: Float32Array, grid: Float32Array, width: number, height: number) {
  const flat = new Float32Array(luma.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const bgL = sampleGrid(grid, x, y, width, height)
      flat[row + x] = clamp255(((luma[row + x] ?? 0) / bgL) * FLAT_TARGET)
    }
  }
  return flat
}

function clipHistogram(hist: Float64Array, clipLimit: number) {
  for (let pass = 0; pass < 3; pass += 1) {
    let excess = 0
    for (let i = 0; i < CLAHE_BINS; i += 1) {
      const value = hist[i] ?? 0
      if (value > clipLimit) {
        excess += value - clipLimit
        hist[i] = clipLimit
      }
    }
    if (excess < 1e-3) break
    const raise = excess / CLAHE_BINS
    for (let i = 0; i < CLAHE_BINS; i += 1) {
      hist[i] = (hist[i] ?? 0) + raise
    }
  }
}

function claheLuts(luma: Float32Array, width: number, height: number) {
  const tiles = CLAHE_TILES
  const hists = Array.from({ length: tiles * tiles }, () => new Float64Array(CLAHE_BINS))
  const totals = new Float64Array(tiles * tiles)

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(tiles - 1, ((y * tiles) / height) | 0)
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(tiles - 1, ((x * tiles) / width) | 0)
      const id = gy * tiles + gx
      const bin = Math.min(255, Math.max(0, Math.round(luma[row + x] ?? 0)))
      const hist = hists[id]
      if (!hist) continue
      hist[bin] += 1
      totals[id] += 1
    }
  }

  const luts = new Float32Array(tiles * tiles * CLAHE_BINS)
  for (let id = 0; id < hists.length; id += 1) {
    const hist = hists[id]
    const total = Math.max(1, totals[id] ?? 1)
    if (!hist) continue
    clipHistogram(hist, Math.max(1, CLAHE_CLIP * (total / CLAHE_BINS)))
    let cdf = 0
    const offset = id * CLAHE_BINS
    for (let bin = 0; bin < CLAHE_BINS; bin += 1) {
      cdf += hist[bin] ?? 0
      luts[offset + bin] = clamp255((cdf / total) * 255)
    }
  }
  return luts
}

function mapClahe(luts: Float32Array, gx: number, gy: number, bin: number) {
  const x = Math.min(CLAHE_TILES - 1, Math.max(0, gx))
  const y = Math.min(CLAHE_TILES - 1, Math.max(0, gy))
  return luts[(y * CLAHE_TILES + x) * CLAHE_BINS + bin] ?? bin
}

async function applyCLAHE(
  luma: Float32Array,
  width: number,
  height: number,
  clock: { last: number },
) {
  const luts = claheLuts(luma, width, height)
  const out = new Float32Array(luma.length)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    const gy = ((y + 0.5) * CLAHE_TILES) / height - 0.5
    const y0 = Math.floor(gy)
    const ty = gy - y0
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const gx = ((x + 0.5) * CLAHE_TILES) / width - 0.5
      const x0 = Math.floor(gx)
      const tx = gx - x0
      const bin = Math.min(255, Math.max(0, Math.round(luma[row + x] ?? 0)))
      const a = mapClahe(luts, x0, y0, bin)
      const b = mapClahe(luts, x0 + 1, y0, bin)
      const c = mapClahe(luts, x0, y0 + 1, bin)
      const d = mapClahe(luts, x0 + 1, y0 + 1, bin)
      out[row + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }
  }
  return out
}

/**
 * Apply CLAHE luma, keep original hue, boost chroma 1.35×, and roll only
 * high-luma / low-sat paper (flatL > 218 and S < 15) smoothly to #FFFFFF.
 */
async function applyScanColor(
  data: Uint8ClampedArray,
  luma: Float32Array,
  sat: Float32Array,
  flatL: Float32Array,
  claheL: Float32Array,
  width: number,
  height: number,
  clock: { last: number },
) {
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const srcL = luma[p] ?? 0
      const nextL = claheL[p] ?? 0
      let red: number
      let green: number
      let blue: number
      if (srcL > 0.5) {
        const scale = nextL / srcL
        red = (data[i] ?? 0) * scale
        green = (data[i + 1] ?? 0) * scale
        blue = (data[i + 2] ?? 0) * scale
      } else {
        red = nextL
        green = nextL
        blue = nextL
      }

      const whiteMix =
        smoothstep(PAPER_LUMA, PAPER_LUMA_FULL, flatL[p] ?? 0) * (1 - smoothstep(0, PAPER_SAT, sat[p] ?? 0))
      if (whiteMix < 0.999) {
        const [hue, chroma, value] = rgbToHsv(red, green, blue)
        const boosted = Math.min(1, chroma * SAT_BOOST)
        const mixed = chroma + (boosted - chroma) * (1 - whiteMix)
        const tone = hsvToRgb(hue, mixed, value)
        red = tone[0]
        green = tone[1]
        blue = tone[2]
      }
      if (whiteMix > 0) {
        red += (255 - red) * whiteMix
        green += (255 - green) * whiteMix
        blue += (255 - blue) * whiteMix
      }

      data[i] = clamp255(red)
      data[i + 1] = clamp255(green)
      data[i + 2] = clamp255(blue)
      data[i + 3] = 255
    }
  }
}

/** 3×3 unsharp on luminance. Amount 1.2 / threshold 2 for the scan pass; gentler for warp. */
function sharpen3x3(image: ImageData, amount: number, threshold = 1.2) {
  const { data, width, height } = image
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x
      const center = gray[p] ?? 0
      const blur =
        ((gray[p - 1] ?? 0) + (gray[p + 1] ?? 0) + (gray[p - width] ?? 0) + (gray[p + width] ?? 0)) / 4
      const delta = center - blur
      if (Math.abs(delta) < threshold) continue
      const next = center + delta * amount
      const lift = center > 1 ? next / center : 1
      const i = p * 4
      data[i] = clamp255((data[i] ?? 0) * lift)
      data[i + 1] = clamp255((data[i + 1] ?? 0) * lift)
      data[i + 2] = clamp255((data[i + 2] ?? 0) * lift)
    }
  }
}

function flattenPage(luma: Float32Array, width: number, height: number) {
  return flattenLuma(luma, illuminationGrid(luma, width, height), width, height)
}

async function applyMagicColor(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const { luma, sat } = extractLumaSat(data, width * height)
  const flatL = flattenPage(luma, width, height)
  await yieldBusy(clock)
  const claheL = await applyCLAHE(flatL, width, height, clock)
  await applyScanColor(data, luma, sat, flatL, claheL, width, height, clock)
  sharpen3x3(image, SHARPEN_AMOUNT, SHARPEN_THRESHOLD)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const { luma } = extractLumaSat(data, width * height)
  const flatL = flattenPage(luma, width, height)
  await yieldBusy(clock)
  const claheL = await applyCLAHE(flatL, width, height, clock)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const ink = (claheL[p] ?? 0) < BW_THRESHOLD ? 0 : 255
      data[i] = ink
      data[i + 1] = ink
      data[i + 2] = ink
      data[i + 3] = 255
    }
  }
}

export function desaturateCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = image
  for (let i = 0; i < data.length; i += 4) {
    const tone = Math.round(0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0))
    data[i] = tone
    data[i + 1] = tone
    data[i + 2] = tone
  }
  context.putImageData(image, 0, 0)
  return canvas
}

/**
 * Pulls the corners a hair toward the center so a sliver of table never reaches the A4 edge,
 * without eating the license-plate crop at the top of the sheet.
 */
function insetCorners(corners: Corners, amount = 0.001): Corners {
  const cx = (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4
  const cy = (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4
  const pull = (point: Point): Point => ({
    x: point.x + (cx - point.x) * amount * 2,
    y: point.y + (cy - point.y) * amount * 2,
  })
  return { tl: pull(corners.tl), tr: pull(corners.tr), br: pull(corners.br), bl: pull(corners.bl) }
}

export async function straightenCanvas(
  image: CanvasImageSource,
  corners: Corners,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HTMLCanvasElement> {
  const fitted = a4Size(outputSize(corners), isLandscape(corners))
  const longEdge = Math.max(fitted.width, fitted.height, 1)
  const scale = Math.min(MAX_EDGE / longEdge, Math.min(MAX_UPSCALE, Math.max(1, MIN_EDGE / longEdge)))
  const width = Math.max(32, Math.round(fitted.width * scale))
  const height = Math.max(32, Math.round(fitted.height * scale))
  const copy = drawSource(image)
  try {
    return await warpCanvas(copy, insetCorners(corners), width, height, deadlineAt)
  } finally {
    copy.width = 0
    copy.height = 0
  }
}

async function processPixels(
  source: HTMLCanvasElement,
  run: (pixels: ImageData) => void | Promise<void>,
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return source
  context.drawImage(source, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  await run(pixels)
  context.putImageData(pixels, 0, 0)
  return canvas
}

/** Uniform scan: flattened paper, CLAHE contrast, vivid stamps, photos left intact. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyMagicColor)
}

/** Adaptive black and white from the same flatten + CLAHE field. */
export async function applyCanvasBlackWhite(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyFastBlackWhite)
}

export async function renderCanvasDocument(
  image: CanvasImageSource,
  corners: Corners,
  filter: FilterMode,
): Promise<HTMLCanvasElement> {
  const warped = await straightenCanvas(image, corners)
  if (filter === 'original') return warped
  if (filter === 'gray') return desaturateCanvas(copyCanvas(warped))
  if (filter === 'magic') return applyCanvasMagic(warped)
  return applyCanvasBlackWhite(warped)
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  canvas.getContext('2d')?.drawImage(source, 0, 0)
  return canvas
}
