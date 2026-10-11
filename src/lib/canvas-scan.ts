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

/** Illumination on a tiny copy so a max-filter can jump across dark photo blocks. */
const LIGHT_WIDTH = 96
const LIGHT_MAX = 22
const LIGHT_BLUR = 6
const TEX_WIDTH = 280
const PAPER_FLAT = 9
const PHOTO_VAR = 12
const PAPER_KNEE = 225
const PHOTO_BLACK = 26
const PHOTO_WHITE = 240
const SAT_BOOST = 1.6

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

/* ---------- CamScanner Magic Color (max-filter paper light + variance gate) ---------- */

function downsample(source: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'medium'
  context.drawImage(source, 0, 0, width, height)
  return canvas
}

function upsample(source: HTMLCanvasElement, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return new ImageData(width, height)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(source, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

/** Separable max (dilation). Dark text / photo blocks do not pull the paper estimate down. */
function maxFilterRgba(image: ImageData, radius: number) {
  const { data, width, height } = image
  const tmp = new Uint8ClampedArray(data.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    for (let x = 0; x < width; x += 1) {
      let mr = 0
      let mg = 0
      let mb = 0
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let k = x0; k <= x1; k += 1) {
        const i = row + k * 4
        const r = data[i] ?? 0
        const g = data[i + 1] ?? 0
        const b = data[i + 2] ?? 0
        if (r > mr) mr = r
        if (g > mg) mg = g
        if (b > mb) mb = b
      }
      const o = row + x * 4
      tmp[o] = mr
      tmp[o + 1] = mg
      tmp[o + 2] = mb
      tmp[o + 3] = 255
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let mr = 0
      let mg = 0
      let mb = 0
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      for (let k = y0; k <= y1; k += 1) {
        const i = (k * width + x) * 4
        const r = tmp[i] ?? 0
        const g = tmp[i + 1] ?? 0
        const b = tmp[i + 2] ?? 0
        if (r > mr) mr = r
        if (g > mg) mg = g
        if (b > mb) mb = b
      }
      const o = (y * width + x) * 4
      data[o] = mr
      data[o + 1] = mg
      data[o + 2] = mb
      data[o + 3] = 255
    }
  }
}

/** Two-pass sliding-window box blur on a small RGBA buffer. */
function boxBlurRgba(image: ImageData, radius: number) {
  const { data, width, height } = image
  const tmp = new Uint8ClampedArray(data.length)
  const span = radius * 2 + 1
  for (let y = 0; y < height; y += 1) {
    const row = y * width * 4
    let sr = 0
    let sg = 0
    let sb = 0
    for (let k = -radius; k <= radius; k += 1) {
      const x = Math.min(width - 1, Math.max(0, k)) * 4
      sr += data[row + x] ?? 0
      sg += data[row + x + 1] ?? 0
      sb += data[row + x + 2] ?? 0
    }
    for (let x = 0; x < width; x += 1) {
      const i = row + x * 4
      tmp[i] = sr / span
      tmp[i + 1] = sg / span
      tmp[i + 2] = sb / span
      tmp[i + 3] = 255
      const add = Math.min(width - 1, x + radius + 1) * 4
      const rem = Math.max(0, x - radius) * 4
      sr += (data[row + add] ?? 0) - (data[row + rem] ?? 0)
      sg += (data[row + add + 1] ?? 0) - (data[row + rem + 1] ?? 0)
      sb += (data[row + add + 2] ?? 0) - (data[row + rem + 2] ?? 0)
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sr = 0
    let sg = 0
    let sb = 0
    for (let k = -radius; k <= radius; k += 1) {
      const y = Math.min(height - 1, Math.max(0, k))
      const i = (y * width + x) * 4
      sr += tmp[i] ?? 0
      sg += tmp[i + 1] ?? 0
      sb += tmp[i + 2] ?? 0
    }
    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4
      data[i] = sr / span
      data[i + 1] = sg / span
      data[i + 2] = sb / span
      data[i + 3] = 255
      const addY = Math.min(height - 1, y + radius + 1)
      const remY = Math.max(0, y - radius)
      sr += (tmp[(addY * width + x) * 4] ?? 0) - (tmp[(remY * width + x) * 4] ?? 0)
      sg += (tmp[(addY * width + x) * 4 + 1] ?? 0) - (tmp[(remY * width + x) * 4 + 1] ?? 0)
      sb += (tmp[(addY * width + x) * 4 + 2] ?? 0) - (tmp[(remY * width + x) * 4 + 2] ?? 0)
    }
  }
}

function morphChannel(values: Uint8Array, width: number, height: number, radius: number, dilate: boolean): Uint8Array {
  const tmp = new Uint8Array(values.length)
  const out = new Uint8Array(values.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let best = dilate ? 0 : 255
      const x0 = Math.max(0, x - radius)
      const x1 = Math.min(width - 1, x + radius)
      for (let k = x0; k <= x1; k += 1) {
        const value = values[row + k] ?? 0
        if (dilate ? value > best : value < best) best = value
      }
      tmp[row + x] = best
    }
  }
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      let best = dilate ? 0 : 255
      const y0 = Math.max(0, y - radius)
      const y1 = Math.min(height - 1, y + radius)
      for (let k = y0; k <= y1; k += 1) {
        const value = tmp[k * width + x] ?? 0
        if (dilate ? value > best : value < best) best = value
      }
      out[y * width + x] = best
    }
  }
  return out
}

/** 5×5 luminance range — paper is flat, photos keep a midtone spread, ink is a thin spike. */
function localRange(image: ImageData): Uint8Array {
  const { data, width, height } = image
  const gray = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < gray.length; p += 1, i += 4) {
    gray[p] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  const range = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let lo = 255
      let hi = 0
      for (let dy = -2; dy <= 2; dy += 1) {
        const yy = Math.min(height - 1, Math.max(0, y + dy))
        for (let dx = -2; dx <= 2; dx += 1) {
          const xx = Math.min(width - 1, Math.max(0, x + dx))
          const value = gray[yy * width + xx] ?? 0
          if (value < lo) lo = value
          if (value > hi) hi = value
        }
      }
      range[y * width + x] = hi - lo
    }
  }
  return range
}

function paintChannel(values: Uint8Array, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas
  const image = context.createImageData(width, height)
  const data = image.data
  for (let p = 0, i = 0; p < values.length; p += 1, i += 4) {
    const value = values[p] ?? 0
    data[i] = value
    data[i + 1] = value
    data[i + 2] = value
    data[i + 3] = 255
  }
  context.putImageData(image, 0, 0)
  return canvas
}

/** 80th-percentile of each channel — the actual paper white, ignoring dark blocks. */
function paperPercentile(image: ImageData): [number, number, number] {
  const { data } = image
  const histR = new Uint32Array(256)
  const histG = new Uint32Array(256)
  const histB = new Uint32Array(256)
  const pixels = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    histR[data[i] ?? 0] += 1
    histG[data[i + 1] ?? 0] += 1
    histB[data[i + 2] ?? 0] += 1
  }
  const pick = (hist: Uint32Array) => {
    const target = pixels * 0.8
    let acc = 0
    for (let value = 0; value < 256; value += 1) {
      acc += hist[value] ?? 0
      if (acc >= target) return value
    }
    return 255
  }
  return [pick(histR), pick(histG), pick(histB)]
}

function lightingMaps(source: HTMLCanvasElement, width: number, height: number): { bg: ImageData; texture: Uint8Array } {
  const empty = { bg: new ImageData(width, height), texture: new Uint8Array(width * height) }
  const tw = Math.min(TEX_WIDTH, width)
  const th = Math.max(1, Math.round((height * tw) / Math.max(width, 1)))
  const texCanvas = downsample(source, tw, th)
  const texContext = texCanvas.getContext('2d', { willReadFrequently: true })
  if (!texContext) return empty
  const texPreview = texContext.getImageData(0, 0, tw, th)
  const range = localRange(texPreview)
  const photo = morphChannel(morphChannel(range, tw, th, 1, false), tw, th, Math.max(6, Math.round(tw * 0.045)), true)

  const lw = Math.min(LIGHT_WIDTH, width)
  const lh = Math.max(1, Math.round((height * lw) / Math.max(width, 1)))
  const lightCanvas = downsample(source, lw, lh)
  const lightContext = lightCanvas.getContext('2d', { willReadFrequently: true })
  if (!lightContext) return empty
  const preview = lightContext.getImageData(0, 0, lw, lh)
  maxFilterRgba(preview, Math.max(LIGHT_MAX, Math.round(lw * 0.24)))
  const [floorR, floorG, floorB] = paperPercentile(preview)
  const liftR = floorR * 0.92
  const liftG = floorG * 0.92
  const liftB = floorB * 0.92
  const light = preview.data
  for (let i = 0; i < light.length; i += 4) {
    if ((light[i] ?? 0) < liftR) light[i] = liftR
    if ((light[i + 1] ?? 0) < liftG) light[i + 1] = liftG
    if ((light[i + 2] ?? 0) < liftB) light[i + 2] = liftB
  }
  boxBlurRgba(preview, LIGHT_BLUR)
  lightContext.putImageData(preview, 0, 0)
  const bg = upsample(lightCanvas, width, height)
  const texture = upsample(paintChannel(photo, tw, th), width, height)
  const channel = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < channel.length; p += 1, i += 4) channel[p] = texture.data[i] ?? 0
  return { bg, texture: channel }
}

function paperKnee(luma: number) {
  if (luma >= 248) return 255
  const t = Math.min(1, Math.max(0, (luma - PAPER_KNEE) / 23))
  const s = t * t * (3 - 2 * t)
  return luma + (255 - luma) * s
}

function flattenPixel(src: Uint8ClampedArray, bg: Uint8ClampedArray, i: number) {
  const red = Math.min(255, ((src[i] ?? 0) / Math.max(bg[i] ?? 0, 18)) * 255)
  const green = Math.min(255, ((src[i + 1] ?? 0) / Math.max(bg[i + 1] ?? 0, 18)) * 255)
  const blue = Math.min(255, ((src[i + 2] ?? 0) / Math.max(bg[i + 2] ?? 0, 18)) * 255)
  return { red, green, blue, luma: 0.299 * red + 0.587 * green + 0.114 * blue }
}

function histPercentile(hist: Uint32Array, total: number, q: number) {
  const target = total * q
  let acc = 0
  for (let value = 0; value < 256; value += 1) {
    acc += hist[value] ?? 0
    if (acc >= target) return value
  }
  return q < 0.5 ? 0 : 255
}

/** 5th–95th luminance of textured photo pixels after paper flatten. */
function photoStretch(src: Uint8ClampedArray, bg: Uint8ClampedArray, texture: Uint8Array) {
  const hist = new Uint32Array(256)
  let count = 0
  const pixels = src.length / 4
  for (let p = 0, i = 0; p < pixels; p += 1, i += 4) {
    if ((texture[p] ?? 0) < PHOTO_VAR) continue
    const bin = Math.min(255, Math.max(0, Math.round(flattenPixel(src, bg, i).luma)))
    hist[bin] += 1
    count += 1
  }
  if (count < 64) return { lo: 48, hi: 210, span: 162 }
  const lo = histPercentile(hist, count, 0.05)
  const hi = histPercentile(hist, count, 0.95)
  const span = Math.max(hi - lo, 48)
  return { lo, hi: lo + span, span }
}

/**
 * Magic Color: white paper, vivid stamps/vouchers, photos with a real black point.
 * Paper vs photo is local variance — never saturation (cars and asphalt are monochrome).
 */
function magicColor(src: Uint8ClampedArray, bg: Uint8ClampedArray, texture: Uint8Array) {
  const stretch = photoStretch(src, bg, texture)
  const pixels = src.length / 4
  for (let p = 0, i = 0; p < pixels; p += 1, i += 4) {
    const { red, green, blue, luma } = flattenPixel(src, bg, i)
    const tex = texture[p] ?? 0
    const photo = tex >= PHOTO_VAR
    const flat = tex <= PAPER_FLAT
    const sat = Math.max(red, green, blue) - Math.min(red, green, blue)

    let next = luma
    if (!photo && flat && sat < 18 && luma >= PAPER_KNEE) {
      next = paperKnee(luma)
    } else if (photo) {
      next = PHOTO_BLACK + ((luma - stretch.lo) / stretch.span) * (PHOTO_WHITE - PHOTO_BLACK)
      if (next < 8) next = 8
      else if (next > 248) next = 248
    }

    const scale = luma > 1 ? next / luma : 0
    let outR = red * scale
    let outG = green * scale
    let outB = blue * scale
    if (sat > 12) {
      const mid = 0.299 * outR + 0.587 * outG + 0.114 * outB
      outR = mid + (outR - mid) * SAT_BOOST
      outG = mid + (outG - mid) * SAT_BOOST
      outB = mid + (outB - mid) * SAT_BOOST
    }
    src[i] = Math.min(255, Math.max(0, outR))
    src[i + 1] = Math.min(255, Math.max(0, outG))
    src[i + 2] = Math.min(255, Math.max(0, outB))
    src[i + 3] = 255
  }
}

/** Lightweight 3×3 Laplacian sharpen on luminance. */
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

function applyMagicColor(image: ImageData, source: HTMLCanvasElement) {
  const { bg, texture } = lightingMaps(source, image.width, image.height)
  magicColor(image.data, bg.data, texture)
  sharpen3x3(image, 0.55)
}

function applyFastBlackWhite(image: ImageData, source: HTMLCanvasElement) {
  const { bg } = lightingMaps(source, image.width, image.height)
  const { data } = image
  const light = bg.data
  for (let i = 0; i < data.length; i += 4) {
    const br = Math.max(light[i] ?? 0, 12)
    const bg_ = Math.max(light[i + 1] ?? 0, 12)
    const bb = Math.max(light[i + 2] ?? 0, 12)
    const red = ((data[i] ?? 0) / br) * 255
    const green = ((data[i + 1] ?? 0) / bg_) * 255
    const blue = ((data[i + 2] ?? 0) / bb) * 255
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue
    const ink = luma < 148 ? 0 : 255
    data[i] = ink
    data[i + 1] = ink
    data[i + 2] = ink
    data[i + 3] = 255
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

function processPixels(source: HTMLCanvasElement, run: (pixels: ImageData, canvas: HTMLCanvasElement) => void): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return source
  context.drawImage(source, 0, 0)
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  run(pixels, canvas)
  context.putImageData(pixels, 0, 0)
  return canvas
}

/** CamScanner Magic Color: white paper, vivid stamps, photos preserved. Sync, one pass. */
export async function applyCanvasMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  return processPixels(source, applyMagicColor)
}

/** Fast adaptive black and white from the same illumination map. */
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
