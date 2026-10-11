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

/** Native-scale illumination blur (two box passes ≈ Gaussian). Never downsample the page. */
const LIGHT_RADIUS = 40
const LIGHT_PASSES = 2
const FLAT_EPS = 1
const PAPER_LO = 215
const INK_HI = 90
const INK_BLACK = 10
const MID_GAMMA = 1.1
const SAT_BOOST = 1.35
const SHARPEN_AMOUNT = 0.5
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

/* ---------- Frequency-separation Magic Color (full native resolution) ---------- */

function smoothstep(t: number) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  return x * x * (3 - 2 * x)
}

/**
 * Global S-curve after flatten: ink to #0A0A0A, paper rolled to #FFFFFF,
 * midtones (photos, stamps, charts) kept with a gentle gamma 1.1 lift.
 */
function magicCurve(luma: number) {
  if (luma < INK_HI) {
    const t = luma / INK_HI
    return INK_BLACK + (INK_HI - INK_BLACK) * t ** 1.35
  }
  if (luma > PAPER_LO) {
    return luma + (255 - luma) * smoothstep((luma - PAPER_LO) / 22)
  }
  const n = (luma - INK_HI) / (PAPER_LO - INK_HI)
  return INK_HI + (PAPER_LO - INK_HI) * n ** (1 / MID_GAMMA)
}

function buildMagicLut() {
  const lut = new Float32Array(256)
  for (let i = 0; i < 256; i += 1) lut[i] = magicCurve(i)
  return lut
}

const MAGIC_LUT = buildMagicLut()

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

/** Sliding-window separable box blur on a full-resolution luminance plane. */
async function boxBlurChannel(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
  clock: { last: number },
): Promise<Float32Array> {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const span = radius * 2 + 1

  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    const row = y * width
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) {
      sum += src[row + Math.min(width - 1, Math.max(0, k))] ?? 0
    }
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / span
      const addX = Math.min(width - 1, x + radius + 1)
      const remX = Math.max(0, x - radius)
      sum += (src[row + addX] ?? 0) - (src[row + remX] ?? 0)
    }
  }

  for (let x = 0; x < width; x += 1) {
    if (x % 48 === 0) await yieldBusy(clock)
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) {
      const y = Math.min(height - 1, Math.max(0, k))
      sum += tmp[y * width + x] ?? 0
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / span
      const addY = Math.min(height - 1, y + radius + 1)
      const remY = Math.max(0, y - radius)
      sum += (tmp[addY * width + x] ?? 0) - (tmp[remY * width + x] ?? 0)
    }
  }
  return out
}

/** Low-frequency paper lighting at native resolution — no shrink/stretch. */
async function illuminationSurface(luma: Float32Array, width: number, height: number, clock: { last: number }) {
  const radius = Math.max(1, Math.min(LIGHT_RADIUS, Math.floor((Math.min(width, height) - 1) / 2)))
  let background = luma
  for (let pass = 0; pass < LIGHT_PASSES; pass += 1) {
    background = await boxBlurChannel(background, width, height, radius, clock)
  }
  return background
}

/**
 * HighFreq = Source / (Background + ε) * 255, then the Magic Color S-curve.
 * Chrominance ratios (R/L, G/L, B/L) are kept; saturation is lifted 1.35×
 * except on near-white paper, which rolls to #FFFFFF.
 */
async function applyToneAndColor(
  data: Uint8ClampedArray,
  luma: Float32Array,
  background: Float32Array,
  width: number,
  height: number,
  clock: { last: number },
) {
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const red = data[i] ?? 0
      const green = data[i + 1] ?? 0
      const blue = data[i + 2] ?? 0
      const srcL = luma[p] ?? 0
      const flat = Math.min(255, (srcL / ((background[p] ?? 0) + FLAT_EPS)) * 255)
      const next = MAGIC_LUT[flat | 0] ?? flat

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

      const paperMix = next > PAPER_LO ? smoothstep((next - PAPER_LO) / (255 - PAPER_LO)) : 0
      if (paperMix > 0) {
        const keep = 1 - paperMix
        outR = next + (outR - next) * keep
        outG = next + (outG - next) * keep
        outB = next + (outB - next) * keep
      }

      const sat = 1 + (SAT_BOOST - 1) * (1 - paperMix)
      const mid = 0.299 * outR + 0.587 * outG + 0.114 * outB
      data[i] = Math.min(255, Math.max(0, mid + (outR - mid) * sat))
      data[i + 1] = Math.min(255, Math.max(0, mid + (outG - mid) * sat))
      data[i + 2] = Math.min(255, Math.max(0, mid + (outB - mid) * sat))
      data[i + 3] = 255
    }
  }
}

/** 3×3 unsharp mask on luminance so text, tables, and barcodes stay razor-sharp. */
function sharpen3x3(image: ImageData, amount: number) {
  const { data, width, height } = image
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x
      const center = gray[p] ?? 0
      const lap =
        center * 4 -
        (gray[p - 1] ?? 0) -
        (gray[p + 1] ?? 0) -
        (gray[p - width] ?? 0) -
        (gray[p + width] ?? 0)
      const next = center + lap * amount
      if (Math.abs(next - center) < 1.2) continue
      const lift = center > 1 ? next / center : 1
      const i = p * 4
      data[i] = Math.min(255, Math.max(0, (data[i] ?? 0) * lift))
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] ?? 0) * lift))
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] ?? 0) * lift))
    }
  }
}

async function applyMagicColor(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const luma = extractLuma(data, width * height)
  const background = await illuminationSurface(luma, width, height, clock)
  await applyToneAndColor(data, luma, background, width, height, clock)
  sharpen3x3(image, SHARPEN_AMOUNT)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  const luma = extractLuma(data, width * height)
  const background = await illuminationSurface(luma, width, height, clock)
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    let p = y * width
    let i = p * 4
    for (let x = 0; x < width; x += 1, p += 1, i += 4) {
      const flat = Math.min(255, ((luma[p] ?? 0) / ((background[p] ?? 0) + FLAT_EPS)) * 255)
      const ink = flat < BW_THRESHOLD ? 0 : 255
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

/** Fast adaptive black and white from the same native-resolution illumination map. */
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
