import type { Corners, FilterMode, Point } from '../types'
import { outputSize } from './geometry'
import { nextFrame } from './image'

const MAX_EDGE = 1400

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

function project(h: number[], x: number, y: number): Point {
  const w = (h[6] ?? 0) * x + (h[7] ?? 0) * y + (h[8] ?? 1)
  const safe = Math.abs(w) < 1e-6 ? (w < 0 ? -1e-6 : 1e-6) : w
  return {
    x: ((h[0] ?? 0) * x + (h[1] ?? 0) * y + (h[2] ?? 0)) / safe,
    y: ((h[3] ?? 0) * x + (h[4] ?? 0) * y + (h[5] ?? 0)) / safe,
  }
}

function sample(data: Uint8ClampedArray, width: number, height: number, x: number, y: number) {
  const maxX = width - 1
  const maxY = height - 1
  const cx = Math.min(maxX, Math.max(0, x))
  const cy = Math.min(maxY, Math.max(0, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(maxX, x0 + 1)
  const y1 = Math.min(maxY, y0 + 1)
  const dx = cx - x0
  const dy = cy - y0
  const at = (px: number, py: number) => (py * width + px) * 4
  const i00 = at(x0, y0)
  const i10 = at(x1, y0)
  const i01 = at(x0, y1)
  const i11 = at(x1, y1)
  const mix = (channel: number) => {
    const top = (data[i00 + channel] ?? 0) * (1 - dx) + (data[i10 + channel] ?? 0) * dx
    const bottom = (data[i01 + channel] ?? 0) * (1 - dx) + (data[i11 + channel] ?? 0) * dx
    return top * (1 - dy) + bottom * dy
  }
  return [mix(0), mix(1), mix(2), mix(3)]
}

function paintScaled(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(source, 0, 0, width, height)
  return canvas
}

async function warpCanvas(
  source: HTMLCanvasElement,
  corners: Corners,
  width: number,
  height: number,
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<HTMLCanvasElement> {
  if (performance.now() > deadlineAt) return paintScaled(source, width, height)
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

  if (performance.now() > deadlineAt) return paintScaled(source, width, height)

  const dest = output.createImageData(width, height)
  const data = dest.data
  for (let y = 0; y < height; y += 1) {
    if (y % 8 === 0) {
      await nextFrame()
      if (performance.now() > deadlineAt) return paintScaled(source, width, height)
    }
    for (let x = 0; x < width; x += 1) {
      const point = project(map, x, y)
      const [r, g, b, a] = sample(pixels.data, source.width, source.height, point.x, point.y)
      const index = (y * width + x) * 4
      data[index] = r ?? 0
      data[index + 1] = g ?? 0
      data[index + 2] = b ?? 0
      data[index + 3] = a ?? 255
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
  const fitted = outputSize(corners)
  const scale = Math.min(1, MAX_EDGE / Math.max(fitted.width, fitted.height, 1))
  const width = Math.max(32, Math.round(fitted.width * scale))
  const height = Math.max(32, Math.round(fitted.height * scale))
  return warpCanvas(drawSource(image), corners, width, height, deadlineAt)
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
