import type { Corners, FilterMode, Point } from '../types'
import { distance, orderCorners } from './geometry'
import { nextFrame } from './image'

/** 125% of the 3234 page that looked right when the PDF was zoomed to 125%. */
const WARP_LONG = 4042
const WARP_SOURCE = 4600

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

/** Uniform mathematical scan: illumination ÷ → saturation → despeckle → unsharp. No region masks. */
const BG_DOWN = 8
const BG_BLUR_RADIUS = 18
const BG_BLUR_PASSES = 3
const PAPER_RATIO = 0.82
const INK_RATIO = 0.15
const PAPER_SAT = 0.2
const PAPER_LUMA = 232
const SAT_BOOST = 1.1
const SAT_MIN = 0.08
const SHARPEN_AMOUNT = 1.08
const SHARPEN_NOISE = 10
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

function cubicCatmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function sampleChannel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, channel: number) {
  const xi = x < 0 ? 0 : x > width - 1 ? width - 1 : x
  const yi = y < 0 ? 0 : y > height - 1 ? height - 1 : y
  return data[(yi * width + xi) * 4 + channel] ?? 255
}

/** Catmull-Rom bicubic — keeps the stretched far edge sharp when the page is lifted. */
function sampleBicubic(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  out: Uint8ClampedArray,
  offset: number,
) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  for (let c = 0; c < 3; c += 1) {
    const rows = [0, 0, 0, 0]
    for (let dy = -1; dy <= 2; dy += 1) {
      const yy = y0 + dy
      rows[dy + 1] = cubicCatmull(
        sampleChannel(data, width, height, x0 - 1, yy, c),
        sampleChannel(data, width, height, x0, yy, c),
        sampleChannel(data, width, height, x0 + 1, yy, c),
        sampleChannel(data, width, height, x0 + 2, yy, c),
        fx,
      )
    }
    out[offset + c] = clamp255(cubicCatmull(rows[0] ?? 0, rows[1] ?? 0, rows[2] ?? 0, rows[3] ?? 0, fy))
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
 * Map the paper trapezoid onto a flat A4. Inverse homography + bicubic sample.
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
  const ordered = (() => {
    try {
      return orderCorners([quad.tl, quad.tr, quad.br, quad.bl])
    } catch {
      return quad
    }
  })()
  // Inverse homography: dest A4 rectangle → source quad (same math as cv.getPerspectiveTransform + warpPerspective).
  const map = homography(
    [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ],
    [ordered.tl, ordered.tr, ordered.br, ordered.bl],
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
    if (y % 16 === 0) await nextFrame()
    for (let x = 0; x < width; x += 1) {
      const sample = mapHomography(map, x + 0.5, y + 0.5)
      sampleBicubic(srcData, sw, sh, sample.x, sample.y, out, (y * width + x) * 4)
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

function boostSat(r: number, g: number, b: number, sat: number): [number, number, number] {
  const [hue, , value] = rgbToHsv(r, g, b)
  return hsvToRgb(hue, Math.min(1, sat * SAT_BOOST), value)
}

function boxBlurAxis(
  src: Float32Array,
  dest: Float32Array,
  length: number,
  stride: number,
  count: number,
  step: number,
  radius: number,
) {
  for (let line = 0; line < count; line += 1) {
    const origin = line * step
    let left = 0
    let right = -1
    let sum = 0
    let n = 0
    for (let i = 0; i < length; i += 1) {
      const newRight = Math.min(length - 1, i + radius)
      const newLeft = Math.max(0, i - radius)
      while (right < newRight) {
        right += 1
        sum += src[origin + right * stride] ?? 0
        n += 1
      }
      while (left < newLeft) {
        sum -= src[origin + left * stride] ?? 0
        n -= 1
        left += 1
      }
      dest[origin + i * stride] = n > 0 ? sum / n : 1
    }
  }
}

function boxBlurGray(gray: Float32Array, width: number, height: number, radius: number) {
  const temp = new Float32Array(width * height)
  boxBlurAxis(gray, temp, width, 1, height, width, radius)
  boxBlurAxis(temp, gray, height, width, width, 1, radius)
  return gray
}

function dilateGray3x3(gray: Float32Array, width: number, height: number) {
  const next = new Float32Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let peak = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const value = gray[row + xx] ?? 0
          if (value > peak) peak = value
        }
      }
      next[y * width + x] = peak
    }
  }
  return next
}

function sampleBlurred(gray: Float32Array, sw: number, sh: number, x: number, y: number, width: number, height: number) {
  const fx = ((x + 0.5) / width) * (sw - 1)
  const fy = ((y + 0.5) / height) * (sh - 1)
  const x0 = fx | 0
  const y0 = fy | 0
  const x1 = Math.min(sw - 1, x0 + 1)
  const y1 = Math.min(sh - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const a = gray[y0 * sw + x0] ?? 1
  const b = gray[y0 * sw + x1] ?? 1
  const c = gray[y1 * sw + x0] ?? 1
  const d = gray[y1 * sw + x1] ?? 1
  return Math.max(1, (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty)
}

/**
 * CamScanner-style illumination: heavily blurred paper field, then divide.
 * Soft shadows follow the field (ratio ≈ 1 → white); ink and photos stay below 0.82.
 */
async function whiteBalanceRgb(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clock: { last: number },
) {
  const sw = Math.max(12, Math.round(width / BG_DOWN))
  const sh = Math.max(12, Math.round(height / BG_DOWN))
  let field = new Float32Array(sw * sh)
  for (let y = 0; y < sh; y += 1) {
    const y0 = Math.floor((y * height) / sh)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / sh))
    for (let x = 0; x < sw; x += 1) {
      const x0 = Math.floor((x * width) / sw)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / sw))
      let peak = 0
      for (let yy = y0; yy < y1; yy += 1) {
        const row = yy * width
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (row + xx) * 4
          const luma = pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
          if (luma > peak) peak = luma
        }
      }
      field[y * sw + x] = peak
    }
    if (y % 4 === 0) await yieldBusy(clock)
  }
  field = dilateGray3x3(dilateGray3x3(field, sw, sh), sw, sh)
  const radius = Math.max(2, Math.min(BG_BLUR_RADIUS, Math.floor(Math.min(sw, sh) / 2) - 1))
  for (let pass = 0; pass < BG_BLUR_PASSES; pass += 1) {
    boxBlurGray(field, sw, sh, radius)
    await yieldBusy(clock)
  }
  const span = PAPER_RATIO - INK_RATIO
  for (let y = 0; y < height; y += 1) {
    if (y % 48 === 0) await yieldBusy(clock)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const red = data[i] ?? 0
      const green = data[i + 1] ?? 0
      const blue = data[i + 2] ?? 0
      const luma = pixelLuma(red, green, blue)
      const sat = pixelSat(red, green, blue)
      const bg = sampleBlurred(field, sw, sh, x, y, width, height)
      const ratio = luma / Math.max(bg, 1)
      if (ratio > PAPER_RATIO && sat < PAPER_SAT) {
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
      } else if (ratio > PAPER_RATIO) {
        data[i] = red
        data[i + 1] = green
        data[i + 2] = blue
      } else {
        const scale = Math.max(0, (ratio - INK_RATIO) / span) * 0.9 + 0.1
        data[i] = clamp255(Math.floor(red * scale))
        data[i + 1] = clamp255(Math.floor(green * scale))
        data[i + 2] = clamp255(Math.floor(blue * scale))
      }
      data[i + 3] = 255
    }
  }
}

function clampPaperWhite(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const red = data[i] ?? 0
    const green = data[i + 1] ?? 0
    const blue = data[i + 2] ?? 0
    if (pixelLuma(red, green, blue) >= PAPER_LUMA && pixelSat(red, green, blue) < PAPER_SAT) {
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
    }
  }
}

/** Mild 1.1× saturation on color only. No second luma curve — that posterized photos and ate fine print. */
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
    const sat = pixelSat(red, green, blue)
    const out = sat > SAT_MIN ? boostSat(red, green, blue, sat) : [red, green, blue]
    data[i] = clamp255(out[0])
    data[i + 1] = clamp255(out[1])
    data[i + 2] = clamp255(out[2])
    data[i + 3] = 255
  }
}

/** One mild unsharp after the tone curve. Triple-sharpening turned paper grain into sparkle. */
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
      if (center >= PAPER_LUMA || Math.abs(delta) < SHARPEN_NOISE) continue
      const sharp = clamp255(center + SHARPEN_AMOUNT * delta)
      const lift = center > 1 ? sharp / center : 1
      const i = p * 4
      data[i] = clamp255((data[i] ?? 0) * lift)
      data[i + 1] = clamp255((data[i + 1] ?? 0) * lift)
      data[i + 2] = clamp255((data[i + 2] ?? 0) * lift)
    }
  }
}

/** Isolated dark specks (dust / sensor noise), not strokes of letters or barcode modules. */
async function despeckle(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  clock: { last: number },
) {
  const n = width * height
  const gray = new Uint8Array(n)
  for (let p = 0, i = 0; p < n; p += 1, i += 4) {
    gray[p] = pixelLuma(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) | 0
  }
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const cells = new Int32Array(4)
  const yieldEvery = Math.max(width * 20, 1)
  for (let start = 0; start < n; start += 1) {
    if (start % yieldEvery === 0) await yieldBusy(clock)
    if (seen[start] || (gray[start] ?? 255) >= 128) continue
    let top = 0
    stack[0] = start
    top = 1
    seen[start] = 1
    let count = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      if (count < 4) cells[count] = index
      count += 1
      const x = index % width
      const y = (index - x) / width
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x > 0) {
        const next = index - 1
        if (!seen[next] && (gray[next] ?? 255) < 128) {
          seen[next] = 1
          stack[top] = next
          top += 1
        }
      }
      if (x + 1 < width) {
        const next = index + 1
        if (!seen[next] && (gray[next] ?? 255) < 128) {
          seen[next] = 1
          stack[top] = next
          top += 1
        }
      }
      if (y > 0) {
        const next = index - width
        if (!seen[next] && (gray[next] ?? 255) < 128) {
          seen[next] = 1
          stack[top] = next
          top += 1
        }
      }
      if (y + 1 < height) {
        const next = index + width
        if (!seen[next] && (gray[next] ?? 255) < 128) {
          seen[next] = 1
          stack[top] = next
          top += 1
        }
      }
    }
    if (count > 3 || maxX - minX > 1 || maxY - minY > 1) continue
    for (let c = 0; c < count; c += 1) {
      const i = (cells[c] ?? 0) * 4
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
    }
  }
}

function cropCanvas(source: HTMLCanvasElement, left: number, top: number, right: number, bottom: number) {
  const cropW = right - left
  const cropH = bottom - top
  if (cropW < 64 || cropH < 64) return source
  if (left <= 0 && top <= 0 && right >= source.width && bottom >= source.height) return source
  const canvas = document.createElement('canvas')
  canvas.width = cropW
  canvas.height = cropH
  const next = canvas.getContext('2d')
  if (!next) return source
  highQuality(next)
  next.drawImage(source, left, top, cropW, cropH, 0, 0, cropW, cropH)
  return canvas
}

function otsuThreshold(gray: Uint8Array) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i += 1) hist[gray[i] ?? 0] += 1
  const total = gray.length
  let sumAll = 0
  for (let level = 0; level < 256; level += 1) sumAll += level * (hist[level] ?? 0)
  let weightBack = 0
  let sumBack = 0
  let best = -1
  let threshold = 170
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

function sampleLine(
  mask: Uint8Array,
  luma: Uint8Array,
  chroma: Uint8Array,
  width: number,
  height: number,
  axis: 'row' | 'col',
  index: number,
) {
  const span = axis === 'row' ? width : height
  let paper = 0
  let dark = 0
  let yellow = 0
  let sum = 0
  let midPaper = 0
  const mid0 = (span * 0.22) | 0
  const mid1 = (span * 0.78) | 0
  for (let k = 0; k < span; k += 1) {
    const p = axis === 'row' ? index * width + k : k * width + index
    const tone = luma[p] ?? 0
    const sat = chroma[p] ?? 0
    sum += tone
    if (tone < 70) dark += 1
    if (tone > 160 && sat > 28) yellow += 1
    if (mask[p]) {
      paper += 1
      if (k >= mid0 && k < mid1) midPaper += 1
    }
  }
  const midN = Math.max(1, mid1 - mid0)
  return {
    paper: paper / span,
    dark: dark / span,
    yellow: yellow / span,
    mean: sum / span,
    midPaper: midPaper / midN,
  }
}

/** Axis-aligned crop to the white page. Beige desk stays out; blue letterheads stay in. */
function trimToPaper(source: HTMLCanvasElement): HTMLCanvasElement {
  const { width, height } = source
  const maxEdge = 420
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  const sw = Math.max(1, Math.round(width * scale))
  const sh = Math.max(1, Math.round(height * scale))
  const sample = document.createElement('canvas')
  sample.width = sw
  sample.height = sh
  const context = sample.getContext('2d', { willReadFrequently: true })
  if (!context) return source
  context.imageSmoothingEnabled = false
  context.drawImage(source, 0, 0, sw, sh)
  const data = context.getImageData(0, 0, sw, sh).data
  const gray = new Uint8Array(sw * sh)
  const chroma = new Uint8Array(sw * sh)
  const mask = new Uint8Array(sw * sh)
  for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const tone = pixelLuma(r, g, b) | 0
    gray[p] = tone
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    chroma[p] = sat
    if (tone > 148 && sat < 38) mask[p] = 1
  }
  const threshold = Math.min(185, Math.max(148, otsuThreshold(gray)))
  for (let p = 0; p < mask.length; p += 1) {
    if ((gray[p] ?? 0) <= threshold) mask[p] = 0
  }
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  let bestCount = 0
  let best = { minX: 0, minY: 0, maxX: sw - 1, maxY: sh - 1 }
  for (let start = 0; start < mask.length; start += 1) {
    if (seen[start] || !mask[start]) continue
    let top = 0
    stack[0] = start
    top = 1
    seen[start] = 1
    let count = 0
    let minX = sw
    let minY = sh
    let maxX = 0
    let maxY = 0
    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      count += 1
      const x = index % sw
      const y = (index - x) / sw
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (x > 0 && !seen[index - 1] && mask[index - 1]) {
        seen[index - 1] = 1
        stack[top] = index - 1
        top += 1
      }
      if (x + 1 < sw && !seen[index + 1] && mask[index + 1]) {
        seen[index + 1] = 1
        stack[top] = index + 1
        top += 1
      }
      if (y > 0 && !seen[index - sw] && mask[index - sw]) {
        seen[index - sw] = 1
        stack[top] = index - sw
        top += 1
      }
      if (y + 1 < sh && !seen[index + sw] && mask[index + sw]) {
        seen[index + sw] = 1
        stack[top] = index + sw
        top += 1
      }
    }
    if (count > bestCount) {
      bestCount = count
      best = { minX, minY, maxX, maxY }
    }
  }
  const linePage = (axis: 'row' | 'col', index: number) => {
    const stats = sampleLine(mask, gray, chroma, sw, sh, axis, index)
    return stats.paper > 0.3 && stats.dark < 0.22 && stats.yellow < 0.28
  }
  const lineWeak = (axis: 'row' | 'col', index: number) => {
    const stats = sampleLine(mask, gray, chroma, sw, sh, axis, index)
    if (stats.midPaper > 0.48) return false
    return stats.paper < 0.4 && (stats.dark > 0.12 || stats.yellow > 0.25 || stats.paper < 0.22)
  }
  let left = best.minX
  let right = best.maxX
  let top = best.minY
  let bottom = best.maxY
  while (left > 0 && linePage('col', left - 1)) left -= 1
  while (right + 1 < sw && linePage('col', right + 1)) right += 1
  while (top > 0 && linePage('row', top - 1)) top -= 1
  while (bottom + 1 < sh && linePage('row', bottom + 1)) bottom += 1
  const maxX = (sw * 0.22) | 0
  const maxY = (sh * 0.12) | 0
  while (left < maxX && left < right && lineWeak('col', left)) left += 1
  while (right > sw - 1 - maxX && right > left && lineWeak('col', right)) right -= 1
  while (top < maxY && top < bottom && lineWeak('row', top)) top += 1
  while (bottom > sh - 1 - maxY && bottom > top && lineWeak('row', bottom)) bottom -= 1
  sample.width = 0
  sample.height = 0
  if (bestCount < gray.length * 0.16) return source
  const inv = 1 / scale
  const padX = 2
  const padY = 2
  const cropL = Math.max(0, Math.floor(left * inv) - padX)
  const cropT = Math.max(0, Math.floor(top * inv) - padY)
  const cropR = Math.min(width, Math.ceil((right + 1) * inv) + padX)
  const cropB = Math.min(height, Math.ceil((bottom + 1) * inv) + padY)
  if (cropR - cropL < width * 0.28 || cropB - cropT < height * 0.28) return source
  if (cropL <= 6 && cropT <= 6 && cropR >= width - 6 && cropB >= height - 6) return source
  return cropCanvas(source, cropL, cropT, cropR, cropB)
}

function edgeIsBackdrop(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  axis: 'row' | 'col',
  index: number,
  dropYellow: boolean,
) {
  const span = axis === 'row' ? width : height
  const mid0 = (span * 0.22) | 0
  const mid1 = (span * 0.78) | 0
  let dark = 0
  let paper = 0
  let yellow = 0
  let midPaper = 0
  let sum = 0
  for (let k = 0; k < span; k += 1) {
    const i = axis === 'row' ? (index * width + k) * 4 : (k * width + index) * 4
    const r = data[i] ?? 0
    const g = data[i + 1] ?? 0
    const b = data[i + 2] ?? 0
    const luma = pixelLuma(r, g, b)
    const sat = Math.max(r, g, b) - Math.min(r, g, b)
    sum += luma
    if (luma < 70) dark += 1
    if (luma > 160 && sat > 28) yellow += 1
    if (luma > 200 && sat < 22) {
      paper += 1
      if (k >= mid0 && k < mid1) midPaper += 1
    } else if (!dropYellow && luma > 200 && k >= mid0 && k < mid1) {
      midPaper += 1
    }
  }
  if (midPaper > (mid1 - mid0) * 0.48) return false
  if (paper < span * 0.12 && (sum / span < 80 || dark > span * 0.4)) return true
  if (!dropYellow) return false
  return paper < span * 0.4 && (dark > span * 0.12 || yellow > span * 0.25 || paper < span * 0.22)
}

function interiorIsWhite(data: Uint8ClampedArray, width: number, height: number) {
  const x0 = (width * 0.25) | 0
  const x1 = (width * 0.75) | 0
  const y0 = (height * 0.25) | 0
  const y1 = (height * 0.75) | 0
  let sat = 0
  let n = 0
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * width + x) * 4
      const r = data[i] ?? 0
      const g = data[i + 1] ?? 0
      const b = data[i + 2] ?? 0
      if (pixelLuma(r, g, b) < 200) continue
      sat += Math.max(r, g, b) - Math.min(r, g, b)
      n += 1
    }
  }
  return n > 40 && sat / n < 16
}

/** Drop keyboard / beige-desk strips. Sides first so a header is not sliced off with the bezel. */
function trimDarkMargins(source: HTMLCanvasElement): HTMLCanvasElement {
  const context = source.getContext('2d', { willReadFrequently: true })
  if (!context) return source
  const { width, height } = source
  const image = context.getImageData(0, 0, width, height)
  const data = image.data
  const dropYellow = interiorIsWhite(data, width, height)
  const maxY = Math.floor(height * 0.1)
  const maxX = Math.floor(width * 0.2)
  let top = 0
  let bottom = height
  let left = 0
  let right = width
  while (left < maxX && edgeIsBackdrop(data, width, height, 'col', left, dropYellow)) left += 1
  while (right - 1 > width - 1 - maxX && right - 1 > left + 32 && edgeIsBackdrop(data, width, height, 'col', right - 1, dropYellow)) {
    right -= 1
  }
  while (top < maxY && edgeIsBackdrop(data, width, height, 'row', top, dropYellow)) top += 1
  while (bottom - 1 > height - 1 - maxY && bottom - 1 > top + 32 && edgeIsBackdrop(data, width, height, 'row', bottom - 1, dropYellow)) {
    bottom -= 1
  }
  if (top === 0 && bottom === height && left === 0 && right === width) return source
  return cropCanvas(source, left, top, right, bottom)
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
  clampPaperWhite(data)
  await applyScanTone(data, width, height, clock)
  await despeckle(data, width, height, clock)
  sharpenLuma(image)
  clampPaperWhite(data)
}

async function applyFastBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const clock = { last: performance.now() }
  await whiteBalanceRgb(data, width, height, clock)
  clampPaperWhite(data)
  await applyScanTone(data, width, height, clock)
  await despeckle(data, width, height, clock)
  sharpenLuma(image)
  clampPaperWhite(data)
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
    const warped = await warpCanvas(copy, corners, width, height)
    return trimDarkMargins(trimToPaper(warped))
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
  return trimDarkMargins(await processPixels(source, applyMagicColor))
}

/** High-contrast grayscale of the same continuous-tone page (no binary threshold). */
export async function applyCanvasBlackWhite(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return trimDarkMargins(await processPixels(source, applyFastBlackWhite))
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
