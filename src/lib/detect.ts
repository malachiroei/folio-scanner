import type { Corners, Point } from '../types'
import { clampPoint, cornersValid, defaultCorners, orderCorners } from './geometry'
import { getCv, MatBin, type Cv, type CvMat } from './opencv'

const DETECT_MAX = 1024
const DETECT_BUDGET_MS = 1400

type Quad = { area: number; points: Point[] }

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

function collectQuads(cv: Cv, mask: CvMat, quads: Quad[], imageArea: number, deadline: number) {
  if (performance.now() > deadline) return
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < contours.size(); i += 1) {
      if (performance.now() > deadline) return
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area < imageArea * 0.08 || area > imageArea * 0.985) continue
      const perimeter = cv.arcLength(contour, true)
      for (const factor of [0.015, 0.02, 0.035, 0.05, 0.08]) {
        const approx = new cv.Mat()
        try {
          cv.approxPolyDP(contour, approx, factor * perimeter, true)
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const points = readPoints(approx)
            if (points.length === 4) quads.push({ area, points })
            break
          }
        } finally {
          approx.delete()
        }
      }
    }
  } finally {
    contours.delete()
    hierarchy.delete()
  }
}

function edgeMask(cv: Cv, bin: MatBin, gray: CvMat): CvMat {
  const edges = bin.keep(new cv.Mat())
  cv.Canny(gray, edges, 50, 150)
  const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)))
  const dilated = bin.keep(new cv.Mat())
  cv.dilate(edges, dilated, kernel)
  return dilated
}

function paperMask(cv: Cv, bin: MatBin, gray: CvMat): CvMat {
  const binary = bin.keep(new cv.Mat())
  cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU)
  return binary
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

/**
 * Finds the largest 4-point page on a 1024px copy, then maps those corners
 * back onto the full-resolution photo.
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
): { corners: Corners; detected: boolean } {
  const cv = getCv()
  const deadline = performance.now() + DETECT_BUDGET_MS
  const bin = new MatBin()
  try {
    const small = downscaleForDetection(image)
    const src = bin.keep(cv.imread(small))
    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)

    const quads: Quad[] = []
    const imageArea = src.cols * src.rows
    collectQuads(cv, edgeMask(cv, bin, blur), quads, imageArea, deadline)
    if (performance.now() <= deadline) {
      collectQuads(cv, paperMask(cv, bin, blur), quads, imageArea, deadline)
    }

    const ranked = quads.sort((a, b) => b.area - a.area)
    for (const quad of ranked) {
      const corners = orderCorners(
        quad.points.map((point) => scaleUp(point, src.cols, src.rows, width, height)),
      )
      if (cornersValid(corners, width, height)) return { corners, detected: true }
    }

    return { corners: defaultCorners(width, height, 0.1), detected: false }
  } catch (error) {
    console.error(error)
    return { corners: defaultCorners(width, height, 0.1), detected: false }
  } finally {
    bin.release()
  }
}
