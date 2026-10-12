import type { CaptureHint, Corners, Point } from '../types'

/**
 * Last orange-box lock. Survives CameraCapture unmount (screen → prepare → crop)
 * so crop pins are not reset to the dummy 10% box.
 */
let locked: CaptureHint | null = null

function copyPoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function copyCorners(corners: Corners): Corners {
  return {
    tl: copyPoint(corners.tl),
    tr: copyPoint(corners.tr),
    br: copyPoint(corners.br),
    bl: copyPoint(corners.bl),
  }
}

export function rememberLiveLock(hint: CaptureHint) {
  locked = {
    corners: copyCorners(hint.corners),
    aspect: hint.aspect,
    mirrored: hint.mirrored,
  }
}

export function peekLiveLock(): CaptureHint | null {
  return locked
}

export function consumeLiveLock(): CaptureHint | null {
  const hint = locked
  locked = null
  return hint
}

export function clearLiveLock() {
  locked = null
}
