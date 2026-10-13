import type { Corners, Point } from '../types'
import type { Cv, CvMat, CvMatVector } from './opencv'

const DETECT_WIDTH = 320
const MIN_AREA = 0.1

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
  if (typeof cv.boxPoints === 'function') {
    const mat = cv.boxPoints(rect)
    try {
      const data = mat.data32F
      return [0, 1, 2, 3].map((i) => ({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 }))
    } finally {
      mat.delete()
    }
  }
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

/**
 * One adaptive-threshold pass on a 320px canvas. Every Mat is deleted in `finally`
 * so the live camera cannot exhaust OpenCV WASM memory.
 */
export function detectDocumentCorners(
  cv: Cv,
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  const image = grabFrame(source)
  if (!image) return null

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
    cv.adaptiveThreshold(
      blurred,
      thresh,
      255,
      cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV,
      15,
      4,
    )
    kernel =
      typeof cv.Mat.ones === 'function'
        ? cv.Mat.ones(5, 5, cv.CV_8U)
        : cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
    cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel)
    contours = new cv.MatVector()
    hierarchy = new cv.Mat()
    cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    let bestArea = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area > bestArea) {
        release(best)
        best = contour
        bestArea = area
      } else {
        contour.delete()
      }
    }

    if (!best || bestArea < width * height * MIN_AREA) return null
    const points = boxPoints(cv, best)
    if (points.length < 4) return null
    return toUnit(orderCorners(points), width, height)
  } catch (err) {
    console.warn('Detection failed:', err)
    return null
  } finally {
    release(src, gray, blurred, thresh, kernel, contours, hierarchy, best)
  }
}
