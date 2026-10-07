import Jscanify from 'jscanify/client'
import type { Corners, FilterMode } from '../types'
import { outputSize } from './geometry'
import { getCv, loadOpenCv, MatBin, type Cv, type CvMat } from './opencv'

function toJscanCorners(corners: Corners) {
  return {
    topLeftCorner: corners.tl,
    topRightCorner: corners.tr,
    bottomLeftCorner: corners.bl,
    bottomRightCorner: corners.br,
  }
}

function warpWithOpenCv(
  cv: Cv,
  image: CanvasImageSource,
  corners: Corners,
  width: number,
  height: number,
): HTMLCanvasElement {
  const src = cv.imread(image)
  const dst = new cv.Mat()
  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners.tl.x,
    corners.tl.y,
    corners.tr.x,
    corners.tr.y,
    corners.bl.x,
    corners.bl.y,
    corners.br.x,
    corners.br.y,
  ])
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, 0, height, width, height])
  const transform = cv.getPerspectiveTransform(srcTri, dstTri)
  try {
    cv.warpPerspective(
      src,
      dst,
      transform,
      new cv.Size(width, height),
      cv.INTER_LINEAR,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    )
    const canvas = document.createElement('canvas')
    cv.imshow(canvas, dst)
    return canvas
  } finally {
    src.delete()
    dst.delete()
    srcTri.delete()
    dstTri.delete()
    transform.delete()
  }
}

function warp(
  cv: Cv,
  image: CanvasImageSource,
  corners: Corners,
  width: number,
  height: number,
): HTMLCanvasElement {
  try {
    const scanner = new Jscanify()
    const extracted = scanner.extractPaper(image, width, height, toJscanCorners(corners))
    if (extracted && extracted.width > 0 && extracted.height > 0) return extracted
  } catch (error) {
    console.error(error)
  }
  return warpWithOpenCv(cv, image, corners, width, height)
}

function illuminationMap(cv: Cv, bin: MatBin, lightness: CvMat): CvMat {
  const smallWidth = Math.max(48, Math.round(lightness.cols / 8))
  const smallHeight = Math.max(48, Math.round(lightness.rows / 8))
  const small = bin.keep(new cv.Mat())
  cv.resize(lightness, small, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_AREA)
  const kernel = bin.keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(11, 11)))
  const closed = bin.keep(new cv.Mat())
  cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel)
  const blurred = bin.keep(new cv.Mat())
  cv.GaussianBlur(closed, blurred, new cv.Size(0, 0), 2.2)
  const illum = bin.keep(new cv.Mat())
  cv.resize(blurred, illum, new cv.Size(lightness.cols, lightness.rows), 0, 0, cv.INTER_LINEAR)
  return illum
}

function magicCurve(index: number): number {
  const x = index / 255
  let y: number
  if (x < 0.5) {
    y = (x / 0.5) ** 1.08 * 0.48
  } else if (x < 0.72) {
    const t = (x - 0.5) / 0.22
    y = 0.48 + t * 0.22
  } else {
    const t = (x - 0.72) / 0.28
    const smooth = t * t * (3 - 2 * t)
    const base = 0.7 + (x - 0.72) * 0.35
    y = base + (1 - base) * smooth * 0.95
  }
  return Math.max(0, Math.min(255, Math.round(y * 255)))
}

function curveLut(cv: Cv): CvMat {
  const lut = new cv.Mat(1, 256, cv.CV_8U)
  for (let i = 0; i < 256; i += 1) lut.data[i] = magicCurve(i)
  return lut
}

function applyMagicColor(cv: Cv, source: HTMLCanvasElement): HTMLCanvasElement {
  const bin = new MatBin()
  try {
    const src = bin.keep(cv.imread(source))
    const rgb = bin.keep(new cv.Mat())
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB)
    const lab = bin.keep(new cv.Mat())
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab)

    const lightness = bin.keep(new cv.Mat())
    cv.extractChannel(lab, lightness, 0)
    const illum = illuminationMap(cv, bin, lightness)
    const lightFloat = bin.keep(new cv.Mat())
    const illumFloat = bin.keep(new cv.Mat())
    lightness.convertTo(lightFloat, cv.CV_32F)
    illum.convertTo(illumFloat, cv.CV_32F)

    const floor = bin.keep(new cv.Mat(illumFloat.rows, illumFloat.cols, cv.CV_32F, new cv.Scalar(16)))
    cv.max(illumFloat, floor, illumFloat)
    const divided = bin.keep(new cv.Mat())
    cv.divide(lightFloat, illumFloat, divided, 248)
    const cap = bin.keep(new cv.Mat(divided.rows, divided.cols, cv.CV_32F, new cv.Scalar(255)))
    cv.min(divided, cap, divided)

    const flattened = bin.keep(new cv.Mat())
    divided.convertTo(flattened, cv.CV_8U)

    const clahe = new cv.CLAHE(1.6, new cv.Size(8, 8))
    const local = bin.keep(new cv.Mat())
    try {
      clahe.apply(flattened, local)
    } finally {
      clahe.delete()
    }

    const lut = bin.keep(curveLut(cv))
    const lifted = bin.keep(new cv.Mat())
    cv.LUT(local, lut, lifted)
    const blurred = bin.keep(new cv.Mat())
    cv.GaussianBlur(lifted, blurred, new cv.Size(0, 0), 0.8)
    const sharp = bin.keep(new cv.Mat())
    cv.addWeighted(lifted, 1.28, blurred, -0.28, 0, sharp)
    cv.insertChannel(sharp, lab, 0)

    const outRgb = bin.keep(new cv.Mat())
    cv.cvtColor(lab, outRgb, cv.COLOR_Lab2RGB)
    const canvas = document.createElement('canvas')
    cv.imshow(canvas, outRgb)
    return canvas
  } finally {
    bin.release()
  }
}

function applyBlackAndWhite(cv: Cv, source: HTMLCanvasElement): HTMLCanvasElement {
  const src = cv.imread(source)
  const gray = new cv.Mat()
  const blur = new cv.Mat()
  const bw = new cv.Mat()
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, blur, new cv.Size(3, 3), 0)
    const limit = Math.max(3, Math.min(gray.cols, gray.rows))
    let block = Math.round(limit / 28)
    if (block % 2 === 0) block += 1
    block = Math.max(15, Math.min(75, block))
    if (block >= limit) block = limit % 2 === 0 ? limit - 1 : limit
    if (block % 2 === 0) block -= 1
    block = Math.max(3, block)
    cv.adaptiveThreshold(blur, bw, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 12)
    const canvas = document.createElement('canvas')
    cv.imshow(canvas, bw)
    return canvas
  } finally {
    src.delete()
    gray.delete()
    blur.delete()
    bw.delete()
  }
}

export async function renderDocument(
  image: CanvasImageSource,
  corners: Corners,
  filter: FilterMode,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  await loadOpenCv()
  const cv = getCv()
  const size = outputSize(corners)
  let warped: HTMLCanvasElement
  try {
    warped = warp(cv, image, corners, size.width, size.height)
  } catch (error) {
    console.error(error)
    throw new Error('Could not straighten this page. Move the pins onto the corners and try again.')
  }

  if (filter === 'original') {
    return { canvas: warped, width: warped.width, height: warped.height }
  }

  try {
    const canvas = filter === 'bw' ? applyBlackAndWhite(cv, warped) : applyMagicColor(cv, warped)
    return { canvas, width: canvas.width, height: canvas.height }
  } catch (error) {
    console.error(error)
    throw new Error('Could not clean this page. Try Original, or adjust the corners.')
  }
}
