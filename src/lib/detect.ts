import type { Corners, Point } from '../types'
import { MatBin, type Cv, type CvMat } from './opencv'

const DETECT_WIDTH = 360
const MIN_AREA = 0.15
const MAX_AREA = 0.95

function readPoints(mat: CvMat): Point[] {
  const points: Point[] = []
  const data = mat.data32S
  for (let i = 0; i < mat.rows; i += 1) {
    points.push({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 })
  }
  return points
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

function boxPoints(cv: Cv, hull: CvMat): Point[] {
  const rect = cv.minAreaRect(hull)
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

function closeMask(cv: Cv, bin: MatBin, src: CvMat, kernel: CvMat): CvMat {
  const closed = bin.keep(new cv.Mat())
  cv.morphologyEx(src, closed, cv.MORPH_CLOSE, kernel)
  return closed
}

function largestSheet(cv: Cv, bin: MatBin, mask: CvMat, width: number, height: number): CvMat | null {
  const work = bin.keep(mask.clone())
  const contours = bin.keep(new cv.MatVector())
  const hierarchy = bin.keep(new cv.Mat())
  cv.findContours(work, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)
  const frame = width * height
  let best: CvMat | null = null
  let bestArea = 0
  for (let i = 0; i < contours.size(); i += 1) {
    const contour = contours.get(i)
    const area = cv.contourArea(contour)
    const frac = area / frame
    if (frac <= MIN_AREA || frac >= MAX_AREA) continue
    if (area > bestArea) {
      bestArea = area
      best = contour
    }
  }
  return best
}

function quadFromContour(cv: Cv, bin: MatBin, contour: CvMat, width: number, height: number): Corners | null {
  const hull = bin.keep(new cv.Mat())
  cv.convexHull(contour, hull, false, true)
  const poly = bin.keep(new cv.Mat())
  cv.approxPolyDP(hull, poly, 0.02 * cv.arcLength(hull, true), true)
  const points = poly.rows === 4 ? readPoints(poly) : boxPoints(cv, hull)
  if (points.length < 4) return null
  return toUnit(orderCorners(points), width, height)
}

/**
 * White sheet on a light desk: Otsu / saturation / adaptive — not fixed Canny.
 * Returns unit 0..1 corners, or null when the frame is empty.
 */
export function detectDocumentCorners(
  cv: Cv,
  source: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement,
): Corners | null {
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(source))
    if (src.cols < 8 || src.rows < 8) return null
    const scale = Math.min(1, DETECT_WIDTH / src.cols)
    const width = Math.max(1, Math.round(src.cols * scale))
    const height = Math.max(1, Math.round(src.rows * scale))
    const small = bin.keep(new cv.Mat())
    cv.resize(src, small, new cv.Size(width, height), 0, 0, cv.INTER_AREA)

    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)
    const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))

    const luma = bin.keep(new cv.Mat())
    cv.threshold(blur, luma, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
    let sheet = largestSheet(cv, bin, closeMask(cv, bin, luma, kernel), width, height)

    if (!sheet) {
      const rgb = bin.keep(new cv.Mat())
      const hsv = bin.keep(new cv.Mat())
      const sat = bin.keep(new cv.Mat())
      const paper = bin.keep(new cv.Mat())
      cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB)
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV)
      cv.extractChannel(hsv, sat, 1)
      cv.threshold(sat, paper, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU)
      sheet = largestSheet(cv, bin, closeMask(cv, bin, paper, kernel), width, height)
    }

    if (!sheet) {
      const adapt = bin.keep(new cv.Mat())
      cv.adaptiveThreshold(blur, adapt, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 4)
      sheet = largestSheet(cv, bin, closeMask(cv, bin, adapt, kernel), width, height)
    }

    return sheet ? quadFromContour(cv, bin, sheet, width, height) : null
  } catch (err) {
    console.error('Detect error:', err)
    return null
  } finally {
    bin.release()
  }
}
