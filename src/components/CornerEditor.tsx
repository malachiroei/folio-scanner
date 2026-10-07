import { ChevronLeft, Expand, RotateCcw } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { CORNER_KEYS, cornersValid } from '../lib/geometry'
import { useScan } from '../state/scan-context'
import type { CornerKey, Corners, Point } from '../types'
import { Button } from './Button'

const LABELS: Record<CornerKey, string> = {
  tl: 'Top left corner',
  tr: 'Top right corner',
  br: 'Bottom right corner',
  bl: 'Bottom left corner',
}

type Loupe = { x: number; y: number; point: Point }

export function CornerEditor() {
  const { draft, busy, updateCorners, resetDetection, useFullFrame, confirmCorners, backFromCorners } =
    useScan()
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null)
  const cornersRef = useRef<Corners | null>(null)
  const dragKey = useRef<CornerKey | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [active, setActive] = useState<CornerKey | null>(null)
  const [loupe, setLoupe] = useState<Loupe | null>(null)

  const width = draft?.width ?? 1
  const height = draft?.height ?? 1
  const corners = draft?.corners

  useLayoutEffect(() => {
    if (!dragKey.current && corners) cornersRef.current = corners
  }, [corners])

  useLayoutEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    const measure = () => setStage({ w: stageEl.clientWidth, h: stageEl.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stageEl)
    return () => observer.disconnect()
  }, [])

  const scale = Math.min(stage.w / width, stage.h / height)
  const fitted =
    stage.w > 0 && stage.h > 0 && Number.isFinite(scale) && scale > 0
      ? { w: width * scale, h: height * scale }
      : null
  const displayScale = fitted ? fitted.w / width : 1

  useLayoutEffect(() => {
    if (!loupe) return
    const canvas = loupeCanvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const dpr = window.devicePixelRatio || 1
    const size = 148
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const context = canvas.getContext('2d')
    if (!context) return
    const imageWindow = Math.max(24, size / 2.4 / Math.max(displayScale, 0.0001))
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.beginPath()
    context.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2 - dpr, 0, Math.PI * 2)
    context.clip()
    context.drawImage(
      image,
      loupe.point.x - imageWindow / 2,
      loupe.point.y - imageWindow / 2,
      imageWindow,
      imageWindow,
      0,
      0,
      canvas.width,
      canvas.height,
    )
    context.restore()
    context.strokeStyle = '#e7a06a'
    context.lineWidth = 1.5 * dpr
    context.beginPath()
    context.moveTo(canvas.width / 2, 14 * dpr)
    context.lineTo(canvas.width / 2, canvas.height - 14 * dpr)
    context.moveTo(14 * dpr, canvas.height / 2)
    context.lineTo(canvas.width - 14 * dpr, canvas.height / 2)
    context.stroke()
  }, [displayScale, loupe])

  if (!draft || !corners) return null
  const page = draft
  const pins = corners

  const valid = cornersValid(pins, page.width, page.height)
  const polygon = CORNER_KEYS.map((key) => `${pins[key].x},${pins[key].y}`).join(' ')

  function clientToImage(clientX: number, clientY: number): Point {
    const frame = frameRef.current
    if (!frame) return { x: 0, y: 0 }
    const rect = frame.getBoundingClientRect()
    const x = ((clientX - rect.left) / rect.width) * page.width
    const y = ((clientY - rect.top) / rect.height) * page.height
    return {
      x: Math.min(page.width, Math.max(0, x)),
      y: Math.min(page.height, Math.max(0, y)),
    }
  }

  function placeLoupe(clientX: number, clientY: number, point: Point) {
    const stageEl = stageRef.current
    if (!stageEl) return
    const rect = stageEl.getBoundingClientRect()
    const size = 148
    let x = clientX - rect.left - size / 2
    let y = clientY - rect.top - size - 36
    if (y < 8) y = clientY - rect.top + 28
    x = Math.max(8, Math.min(x, rect.width - size - 8))
    y = Math.max(8, Math.min(y, rect.height - size - 8))
    setLoupe({ x, y, point })
  }

  function movePin(event: PointerEvent<HTMLButtonElement>, key: CornerKey) {
    if (dragKey.current !== key || !cornersRef.current) return
    event.preventDefault()
    const point = clientToImage(event.clientX, event.clientY)
    const next = { ...cornersRef.current, [key]: point }
    cornersRef.current = next
    updateCorners(next)
    placeLoupe(event.clientX, event.clientY, point)
  }

  function nudge(key: CornerKey, dx: number, dy: number) {
    if (!cornersRef.current) return
    const point = cornersRef.current[key]
    const nextPoint = {
      x: Math.min(page.width, Math.max(0, point.x + dx)),
      y: Math.min(page.height, Math.max(0, point.y + dy)),
    }
    const next = { ...cornersRef.current, [key]: nextPoint }
    cornersRef.current = next
    updateCorners(next)
  }

  return (
    <div className="app-bg flex min-h-dvh flex-col text-ink dark:text-paper">
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={backFromCorners}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
          aria-label="Back"
        >
          <ChevronLeft className="size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl leading-none">Adjust corners</h1>
          <p className="mt-1 text-xs text-mist dark:text-paper/55">Drag each pin to a page corner</p>
        </div>
        <button
          type="button"
          onClick={() => void resetDetection()}
          disabled={Boolean(busy)}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
          aria-label="Detect edges again"
        >
          <RotateCcw className="size-5" />
        </button>
        <button
          type="button"
          onClick={useFullFrame}
          disabled={Boolean(busy)}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/8"
          aria-label="Use the full photo"
        >
          <Expand className="size-5" />
        </button>
      </header>

      <div ref={stageRef} className="relative min-h-0 flex-1 touch-none">
        <div className="flex h-full items-center justify-center p-3">
          {fitted && (
            <div
              ref={frameRef}
              className="relative overflow-hidden rounded-lg shadow-[0_16px_40px_rgba(20,34,28,0.18)]"
              style={{ width: fitted.w, height: fitted.h }}
            >
              <img
                ref={imageRef}
                src={draft.sourceUrl}
                alt="Photo to crop"
                draggable={false}
                className="absolute inset-0 h-full w-full select-none"
              />
              <svg
                viewBox={`0 0 ${draft.width} ${draft.height}`}
                className="absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
                <defs>
                  <mask id="folio-crop-mask">
                    <rect width={draft.width} height={draft.height} fill="white" />
                    <polygon points={polygon} fill="black" />
                  </mask>
                </defs>
                <rect
                  width={draft.width}
                  height={draft.height}
                  fill="rgba(8,14,12,0.55)"
                  mask="url(#folio-crop-mask)"
                />
                <polygon
                  points={polygon}
                  fill="transparent"
                  stroke="#e7a06a"
                  strokeWidth={2.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {CORNER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-label={LABELS[key]}
                  className="absolute z-20 size-11 -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${(corners[key].x / draft.width) * 100}%`,
                    top: `${(corners[key].y / draft.height) * 100}%`,
                    touchAction: 'none',
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    dragKey.current = key
                    setActive(key)
                    event.currentTarget.setPointerCapture(event.pointerId)
                    placeLoupe(event.clientX, event.clientY, cornersRef.current?.[key] ?? corners[key])
                  }}
                  onPointerMove={(event) => movePin(event, key)}
                  onPointerUp={() => {
                    dragKey.current = null
                    setActive(null)
                    setLoupe(null)
                  }}
                  onPointerCancel={() => {
                    dragKey.current = null
                    setActive(null)
                    setLoupe(null)
                  }}
                  onKeyDown={(event) => {
                    const step = event.shiftKey ? 12 : 2
                    const delta: Record<string, [number, number] | undefined> = {
                      ArrowLeft: [-step, 0],
                      ArrowRight: [step, 0],
                      ArrowUp: [0, -step],
                      ArrowDown: [0, step],
                    }
                    const move = delta[event.key]
                    if (!move) return
                    event.preventDefault()
                    nudge(key, move[0], move[1])
                  }}
                >
                  <span
                    className={`pointer-events-none absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-copper shadow-md ${
                      active === key ? 'scale-125' : ''
                    }`}
                  />
                </button>
              ))}
            </div>
          )}
        </div>
        {loupe && (
          <div
            className="pointer-events-none absolute z-30 size-36 overflow-hidden rounded-full border-4 border-white shadow-2xl"
            style={{ left: loupe.x, top: loupe.y }}
            aria-hidden="true"
          >
            <canvas ref={loupeCanvasRef} className="h-full w-full" />
          </div>
        )}
      </div>

      <footer className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-center text-sm text-mist dark:text-paper/60">
          {!draft.detected
            ? "Edges weren't found automatically. Drag the pins onto the page."
            : valid
              ? 'A magnifier follows your finger while you drag.'
              : 'Those edges cross. Separate the pins so they frame the page.'}
        </p>
        <Button className="w-full" disabled={!valid || Boolean(busy)} onClick={confirmCorners}>
          Straighten page
        </Button>
      </footer>
    </div>
  )
}
