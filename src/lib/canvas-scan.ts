import type { Corners, FilterMode, Point } from '../types'
import { distance } from './geometry'
import { nextFrame } from './image'

/** ~200 DPI A4. Full 300 DPI (3508) froze phones; 1600 made small Hebrew text mushy. */
const WARP_LONG = 2200
const WARP_SOURCE = 3000

function a4Page(landscape: boolean): { width: number; height: number } {
  const short = Math.round(WARP_LONG / Math.SQRT2)
  return landscape ? { width: WARP_LONG, height: short } : { width: short, height: WARP_LONG }
}

/**
 * Landscape when the quad is wider than tall, portrait otherwise. Opposite sides are averaged,
 * so perspective (a near edge longer than the far one) cannot flip the decision.
 */
function isLandscape(corners: Corners): boolean {
  const width = (distance(corners.tl, corners.tr) + distance(corners.bl, corners.br)) / 2
  const height = (distance(corners.tl, corners.bl) + distance(corners.tr, corners.br)) / 2
  return width > height * 1.15
}

/** Uniform mathematical scan: flat-field → luma curve → saturation → unsharp. No region masks. */
const LIGHT_GRID = 16
const LIGHT_PERCENTILE = 0.95
const LIGHT_BLUR_PASSES = 4
const LIGHT_FLOOR = 0.74
const FLAT_TARGET = 255
const SAT_BOOST = 1.6
const SAT_MIN = 0.08
const PAPER_LUMA = 215
const PAPER_SAT = 0.1
const INK_SAT = 0.12
const INK_HARD = 90
const MID_DARK = 175
const SHADOW_TARGET = 20
const MID_DARK_TARGET = 100
const INK_FAINT_GAIN = 70
const HIGHLIGHT_TARGET = 220
const SHARPEN_AMOUNT = 1.7
const SHARPEN_NOISE = 2
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
    if (!pivotRow || !colRow || Math.abs(pivotRow[col] ?? 0) < 1e-10) return null
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

function similarity(points: Point[]): { scale: number; cx: number; cy: number } | null {
  const n = points.length
  if (n < 4) return null
  let cx = 0
  let cy = 0
  for (const point of points) {
    cx += point.x
    cy += point.y
  }
  cx /= n
  cy /= n
  let mean = 0
  for (const point of points) mean += Math.hypot(point.x - cx, point.y - cy)
  mean /= n
  if (mean < 1e-6) return null
  return { scale: Math.SQRT2 / mean, cx, cy }
}

function applySimilarity(point: Point, t: { scale: number; cx: number; cy: number }): Point {
  return { x: (point.x - t.cx) * t.scale, y: (point.y - t.cy) * t.scale }
}

function homography(from: Point[], to: Point[]): number[] | null {
  const srcT = similarity(from)
  const dstT = similarity(to)
  if (!srcT || !dstT) return null
  const matrix: number[][] = []
  const values: number[] = []
  for (let i = 0; i < 4; i += 1) {
    const src = from[i]
    const dst = to[i]
    if (!src || !dst) return null
    const s = applySimilarity(src, srcT)
    const d = applySimilarity(dst, dstT)
    matrix.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y])
    values.push(d.x)
    matrix.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y])
    values.push(d.y)
  }
  const solved = solveLinear(matrix, values)
  if (!solved) return null
  const hn = [...solved, 1]
  const Hn = [
    [hn[0] ?? 0, hn[1] ?? 0, hn[2] ?? 0],
    [hn[3] ?? 0, hn[4] ?? 0, hn[5] ?? 0],
    [hn[6] ?? 0, hn[7] ?? 0, hn[8] ?? 1],
  ]
  const Tsrc = [
    [srcT.scale, 0, -srcT.scale * srcT.cx],
    [0, srcT.scale, -srcT.scale * srcT.cy],
    [0, 0, 1],
  ]
  const TdstInv = [
    [1 / dstT.scale, 0, dstT.cx],
    [0, 1 / dstT.scale, dstT.cy],
    [0, 0, 1],
  ]
  const mul = (a: number[][], b: number[][]) =>
    a.map((row) =>
      [0, 1, 2].map((c) => (row[0] ?? 0) * (b[0]?.[c] ?? 0) + (row[1] ?? 0) * (b[1]?.[c] ?? 0) + (row[2] ?? 0) * (b[2]?.[c] ?? 0)),
    )
  const H = mul(TdstInv, mul(Hn, Tsrc))
  const row0 = H[0]
  const row1 = H[1]
  const row2 = H[2]
  if (!row0 || !row1 || !row2) return null
  const w = row2[2] ?? 1
  const safe = Math.abs(w) < 1e-12 ? 1 : w
  return [
    (row0[0] ?? 0) / safe,
    (row0[1] ?? 0) / safe,
    (row0[2] ?? 0) / safe,
    (row1[0] ?? 0) / safe,
    (row1[1] ?? 0) / safe,
    (row1[2] ?? 0) / safe,
    (row2[0] ?? 0) / safe,
    (row2[1] ?? 0) / safe,
    1,
  ]
}

function mapHomography(h: number[], x: number, y: number): Point {
  const w = (h[6] ?? 0) * x + (h[7] ?? 0) * y + (h[8] ?? 1)
  const safe = Math.abs(w) < 1e-6 ? 1e-6 : w
  return {
    x: ((h[0] ?? 1) * x + (h[1] ?? 0) * y + (h[2] ?? 0)) / safe,
    y: ((h[3] ?? 0) * x + (h[4] ?? 1) * y + (h[5] ?? 0)) / safe,
  }
}

function sampleBilinear(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  offset: number,
) {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) {
    out[offset] = 255
    out[offset + 1] = 255
    out[offset + 2] = 255
    out[offset + 3] = 255
    return
  }
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = i00 + 4
  const i01 = i00 + width * 4
  const i11 = i01 + 4
  for (let c = 0; c < 3; c += 1) {
    const v00 = data[i00 + c] ?? 255
    const v10 = data[i10 + c] ?? 255
    const v01 = data[i01 + c] ?? 255
    const v11 = data[i11 + c] ?? 255
    const top = v00 + (v10 - v00) * fx
    const bottom = v01 + (v11 - v01) * fx
    out[offset + c] = top + (bottom - top) * fy
  }
  out[offset + 3] = 255
}

function scaleSource(source: HTMLCanvasElement, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height, 1))
  if (scale >= 0.999) return { canvas: source, scale: 1 }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return { canvas: source, scale: 1 }
  highQuality(context)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return { canvas, scale }
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
 * Map the paper trapezoid onto a flat A4. Inverse homography + bilinear sample.
 * Stretching the shorter far edge is what lifts the page to face the camera.
 * No OpenCV — loading WASM here froze the phone after shutter.
 */
async function warpCanvas(
  source: HTMLCanvasElement,
  corners: Corners,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> {
  const shrunk = scaleSource(source, WARP_SOURCE)
  const quad: Corners = {
    tl: { x: corners.tl.x * shrunk.scale, y: corners.tl.y * shrunk.scale },
    tr: { x: corners.tr.x * shrunk.scale, y: corners.tr.y * shrunk.scale },
    br: { x: corners.br.x * shrunk.scale, y: corners.br.y * shrunk.scale },
    bl: { x: corners.bl.x * shrunk.scale, y: corners.bl.y * shrunk.scale },
  }
  const map = homography(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    [quad.tl, quad.tr, quad.br, quad.bl],
  )
  if (!map) return paintScaled(source, width, height, corners)

  const src = shrunk.canvas
  const srcCtx = src.getContext('2d', { willReadFrequently: true })
  if (!srcCtx) return paintScaled(source, width, height, corners)
  const srcImage = srcCtx.getImageData(0, 0, src.width, src.height)
  const srcData = srcImage.data
  const sw = src.width
  const sh = src.height

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('לא ניתן ליישר את העמוד.')
  const dest = context.createImageData(width, height)
  const out = dest.data

  for (let y = 0; y < height; y += 1) {
    if (y % 40 === 0) await nextFrame()
    for (let x = 0; x < width; x += 1) {
      const sample = mapHomography(map, x + 0.5, y + 0.5)
      sampleBilinear(srcData, sw, sh, sample.x, sample.y, out, (y * width + x) * 4)
    }
  }
  context.putImageData(dest, 0, 0)
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
 * Contrast stretch: gray print (L < 175, S < 0.12) → toward #151515; colored
 * midtones stay continuous; paper snaps to white. No region mask.
 */
function scanLuma(normL: number, sat: number) {
  let next: number
  if (normL < MID_DARK && sat < INK_SAT) {
    next = Math.floor(Math.pow(Math.max(0, normL) / MID_DARK, 1.5) * INK_FAINT_GAIN)
  } else if (normL < INK_HARD) {
    next = Math.floor((normL / INK_HARD) * SHADOW_TARGET)
  } else if (normL < MID_DARK) {
    const t = (normL - INK_HARD) / (MID_DARK - INK_HARD)
    next = Math.floor(SHADOW_TARGET + t * (MID_DARK_TARGET - SHADOW_TARGET))
  } else if (normL <= PAPER_LUMA) {
    const t = (normL - MID_DARK) / (PAPER_LUMA - MID_DARK)
    const start = sat < INK_SAT ? INK_FAINT_GAIN : MID_DARK_TARGET
    next = start + t * (HIGHLIGHT_TARGET - start)
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

/** Unsharp mask: skip |L − blur| < 2, boost 1.7 so print stays crisp after the warp. */
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

export async function straightenCanvas(
  image: CanvasImageSource,
  corners: Corners,
): Promise<HTMLCanvasElement> {
  const copy = drawSource(image)
  const { width, height } = a4Page(isLandscape(corners))
  try {
    return await warpCanvas(copy, corners, width, height)
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
