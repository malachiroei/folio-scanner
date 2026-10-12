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
 * 300 DPI (3508x2480 landscape, 2480x3508 portrait). Smaller quads are enlarged with high-quality
 * interpolation, but never more than 3x, so a tiny source does not blow up memory for nothing.
 */
const MIN_EDGE = 2800
const MAX_EDGE = 3508
const MAX_UPSCALE = 3
/** Destination mesh density: piecewise affine cells approximate the homography without seams. */
const WARP_GRID = 48

/** Uniform mathematical scan: flat-field → luma curve → saturation → unsharp. No region masks. */
const LIGHT_GRID = 16
const LIGHT_PERCENTILE = 0.95
const LIGHT_BLUR_PASSES = 4
const LIGHT_FLOOR = 0.85
const FLAT_TARGET = 255
const SAT_BOOST = 1.6
const SAT_MIN = 0.08
const PAPER_LUMA = 215
const PAPER_SAT = 0.1
const INK_HARD = 90
const MID_DARK = 160
const SHADOW_TARGET = 20
const MID_DARK_TARGET = 100
const HIGHLIGHT_TARGET = 220
const SHARPEN_AMOUNT = 1.25
const SHARPEN_NOISE = 3
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

function highQuality(context: CanvasRenderingContext2D) {
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
}

function drawSource(image: CanvasImageSource): HTMLCanvasElement {
  const { width, height } = sourceSize(image)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('לא ניתן להכין את התמונה.')
  highQuality(context)
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

function mapHomography(h: number[], x: number, y: number): Point {
  const w = (h[6] ?? 0) * x + (h[7] ?? 0) * y + (h[8] ?? 1)
  const safe = Math.abs(w) < 1e-6 ? 1e-6 : w
  return {
    x: ((h[0] ?? 1) * x + (h[1] ?? 0) * y + (h[2] ?? 0)) / safe,
    y: ((h[3] ?? 0) * x + (h[4] ?? 1) * y + (h[5] ?? 0)) / safe,
  }
}

function invert3(m: number[]): number[] | null {
  const a = m[0] ?? 0
  const b = m[1] ?? 0
  const c = m[2] ?? 0
  const d = m[3] ?? 0
  const e = m[4] ?? 0
  const f = m[5] ?? 0
  const g = m[6] ?? 0
  const h = m[7] ?? 0
  const i = m[8] ?? 0
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) return null
  const id = 1 / det
  return [
    (e * i - f * h) * id,
    (c * h - b * i) * id,
    (b * f - c * e) * id,
    (f * g - d * i) * id,
    (a * i - c * g) * id,
    (c * d - a * f) * id,
    (d * h - e * g) * id,
    (b * g - a * h) * id,
    (a * e - b * d) * id,
  ]
}

function mul3(left: number[], right: number[]): number[] {
  const out = new Array<number>(9)
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      out[row * 3 + col] =
        (left[row * 3] ?? 0) * (right[col] ?? 0) +
        (left[row * 3 + 1] ?? 0) * (right[3 + col] ?? 0) +
        (left[row * 3 + 2] ?? 0) * (right[6 + col] ?? 0)
    }
  }
  return out
}

/** Affine matrix mapping source triangle → dest, as canvas setTransform(a, b, c, d, e, f). */
function triangleTransform(s0: Point, s1: Point, s2: Point, d0: Point, d1: Point, d2: Point) {
  const source = [s0.x, s1.x, s2.x, s0.y, s1.y, s2.y, 1, 1, 1]
  const dest = [d0.x, d1.x, d2.x, d0.y, d1.y, d2.y, 1, 1, 1]
  const inverse = invert3(source)
  if (!inverse) return null
  const mapped = mul3(dest, inverse)
  return {
    a: mapped[0] ?? 1,
    b: mapped[3] ?? 0,
    c: mapped[1] ?? 0,
    d: mapped[4] ?? 1,
    e: mapped[2] ?? 0,
    f: mapped[5] ?? 0,
  }
}

function drawTexturedTriangle(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  s0: Point,
  s1: Point,
  s2: Point,
  d0: Point,
  d1: Point,
  d2: Point,
) {
  const matrix = triangleTransform(s0, s1, s2, d0, d1, d2)
  if (!matrix) return
  const minX = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 2)
  const minY = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 2)
  const maxX = Math.min(source.width, Math.ceil(Math.max(s0.x, s1.x, s2.x)) + 2)
  const maxY = Math.min(source.height, Math.ceil(Math.max(s0.y, s1.y, s2.y)) + 2)
  const sw = maxX - minX
  const sh = maxY - minY
  if (sw < 1 || sh < 1) return

  context.save()
  context.beginPath()
  context.moveTo(d0.x, d0.y)
  context.lineTo(d1.x, d1.y)
  context.lineTo(d2.x, d2.y)
  context.closePath()
  context.clip()
  context.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)
  context.drawImage(source, minX, minY, sw, sh, minX, minY, sw, sh)
  context.restore()
}

/** Fast fallback when the homography cannot be solved: the corners' bounding box, scaled to the page. */
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
  highQuality(context)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
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

/**
 * Perspective warp onto a full-resolution A4 canvas. Destination cells are mapped through the
 * homography; each triangle is drawn with the browser's high-quality bilinear/bicubic sampler
 * so small Hebrew type is not smeared on a screen-sized canvas.
 */
async function warpCanvas(
  source: HTMLCanvasElement,
  corners: Corners,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const from = [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]
  const to = [corners.tl, corners.tr, corners.br, corners.bl]
  const map = homography(from, to)
  if (!map) return paintScaled(source, width, height, corners)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('לא ניתן ליישר את העמוד.')
  highQuality(context)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)

  const padX = 0.45
  const padY = 0.45
  for (let gy = 0; gy < WARP_GRID; gy += 1) {
    if (gy % 4 === 0) await nextFrame()
    const y0 = (gy / WARP_GRID) * height
    const y1 = ((gy + 1) / WARP_GRID) * height
    const dy0 = gy === 0 ? y0 : y0 - padY
    const dy1 = gy === WARP_GRID - 1 ? y1 : y1 + padY
    for (let gx = 0; gx < WARP_GRID; gx += 1) {
      const x0 = (gx / WARP_GRID) * width
      const x1 = ((gx + 1) / WARP_GRID) * width
      const dx0 = gx === 0 ? x0 : x0 - padX
      const dx1 = gx === WARP_GRID - 1 ? x1 : x1 + padX
      const d00 = { x: dx0, y: dy0 }
      const d10 = { x: dx1, y: dy0 }
      const d11 = { x: dx1, y: dy1 }
      const d01 = { x: dx0, y: dy1 }
      const s00 = mapHomography(map, d00.x, d00.y)
      const s10 = mapHomography(map, d10.x, d10.y)
      const s11 = mapHomography(map, d11.x, d11.y)
      const s01 = mapHomography(map, d01.x, d01.y)
      drawTexturedTriangle(context, source, s00, s10, s11, d00, d10, d11)
      drawTexturedTriangle(context, source, s00, s11, s01, d00, d11, d01)
    }
  }
  return canvas
}

/* ---------- Scan: illumination ÷ → luma curve → saturation → unsharp. No region masks. ---------- */

async function yieldBusy(clock: { last: number }) {
  if (performance.now() - clock.last < YIELD_MS) return
  await nextFrame()
  clock.last = performance.now()
}

function clamp255(value: number) {
  return value < 0 ? 0 : value > 255 ? 255 : value
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
 * blurred, then bilinearly sampled across the page. Floor at global 95th × 0.85
 * so a dark tile cannot collapse the lighting estimate toward its own content.
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

function sampleGridRaw(grid: Float32Array, x: number, y: number, width: number, height: number) {
  const fx = ((x + 0.5) / width) * (LIGHT_GRID - 1)
  const fy = ((y + 0.5) / height) * (LIGHT_GRID - 1)
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(LIGHT_GRID - 1, x0 + 1)
  const y1 = Math.min(LIGHT_GRID - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const a = grid[y0 * LIGHT_GRID + x0] ?? 0
  const b = grid[y0 * LIGHT_GRID + x1] ?? 0
  const c = grid[y1 * LIGHT_GRID + x0] ?? 0
  const d = grid[y1 * LIGHT_GRID + x1] ?? 0
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

function sampleGrid(grid: Float32Array, x: number, y: number, width: number, height: number) {
  return Math.max(1, sampleGridRaw(grid, x, y, width, height))
}

function flattenChannel(value: number, bg: number) {
  const flat = (value / bg) * FLAT_TARGET
  return flat < 0 ? 0 : flat > 255 ? 255 : flat
}

function scaleToLuma(r: number, g: number, b: number, fromL: number, toL: number): [number, number, number] {
  if (fromL < 0.5) return [toL, toL, toL]
  const scale = toL / fromL
  return [r * scale, g * scale, b * scale]
}

function boostSat(r: number, g: number, b: number, sat: number): [number, number, number] {
  const [hue, , value] = rgbToHsv(r, g, b)
  return hsvToRgb(hue, Math.min(1, sat * SAT_BOOST), value)
}

function smooth01(t: number) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/** Every pixel: `normC = clamp((C / bgC) * 255)`. Never skips or clears a region. */
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
 * Contrast stretch: shadows → deep black, print → solid ink, car midtones stay
 * continuous, paper snaps to white. Same path for every pixel — no region mask.
 */
function scanLuma(normL: number, sat: number) {
  let next: number
  if (normL < INK_HARD) {
    next = Math.floor((normL / INK_HARD) * SHADOW_TARGET)
  } else if (normL < MID_DARK) {
    next = SHADOW_TARGET + Math.floor(((normL - INK_HARD) / (MID_DARK - INK_HARD)) * (MID_DARK_TARGET - SHADOW_TARGET))
  } else if (normL <= PAPER_LUMA) {
    const t = smooth01((normL - MID_DARK) / (PAPER_LUMA - MID_DARK))
    next = MID_DARK_TARGET + t * (HIGHLIGHT_TARGET - MID_DARK_TARGET)
  } else if (sat < PAPER_SAT) {
    next = 255
  } else {
    const t = smooth01((normL - PAPER_LUMA) / (255 - PAPER_LUMA))
    next = HIGHLIGHT_TARGET + t * (255 - HIGHLIGHT_TARGET)
  }
  return clamp255(next)
}

/** Luma curve then 1.6× HSV saturation when S > 0.08. Every pixel is written. */
async function applyScanTone(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clock: { last: number },
) {
  const count = width * height
  for (let p = 0; p < count; p += 1) {
    if (p % (width * 32) === 0) await yieldBusy(clock)
    const i = p * 4
    const red = data[i] ?? 0
    const green = data[i + 1] ?? 0
    const blue = data[i + 2] ?? 0
    const normL = pixelLuma(red, green, blue)
    const sat = pixelSat(red, green, blue)
    const rgb = scaleToLuma(red, green, blue, normL, scanLuma(normL, sat))
    const out = sat > SAT_MIN ? boostSat(rgb[0], rgb[1], rgb[2], sat) : rgb
    data[i] = clamp255(out[0])
    data[i + 1] = clamp255(out[1])
    data[i + 2] = clamp255(out[2])
    data[i + 3] = 255
  }
}

/** Unsharp mask: skip |L − blur| < 3, boost 1.25, clamp 0–255. */
function sharpenLuma(image: ImageData) {
  const { data, width, height } = image
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
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
      if (Math.abs(delta) < SHARPEN_NOISE) continue
      const sharp = clamp255(center + SHARPEN_AMOUNT * delta)
      const lift = center > 1 ? sharp / center : 1
      const i = p * 4
      data[i] = clamp255((data[i] ?? 0) * lift)
      data[i + 1] = clamp255((data[i + 1] ?? 0) * lift)
      data[i + 2] = clamp255((data[i + 2] ?? 0) * lift)
    }
  }
}

function desaturatePixels(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const tone = Math.round(pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0))
    data[i] = tone
    data[i + 1] = tone
    data[i + 2] = tone
  }
}

async function applyMagicColor(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  await whiteBalanceRgb(data, width, height, clock)
  await applyScanTone(data, width, height, clock)
  sharpenLuma(image)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  await whiteBalanceRgb(data, width, height, clock)
  await applyScanTone(data, width, height, clock)
  sharpenLuma(image)
  desaturatePixels(data)
  await yieldBusy(clock)
}

export function desaturateCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  desaturatePixels(image.data)
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
): Promise<HTMLCanvasElement> {
  const fitted = a4Size(outputSize(corners), isLandscape(corners))
  const longEdge = Math.max(fitted.width, fitted.height, 1)
  const scale = Math.min(MAX_EDGE / longEdge, Math.min(MAX_UPSCALE, Math.max(1, MIN_EDGE / longEdge)))
  const width = Math.max(32, Math.round(fitted.width * scale))
  const height = Math.max(32, Math.round(fitted.height * scale))
  const copy = drawSource(image)
  try {
    return await warpCanvas(copy, insetCorners(corners), width, height)
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
  highQuality(context)
  context.drawImage(source, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  await run(pixels)
  context.putImageData(pixels, 0, 0)
  return canvas
}

/** Magic Color: white paper, crisp text, continuous-tone photos. Never 1-bit, never a region mask. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyMagicColor)
}

/** High-contrast grayscale of the same continuous-tone page (no binary threshold). */
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
  const context = canvas.getContext('2d')
  if (context) {
    highQuality(context)
    context.drawImage(source, 0, 0)
  }
  return canvas
}
