import type { CaptureHint, CornerKey, Corners, Point } from '../types'

export const CORNER_KEYS: CornerKey[] = ['tl', 'tr', 'br', 'bl']

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function clampPoint(point: Point, width: number, height: number): Point {
  return {
    x: clamp(point.x, 0, width),
    y: clamp(point.y, 0, height),
  }
}

export function polygonArea(points: Point[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const next = points[(i + 1) % points.length]
    sum += points[i].x * next.y - next.x * points[i].y
  }
  return Math.abs(sum) / 2
}

export function cornersArea(corners: Corners): number {
  return polygonArea([corners.tl, corners.tr, corners.br, corners.bl])
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const cdx = d.x - c.x
  const cdy = d.y - c.y
  const denom = abx * cdy - aby * cdx
  if (Math.abs(denom) < 1e-6) return false
  const t = ((c.x - a.x) * cdy - (c.y - a.y) * cdx) / denom
  const u = ((c.x - a.x) * aby - (c.y - a.y) * abx) / denom
  const eps = 0.001
  return t > eps && t < 1 - eps && u > eps && u < 1 - eps
}

export function cornersValid(corners: Corners, width: number, height: number): boolean {
  const points = [corners.tl, corners.tr, corners.br, corners.bl]
  const inside = points.every(
    (point) => point.x >= -1 && point.y >= -1 && point.x <= width + 1 && point.y <= height + 1,
  )
  if (!inside) return false
  if (cornersArea(corners) < width * height * 0.02) return false
  if (segmentsIntersect(corners.tl, corners.tr, corners.br, corners.bl)) return false
  if (segmentsIntersect(corners.tr, corners.br, corners.bl, corners.tl)) return false
  const edgeWidth = Math.max(distance(corners.tl, corners.tr), distance(corners.bl, corners.br))
  const edgeHeight = Math.max(distance(corners.tl, corners.bl), distance(corners.tr, corners.br))
  return edgeWidth >= 32 && edgeHeight >= 32
}

/** Same-sign cross products around TL→TR→BR→BL. Rejects bows, arrows, and crossed pins. */
export function quadIsConvex(corners: Corners): boolean {
  const points = [corners.tl, corners.tr, corners.br, corners.bl]
  let sign = 0
  for (let i = 0; i < 4; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % 4]
    const c = points[(i + 2) % 4]
    if (!a || !b || !c) return false
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-8) continue
    const next = cross > 0 ? 1 : -1
    if (sign !== 0 && next !== sign) return false
    sign = next
  }
  return sign !== 0
}

/** Interior corner angles in degrees, in TL, TR, BR, BL order. */
export function quadAngles(corners: Corners): number[] {
  const points = [corners.tl, corners.tr, corners.br, corners.bl]
  return points.map((curr, index) => {
    const prev = points[(index + 3) % 4]
    const next = points[(index + 1) % 4]
    if (!prev || !next) return 0
    const ax = prev.x - curr.x
    const ay = prev.y - curr.y
    const bx = next.x - curr.x
    const by = next.y - curr.y
    const den = (Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1)
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / den))
    return (Math.acos(cos) * 180) / Math.PI
  })
}

/** Axis-aligned bounding rectangle of the four pins — a safe warp when the quad is twisted. */
export function boundingRectCorners(corners: Corners): Corners {
  const xs = [corners.tl.x, corners.tr.x, corners.br.x, corners.bl.x]
  const ys = [corners.tl.y, corners.tr.y, corners.br.y, corners.bl.y]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  return {
    tl: { x: minX, y: minY },
    tr: { x: maxX, y: minY },
    br: { x: maxX, y: maxY },
    bl: { x: minX, y: maxY },
  }
}

export function lerpCorners(from: Corners, to: Corners, t: number): Corners {
  const mix = (a: Point, b: Point): Point => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  })
  return {
    tl: mix(from.tl, to.tl),
    tr: mix(from.tr, to.tr),
    br: mix(from.br, to.br),
    bl: mix(from.bl, to.bl),
  }
}

export function defaultCorners(width: number, height: number, inset = 0.08): Corners {
  const x = width * inset
  const y = height * inset
  return {
    tl: { x, y },
    tr: { x: width - x, y },
    br: { x: width - x, y: height - y },
    bl: { x, y: height - y },
  }
}

/**
 * Centered portrait document box with ~10% side margins. Never the raw viewfinder
 * edge, which would include a keyboard or desk around the sheet.
 */
export function fullFrameCorners(width: number, height: number): Corners {
  return {
    tl: { x: width * 0.1, y: height * 0.08 },
    tr: { x: width * 0.9, y: height * 0.08 },
    br: { x: width * 0.9, y: height * 0.92 },
    bl: { x: width * 0.1, y: height * 0.92 },
  }
}

/**
 * A centered A4-shaped rectangle (1:1.414), upright in a portrait photo and lying down in a
 * landscape one, with `pad` of empty space on every side.
 * Used when no page is found, so the pins start near where a page usually is instead of at the
 * very edges of the photo.
 */
export function inwardPageCorners(width: number, height: number, pad = 0.06): Corners {
  const maxWidth = width * (1 - 2 * pad)
  const maxHeight = height * (1 - 2 * pad)
  const landscape = width > height * 1.05
  let pageHeight = maxHeight
  let pageWidth = landscape ? pageHeight * Math.SQRT2 : pageHeight / Math.SQRT2
  if (pageWidth > maxWidth) {
    pageWidth = maxWidth
    pageHeight = landscape ? pageWidth / Math.SQRT2 : pageWidth * Math.SQRT2
  }
  const left = (width - pageWidth) / 2
  const top = (height - pageHeight) / 2
  return {
    tl: { x: left, y: top },
    tr: { x: left + pageWidth, y: top },
    br: { x: left + pageWidth, y: top + pageHeight },
    bl: { x: left, y: top + pageHeight },
  }
}

export function orderCorners(points: Point[]): Corners {
  if (points.length !== 4) {
    throw new Error('לחיתוך דרושות 4 פינות.')
  }
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y))
  const tl = bySum[0]
  const br = bySum[3]
  const rest = points.filter((point) => point !== tl && point !== br)
  const first = rest[0]
  const second = rest[1]
  if (!first || !second) {
    throw new Error('לחיתוך דרושות 4 פינות.')
  }
  const [tr, bl] =
    first.x - first.y > second.x - second.y ? [first, second] : [second, first]
  return { tl, tr, br, bl }
}

const MAX_OUTPUT_EDGE = 3508

export function outputSize(corners: Corners): { width: number; height: number } {
  const width = Math.max(distance(corners.tl, corners.tr), distance(corners.bl, corners.br))
  const height = Math.max(distance(corners.tl, corners.bl), distance(corners.tr, corners.br))
  const longEdge = Math.max(width, height)
  const scale = longEdge > MAX_OUTPUT_EDGE ? MAX_OUTPUT_EDGE / longEdge : 1
  return {
    width: Math.max(32, Math.round(width * scale)),
    height: Math.max(32, Math.round(height * scale)),
  }
}

/**
 * Maps live-preview corners (unit 0..1 of the rendered video frame) onto the photo.
 * When the still is a different aspect (full-sensor 4:3 vs 16:9 preview), the video
 * is treated as a center crop of the photo so the orange box does not expand.
 */
export function mapLiveCorners(hint: CaptureHint, width: number, height: number): Corners | null {
  if (width < 1 || height < 1) return null
  const videoAspect = hint.aspect > 0 ? hint.aspect : width / Math.max(1, height)
  const photoAspect = width / height
  let originX = 0
  let originY = 0
  let scaleW = width
  let scaleH = height
  if (Math.abs(photoAspect - videoAspect) > 0.04) {
    if (photoAspect > videoAspect) {
      scaleH = height
      scaleW = height * videoAspect
      originX = (width - scaleW) / 2
    } else {
      scaleW = width
      scaleH = width / videoAspect
      originY = (height - scaleH) / 2
    }
  }
  const place = (point: Point): Point => {
    const nx = hint.mirrored ? 1 - point.x : point.x
    return {
      x: clamp(originX + nx * scaleW, 0, width),
      y: clamp(originY + point.y * scaleH, 0, height),
    }
  }
  const tl = place(hint.corners.tl)
  const tr = place(hint.corners.tr)
  const br = place(hint.corners.br)
  const bl = place(hint.corners.bl)
  try {
    return orderCorners([tl, tr, br, bl])
  } catch {
    return { tl, tr, br, bl }
  }
}
