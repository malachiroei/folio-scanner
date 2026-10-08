import type { CornerKey, Corners, Point } from '../types'

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

export function orderCorners(points: Point[]): Corners {
  if (points.length !== 4) {
    throw new Error('A document crop needs 4 corners.')
  }
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y))
  const tl = bySum[0]
  const br = bySum[3]
  const rest = points.filter((point) => point !== tl && point !== br)
  const first = rest[0]
  const second = rest[1]
  if (!first || !second) {
    throw new Error('A document crop needs 4 corners.')
  }
  const [tr, bl] =
    first.x - first.y > second.x - second.y ? [first, second] : [second, first]
  return { tl, tr, br, bl }
}

const MAX_OUTPUT_EDGE = 2400

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
