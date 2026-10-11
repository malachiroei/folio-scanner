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

/** Cells of the low-resolution lighting map are this many pixels wide. */
const LIGHT_CELL = 8

/** A cell is photo-like when this share of its samples sit in the middle of its own tone range. */
const PHOTO_TEXTURE = 0.36
/** Smallest printed photo (cells). Stamps and logos sit below this. */
const PHOTO_MIN_CELLS = 36
/** Shortest side of a photo rectangle (cells). ~64px at LIGHT_CELL. */
const PHOTO_MIN_SIDE = 8
/** A second, smaller print (plate crop) may be slightly under the primary size floor. */
const PHOTO_MIN_CELLS_SECOND = 24
const PHOTO_MIN_SIDE_SECOND = 6
/** Peel at most this many vignette cells off each side of a detected box. */
const PHOTO_PEEL = 3
/** Keep at most this many independent photo rectangles (overview + plate, rarely a third). */
const PHOTO_MAX_BOXES = 3

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
  /** 'paper' maps only: how photo-like (continuous mid-tones) each cell is, 0..1. */
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

        // Photo-likeness: text and bars put their pixels at the two extremes (paper and ink) with only
        // antialiased edges between, while a continuous-tone picture spreads over the middle of the range.
        const top = ranked[0] ?? 0
        const bottom = ranked[count - 1] ?? 0
        const range = top - bottom
        if (texture && mean > 20 && mean < 245) {
          const low = bottom + range * 0.18
          const high = bottom + range * 0.82
          let middle = 0
          let moment = 0
          for (const level of ranked) {
            if (level > low && level < high) middle += 1
            moment += (level - mean) * (level - mean)
          }
          const spread = Math.sqrt(moment / count)
          const midShare = middle / count
          if (range >= 22 && midShare >= 0.28 && spread >= 10) {
            texture[row * cols + col] = Math.min(1, midShare + spread / 80)
          } else if (chroma > 0.12 && mean > 30 && mean < 230) {
            texture[row * cols + col] = Math.min(1, chroma * 1.8)
          }
        }
      }
      values[row * cols + col] = value
    }
  }
  return texture ? { values, cols, rows, texture, sat } : { values, cols, rows }
}

/** Morphology on a 0/1 cell map through box means (a cell survives erosion only if its whole window is set). */
function morphCells(map: Float32Array, cols: number, rows: number, radius: number, grow: boolean): Float32Array {
  const mean = boxFilter({ values: map, cols, rows }, radius, 'mean').values
  const result = new Float32Array(map.length)
  for (let i = 0; i < map.length; i += 1) {
    const value = mean[i] ?? 0
    result[i] = grow ? (value > 0.001 ? 1 : 0) : value > 0.999 ? 1 : 0
  }
  return result
}

type PhotoBox = { left: number; right: number; north: number; south: number }

function photoLike(low: LowMap, i: number): boolean {
  return (low.texture?.[i] ?? 0) >= PHOTO_TEXTURE * 0.5 || (low.sat?.[i] ?? 0) > 0.14
}

function boxArea(box: PhotoBox): number {
  return (box.right - box.left + 1) * (box.south - box.north + 1)
}

function validPhotoBox(box: PhotoBox, minCells: number, minSide: number): boolean {
  const width = box.right - box.left + 1
  const height = box.south - box.north + 1
  if (width < minSide || height < minSide || width * height < minCells) return false
  return Math.max(width, height) / Math.min(width, height) <= 3.8
}

function seedPhoto(low: LowMap): Float32Array {
  const { cols, rows, texture } = low
  const seeds = new Float32Array(cols * rows)
  if (!texture) return seeds
  // Radius 1 only — a wider blur glues two nearby prints (car + plate) into one blob.
  const local = boxFilter({ values: texture, cols, rows }, 1, 'mean').values
  for (let i = 0; i < seeds.length; i += 1) {
    const grain = local[i] ?? 0
    const chroma = low.sat?.[i] ?? 0
    const bright = low.values[i] ?? 0
    if (grain >= PHOTO_TEXTURE) {
      seeds[i] = 1
      continue
    }
    // Paint / sky: colored mid-tones with some grain. A solid stamp on paper does not qualify.
    if (chroma > 0.16 && bright > 35 && bright < 225 && grain >= PHOTO_TEXTURE * 0.35) seeds[i] = 1
  }
  return seeds
}

function stripPhotoShare(
  low: LowMap,
  box: PhotoBox,
  side: 'left' | 'right' | 'top' | 'bottom',
): number {
  const { cols } = low
  let hit = 0
  let total = 0
  if (side === 'left' || side === 'right') {
    const col = side === 'left' ? box.left : box.right
    for (let row = box.north; row <= box.south; row += 1) {
      total += 1
      if (photoLike(low, row * cols + col)) hit += 1
    }
  } else {
    const row = side === 'top' ? box.north : box.south
    for (let col = box.left; col <= box.right; col += 1) {
      total += 1
      if (photoLike(low, row * cols + col)) hit += 1
    }
  }
  return total ? hit / total : 0
}

/** Peel a thin vignette / paper frame. Never more than PHOTO_PEEL cells, so a plate crop is not eaten. */
function modestTighten(low: LowMap, box: PhotoBox): PhotoBox {
  let { left, right, north, south } = box
  for (let step = 0; step < PHOTO_PEEL; step += 1) {
    const width = right - left + 1
    const height = south - north + 1
    const current = { left, right, north, south }
    const candidates: { side: 'left' | 'right' | 'top' | 'bottom'; share: number; ok: boolean }[] = [
      { side: 'left', share: stripPhotoShare(low, current, 'left'), ok: width > PHOTO_MIN_SIDE },
      { side: 'right', share: stripPhotoShare(low, current, 'right'), ok: width > PHOTO_MIN_SIDE },
      { side: 'top', share: stripPhotoShare(low, current, 'top'), ok: height > PHOTO_MIN_SIDE },
      { side: 'bottom', share: stripPhotoShare(low, current, 'bottom'), ok: height > PHOTO_MIN_SIDE },
    ]
    let pick: (typeof candidates)[number] | null = null
    for (const item of candidates) {
      if (!item.ok || item.share >= 0.28) continue
      if (!pick || item.share < pick.share) pick = item
    }
    if (!pick) break
    if (pick.side === 'left') left += 1
    else if (pick.side === 'right') right -= 1
    else if (pick.side === 'top') north += 1
    else south -= 1
  }
  return { left, right, north, south }
}

/**
 * If a connected component is actually two prints with a paper gutter, the seed projection has a
 * valley. Split there so each photo stays its own hard rectangle.
 */
function splitIfTwo(seeds: Float32Array, cols: number, box: PhotoBox): PhotoBox[] {
  const width = box.right - box.left + 1
  const height = box.south - box.north + 1
  const colHits = new Float32Array(width)
  const rowHits = new Float32Array(height)
  for (let row = box.north; row <= box.south; row += 1) {
    for (let col = box.left; col <= box.right; col += 1) {
      if ((seeds[row * cols + col] ?? 0) < 0.5) continue
      colHits[col - box.left] += 1
      rowHits[row - box.north] += 1
    }
  }

  const valley = (hits: Float32Array, span: number, minSpan: number) => {
    if (span < minSpan) return null
    let peak = 1
    for (const value of hits) if (value > peak) peak = value
    const from = Math.max(2, Math.floor(span * 0.18))
    const to = Math.min(span - 4, Math.ceil(span * 0.82))
    let bestAt = -1
    let bestScore = 0.18
    for (let i = from; i <= to; i += 1) {
      const rel = ((hits[i] ?? 0) + (hits[i + 1] ?? 0)) / 2 / peak
      if (rel < bestScore) {
        bestScore = rel
        bestAt = i
      }
    }
    return bestAt >= 0 ? bestAt : null
  }

  const cutCol = valley(colHits, width, 16)
  const cutRow = valley(rowHits, height, 16)
  if (cutCol !== null && (cutRow === null || width >= height)) {
    const a = { ...box, right: box.left + cutCol }
    const b = { ...box, left: box.left + cutCol + 2 }
    if (validPhotoBox(a, PHOTO_MIN_CELLS_SECOND, PHOTO_MIN_SIDE_SECOND) && validPhotoBox(b, PHOTO_MIN_CELLS_SECOND, PHOTO_MIN_SIDE_SECOND)) {
      return [a, b]
    }
  }
  if (cutRow !== null) {
    const a = { ...box, south: box.north + cutRow }
    const b = { ...box, north: box.north + cutRow + 2 }
    if (validPhotoBox(a, PHOTO_MIN_CELLS_SECOND, PHOTO_MIN_SIDE_SECOND) && validPhotoBox(b, PHOTO_MIN_CELLS_SECOND, PHOTO_MIN_SIDE_SECOND)) {
      return [a, b]
    }
  }
  return [box]
}

function containsBox(outer: PhotoBox, inner: PhotoBox): boolean {
  return (
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.north >= outer.north &&
    inner.south <= outer.south
  )
}

/**
 * Independent hard rectangles for each printed photograph. Components are not grown through the
 * oval fog, not merged across a paper gutter, and a second valid box is never discarded.
 */
function findPhotoBoxes(low: LowMap): PhotoBox[] {
  const { cols, rows } = low
  if (!low.texture) return []
  const raw = seedPhoto(low)
  const seeds = morphCells(morphCells(raw, cols, rows, 1, true), cols, rows, 1, false)
  const seen = new Uint8Array(seeds.length)
  const stack = new Int32Array(seeds.length)
  const found: PhotoBox[] = []

  for (let start = 0; start < seeds.length; start += 1) {
    if ((seeds[start] ?? 0) < 0.5 || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    let count = 0
    let minC = cols
    let maxC = 0
    let minR = rows
    let maxR = 0
    while (top > 0) {
      top -= 1
      const i = stack[top] ?? 0
      count += 1
      const c = i % cols
      const r = (i - c) / cols
      if (c < minC) minC = c
      if (c > maxC) maxC = c
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      const neighbors = [c > 0 ? i - 1 : -1, c + 1 < cols ? i + 1 : -1, r > 0 ? i - cols : -1, r + 1 < rows ? i + cols : -1]
      for (const n of neighbors) {
        if (n < 0 || seen[n] || (seeds[n] ?? 0) < 0.5) continue
        seen[n] = 1
        stack[top] = n
        top += 1
      }
    }
    if (count < PHOTO_MIN_CELLS_SECOND) continue
    const loose = { left: minC, right: maxC, north: minR, south: maxR }
    for (const part of splitIfTwo(seeds, cols, loose)) found.push(modestTighten(low, part))
  }

  found.sort((a, b) => boxArea(b) - boxArea(a))
  const kept: PhotoBox[] = []
  for (const box of found) {
    if (kept.some((other) => containsBox(other, box))) continue
    const minCells = kept.length === 0 ? PHOTO_MIN_CELLS : PHOTO_MIN_CELLS_SECOND
    const minSide = kept.length === 0 ? PHOTO_MIN_SIDE : PHOTO_MIN_SIDE_SECOND
    if (!validPhotoBox(box, minCells, minSide)) continue
    kept.push(box)
    if (kept.length >= PHOTO_MAX_BOXES) break
  }
  return kept
}

/** Hard 0/1 mask: photo processing runs only inside these rectangles. Everything else is paper. */
function photoWeights(low: LowMap): LowMap | null {
  const boxes = findPhotoBoxes(low)
  if (!boxes.length) return null
  const values = new Float32Array(low.cols * low.rows)
  for (const box of boxes) {
    for (let row = box.north; row <= box.south; row += 1) {
      const base = row * low.cols
      for (let col = box.left; col <= box.right; col += 1) values[base + col] = 1
    }
  }
  return { values, cols: low.cols, rows: low.rows }
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
 * Paper brightness under the print. A large max filter (~120px across) skips dense text blocks,
 * dark header bars and shaded table rows, then blurring smooths the result. Dividing by it flattens
 * shadows without mistaking table shading for lighting.
 */
/** Copies surrounding paper brightness into cells covered by a photograph (nearest-known BFS). */
function inpaintPaper(values: Float32Array, photo: Float32Array, cols: number): Float32Array {
  const out = new Float32Array(values.length)
  const ready = new Uint8Array(values.length)
  const queue = new Int32Array(values.length)
  let head = 0
  let tail = 0
  for (let i = 0; i < values.length; i += 1) {
    if ((photo[i] ?? 0) > 0.25) continue
    out[i] = values[i] ?? 0
    ready[i] = 1
    queue[tail] = i
    tail += 1
  }
  if (tail === 0) return values
  while (head < tail) {
    const i = queue[head] ?? 0
    head += 1
    const x = i % cols
    const neighbors = [x > 0 ? i - 1 : -1, x + 1 < cols ? i + 1 : -1, i >= cols ? i - cols : -1, i + cols < values.length ? i + cols : -1]
    for (const n of neighbors) {
      if (n < 0 || ready[n]) continue
      out[n] = out[i] ?? 0
      ready[n] = 1
      queue[tail] = n
      tail += 1
    }
  }
  return out
}

/**
 * Moderate CLAHE inside each hard photo rectangle. Local 8th/92nd percentiles (clip ~2) stretch
 * vehicle paint and plate digits without flattening the road to muddy gray. Paper is untouched.
 */
async function photoContrast(image: ImageData, photo: LowMap) {
  const { data, width, height } = image
  const { cols, rows } = photo
  const lo = new Float32Array(cols * rows)
  const hi = new Float32Array(cols * rows)
  lo.fill(0)
  hi.fill(255)
  const tile = LIGHT_CELL * 5
  const ranked: number[] = []
  for (let row = 0; row < rows; row += 1) {
    if (row % 16 === 0) await nextFrame()
    const y0 = Math.max(0, row * LIGHT_CELL - tile + LIGHT_CELL)
    const y1 = Math.min(height, row * LIGHT_CELL + tile)
    for (let col = 0; col < cols; col += 1) {
      if ((photo.values[row * cols + col] ?? 0) < 0.5) continue
      ranked.length = 0
      const x0 = Math.max(0, col * LIGHT_CELL - tile + LIGHT_CELL)
      const x1 = Math.min(width, col * LIGHT_CELL + tile)
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0; x < x1; x += 2) {
          const i = (y * width + x) * 4
          ranked.push(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0))
        }
      }
      if (ranked.length < 8) continue
      ranked.sort((a, b) => a - b)
      const p08 = ranked[Math.floor(ranked.length * 0.08)] ?? 0
      const p92 = ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.92))] ?? 255
      lo[row * cols + col] = p08
      hi[row * cols + col] = Math.max(p08 + 28, p92)
    }
  }

  const lowAt = mapSampler({ values: lo, cols, rows }, width, height)
  const highAt = mapSampler({ values: hi, cols, rows }, width, height)
  const photoAt = nearestSampler(photo)
  for (let y = 0; y < height; y += 1) {
    if (y % 32 === 0) await nextFrame()
    let index = y * width * 4
    for (let x = 0; x < width; x += 1) {
      if (photoAt(x, y) < 0.5) {
        index += 4
        continue
      }
      const red = data[index] ?? 0
      const green = data[index + 1] ?? 0
      const blue = data[index + 2] ?? 0
      const level = 0.299 * red + 0.587 * green + 0.114 * blue
      const floor = lowAt(x, y)
      const ceil = Math.max(floor + 28, highAt(x, y))
      const stretched = 30 + ((level - floor) / (ceil - floor)) * 200
      const target = Math.min(232, Math.max(28, stretched))
      const lift = level > 1 ? target / level : 0
      data[index] = Math.min(255, Math.max(0, red * lift))
      data[index + 1] = Math.min(255, Math.max(0, green * lift))
      data[index + 2] = Math.min(255, Math.max(0, blue * lift))
      index += 4
    }
  }
}

/**
 * Wide morphological closing (~220px) estimates the paper illumination surface: text and table
 * lines disappear, folds and shadows remain. A Gaussian-like blur then makes the divide stable.
 */
function paperLight(low: LowMap, photo?: LowMap | null): LowMap {
  const source = photo
    ? { values: inpaintPaper(low.values, photo.values, low.cols), cols: low.cols, rows: low.rows }
    : low
  const closed = boxFilter(boxFilter(source, 14, 'max'), 10, 'min')
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

/** Bilinear lookup of a low-resolution map at a full-resolution pixel, with no per-pixel allocation. */
function mapSampler(map: LowMap, width: number, height: number): (x: number, y: number) => number {
  const columns = columnSampler(width, map.cols)
  const top = new Int32Array(height)
  const bottom = new Int32Array(height)
  const weight = new Float32Array(height)
  for (let y = 0; y < height; y += 1) {
    const row = sampleRow(map, y)
    top[y] = row.top
    bottom[y] = row.bottom
    weight[y] = row.weight
  }
  const values = map.values
  return (x, y) => {
    const l = columns.left[x] ?? 0
    const r = columns.right[x] ?? 0
    const wx = columns.weight[x] ?? 0
    const t = (values[(top[y] ?? 0) + l] ?? 0) * (1 - wx) + (values[(top[y] ?? 0) + r] ?? 0) * wx
    const b = (values[(bottom[y] ?? 0) + l] ?? 0) * (1 - wx) + (values[(bottom[y] ?? 0) + r] ?? 0) * wx
    const wy = weight[y] ?? 0
    return t * (1 - wy) + b * wy
  }
}

/** Hard cell lookup — no bilinear fade — so paper whitening stops on the photo's rectangular edge. */
function nearestSampler(map: LowMap): (x: number, y: number) => number {
  const { cols, rows, values } = map
  return (x, y) => {
    const col = Math.min(cols - 1, Math.max(0, (x / LIGHT_CELL) | 0))
    const row = Math.min(rows - 1, Math.max(0, (y / LIGHT_CELL) | 0))
    return values[row * cols + col] ?? 0
  }
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * Flatten the page: `pixel = source / background * 255`. After this, paper is ~255 everywhere
 * and folds / lamp gradients are gone. Photographs sit on inpainted paper light so their gain is ~1.
 */
async function filterMagic(image: ImageData, light: LowMap) {
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

const INK_BLACK = 118 // flattened ink after the divide; anything lighter is paper or fog
const INK_FLOOR = 10 // #0A0A0A, inside the #000000–#101010 scanner black range
const EDGE_MARGIN = 0.06 // width of the perimeter band, as a share of the shorter side
const EDGE_KNEE = 110 // inside that band, levels from here up fade to pure white at the very edge
const PAPER_CLAMP = 170 // any non-photo background pixel above this is forced to #FFFFFF

/**
 * Print and paper only — hard rectangular photo masks are skipped entirely.
 * Background above 170, and any desaturated fog/smudge below that, become #FFFFFF.
 * Ink goes to deep #0A0A0A. Saturated red/blue stamps keep their hue and are deepened.
 */
async function inkCurve(image: ImageData, photo?: LowMap | null) {
  const { data, width, height } = image
  const lut = new Uint8ClampedArray(256)
  for (let level = 0; level < 256; level += 1) {
    if (level >= PAPER_CLAMP) {
      lut[level] = 255
      continue
    }
    if (level <= INK_BLACK) {
      lut[level] = INK_FLOOR + (level / INK_BLACK) * 6
      continue
    }
    lut[level] = 255
  }
  const photoAt = photo ? nearestSampler(photo) : null
  const margin = Math.max(24, Math.round(Math.min(width, height) * EDGE_MARGIN))
  for (let y = 0; y < height; y += 1) {
    if (y % 64 === 0) await nextFrame()
    let index = y * width * 4
    const fromY = Math.min(y, height - 1 - y)
    for (let x = 0; x < width; x += 1) {
      const red = data[index] ?? 0
      const green = data[index + 1] ?? 0
      const blue = data[index + 2] ?? 0
      const level = 0.299 * red + 0.587 * green + 0.114 * blue
      const tone = Math.round(level)
      if (photoAt && photoAt(x, y) >= 0.5) {
        index += 4
        continue
      }
      const peak = Math.max(red, green, blue)
      const saturation = peak > 1 ? (peak - Math.min(red, green, blue)) / peak : 0
      const colorInk = saturation > 0.22 && level < 220
      let target: number
      let keep: number
      if (colorInk) {
        const deepened = 255 * (level / 255) ** 1.35
        target = Math.max(16, Math.min(200, deepened))
        keep = 1
      } else {
        target = lut[tone] ?? 255
        const fromEdge = Math.min(x, width - 1 - x, fromY)
        if (fromEdge < margin && level > EDGE_KNEE) {
          const strength = 1 - smoothstep(0, margin, fromEdge)
          target = target * (1 - strength) + 255 * strength
        }
        keep = 0
      }
      const lift = level > 1 ? target / level : 0
      data[index] = target + (Math.min(255, red * lift) - target) * keep
      data[index + 1] = target + (Math.min(255, green * lift) - target) * keep
      data[index + 2] = target + (Math.min(255, blue * lift) - target) * keep
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

/** Magic scan: flat white paper, hard photo rectangles, bold ink, colors kept. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processCopy(source, async (pixels) => {
    const low = await lowLuminance(pixels, 'paper')
    const photo = photoWeights(low)
    const light = paperLight(low, photo)
    await filterMagic(pixels, light)
    if (photo) {
      await photoContrast(pixels, photo)
      await unsharp(pixels, 0.75, 1, 0.5, photo, 'photo')
    }
    await unsharp(pixels, 0.9, 2, 0.35, photo, 'print')
    await unsharp(pixels, 1.6, 1, 0.28, photo, 'print')
    await inkCurve(pixels, photo)
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
