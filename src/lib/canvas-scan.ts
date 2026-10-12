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

/** CamScanner Magic Color: per-channel white balance, paper snap, ink punch, S-curve. */
const LIGHT_GRID = 16
const LIGHT_PERCENTILE = 0.95
const LIGHT_BLUR_PASSES = 4
const LIGHT_FLOOR = 0.85
const FLAT_TARGET = 255
const PAPER_L = 210
const PAPER_S = 0.12
const SAT_KEEP = 0.1
const SAT_BOOST = 1.5
const PHOTO_BLACK = 50
const PHOTO_BLACK_LO = 45
const PHOTO_BLACK_HI = 55
const PHOTO_WHITE = 252
const SHADOW_GAMMA = 0.87
const HIGHLIGHT_POWER = 1.06
const SHARPEN_AMOUNT = 1.25
const SHARPEN_THRESHOLD = 1
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

/* ---------- Magic Color: RGB white balance → levels → sat → unsharp ---------- */

async function yieldBusy(clock: { last: number }) {
  if (performance.now() - clock.last < YIELD_MS) return
  await nextFrame()
  clock.last = performance.now()
}

function clamp255(value: number) {
  return value < 0 ? 0 : value > 255 ? 255 : value
}

function clamp01(value: number) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function pixelLuma(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b
}

function pixelSat(r: number, g: number, b: number) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return max < 1 ? 0 : (max - min) / max
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

function dilateGrid3x3(grid: Float32Array, size: number) {
  const next = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let peak = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        const row = yy * size
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= size) continue
          const value = grid[row + xx] ?? 0
          if (value > peak) peak = value
        }
      }
      next[y * size + x] = peak
    }
  }
  return next
}

function erodeGrid3x3(grid: Float32Array, size: number) {
  const next = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let floor = Number.POSITIVE_INFINITY
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= size) continue
        const row = yy * size
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= size) continue
          const value = grid[row + xx] ?? 0
          if (value < floor) floor = value
        }
      }
      next[y * size + x] = Number.isFinite(floor) ? floor : 1
    }
  }
  return next
}

function finishLightGrid(hists: Uint32Array, global: Uint32Array, counts: Uint32Array, total: number) {
  const cells = LIGHT_GRID * LIGHT_GRID
  const paper = Math.max(1, histPercentile(global, total, LIGHT_PERCENTILE))
  const grid = new Float32Array(cells)
  for (let id = 0; id < cells; id += 1) {
    const n = Math.max(1, counts[id] ?? 1)
    grid[id] = Math.max(1, histPercentile(hists.subarray(id * 256, id * 256 + 256), n, LIGHT_PERCENTILE))
  }
  let smooth = erodeGrid3x3(dilateGrid3x3(grid, LIGHT_GRID), LIGHT_GRID)
  for (let pass = 0; pass < LIGHT_BLUR_PASSES; pass += 1) {
    smooth = blurGrid3x3(smooth, LIGHT_GRID)
  }
  return { grid: smooth, paper }
}

/**
 * Paper-white field per RGB channel: 16×16 95th-percentile cells, closed and
 * blurred, then bilinearly sampled. Floor at global 95th × 0.85 so a dark
 * photo cell cannot pull the estimated paper color down.
 */
function illuminationRgb(data: Uint8ClampedArray, width: number, height: number) {
  const cells = LIGHT_GRID * LIGHT_GRID
  const histR = new Uint32Array(cells * 256)
  const histG = new Uint32Array(cells * 256)
  const histB = new Uint32Array(cells * 256)
  const globalR = new Uint32Array(256)
  const globalG = new Uint32Array(256)
  const globalB = new Uint32Array(256)
  const counts = new Uint32Array(cells)

  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(LIGHT_GRID - 1, ((y * LIGHT_GRID) / height) | 0)
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(LIGHT_GRID - 1, ((x * LIGHT_GRID) / width) | 0)
      const id = gy * LIGHT_GRID + gx
      const i = (y * width + x) * 4
      const red = Math.min(255, Math.max(0, Math.round(data[i] ?? 0)))
      const green = Math.min(255, Math.max(0, Math.round(data[i + 1] ?? 0)))
      const blue = Math.min(255, Math.max(0, Math.round(data[i + 2] ?? 0)))
      histR[id * 256 + red] += 1
      histG[id * 256 + green] += 1
      histB[id * 256 + blue] += 1
      globalR[red] += 1
      globalG[green] += 1
      globalB[blue] += 1
      counts[id] += 1
    }
  }

  const total = width * height
  const r = finishLightGrid(histR, globalR, counts, total)
  const g = finishLightGrid(histG, globalG, counts, total)
  const b = finishLightGrid(histB, globalB, counts, total)
  return {
    gridR: r.grid,
    gridG: g.grid,
    gridB: b.grid,
    paperR: r.paper,
    paperG: g.paper,
    paperB: b.paper,
  }
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

function flattenChannel(value: number, bg: number) {
  const flat = (value / bg) * FLAT_TARGET
  return flat < 0 ? 0 : flat > 255 ? 255 : flat
}

function clampRange(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value
}

/**
 * Local photo black point: 8th percentile of non-paper luma per 16×16 cell,
 * clamped to 45–55 so milky asphalt (~70–90) remaps toward 15–25.
 */
function photoBlackGrid(data: Uint8ClampedArray, width: number, height: number) {
  const cells = LIGHT_GRID * LIGHT_GRID
  const hists = new Uint32Array(cells * 256)
  const counts = new Uint32Array(cells)
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(LIGHT_GRID - 1, ((y * LIGHT_GRID) / height) | 0)
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(LIGHT_GRID - 1, ((x * LIGHT_GRID) / width) | 0)
      const i = (y * width + x) * 4
      const luma = Math.min(255, Math.max(0, Math.round(pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0))))
      if (luma >= PAPER_L) continue
      const id = gy * LIGHT_GRID + gx
      hists[id * 256 + luma] += 1
      counts[id] += 1
    }
  }
  const grid = new Float32Array(cells)
  for (let id = 0; id < cells; id += 1) {
    const n = counts[id] ?? 0
    if (n < 12) {
      grid[id] = PHOTO_BLACK
      continue
    }
    grid[id] = clampRange(histPercentile(hists.subarray(id * 256, id * 256 + 256), n, 0.08), PHOTO_BLACK_LO, PHOTO_BLACK_HI)
  }
  return blurGrid3x3(grid, LIGHT_GRID)
}

/** `stretchedL = clamp(((normL - blackPoint) / (whitePoint - blackPoint)) * 255, 0, 255)` */
function stretchBlack(normL: number, blackPoint: number) {
  const span = PHOTO_WHITE - blackPoint
  if (span < 1) return clamp255(normL)
  const stretched = ((normL - blackPoint) / span) * 255
  return stretched < 0 ? 0 : stretched > 255 ? 255 : stretched
}

/**
 * Steep S-curve after the black-point stretch. Shadows use levels-gamma 0.87
 * so asphalt and tires go solid; highlights stay short of clipping.
 */
function photoCurve(stretchedL: number) {
  const t = clamp01(stretchedL / 255)
  const shadowPower = 1 / SHADOW_GAMMA
  const s =
    t < 0.5 ? 0.5 * (2 * t) ** shadowPower : 1 - 0.5 * (2 - 2 * t) ** HIGHLIGHT_POWER
  return s * 255
}

function photoTone(normL: number, blackPoint: number) {
  return photoCurve(stretchBlack(normL, blackPoint))
}

function scaleToLuma(r: number, g: number, b: number, fromL: number, toL: number): [number, number, number] {
  if (fromL < 0.5) return [toL, toL, toL]
  const scale = toL / fromL
  return [r * scale, g * scale, b * scale]
}

/** Every pixel: `normC = clamp((C / bgC) * 255)`. Kills the incandescent yellow. */
async function whiteBalanceRgb(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clock: { last: number },
) {
  const fields = illuminationRgb(data, width, height)
  await yieldBusy(clock)
  const floorR = fields.paperR * LIGHT_FLOOR
  const floorG = fields.paperG * LIGHT_FLOOR
  const floorB = fields.paperB * LIGHT_FLOOR
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const bgR = Math.max(sampleGrid(fields.gridR, x, y, width, height), floorR)
      const bgG = Math.max(sampleGrid(fields.gridG, x, y, width, height), floorG)
      const bgB = Math.max(sampleGrid(fields.gridB, x, y, width, height), floorB)
      data[i] = flattenChannel(data[i] ?? 0, bgR)
      data[i + 1] = flattenChannel(data[i + 1] ?? 0, bgG)
      data[i + 2] = flattenChannel(data[i + 2] ?? 0, bgB)
      data[i + 3] = 255
    }
  }
}

/**
 * After white balance: paper → #FFFFFF. Everything else gets a photo black-point
 * stretch and a steep S-curve so asphalt/tires land around 15–25. Chromatic
 * pixels (S > 0.10) keep hue and get a 1.5× saturation boost.
 */
async function applyLevelsAndColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clock: { last: number },
) {
  const blackGrid = photoBlackGrid(data, width, height)
  await yieldBusy(clock)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let i = y * width * 4
    for (let x = 0; x < width; x += 1, i += 4) {
      let red = data[i] ?? 0
      let green = data[i + 1] ?? 0
      let blue = data[i + 2] ?? 0
      const normL = pixelLuma(red, green, blue)
      const sat = pixelSat(red, green, blue)
      let paper = false

      if (normL > PAPER_L && sat < PAPER_S) {
        red = 255
        green = 255
        blue = 255
        paper = true
      } else {
        const blackPoint = sampleGrid(blackGrid, x, y, width, height)
        const tone = scaleToLuma(red, green, blue, normL, photoTone(normL, blackPoint))
        red = tone[0]
        green = tone[1]
        blue = tone[2]
      }

      if (!paper && sat > SAT_KEEP) {
        const [hue, , value] = rgbToHsv(red, green, blue)
        const chroma = hsvToRgb(hue, Math.min(1, sat * SAT_BOOST), value)
        red = chroma[0]
        green = chroma[1]
        blue = chroma[2]
      }

      data[i] = clamp255(red)
      data[i + 1] = clamp255(green)
      data[i + 2] = clamp255(blue)
      data[i + 3] = 255
    }
  }
}

/** 3×3 unsharp on luminance. Amount 1.25 for Magic Color; gentler for warp. */
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
        ((gray[p - width - 1] ?? 0) +
          (gray[p - width] ?? 0) +
          (gray[p - width + 1] ?? 0) +
          (gray[p - 1] ?? 0) +
          center +
          (gray[p + 1] ?? 0) +
          (gray[p + width - 1] ?? 0) +
          (gray[p + width] ?? 0) +
          (gray[p + width + 1] ?? 0)) /
        9
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

async function applyMagicColor(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  await whiteBalanceRgb(data, width, height, clock)
  await applyLevelsAndColor(data, width, height, clock)
  sharpen3x3(image, SHARPEN_AMOUNT, SHARPEN_THRESHOLD)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  await whiteBalanceRgb(data, width, height, clock)
  const blackGrid = photoBlackGrid(data, width, height)
  await yieldBusy(clock)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let i = y * width * 4
    for (let x = 0; x < width; x += 1, i += 4) {
      const normL = pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
      const sat = pixelSat(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
      const tone =
        normL > PAPER_L && sat < PAPER_S
          ? 255
          : photoTone(normL, sampleGrid(blackGrid, x, y, width, height))
      const ink = tone < BW_THRESHOLD ? 0 : 255
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

/** Magic Color: white paper, stretched photo blacks, 1.5× chroma. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyMagicColor)
}

/** Adaptive black and white from the same white-balance and levels curve. */
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
