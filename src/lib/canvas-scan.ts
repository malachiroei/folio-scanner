import type { Corners, FilterMode, Point } from '../types'
import { outputSize } from './geometry'
import { nextFrame } from './image'

/**
 * A page that is roughly paper-shaped (long/short between 1.25 and 1.6) snaps to the exact A4
 * ratio 1:1.414 on its long side, so slightly off corners cannot stretch the text.
 * Other shapes (receipts, cards) keep the measured size.
 */
function a4Size(size: { width: number; height: number }): { width: number; height: number } {
  const long = Math.max(size.width, size.height)
  const short = Math.min(size.width, size.height)
  if (short < 1) return size
  const ratio = long / short
  if (ratio < 1.25 || ratio > 1.6) return size
  const snapped = Math.round(long / Math.SQRT2)
  return size.width >= size.height ? { width: long, height: snapped } : { width: snapped, height: long }
}

/** Long edge of the straightened page. Text in a dense table needs this much to stay sharp. */
const MAX_EDGE = 3000

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
  if (!context) throw new Error('׳׳ ׳ ׳™׳×׳ ׳׳”׳›׳™׳ ׳׳× ׳”׳×׳׳•׳ ׳”.')
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
  if (!context) throw new Error('׳׳ ׳ ׳™׳×׳ ׳׳§׳¨׳•׳ ׳׳× ׳”׳×׳׳•׳ ׳”.')
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
  if (!output) throw new Error('׳׳ ׳ ׳™׳×׳ ׳׳™׳™׳©׳¨ ׳׳× ׳”׳¢׳׳•׳“.')
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
  output.putImageData(dest, 0, 0)
  return canvas
}

function luminance(data: Uint8ClampedArray, index: number) {
  return (
    0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0)
  )
}

function integralImage(gray: Float32Array, width: number, height: number) {
  const stride = width + 1
  const table = new Float64Array(stride * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let row = 0
    for (let x = 0; x < width; x += 1) {
      row += gray[y * width + x] ?? 0
      table[(y + 1) * stride + (x + 1)] = row + (table[y * stride + (x + 1)] ?? 0)
    }
  }
  return table
}

function areaSum(table: Float64Array, width: number, x0: number, y0: number, x1: number, y1: number) {
  const stride = width + 1
  return (
    (table[y1 * stride + x1] ?? 0) -
    (table[y0 * stride + x1] ?? 0) -
    (table[y1 * stride + x0] ?? 0) +
    (table[y0 * stride + x0] ?? 0)
  )
}

function magicCurve(value: number) {
  const x = Math.min(1, Math.max(0, value / 255))
  let y: number
  if (x < 0.5) y = (x / 0.5) ** 1.08 * 0.48
  else if (x < 0.72) y = 0.48 + ((x - 0.5) / 0.22) * 0.22
  else {
    const t = (x - 0.72) / 0.28
    const smooth = t * t * (3 - 2 * t)
    const base = 0.7 + (x - 0.72) * 0.35
    y = base + (1 - base) * smooth * 0.95
  }
  return Math.max(0, Math.min(255, Math.round(y * 255)))
}

export function desaturateCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = image
  for (let i = 0; i < data.length; i += 4) {
    const tone = Math.round(
      0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0),
    )
    data[i] = tone
    data[i + 1] = tone
    data[i + 2] = tone
  }
  context.putImageData(image, 0, 0)
  return canvas
}

async function filterPixels(image: ImageData, filter: 'magic' | 'bw') {
  const { data, width, height } = image
  const gray = new Float32Array(width * height)
  for (let i = 0; i < gray.length; i += 1) gray[i] = luminance(data, i * 4)
  const table = integralImage(gray, width, height)
  const radius = Math.max(8, Math.round(Math.min(width, height) / (filter === 'bw' ? 28 : 14)))

  for (let y = 0; y < height; y += 1) {
    if (y % 16 === 0) await nextFrame()
    const y0 = Math.max(0, y - radius)
    const y1 = Math.min(height, y + radius + 1)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width, x + radius + 1)
      const count = (x1 - x0) * (y1 - y0)
      const average = areaSum(table, width, x0, y0, x1, y1) / Math.max(1, count)
      const index = (y * width + x) * 4
      const lum = gray[y * width + x] ?? 0
      if (filter === 'bw') {
        const ink = lum + 12 < average ? 0 : 255
        data[index] = ink
        data[index + 1] = ink
        data[index + 2] = ink
      } else {
        const lifted = magicCurve(lum * (242 / Math.max(16, average)))
        const gain = lum < 1 ? 1 : lifted / lum
        data[index] = Math.max(0, Math.min(255, (data[index] ?? 0) * gain))
        data[index + 1] = Math.max(0, Math.min(255, (data[index + 1] ?? 0) * gain))
        data[index + 2] = Math.max(0, Math.min(255, (data[index + 2] ?? 0) * gain))
      }
      data[index + 3] = 255
    }
  }
}

export async function straightenCanvas(
  image: CanvasImageSource,
  corners: Corners,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HTMLCanvasElement> {
  const fitted = a4Size(outputSize(corners))
  const scale = Math.min(1, MAX_EDGE / Math.max(fitted.width, fitted.height, 1))
  const width = Math.max(32, Math.round(fitted.width * scale))
  const height = Math.max(32, Math.round(fitted.height * scale))
  const copy = drawSource(image)
  try {
    return await warpCanvas(copy, corners, width, height, deadlineAt)
  } finally {
    // Release the full-size working copy right away so phones do not hold ~30MB until GC.
    copy.width = 0
    copy.height = 0
  }
}

export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return source
  context.drawImage(source, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  await filterPixels(pixels, 'magic')
  context.putImageData(pixels, 0, 0)
  return canvas
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
  const context = copyCanvas(warped).getContext('2d', { willReadFrequently: true })
  if (!context) return warped
  const pixels = context.getImageData(0, 0, context.canvas.width, context.canvas.height)
  await filterPixels(pixels, 'bw')
  context.putImageData(pixels, 0, 0)
  return context.canvas
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  canvas.getContext('2d')?.drawImage(source, 0, 0)
  return canvas
}
