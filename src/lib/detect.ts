import Jscanify from 'jscanify/client'
import type { Corners, Point } from '../types'
import { clampPoint, cornersValid, defaultCorners, orderCorners } from './geometry'
import { getCv, MatBin, type Cv, type CvMat } from './opencv'

type Quad = { area: number; points: Point[] }

function readPoints(mat: CvMat): Point[] {
  const points: Point[] = []
  const data = mat.data32S
  for (let i = 0; i < mat.rows; i += 1) {
    points.push({ x: data[i * 2] ?? 0, y: data[i * 2 + 1] ?? 0 })
  }
  return points
}

function collectQuads(cv: Cv, mask: CvMat, quads: Quad[], imageArea: number) {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area < imageArea * 0.1) continue
      const perimeter = cv.arcLength(contour, true)
      for (const factor of [0.012, 0.02, 0.032, 0.05]) {
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

function largestContourCorners(cv: Cv, mask: CvMat, imageArea: number): Point[] | null {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  let best: CvMat | null = null
  let bestArea = 0
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE)
    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i)
      const area = cv.contourArea(contour)
      if (area > bestArea) {
        bestArea = area
        best?.delete()
        best = contour.clone()
      }
    }
    if (!best || bestArea < imageArea * 0.12) return null

    try {
      const scanner = new Jscanify()
      const found = scanner.getCornerPoints(best)
      if (
        found.topLeftCorner &&
        found.topRightCorner &&
        found.bottomRightCorner &&
        found.bottomLeftCorner
      ) {
        return [
          found.topLeftCorner,
          found.topRightCorner,
          found.bottomRightCorner,
          found.bottomLeftCorner,
        ]
      }
    } catch (error) {
      console.error(error)
    }

    try {
      const rect = cv.minAreaRect(best)
      const points = cv.RotatedRect.points(rect)
      if (points.length === 4) return points
    } catch (error) {
      console.error(error)
    }
    return null
  } finally {
    best?.delete()
    contours.delete()
    hierarchy.delete()
  }
}

function edgeMask(cv: Cv, bin: MatBin, gray: CvMat): CvMat {
  const edges = bin.keep(new cv.Mat())
  cv.Canny(gray, edges, 40, 130)
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

/**
 * Finds a page quadrilateral. Quadrilaterals come from OpenCV contours.
 * If the page isn't a clean 4-point contour, jscanify's corner picker runs
 * on the largest contour we still own (its own finder frees that contour).
 */
export function detectDocumentCorners(
  image: CanvasImageSource,
  width: number,
  height: number,
): { corners: Corners; detected: boolean } {
  const cv = getCv()
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(image))
    const maxDim = 900
    const scale = Math.min(1, maxDim / Math.max(src.cols, src.rows))
    const smallWidth = Math.max(1, Math.round(src.cols * scale))
    const smallHeight = Math.max(1, Math.round(src.rows * scale))
    const small = bin.keep(new cv.Mat())
    cv.resize(src, small, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_AREA)

    const gray = bin.keep(new cv.Mat())
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY)
    const blur = bin.keep(new cv.Mat())
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0)

    const edges = edgeMask(cv, bin, blur)
    const paper = paperMask(cv, bin, blur)
    const quads: Quad[] = []
    const imageArea = smallWidth * smallHeight
    collectQuads(cv, edges, quads, imageArea)
    collectQuads(cv, paper, quads, imageArea)

    const ranked = quads
      .filter((quad) => quad.area > imageArea * 0.12 && quad.area < imageArea * 0.995)
      .sort((a, b) => b.area - a.area)

    for (const quad of ranked) {
      const corners = orderCorners(
        quad.points.map((point) => scaleCorner(point, scale, width, height)),
      )
      if (cornersValid(corners, width, height)) return { corners, detected: true }
    }

    const fallback = largestContourCorners(cv, edges, imageArea)
    if (fallback) {
      const corners = orderCorners(fallback.map((point) => scaleCorner(point, scale, width, height)))
      if (cornersValid(corners, width, height)) return { corners, detected: true }
    }

    return { corners: defaultCorners(width, height, 0.07), detected: false }
  } catch (error) {
    console.error(error)
    return { corners: defaultCorners(width, height, 0.07), detected: false }
  } finally {
    bin.release()
  }
}

function scaleCorner(point: Point, scale: number, width: number, height: number): Point {
  return clampPoint({ x: point.x / scale, y: point.y / scale }, width, height)
}
