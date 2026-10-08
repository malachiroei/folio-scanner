import { ChevronLeft, ChevronRight, Expand, RotateCcw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { CORNER_KEYS, cornersValid, defaultCorners, lerpCorners } from '../lib/geometry'
import { useScan } from '../state/scan-context'
import type { CornerKey, Corners, Point } from '../types'
import { Button } from './Button'

const LABELS: Record<CornerKey, string> = {
  tl: 'פינה שמאלית עליונה',
  tr: 'פינה ימנית עליונה',
  br: 'פינה ימנית תחתונה',
  bl: 'פינה שמאלית תחתונה',
}

const LOUPE = 184

type Loupe = { x: number; y: number; point: Point; key: CornerKey }

function buzz(duration: number) {
  try {
    navigator.vibrate?.(duration)
  } catch {
    // Vibration is optional and some browsers block it.
  }
}

function stopGesture(event: { preventDefault: () => void; stopPropagation?: () => void }) {
  try {
    event.preventDefault()
    event.stopPropagation?.()
  } catch (error) {
    console.error(error)
  }
}

export function CornerEditor() {
  const { draft, updateCorners, resetDetection, resetPins, useFullFrame, confirmCorners, backFromCorners } =
    useScan()
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const loupeCanvasRef = useRef<HTMLCanvasElement>(null)
  const cornersRef = useRef<Corners | null>(null)
  const visualRef = useRef<Corners | null>(null)
  const dragKey = useRef<CornerKey | null>(null)
  const dragged = useRef(false)
  const seenSnap = useRef(0)
  const pageRef = useRef(draft)
  const animRef = useRef(0)
  const animSettled = useRef(false)
  const [visual, setVisual] = useState<Corners | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [active, setActive] = useState<CornerKey | null>(null)
  const [loupe, setLoupe] = useState<Loupe | null>(null)

  const width = draft?.width ?? 1
  const height = draft?.height ?? 1
  const corners = draft?.corners

  useLayoutEffect(() => {
    pageRef.current = draft
    if (!draft?.corners || draft.snapToken !== seenSnap.current || dragKey.current) return
    cancelAnimationFrame(animRef.current)
    animRef.current = 0
    animSettled.current = true
    visualRef.current = draft.corners
    cornersRef.current = draft.corners
    setVisual(draft.corners)
  }, [draft])

  useEffect(() => {
    const page = pageRef.current
    if (!page || page.snapToken === 0 || page.snapToken === seenSnap.current) return
    const token = page.snapToken
    const to = page.corners
    const previous = seenSnap.current
    seenSnap.current = token
    if (dragKey.current) {
      visualRef.current = to
      cornersRef.current = to
      setVisual(to)
      return
    }
    animSettled.current = false
    const from = visualRef.current ?? defaultCorners(page.width, page.height, 0.1)
    visualRef.current = from
    cornersRef.current = from
    setVisual(from)
    const start = performance.now()
    const step = (now: number) => {
      if (dragKey.current) {
        animSettled.current = true
        animRef.current = 0
        return
      }
      const t = Math.min(1, (now - start) / 420)
      const next = t >= 1 ? to : lerpCorners(from, to, 1 - (1 - t) ** 3)
      visualRef.current = next
      cornersRef.current = next
      setVisual(next)
      if (t < 1) animRef.current = requestAnimationFrame(step)
      else {
        animSettled.current = true
        animRef.current = 0
      }
    }
    animRef.current = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(animRef.current)
      animRef.current = 0
      if (!animSettled.current) seenSnap.current = previous
    }
  }, [draft?.snapToken])

  useLayoutEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    const measure = () => setStage({ w: stageEl.clientWidth, h: stageEl.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stageEl)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const stageEl = stageRef.current
    if (!stageEl) return
    const blockScroll = (event: TouchEvent) => {
      if (dragKey.current) event.preventDefault()
    }
    stageEl.addEventListener('touchstart', blockScroll, { passive: false })
    stageEl.addEventListener('touchmove', blockScroll, { passive: false })
    return () => {
      stageEl.removeEventListener('touchstart', blockScroll)
      stageEl.removeEventListener('touchmove', blockScroll)
    }
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
    const size = LOUPE
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const context = canvas.getContext('2d')
    if (!context) return
    const imageWindow = Math.max(18, size / 3.8 / Math.max(displayScale, 0.0001))
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
    const cx = canvas.width / 2
    const cy = canvas.height / 2
    const gap = 14 * dpr
    const arm = 18 * dpr
    context.lineCap = 'round'
    context.strokeStyle = 'rgba(255,255,255,0.95)'
    context.lineWidth = 4 * dpr
    context.beginPath()
    context.moveTo(cx, cy - gap - arm)
    context.lineTo(cx, cy - gap)
    context.moveTo(cx, cy + gap)
    context.lineTo(cx, cy + gap + arm)
    context.moveTo(cx - gap - arm, cy)
    context.lineTo(cx - gap, cy)
    context.moveTo(cx + gap, cy)
    context.lineTo(cx + gap + arm, cy)
    context.stroke()
    context.strokeStyle = '#c56a3d'
    context.lineWidth = 2 * dpr
    context.stroke()
    context.fillStyle = '#ffffff'
    context.beginPath()
    context.arc(cx, cy, 3.2 * dpr, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = '#c56a3d'
    context.lineWidth = 1.5 * dpr
    context.stroke()
  }, [displayScale, loupe])

  if (!draft || !corners) return null
  const page = draft
  const pins = visual ?? corners

  const valid = cornersValid(page.corners, page.width, page.height)
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
    const size = LOUPE
    let x = clientX - rect.left - size / 2
    let y = clientY - rect.top - size - 36
    if (y < 8) y = clientY - rect.top + 28
    x = Math.max(8, Math.min(x, rect.width - size - 8))
    y = Math.max(8, Math.min(y, rect.height - size - 8))
    setLoupe({ x, y, point, key: dragKey.current ?? 'tl' })
  }

  function movePin(event: PointerEvent<HTMLDivElement>, key: CornerKey) {
    if (dragKey.current !== key || !cornersRef.current) return
    if (event.pointerType === 'mouse' && event.buttons === 0) return
    stopGesture(event)
    const point = clientToImage(event.clientX, event.clientY)
    const next = { ...cornersRef.current, [key]: point }
    dragged.current = true
    cornersRef.current = next
    visualRef.current = next
    setVisual(next)
    placeLoupe(event.clientX, event.clientY, point)
  }

  function finishDrag() {
    const next = visualRef.current
    const moved = dragged.current
    dragged.current = false
    dragKey.current = null
    if (moved && next) {
      buzz(8)
      updateCorners(next)
    }
    setActive(null)
    setLoupe(null)
  }

  function processPage() {
    try {
      const next = dragKey.current ? (visualRef.current ?? page.corners) : page.corners
      if (!cornersValid(next, page.width, page.height)) {
        console.error('הפינות לא יוצרות מרובע מושלם, ממשיכים לעיבוד', next)
      }
      updateCorners(next)
      confirmCorners()
    } catch (error) {
      console.error(error)
    }
  }

  function nudge(key: CornerKey, dx: number, dy: number) {
    if (!cornersRef.current) return
    const point = cornersRef.current[key]
    const nextPoint = {
      x: Math.min(page.width, Math.max(0, point.x + dx)),
      y: Math.min(page.height, Math.max(0, point.y + dy)),
    }
    const next = { ...cornersRef.current, [key]: nextPoint }
    dragged.current = true
    cornersRef.current = next
    visualRef.current = next
    setVisual(next)
    updateCorners(next)
  }

  return (
    <div className="app-bg flex h-dvh max-h-dvh flex-col overflow-hidden text-ink dark:text-paper">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={backFromCorners}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
          aria-label="חזרה"
        >
          <ChevronLeft className="dir-icon size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl leading-none font-semibold">התאמת פינות</h1>
          <p className="mt-1 text-xs text-mist dark:text-paper/55">גרור כל פינה לקצה המסמך</p>
        </div>
        <button
          type="button"
          onClick={resetDetection}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          aria-label="זיהוי שוליים מחדש"
        >
          <RotateCcw className="size-5" />
        </button>
        <button
          type="button"
          onClick={useFullFrame}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          aria-label="השתמש בתמונה המלאה"
        >
          <Expand className="size-5" />
        </button>
      </header>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden select-none"
        style={{ touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div className="flex h-full items-center justify-center p-3">
          {fitted && (
            <div
              ref={frameRef}
              className="relative touch-none select-none"
              style={{ width: fitted.w, height: fitted.h, touchAction: 'none', userSelect: 'none' }}
            >
              <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl shadow-[0_16px_40px_rgba(20,34,28,0.18)]">
              <img
                ref={imageRef}
                src={draft.sourceUrl}
                alt="תמונה לחיתוך"
                draggable={false}
                className="absolute inset-0 h-full w-full select-none"
              />
              <svg
                viewBox={`0 0 ${draft.width} ${draft.height}`}
                className="pointer-events-none absolute inset-0 h-full w-full touch-none select-none"
                style={{ touchAction: 'none' }}
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
                {active && (
                  <g pointerEvents="none">
                    <line
                      x1={pins[active].x}
                      y1={0}
                      x2={pins[active].x}
                      y2={draft.height}
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={0}
                      y1={pins[active].y}
                      x2={draft.width}
                      y2={pins[active].y}
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={pins[active].x}
                      y1={0}
                      x2={pins[active].x}
                      y2={draft.height}
                      stroke="#c56a3d"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={0}
                      y1={pins[active].y}
                      x2={draft.width}
                      y2={pins[active].y}
                      stroke="#c56a3d"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  </g>
                )}
              </svg>
              </div>
              {CORNER_KEYS.map((key) => (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  aria-label={LABELS[key]}
                  className={`absolute z-20 h-14 w-14 -translate-x-1/2 -translate-y-1/2 touch-none select-none ${
                    active === key ? 'z-30' : ''
                  }`}
                  style={{
                    left: `${(pins[key].x / draft.width) * 100}%`,
                    top: `${(pins[key].y / draft.height) * 100}%`,
                    touchAction: 'none',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  }}
                  onPointerDown={(event) => {
                    stopGesture(event)
                    cancelAnimationFrame(animRef.current)
                    animRef.current = 0
                    animSettled.current = true
                    seenSnap.current = page.snapToken
                    dragged.current = false
                    const current = visualRef.current ?? page.corners
                    cornersRef.current = current
                    dragKey.current = key
                    setActive(key)
                    buzz(12)
                    try {
                      event.currentTarget.setPointerCapture(event.pointerId)
                    } catch (error) {
                      console.error(error)
                    }
                    placeLoupe(event.clientX, event.clientY, current[key])
                  }}
                  onPointerMove={(event) => movePin(event, key)}
                  onPointerUp={finishDrag}
                  onPointerCancel={finishDrag}
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
                    className={`pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-white bg-copper ${
                      active === key
                        ? 'size-9 border-[3px] shadow-[0_0_0_7px_rgba(197,106,61,0.35)]'
                        : 'size-5 border-2 shadow-md'
                    }`}
                  >
                    <span className="absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {loupe && (
          <div
            className="pointer-events-none absolute z-30"
            style={{ left: loupe.x, top: loupe.y, width: LOUPE }}
            aria-hidden="true"
          >
            <div className="h-[184px] w-[184px] overflow-hidden rounded-full border-4 border-white shadow-[0_12px_40px_rgba(20,34,28,0.35)] ring-2 ring-copper">
              <canvas ref={loupeCanvasRef} className="h-full w-full" />
            </div>
            <p className="mt-1 rounded-full bg-ink/85 px-2 py-1 text-center text-[11px] font-semibold text-white">
              {LABELS[loupe.key]}
            </p>
          </div>
        )}
      </div>

      <footer className="relative z-40 shrink-0 space-y-3 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <p className="text-center text-sm text-mist dark:text-paper/60">
          {active
            ? `${LABELS[active]}. הצלב מסמן את הפינה המדויקת.`
            : page.detecting
              ? 'מחפש את העמוד. אפשר לגרור פינה בכל רגע.'
              : !page.detected
                ? 'לא זוהו שוליים באופן אוטומטי. גרור את הפינות ידנית.'
                : valid
                  ? 'גרור פינה. הזכוכית המגדלת והצלב מסמנים את הנקודה המדויקת.'
                  : 'הקווים נחתכים. הרחק את הפינות כך שיקיפו את העמוד.'}
        </p>
        <button
          type="button"
          onClick={resetPins}
          className="mx-auto block min-h-11 rounded-2xl bg-paper px-4 py-2 text-sm font-semibold text-ink shadow-[0_8px_20px_rgba(20,34,28,0.08)] ring-1 ring-black/10 active:scale-[0.98] dark:bg-night-2 dark:text-paper dark:ring-white/10"
        >
          אפס פינות
        </button>
        <Button className="relative z-40 w-full" onClick={processPage}>
          המשך לעיבוד
          <ChevronRight className="dir-icon size-5" />
        </Button>
      </footer>
    </div>
  )
}
