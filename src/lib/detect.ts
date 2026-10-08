import type { Corners, Point } from '../types'
import { clampPoint, cornersValid, defaultCorners, orderCorners, polygonArea } from './geometry'
import { getCv, MatBin, type Cv, type CvMat } from './opencv'

const DETECT_MAX = 1024
const DETECT_BUDGET_MS = 1400

type Scan = {
  quad: Point[] | null
  rect: Point[] | null
  /** Largest contour that is not the photo frame itself, as a fraction of the image. */
  contentRatio: number
}

function sourceSize(image: CanvasImageSource): { width: number; height: number } {
  if (image instanceof HTMLImageElement) {
    return { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height }
  }
  if (image instanceof HTMLVideoElement) return { width: image.videoWidth, height: image.videoHeight }
  if (image instanceof HTMLCanvasElement || image instanceof ImageBitmap) {
    return { width: image.width, height: image.height }
  }
  return { width: 0, height: 0 }
}

/** Draw a small copy before OpenCV so a 12–48MP photo never enters the contour pass. */
function downscaleForDetection(image: CanvasImageSource): HTMLCanvasElement {
  const { width, height } = sourceSize(image)
  const scale = Math.min(1, DETECT_MAX / Math.max(width, height, 1))
  const targetWidth = Math.max(1, Math.round(width * scale))
  const targetHeight = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return canvas

  if (typeof OffscreenCanvas !== 'undefined') {
    const offscreen = new OffscreenCanvas(targetWidth, targetHeight)
    const offscreenContext = offscreen.getContext('2d')
    if (offscreenContext) {
      offscreenContext.drawImage(image, 0, 0, targetWidth, targetHeight)
      context.drawImage(offscreen, 0, 0)
      return canvas
    }
  }

  context.drawImage(image, 0, 0, targetWidth, targetHeight)
  return canvas
}

function readPoints(mat: CvMat): Point[] {
  const points: Point[] = []
  const data = mat.data32S
  for (let i = 0; i < mat.rows; i += 1) {
    points.push({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 })
  }
  return points
}

function smoothGray(cv: Cv, bin: MatBin, src: CvMat): CvMat {
  const gray = bin.keep(new cv.Mat())
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
  const blurred = bin.keep(new cv.Mat())
  try {
    // Small radius: keeps a faint page edge, drops paper grain and text.
    cv.bilateralFilter(gray, blurred, 5, 50, 50)
  } catch {
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)
  }
  return blurred
}

function sealOutline(cv: Cv, bin: MatBin, binary: CvMat): CvMat {
  const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7)))
  const closed = bin.keep(new cv.Mat())
  cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel)
  return closed
}

function otsuMask(cv: Cv, bin: MatBin, gray: CvMat, invert: boolean): CvMat {
  const binary = bin.keep(new cv.Mat())
  const mode = (invert ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) + cv.THRESH_OTSU
  cv.threshold(gray, binary, 0, 255, mode)
  return sealOutline(cv, bin, binary)
}

function adaptiveMask(cv: Cv, bin: MatBin, gray: CvMat, invert: boolean): CvMat {
  const binary = bin.keep(new cv.Mat())
  const edge = Math.min(gray.rows, gray.cols)
  let block = edge > 48 ? 41 : Math.max(3, edge - (edge % 2 === 0 ? 1 : 0))
  if (block % 2 === 0) block -= 1
  cv.adaptiveThreshold(
    gray,
    binary,
    255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C,
    invert ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY,
    Math.max(3, block),
    6,
  )
  return sealOutline(cv, bin, binary)
}

function inspectContours(cv: Cv, mask: CvMat, imageArea: number, deadline: number): Scan {
  const empty: Scan = { quad: null, rect: null, contentRatio: 0 }
  if (performance.now() > deadline) return empty
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    const ranked: { area: number; index: number }[] = []
    let content = 0
    for (let i = 0; i < contours.size(); i += 1) {
      const area = cv.contourArea(contours.get(i))
      const ratio = area / imageArea
      if (ratio <= 0.95 && ratio > content) content = ratio
      if (ratio >= 0.15 && ratio <= 0.95) ranked.push({ area, index: i })
    }
    ranked.sort((a, b) => b.area - a.area)
    const top = ranked.slice(0, 6)

    for (const item of top) {
      if (performance.now() > deadline) break
      const contour = contours.get(item.index)
      const perimeter = cv.arcLength(contour, true)
      if (perimeter < 1) continue
      for (const factor of [0.02, 0.03, 0.04]) {
        const approx = new cv.Mat()
        try {
          cv.approxPolyDP(contour, approx, factor * perimeter, true)
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue
          const quadArea = cv.contourArea(approx)
          const ratio = quadArea / imageArea
          if (ratio < 0.15 || ratio > 0.95) continue
          const points = readPoints(approx)
          if (points.length !== 4 || !cornersValid(orderCorners(points), mask.cols, mask.rows)) continue
          return { quad: points, rect: null, contentRatio: content }
        } finally {
          approx.delete()
        }
      }
    }

    let bestRect: Point[] | null = null
    let bestRectArea = imageArea * 0.2
    for (const item of top) {
      if (item.area <= imageArea * 0.2) continue
      const contour = contours.get(item.index)
      const rect = cv.minAreaRect(contour)
      const rectArea = Math.abs(rect.size.width * rect.size.height)
      if (rectArea <= bestRectArea || rectArea > imageArea * 0.98) continue
      const vertices = cv.RotatedRect.points(rect)
      if (vertices.length !== 4) continue
      bestRectArea = rectArea
      bestRect = vertices.map((point) => ({ x: point.x, y: point.y }))
    }

    return { quad: null, rect: bestRect, contentRatio: content }
  } finally {
    contours.delete()
    hierarchy.delete()
  }
}

function scaleUp(
  point: Point,
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Point {
  return clampPoint(
    {
      x: (point.x / fromWidth) * toWidth,
      y: (point.y / fromHeight) * toHeight,
    },
    toWidth,
    toHeight,
  )
}

function toCorners(
  points: Point[],
  fromWidth: number,
  fromHeight: number,
  toWidth: number,
  toHeight: number,
): Corners | null {
  if (points.length !== 4) return null
  const corners = orderCorners(
    points.map((point) => scaleUp(point, fromWidth, fromHeight, toWidth, toHeight)),
  )
  return cornersValid(corners, toWidth, toHeight) ? corners : null
}

/**
 * Finds a page on a 1024px copy, then maps those corners back onto the full photo.
 * A convex quad wins. Otherwise the largest rotated rectangle above 20% of the frame is used.
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
): { corners: Corners; detected: boolean } {
  const cv = getCv()
  const deadline = performance.now() + DETECT_BUDGET_MS
  const bin = new MatBin()
  const missed = (): { corners: Corners; detected: boolean } => ({
    corners: defaultCorners(width, height, 0.1),
    detected: false,
  })
  try {
    const small = downscaleForDetection(image)
    const src = bin.keep(cv.imread(small))
    const gray = smoothGray(cv, bin, src)
    const imageArea = src.cols * src.rows
    let fallback: Point[] | null = null

    const take = (scan: Scan): Corners | null => {
      if (scan.rect && (!fallback || polygonArea(scan.rect) > polygonArea(fallback))) fallback = scan.rect
      if (!scan.quad) return null
      return toCorners(scan.quad, src.cols, src.rows, width, height)
    }

    const otsuScan = inspectContours(cv, otsuMask(cv, bin, gray, false), imageArea, deadline)
    const direct = take(otsuScan)
    if (direct) return { corners: direct, detected: true }

    if (otsuScan.contentRatio < 0.2 && performance.now() <= deadline) {
      const adaptive = take(inspectContours(cv, adaptiveMask(cv, bin, gray, false), imageArea, deadline))
      if (adaptive) return { corners: adaptive, detected: true }
    }

    if (performance.now() <= deadline) {
      const flippedScan = inspectContours(cv, otsuMask(cv, bin, gray, true), imageArea, deadline)
      const flipped = take(flippedScan)
      if (flipped) return { corners: flipped, detected: true }
      if (flippedScan.contentRatio < 0.2 && performance.now() <= deadline) {
        const adaptive = take(inspectContours(cv, adaptiveMask(cv, bin, gray, true), imageArea, deadline))
        if (adaptive) return { corners: adaptive, detected: true }
      }
    }

    if (fallback) {
      const corners = toCorners(fallback, src.cols, src.rows, width, height)
      if (corners) return { corners, detected: true }
    }

    return missed()
  } catch (error) {
    console.error(error)
    return missed()
  } finally {
    bin.release()
  }
}
