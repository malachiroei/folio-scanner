import type { Corners, Point } from '../types'
import { isOpenCvReady, type Cv, type CvMat, type CvMatVector } from './opencv'

const DETECT_WIDTH = 320
const MIN_AREA = 0.1
const MAX_AREA = 0.92

const sample = document.createElement('canvas')
const sampleCtx = sample.getContext('2d', { willReadFrequently: true })

function sourceSize(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement) {
  if (source instanceof HTMLVideoElement) return { width: source.videoWidth, height: source.videoHeight }
  if (source instanceof HTMLImageElement) {
    return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height }
  }
  return { width: source.width, height: source.height }
}

function grabFrame(source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement): ImageData | null {
  if (!sampleCtx) return null
  const { width: sw, height: sh } = sourceSize(source)
  if (sw < 8 || sh < 8) return null
  const scale = Math.min(1, DETECT_WIDTH / sw)
  const width = Math.max(1, Math.round(sw * scale))
  const height = Math.max(1, Math.round(sh * scale))
  if (sample.width !== width) sample.width = width
  if (sample.height !== height) sample.height = height
  sampleCtx.drawImage(source, 0, 0, width, height)
  return sampleCtx.getImageData(0, 0, width, height)
}

function orderCorners(points: Point[]): Corners {
  let tl = points[0]!
  let tr = points[0]!
  let br = points[0]!
  let bl = points[0]!
  let minSum = Number.POSITIVE_INFINITY
  let maxSum = Number.NEGATIVE_INFINITY
  let minDiff = Number.POSITIVE_INFINITY
  let maxDiff = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const sum = point.x + point.y
    const diff = point.x - point.y
    if (sum < minSum) {
      minSum = sum
      tl = point
    }
    if (sum > maxSum) {
      maxSum = sum
      br = point
    }
    if (diff > maxDiff) {
      maxDiff = diff
      tr = point
    }
    if (diff < minDiff) {
      minDiff = diff
      bl = point
    }
  }
  return { tl, tr, br, bl }
}

function toUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x / width, y: point.y / height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

export function cornersFromUnit(corners: Corners, width: number, height: number): Corners {
  const n = (point: Point) => ({ x: point.x * width, y: point.y * height })
  return { tl: n(corners.tl), tr: n(corners.tr), br: n(corners.br), bl: n(corners.bl) }
}

function lumaOf(image: ImageData): Float32Array {
  const gray = new Float32Array(image.width * image.height)
  const data = image.data
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0)
  }
  return gray
}

function blur5(gray: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(gray.length)
  const out = new Float32Array(gray.length)
  for (let y = 0; y < height; y += 1) {
    const row = y * width
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let k = -2; k <= 2; k += 1) {
        const xx = x + k
        if (xx < 0 || xx >= width) continue
        sum += gray[row + xx] ?? 0
        count += 1
      }
      tmp[row + x] = sum / count
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0
      let count = 0
      for (let k = -2; k <= 2; k += 1) {
        const yy = y + k
        if (yy < 0 || yy >= height) continue
        sum += tmp[yy * width + x] ?? 0
        count += 1
      }
      out[y * width + x] = sum / count
    }
  }
  return out
}

function otsu(gray: Float32Array): number {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i += 1) {
    hist[Math.max(0, Math.min(255, Math.round(gray[i] ?? 0)))] += 1
  }
  const total = gray.length
  let sumAll = 0
  for (let level = 0; level < 256; level += 1) sumAll += level * (hist[level] ?? 0)
  let weightBack = 0
  let sumBack = 0
  let best = -1
  let threshold = 180
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

function morph(mask: Uint8Array, width: number, height: number, radius: number, erode: boolean): Uint8Array {
  const out = new Uint8Array(mask.length)
  const want = erode ? 0 : 1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hit = erode ? 1 : 0
      outer: for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        const row = yy * width
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          if (mask[row + xx] === want) {
            hit = want
            break outer
          }
        }
      }
      out[y * width + x] = hit
    }
  }
  return out
}

function largestBlob(mask: Uint8Array, width: number, height: number): Point[] | null {
  const frame = width * height
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  let best: Point[] | null = null
  let bestArea = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    let top = 0
    stack[top] = start
    top += 1
    seen[start] = 1
    let count = 0
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    let tl = { x: 0, y: 0 }
    let tr = { x: 0, y: 0 }
    let br = { x: 0, y: 0 }
    let bl = { x: 0, y: 0 }
    let minSum = Number.POSITIVE_INFINITY
    let maxSum = Number.NEGATIVE_INFINITY
    let minDiff = Number.POSITIVE_INFINITY
    let maxDiff = Number.NEGATIVE_INFINITY
    while (top > 0) {
      top -= 1
      const index = stack[top] ?? 0
      const x = index % width
      const y = (index - x) / width
      count += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      const sum = x + y
      const diff = x - y
      if (sum < minSum) {
        minSum = sum
        tl = { x, y }
      }
      if (sum > maxSum) {
        maxSum = sum
        br = { x, y }
      }
      if (diff > maxDiff) {
        maxDiff = diff
        tr = { x, y }
      }
      if (diff < minDiff) {
        minDiff = diff
        bl = { x, y }
      }
      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1
        stack[top] = index - 1
        top += 1
      }
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1
        stack[top] = index + 1
        top += 1
      }
      if (y > 0 && mask[index - width] && !seen[index - width]) {
        seen[index - width] = 1
        stack[top] = index - width
        top += 1
      }
      if (y < height - 1 && mask[index + width] && !seen[index + width]) {
        seen[index + width] = 1
        stack[top] = index + width
        top += 1
      }
    }
    const frac = count / frame
    if (frac < MIN_AREA || frac > MAX_AREA) continue
    const touch =
      Number(minX <= 1) + Number(minY <= 1) + Number(maxX >= width - 2) + Number(maxY >= height - 2)
    if (touch >= 3 || count < bestArea) continue
    bestArea = count
    best = [tl, tr, br, bl]
  }
  return best
}

function detectCanvas(image: ImageData): Corners | null {
  const { width, height } = image
  const blur = blur5(lumaOf(image), width, height)
  const threshold = Math.min(245, Math.max(150, otsu(blur)))
  const mask = new Uint8Array(blur.length)
  for (let i = 0; i < blur.length; i += 1) {
    if ((blur[i] ?? 0) > threshold) mask[i] = 1
  }
  const closed = morph(morph(mask, width, height, 2, false), width, height, 2, true)
  const box = largestBlob(closed, width, height)
  if (!box) return null
  return toUnit(orderCorners(box), width, height)
}

function release(...mats: Array<CvMat | CvMatVector | null | undefined>) {
  for (const mat of mats) {
    try {
      mat?.delete()
    } catch {
      // Already freed by OpenCV.js.
    }
  }
}

function boxPoints(cv: Cv, contour: CvMat): Point[] {
  const rect = cv.minAreaRect(contour)
  const fromApi = cv.RotatedRect?.points?.(rect)
  if (fromApi?.length === 4) return fromApi
  const { center, size, angle } = rect
  const rad = (angle * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const hw = size.width / 2
  const hh = size.height / 2
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ].map((point) => ({
    x: center.x + point.x * cos - point.y * sin,
    y: center.y + point.x * sin + point.y * cos,
  }))
}

function detectOpenCv(cv: Cv, image: ImageData): Corners | null {
  let src: CvMat | undefined
  let gray: CvMat | undefined
  let blurred: CvMat | undefined
  let thresh: CvMat | undefined
  let kernel: CvMat | undefined
  let contours: CvMatVector | undefined
  let hierarchy: CvMat | undefined
  let best: CvMat | undefined
  try {
    src = typeof cv.matFromImageData === 'function' ? cv.matFromImageData(image) : cv.imread(sample)
    const width = src.cols
    const height = src.rows
    gray = new cv.Mat()
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    blurred = new cv.Mat()
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
    thresh = new cv.Mat()
    cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 15, 4)
    kernel =
      typeof cv.Mat.ones === 'function'
        ? cv.Mat.ones(5, 5, cv.CV_8U)
        : cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
    cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel)
    contours = new cv.MatVector()
    hierarchy = new cv.Mat()
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
    let bestArea = 0
    const frame = width * height
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      const frac = area / frame
      if (frac < MIN_AREA || frac > MAX_AREA || area <= bestArea) {
        contour.delete()
        continue
      }
      release(best)
      best = contour
      bestArea = area
    }
    if (!best) return null
    const points = boxPoints(cv, best)
    if (points.length < 4) return null
    return toUnit(orderCorners(points), width, height)
  } finally {
    release(src, gray, blurred, thresh, kernel, contours, hierarchy, best)
  }
}

/**
 * Always searches: canvas Otsu for white paper on a light desk, OpenCV if it is already loaded.
 * Never requires WASM — the live camera used to sit on "מחפש מסמך..." until OpenCV finished (it never did).
 */
export function detectDocumentCorners(
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
  cv?: Cv | null,
): Corners | null {
  const image = grabFrame(source)
  if (!image) return null
  try {
    if (cv && isOpenCvReady()) {
      const found = detectOpenCv(cv, image)
      if (found) return found
    }
  } catch (err) {
    console.warn('Detection failed:', err)
  }
  try {
    return detectCanvas(image)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  }
}
