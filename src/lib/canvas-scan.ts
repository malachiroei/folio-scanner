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

/** Paper white stays global; photo contrast is per-component, never page-wide. */
const LIGHT_GRID = 8
const WHITE_PERCENTILE = 0.95
const PAPER_FLOOR = 200
const PHOTO_RANGE = 32
const PHOTO_SEED_MEAN = 195
const PHOTO_SEED_MIN = 150
const PHOTO_FILL_MEAN = 185
const PHOTO_FILL_DARK = 130
const PHOTO_DILATE = 3
const PHOTO_P_LO = 0.02
const PHOTO_P_HI = 0.98
const PHOTO_MIN_SPAN = 24
const PHOTO_MIN_PIXELS = 2500
const SAT_BOOST = 1.5
const SAT_KEEP = 0.05
const SAT_WHITE = 0.04
const L_TINT = 0.7
const L_WHITE = 0.82
const SHARPEN_AMOUNT = 1.4
const SHARPEN_THRESHOLD = 3
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

/* ---------- Deterministic Magic Color: paper white + per-photo min/max ---------- */

async function yieldBusy(clock: { last: number }) {
  if (performance.now() - clock.last < YIELD_MS) return
  await nextFrame()
  clock.last = performance.now()
}

function extractLuma(data: Uint8ClampedArray, count: number) {
  const luma = new Float32Array(count)
  for (let p = 0, i = 0; p < count; p += 1, i += 4) {
    luma[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  return luma
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

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255
  const green = g / 255
  const blue = b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const light = (max + min) / 2
  if (max - min < 1e-6) return [0, 0, light]
  const delta = max - min
  const sat = light > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = 0
  if (max === red) hue = ((green - blue) / delta + (green < blue ? 6 : 0)) / 6
  else if (max === green) hue = ((blue - red) / delta + 2) / 6
  else hue = ((red - green) / delta + 4) / 6
  return [hue, sat, light]
}

function hueToRgb(p: number, q: number, t: number) {
  let tone = t
  if (tone < 0) tone += 1
  if (tone > 1) tone -= 1
  if (tone < 1 / 6) return p + (q - p) * 6 * tone
  if (tone < 1 / 2) return q
  if (tone < 2 / 3) return p + (q - p) * (2 / 3 - tone) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 1e-6) {
    const tone = l * 255
    return [tone, tone, tone]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255]
}

/** 95th-percentile luminance of the whole page — the true paper white. */
function pageWhitePoint(luma: Float32Array) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < luma.length; i += 1) {
    hist[Math.min(255, Math.max(0, Math.round(luma[i] ?? 0)))] += 1
  }
  return Math.max(PAPER_FLOOR, histPercentile(hist, luma.length, WHITE_PERCENTILE))
}

/**
 * Coarse 8×8 paper-white field. Each cell uses its own 95th percentile so corner
 * shadows can lift, but a cell that is mostly a dark photo is rejected and replaced
 * with the global paper white — never the car's own pixels.
 */
function paperWhiteGrid(luma: Float32Array, width: number, height: number, whitePoint: number) {
  const grid = new Float32Array(LIGHT_GRID * LIGHT_GRID)
  const cellW = width / LIGHT_GRID
  const cellH = height / LIGHT_GRID
  const floor = Math.max(PAPER_FLOOR, whitePoint * 0.82)

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
      const local = count > 0 ? histPercentile(hist, count, WHITE_PERCENTILE) : whitePoint
      grid[gy * LIGHT_GRID + gx] = local < floor ? whitePoint : Math.min(255, Math.max(floor, local))
    }
  }
  return grid
}

/** Bilinear sample of the 8×8 paper-white field — smooth corner lighting, no local photo mean. */
function localPaperWhite(grid: Float32Array, x: number, y: number, width: number, height: number) {
  const fx = ((x + 0.5) / width) * (LIGHT_GRID - 1)
  const fy = ((y + 0.5) / height) * (LIGHT_GRID - 1)
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(LIGHT_GRID - 1, x0 + 1)
  const y1 = Math.min(LIGHT_GRID - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const a = grid[y0 * LIGHT_GRID + x0] ?? PAPER_FLOOR
  const b = grid[y0 * LIGHT_GRID + x1] ?? PAPER_FLOOR
  const c = grid[y1 * LIGHT_GRID + x0] ?? PAPER_FLOOR
  const d = grid[y1 * LIGHT_GRID + x1] ?? PAPER_FLOOR
  return Math.max(PAPER_FLOOR, (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)
}

function photoCellIndex(x: number, y: number, width: number, height: number, cols: number, rows: number) {
  const gx = Math.min(cols - 1, ((x * cols) / width) | 0)
  const gy = Math.min(rows - 1, ((y * rows) / height) | 0)
  return gy * cols + gx
}

function dilatePhotoMask(mask: Uint8Array, fill: Uint8Array, cols: number, rows: number) {
  let current = mask
  for (let pass = 0; pass < PHOTO_DILATE; pass += 1) {
    const next = new Uint8Array(current)
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x
        if (current[i] || !fill[i]) continue
        if (
          (x > 0 && current[i - 1]) ||
          (x + 1 < cols && current[i + 1]) ||
          (y > 0 && current[i - cols]) ||
          (y + 1 < rows && current[i + cols])
        ) {
          next[i] = 1
        }
      }
    }
    current = next
  }
  return current
}

function labelPhotoCells(mask: Uint8Array, cols: number, rows: number) {
  const labels = new Int32Array(mask.length)
  const stack = new Int32Array(mask.length)
  let count = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || labels[start]) continue
    count += 1
    let top = 0
    stack[top++] = start
    labels[start] = count
    while (top > 0) {
      const i = stack[--top] ?? 0
      const x = i % cols
      const y = (i / cols) | 0
      const neighbors = [
        x > 0 ? i - 1 : -1,
        x + 1 < cols ? i + 1 : -1,
        y > 0 ? i - cols : -1,
        y + 1 < rows ? i + cols : -1,
      ]
      for (const next of neighbors) {
        if (next < 0 || !mask[next] || labels[next]) continue
        labels[next] = count
        stack[top++] = next
      }
    }
  }
  return { labels, count }
}

/**
 * Photo components from textured cells (not white paper). Each component
 * gets its own 2nd/98th luminance bounds so night cars stretch to real
 * black/white instead of inheriting the page-wide paper percentile.
 */
function photoLevels(norm: Float32Array, width: number, height: number) {
  const cols = Math.max(8, Math.round(width / Math.max(32, Math.round(Math.min(width, height) / 64))))
  const rows = Math.max(8, Math.round(height / Math.max(32, Math.round(Math.min(width, height) / 64))))
  const cells = cols * rows
  const mins = new Float32Array(cells).fill(255)
  const maxs = new Float32Array(cells)
  const sums = new Float32Array(cells)
  const counts = new Uint32Array(cells)

  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const i = photoCellIndex(x, y, width, height, cols, rows)
      const value = norm[row + x] ?? 0
      if (value < (mins[i] ?? 255)) mins[i] = value
      if (value > (maxs[i] ?? 0)) maxs[i] = value
      sums[i] = (sums[i] ?? 0) + value
      counts[i] = (counts[i] ?? 0) + 1
    }
  }

  const seed = new Uint8Array(cells)
  const fill = new Uint8Array(cells)
  for (let i = 0; i < cells; i += 1) {
    const n = counts[i] ?? 0
    if (n < 1) continue
    const mean = (sums[i] ?? 0) / n
    const range = (maxs[i] ?? 0) - (mins[i] ?? 255)
    if (range >= PHOTO_RANGE && mean < PHOTO_SEED_MEAN && (mins[i] ?? 255) < PHOTO_SEED_MIN) seed[i] = 1
    if (mean < PHOTO_FILL_MEAN || ((mins[i] ?? 255) < PHOTO_FILL_DARK && mean < 200)) fill[i] = 1
  }

  const { labels, count } = labelPhotoCells(dilatePhotoMask(seed, fill, cols, rows), cols, rows)
  const hists = Array.from({ length: count + 1 }, () => new Uint32Array(256))
  const totals = new Uint32Array(count + 1)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const id = labels[photoCellIndex(x, y, width, height, cols, rows)] ?? 0
      if (id < 1) continue
      hists[id][Math.min(255, Math.max(0, (norm[row + x] ?? 0) | 0))] += 1
      totals[id] += 1
    }
  }

  const lo = new Float32Array(count + 1)
  const hi = new Float32Array(count + 1)
  for (let id = 1; id <= count; id += 1) {
    const total = totals[id] ?? 0
    const hist = hists[id]
    if (!hist || total < PHOTO_MIN_PIXELS) {
      lo[id] = 0
      hi[id] = 255
      continue
    }
    const low = histPercentile(hist, total, PHOTO_P_LO)
    const high = histPercentile(hist, total, PHOTO_P_HI)
    if (high - low < PHOTO_MIN_SPAN) {
      lo[id] = 0
      hi[id] = 255
      continue
    }
    lo[id] = low
    hi[id] = high
  }

  return { labels, cols, rows, lo, hi }
}

function stretchPhotoLuma(normL: number, id: number, lo: Float32Array, hi: Float32Array) {
  if (id < 1) return normL
  const min = lo[id] ?? 0
  const max = hi[id] ?? 255
  const span = Math.max(1, max - min)
  return Math.min(255, Math.max(0, ((normL - min) / span) * 255))
}

/**
 * Paper: white-normalize only. Photos: min/max stretch inside the component.
 * Then HSL — tinted highlights keep hue (sat ×1.5); only near-grey paper
 * with L > 0.82 becomes #FFFFFF.
 */
async function applyToneAndColor(
  data: Uint8ClampedArray,
  luma: Float32Array,
  grid: Float32Array,
  photos: ReturnType<typeof photoLevels>,
  width: number,
  height: number,
  clock: { last: number },
) {
  const { labels, cols, rows, lo, hi } = photos
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const red = data[i] ?? 0
      const green = data[i + 1] ?? 0
      const blue = data[i + 2] ?? 0
      const srcL = luma[p] ?? 0
      const paper = localPaperWhite(grid, x, y, width, height)
      const normL = Math.min(255, Math.max(0, (srcL / paper) * 255))
      const id = labels[photoCellIndex(x, y, width, height, cols, rows)] ?? 0
      const next = stretchPhotoLuma(normL, id, lo, hi)

      let outR: number
      let outG: number
      let outB: number
      if (srcL > 0.5) {
        const scale = next / srcL
        outR = red * scale
        outG = green * scale
        outB = blue * scale
      } else {
        outR = next
        outG = next
        outB = next
      }

      const [hue, sat, light] = rgbToHsl(outR, outG, outB)
      if (sat > SAT_KEEP && light > L_TINT) {
        const [toneR, toneG, toneB] = hslToRgb(hue, Math.min(1, sat * SAT_BOOST), light)
        data[i] = Math.min(255, Math.max(0, toneR))
        data[i + 1] = Math.min(255, Math.max(0, toneG))
        data[i + 2] = Math.min(255, Math.max(0, toneB))
        data[i + 3] = 255
        continue
      }
      if (sat < SAT_WHITE && light > L_WHITE) {
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
        data[i + 3] = 255
        continue
      }

      const keepSat = sat > SAT_KEEP ? Math.min(1, sat * SAT_BOOST) : sat
      const [toneR, toneG, toneB] = hslToRgb(hue, keepSat, light)
      data[i] = Math.min(255, Math.max(0, toneR))
      data[i + 1] = Math.min(255, Math.max(0, toneG))
      data[i + 2] = Math.min(255, Math.max(0, toneB))
      data[i + 3] = 255
    }
  }
}

/** 3×3 unsharp on luminance. Amount 1.4 / threshold 3 for Magic Color; gentler for warp. */
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
      data[i] = Math.min(255, Math.max(0, (data[i] ?? 0) * lift))
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] ?? 0) * lift))
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] ?? 0) * lift))
    }
  }
}

function normalizePage(luma: Float32Array, grid: Float32Array, width: number, height: number) {
  const norm = new Float32Array(luma.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      const paper = localPaperWhite(grid, x, y, width, height)
      norm[row + x] = Math.min(255, Math.max(0, ((luma[row + x] ?? 0) / paper) * 255))
    }
  }
  return norm
}

async function applyMagicColor(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const luma = extractLuma(data, width * height)
  const whitePoint = pageWhitePoint(luma)
  const grid = paperWhiteGrid(luma, width, height, whitePoint)
  const norm = normalizePage(luma, grid, width, height)
  const photos = photoLevels(norm, width, height)
  await applyToneAndColor(data, luma, grid, photos, width, height, clock)
  sharpen3x3(image, SHARPEN_AMOUNT, SHARPEN_THRESHOLD)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const luma = extractLuma(data, width * height)
  const whitePoint = pageWhitePoint(luma)
  const grid = paperWhiteGrid(luma, width, height, whitePoint)
  const norm = normalizePage(luma, grid, width, height)
  const photos = photoLevels(norm, width, height)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const id = photos.labels[photoCellIndex(x, y, width, height, photos.cols, photos.rows)] ?? 0
      const stretched = stretchPhotoLuma(norm[p] ?? 0, id, photos.lo, photos.hi)
      const ink = stretched < BW_THRESHOLD ? 0 : 255
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

/** CamScanner Magic Color: white paper, vivid stamps, photos preserved. Full-res, one pass. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyMagicColor)
}

/** Adaptive black and white from the same global paper-white field. */
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
