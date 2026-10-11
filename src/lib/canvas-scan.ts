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

/** Cells of the low-resolution lighting and texture maps are this many pixels wide. */
const LIGHT_CELL = 8
/** Local stddev below this is paper / smooth vignette, not a photograph. */
const TEXTURE_PAPER = 6
/** Local stddev at or above this is full continuous-tone energy. */
const TEXTURE_PHOTO = 22
/** Mid-tone share below this is a binary ink edge (text/barcode), not a photo. */
const TEXTURE_MID = 0.22

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
  await unsharp(dest, 0.35)
  output.putImageData(dest, 0, 0)
  return canvas
}

/* ---------- lighting map: shadows and uneven illumination ---------- */

type LowMap = {
  values: Float32Array
  cols: number
  rows: number
  /** Continuous-tone energy 0..1: high in printed photos, near 0 on paper and text edges. */
  texture?: Float32Array
  /** Mean HSV-style saturation per cell, 0..1. */
  sat?: Float32Array
}

/**
 * One luminance value per LIGHT_CELL block (sampled every 2px), so the pass stays cheap.
 * 'mean' is the plain average; 'paper' is the brightness of the paper in that block (the ~75th
 * percentile of its samples), so print, table lines and shading inside the block do not drag it down
 * while sharpening halos next to dark strokes cannot inflate it.
 */
async function lowLuminance(image: ImageData, mode: 'mean' | 'paper' = 'mean'): Promise<LowMap> {
  const { data, width, height } = image
  const cols = Math.ceil(width / LIGHT_CELL)
  const rows = Math.ceil(height / LIGHT_CELL)
  const values = new Float32Array(cols * rows)
  const texture = mode === 'paper' ? new Float32Array(cols * rows) : undefined
  const sat = mode === 'paper' ? new Float32Array(cols * rows) : undefined
  for (let row = 0; row < rows; row += 1) {
    if (row % 24 === 0) await nextFrame()
    const y0 = row * LIGHT_CELL
    const y1 = Math.min(height, y0 + LIGHT_CELL)
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * LIGHT_CELL
      const x1 = Math.min(width, x0 + LIGHT_CELL)
      let sum = 0
      let satSum = 0
      let count = 0
      const ranked: number[] = []
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const index = (y * width + x) * 4
          const red = data[index] ?? 0
          const green = data[index + 1] ?? 0
          const blue = data[index + 2] ?? 0
          const level = 0.299 * red + 0.587 * green + 0.114 * blue
          const peak = Math.max(red, green, blue)
          sum += level
          satSum += peak > 1 ? (peak - Math.min(red, green, blue)) / peak : 0
          count += 1
          ranked.push(level)
        }
      }
      let value = count ? sum / count : 255
      const chroma = count ? satSum / count : 0
      const mean = count ? sum / count : 0
      if (sat) sat[row * cols + col] = chroma
      if (mode === 'paper' && count > 0) {
        ranked.sort((a, b) => b - a)
        const from = Math.floor(count * 0.15)
        const to = Math.max(from + 1, Math.floor(count * 0.35))
        let total = 0
        for (let k = from; k < to; k += 1) total += ranked[k] ?? 0
        value = total / (to - from)

        const top = ranked[0] ?? 0
        const bottom = ranked[count - 1] ?? 0
        const range = top - bottom
        const bandLow = bottom + range * 0.18
        const bandHigh = bottom + range * 0.82
        let middle = 0
        let moment = 0
        for (const level of ranked) {
          if (level > bandLow && level < bandHigh) middle += 1
          moment += (level - mean) * (level - mean)
        }
        const spread = Math.sqrt(moment / count)
        const midShare = middle / count
        if (texture && mean > 18 && mean < 248) {
          const grain = Math.min(1, Math.max(0, (spread - TEXTURE_PAPER) / (TEXTURE_PHOTO - TEXTURE_PAPER)))
          const tone = Math.min(1, Math.max(0, (midShare - TEXTURE_MID) / 0.28))
          let energy = grain * tone
          if (chroma > 0.1 && mean > 28 && mean < 232) {
            energy = Math.max(energy, Math.min(1, (chroma - 0.08) / 0.2) * Math.min(1, Math.max(0, (spread - 4) / 14)))
          }
          texture[row * cols + col] = energy
        }
      }
      values[row * cols + col] = value
    }
  }
  return texture ? { values, cols, rows, texture, sat } : { values, cols, rows }
}

/** Separable box max (dilate), min (erode) or mean over a small window of cells. */
function boxFilter(map: LowMap, radius: number, mode: 'max' | 'min' | 'mean'): LowMap {
  const { cols, rows } = map
  const horizontal = new Float32Array(map.values.length)
  const output = new Float32Array(map.values.length)
  const reduce = (best: number, value: number) => {
    if (mode === 'min') return value < best ? value : best
    return value > best ? value : best
  }
  const start = mode === 'min' ? 255 : 0
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let best = start
      let sum = 0
      let count = 0
      for (let k = -radius; k <= radius; k += 1) {
        const c = Math.min(cols - 1, Math.max(0, col + k))
        const value = map.values[row * cols + c] ?? 0
        best = reduce(best, value)
        sum += value
        count += 1
      }
      horizontal[row * cols + col] = mode === 'mean' ? sum / count : best
    }
  }
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      let best = start
      let sum = 0
      let count = 0
      for (let k = -radius; k <= radius; k += 1) {
        const r = Math.min(rows - 1, Math.max(0, row + k))
        const value = horizontal[r * cols + col] ?? 0
        best = reduce(best, value)
        sum += value
        count += 1
      }
      output[row * cols + col] = mode === 'mean' ? sum / count : best
    }
  }
  return { values: output, cols, rows }
}

/**
 * Lift isolated low-energy cells that sit inside a photograph (sky, asphalt) without growing
 * outward into the smooth vignette, which has low-energy neighbors on the paper side.
 */
function fillPhotoHoles(values: Float32Array, cols: number, rows: number, seed = 0.36): Float32Array {
  let current = values
  for (let pass = 0; pass < 3; pass += 1) {
    const next = new Float32Array(current)
    for (let i = 0; i < current.length; i += 1) {
      if ((current[i] ?? 0) >= seed) continue
      const c = i % cols
      const r = (i - c) / cols
      let high = 0
      let sum = 0
      const look = [c > 0 ? i - 1 : -1, c + 1 < cols ? i + 1 : -1, r > 0 ? i - cols : -1, r + 1 < rows ? i + cols : -1]
      for (const n of look) {
        const value = n >= 0 ? (current[n] ?? 0) : 0
        if (value < seed) continue
        high += 1
        sum += value
      }
      if (high >= 3) next[i] = sum / high
    }
    current = next
  }
  return current
}

/** Soft 0..1 photo weight from local stddev / mid-tone energy. No bounding boxes. */
function photoEnergy(low: LowMap): LowMap | null {
  const { cols, rows, texture } = low
  if (!texture) return null
  const smooth = boxFilter({ values: texture, cols, rows }, 1, 'mean').values
  const filled = fillPhotoHoles(smooth, cols, rows)
  let any = 0
  for (const value of filled) any += value
  if (any < 8) return null
  return { values: filled, cols, rows }
}

/**
 * CLAHE-lite on the original source: each texture cell uses its own 10th/90th luminance
 * so vehicles and plates keep depth. Output is a separate RGB buffer (Layer 2).
 */
async function claheLayer(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  photo: LowMap,
): Promise<Uint8ClampedArray> {
  const out = new Uint8ClampedArray(source)
  const { cols, rows } = photo
  const lo = new Float32Array(cols * rows)
  const hi = new Float32Array(cols * rows)
  lo.fill(0)
  hi.fill(255)
  const tile = LIGHT_CELL * 6
  const ranked: number[] = []
  for (let row = 0; row < rows; row += 1) {
    if (row % 16 === 0) await nextFrame()
    const y0 = Math.max(0, row * LIGHT_CELL - tile + LIGHT_CELL)
    const y1 = Math.min(height, row * LIGHT_CELL + tile)
    for (let col = 0; col < cols; col += 1) {
      if ((photo.values[row * cols + col] ?? 0) < 0.12) continue
      ranked.length = 0
      const x0 = Math.max(0, col * LIGHT_CELL - tile + LIGHT_CELL)
      const x1 = Math.min(width, col * LIGHT_CELL + tile)
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4
          ranked.push(0.299 * (source[i] ?? 0) + 0.587 * (source[i + 1] ?? 0) + 0.114 * (source[i + 2] ?? 0))
        }
      }
      if (ranked.length < 8) continue
      ranked.sort((a, b) => a - b)
      const p10 = ranked[Math.floor(ranked.length * 0.1)] ?? 0
      const p90 = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.9))] ?? 255
      lo[row * cols + col] = p10
      hi[row * cols + col] = Math.max(p10 + 24, p90)
    }
  }
  const photoAt = nearestSampler(photo)
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await nextFrame()
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (photoAt(x, y) < 0.08) {
        index += 4
        continue
      }
      const col = Math.min(cols - 1, Math.max(0, (x / LIGHT_CELL) | 0))
      const row = Math.min(rows - 1, Math.max(0, (y / LIGHT_CELL) | 0))
      const red = source[index] ?? 0
      const green = source[index + 1] ?? 0
      const blue = source[index + 2] ?? 0
      const level = 0.299 * red + 0.587 * green + 0.114 * blue
      const floor = lo[row * cols + col] ?? 0
      const ceil = Math.max(floor + 24, hi[row * cols + col] ?? 255)
      const stretched = 18 + ((level - floor) / (ceil - floor)) * 217
      const target = Math.min(240, Math.max(15, stretched))
      const lift = level > 1 ? target / level : 0
      out[index] = Math.min(255, Math.max(0, red * lift))
      out[index + 1] = Math.min(255, Math.max(0, green * lift))
      out[index + 2] = Math.min(255, Math.max(0, blue * lift))
      out[index + 3] = 255
      index += 4
    }
  }
  return out
}

async function compositeLayers(document: ImageData, photo: Uint8ClampedArray, weight: LowMap) {
  const { data, width, height } = document
  const at = bilinearSampler(weight, width)
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await nextFrame()
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const w = Math.min(1, Math.max(0, at(x, y)))
      if (w < 0.04) {
        index += 4
        continue
      }
      const keep = 1 - w
      data[index] = (data[index] ?? 0) * keep + (photo[index] ?? 0) * w
      data[index + 1] = (data[index + 1] ?? 0) * keep + (photo[index + 1] ?? 0) * w
      data[index + 2] = (data[index + 2] ?? 0) * keep + (photo[index + 2] ?? 0) * w
      data[index + 3] = 255
      index += 4
    }
  }
}

/**
 * Wide morphological closing (~220px) estimates the paper illumination surface: text and table
 * lines disappear, folds and shadows remain. A Gaussian-like blur then makes the divide stable.
 */
function paperLight(low: LowMap): LowMap {
  const closed = boxFilter(boxFilter(low, 14, 'max'), 10, 'min')
  return boxFilter(boxFilter(closed, 4, 'mean'), 3, 'mean')
}

/** Local mean brightness (~70px window), used by the adaptive black-and-white threshold. */
function localMean(low: LowMap): LowMap {
  return boxFilter(boxFilter(low, 4, 'mean'), 4, 'mean')
}

/** Column and row weights so every pixel samples the low map bilinearly without recomputing. */
function columnSampler(width: number, cols: number) {
  const left = new Int32Array(width)
  const right = new Int32Array(width)
  const weight = new Float32Array(width)
  for (let x = 0; x < width; x += 1) {
    const position = Math.min(cols - 1, Math.max(0, (x + 0.5) / LIGHT_CELL - 0.5))
    const base = Math.floor(position)
    left[x] = base
    right[x] = Math.min(cols - 1, base + 1)
    weight[x] = position - base
  }
  return { left, right, weight }
}

function sampleRow(map: LowMap, y: number): { top: number; bottom: number; weight: number } {
  const position = Math.min(map.rows - 1, Math.max(0, (y + 0.5) / LIGHT_CELL - 0.5))
  const base = Math.floor(position)
  return { top: base * map.cols, bottom: Math.min(map.rows - 1, base + 1) * map.cols, weight: position - base }
}

function nearestSampler(map: LowMap): (x: number, y: number) => number {
  const { cols, rows, values } = map
  return (x, y) => {
    const col = Math.min(cols - 1, Math.max(0, (x / LIGHT_CELL) | 0))
    const row = Math.min(rows - 1, Math.max(0, (y / LIGHT_CELL) | 0))
    return values[row * cols + col] ?? 0
  }
}

function bilinearSampler(map: LowMap, width: number): (x: number, y: number) => number {
  const columns = columnSampler(width, map.cols)
  const values = map.values
  return (x, y) => {
    const row = sampleRow(map, y)
    const l = columns.left[x] ?? 0
    const r = columns.right[x] ?? 0
    const wx = columns.weight[x] ?? 0
    const top = (values[row.top + l] ?? 0) * (1 - wx) + (values[row.top + r] ?? 0) * wx
    const bottom = (values[row.bottom + l] ?? 0) * (1 - wx) + (values[row.bottom + r] ?? 0) * wx
    return top * (1 - row.weight) + bottom * row.weight
  }
}

/** Layer 1 flatten: `pixel = source / background * 255` across the whole page. */
async function flattenIllumination(image: ImageData, light: LowMap) {
  const { data, width, height } = image
  const columns = columnSampler(width, light.cols)

  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await nextFrame()
    const row = sampleRow(light, y)
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const l = columns.left[x] ?? 0
      const r = columns.right[x] ?? 0
      const wx = columns.weight[x] ?? 0
      const top = (light.values[row.top + l] ?? 255) * (1 - wx) + (light.values[row.top + r] ?? 255) * wx
      const bottom = (light.values[row.bottom + l] ?? 255) * (1 - wx) + (light.values[row.bottom + r] ?? 255) * wx
      const background = top * (1 - row.weight) + bottom * row.weight
      const gain = Math.min(3.5, 255 / Math.max(background, 30))

      data[index] = Math.min(255, (data[index] ?? 0) * gain)
      data[index + 1] = Math.min(255, (data[index + 1] ?? 0) * gain)
      data[index + 2] = Math.min(255, (data[index + 2] ?? 0) * gain)
      data[index + 3] = 255
      index += 4
    }
  }
}

const INK_BLACK = 118
const INK_FLOOR = 5 // #050505
const PAPER_CLAMP = 165

/**
 * Layer 1 polish: paper > 165 → #FFFFFF, high-contrast ink → #050505, saturated stamps keep hue.
 * Gray fog and vignette (not ink, not color) become white.
 */
async function polishDocument(image: ImageData) {
  const { data, width, height } = image
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) await nextFrame()
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const red = data[index] ?? 0
      const green = data[index + 1] ?? 0
      const blue = data[index + 2] ?? 0
      const level = 0.299 * red + 0.587 * green + 0.114 * blue
      if (level > PAPER_CLAMP) {
        data[index] = 255
        data[index + 1] = 255
        data[index + 2] = 255
        data[index + 3] = 255
        index += 4
        continue
      }
      const peak = Math.max(red, green, blue)
      const saturation = peak > 1 ? (peak - Math.min(red, green, blue)) / peak : 0
      if (saturation > 0.22 && level < 220) {
        const deepened = 255 * (level / 255) ** 1.35
        const target = Math.max(16, Math.min(200, deepened))
        const lift = level > 1 ? target / level : 0
        data[index] = Math.min(255, red * lift)
        data[index + 1] = Math.min(255, green * lift)
        data[index + 2] = Math.min(255, blue * lift)
      } else if (level <= INK_BLACK) {
        const target = INK_FLOOR + (level / INK_BLACK) * 4
        const lift = level > 1 ? target / level : 0
        data[index] = Math.min(255, red * lift)
        data[index + 1] = Math.min(255, green * lift)
        data[index + 2] = Math.min(255, blue * lift)
      } else {
        data[index] = 255
        data[index + 1] = 255
        data[index + 2] = 255
      }
      data[index + 3] = 255
      index += 4
    }
  }
}

/**
 * Black and white document: shadow-normalized brightness against a Bradley-style local mean.
 * Anything clearly darker than its neighborhood is ink (pure black), the rest is pure white.
 */
async function filterBlackWhite(image: ImageData) {
  const { data, width, height } = image
  const low = await lowLuminance(image)
  const light = paperLight(low)
  const mean = localMean(low)
  const columns = columnSampler(width, light.cols)

  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await nextFrame()
    const row = sampleRow(light, y)
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      const l = columns.left[x] ?? 0
      const r = columns.right[x] ?? 0
      const wx = columns.weight[x] ?? 0
      const lightAt = (map: LowMap) => {
        const top = (map.values[row.top + l] ?? 255) * (1 - wx) + (map.values[row.top + r] ?? 255) * wx
        const bottom = (map.values[row.bottom + l] ?? 255) * (1 - wx) + (map.values[row.bottom + r] ?? 255) * wx
        return top * (1 - row.weight) + bottom * row.weight
      }
      const gain = Math.min(4, 255 / Math.max(lightAt(light), 30))
      const level = (0.299 * (data[index] ?? 0) + 0.587 * (data[index + 1] ?? 0) + 0.114 * (data[index + 2] ?? 0)) * gain
      const neighborhood = lightAt(mean) * gain
      const ink = level < neighborhood * 0.8 && level < 200 ? 0 : 255
      data[index] = ink
      data[index + 1] = ink
      data[index + 2] = ink
      data[index + 3] = 255
      index += 4
    }
  }
}

/**
 * Unsharp mask on luminance (box blur of the given radius). Small deltas are ignored so the white
 * background does not pick up noise; edges of text and table lines gain micro-contrast.
 */
async function unsharp(
  image: ImageData,
  amount: number,
  radius = 2,
  brighten = 1,
  photo?: LowMap | null,
  region: 'print' | 'photo' = 'print',
) {
  const { data, width, height } = image
  const photoAt = photo ? nearestSampler(photo) : null
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  const blurred = new Float32Array(width * height)
  const span = radius * 2 + 1

  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) await nextFrame()
    const base = y * width
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) sum += gray[base + Math.min(width - 1, Math.max(0, k))] ?? 0
    for (let x = 0; x < width; x += 1) {
      blurred[base + x] = sum / span
      sum += (gray[base + Math.min(width - 1, x + radius + 1)] ?? 0) - (gray[base + Math.max(0, x - radius)] ?? 0)
    }
  }

  const column = new Float32Array(height)
  for (let x = 0; x < width; x += 1) {
    if (x % 128 === 0) await nextFrame()
    let sum = 0
    for (let k = -radius; k <= radius; k += 1) sum += blurred[Math.min(height - 1, Math.max(0, k)) * width + x] ?? 0
    for (let y = 0; y < height; y += 1) {
      column[y] = sum / span
      sum +=
        (blurred[Math.min(height - 1, y + radius + 1) * width + x] ?? 0) -
        (blurred[Math.max(0, y - radius) * width + x] ?? 0)
    }
    for (let y = 0; y < height; y += 1) {
      const p = y * width + x
      // Soft threshold: differences under 2 levels (noise, JPEG blocks) get no boost at all and larger
      // ones fade in, so flat paper stays clean and edges are never kinked.
      // `brighten` scales only the positive side (pixels brighter than their surroundings), so dark
      // strokes gain the full boost while bright halos beside them stay small.
      // Photographs get a light touch so plate digits stay readable without speckling the grain.
      const photoW = photoAt ? photoAt(x, y) : 0
      const weight = region === 'photo' ? photoW : 1 - photoW
      if (weight < 0.15) continue
      const diff = (gray[p] ?? 0) - (column[y] ?? 0)
      const raw = diff * amount * (diff > 0 ? brighten : 1) * weight
      const delta = raw - Math.max(-2, Math.min(2, raw))
      if (delta === 0) continue
      const i = p * 4
      data[i] = Math.min(255, Math.max(0, (data[i] ?? 0) + delta))
      data[i + 1] = Math.min(255, Math.max(0, (data[i + 1] ?? 0) + delta))
      data[i + 2] = Math.min(255, Math.max(0, (data[i + 2] ?? 0) + delta))
    }
  }
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

/**
 * Pulls the corners a hair toward the center (0.4% per side) so a sliver of board, clip shadow or
 * table that the corner snap could not remove never reaches the edge of the A4 output.
 */
function insetCorners(corners: Corners, amount = 0.004): Corners {
  const cx = (corners.tl.x + corners.tr.x + corners.br.x + corners.bl.x) / 4
  const cy = (corners.tl.y + corners.tr.y + corners.br.y + corners.bl.y) / 4
  const pull = (point: Point): Point => ({ x: point.x + (cx - point.x) * amount * 2, y: point.y + (cy - point.y) * amount * 2 })
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
    // Release the full-size working copy right away so phones do not hold ~30MB until GC.
    copy.width = 0
    copy.height = 0
  }
}

async function processCopy(
  source: HTMLCanvasElement,
  run: (pixels: ImageData) => Promise<void>,
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

/** Dual-layer magic scan: cleaned document composited with CLAHE photos by texture energy. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processCopy(source, async (pixels) => {
    const original = new Uint8ClampedArray(pixels.data)
    const low = await lowLuminance(pixels, 'paper')
    const photo = photoEnergy(low)
    const light = paperLight(low)
    await flattenIllumination(pixels, light)
    await unsharp(pixels, 0.9, 2, 0.32, photo, 'print')
    await unsharp(pixels, 1.55, 1, 0.25, photo, 'print')
    await polishDocument(pixels)
    if (photo) {
      const enhanced = await claheLayer(original, pixels.width, pixels.height, photo)
      await compositeLayers(pixels, enhanced, photo)
      await unsharp(pixels, 0.85, 1, 0.7, photo, 'photo')
    }
  })
}

/** High-grade adaptive black and white. */
export async function applyCanvasBlackWhite(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processCopy(source, filterBlackWhite)
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
