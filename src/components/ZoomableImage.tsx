import { useEffect, useRef, type PointerEvent } from 'react'

const MIN_SCALE = 1
const MAX_SCALE = 5
const TAP_SCALE = 2.6
const TAP_MS = 320
const TAP_SLOP = 12

type Pointer = { x: number; y: number }

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function distance(a: Pointer, b: Pointer) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: Pointer, b: Pointer): Pointer {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * Full-bleed document viewport: the image fills the available box, then pinch, wheel,
 * or a tap expands it so small print stays readable.
 */
export function ZoomableImage({
  src,
  alt,
  filter,
}: {
  src: string
  alt: string
  filter?: string
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, Pointer>())
  const transform = useRef({ scale: 1, x: 0, y: 0 })
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
  const pan = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const tap = useRef<{ id: number; x: number; y: number; at: number } | null>(null)

  function paint() {
    const frame = frameRef.current
    if (!frame) return
    const { scale, x, y } = transform.current
    frame.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
  }

  function zoomAt(cx: number, cy: number, nextScale: number) {
    const view = viewportRef.current
    if (!view) return
    const rect = view.getBoundingClientRect()
    const px = cx - rect.left
    const py = cy - rect.top
    const current = transform.current
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
    const factor = scale / current.scale
    let x = px - (px - current.x) * factor
    let y = py - (py - current.y) * factor
    if (scale <= 1.001) {
      x = 0
      y = 0
    }
    transform.current = { scale, x, y }
    paint()
  }

  function reset() {
    transform.current = { scale: 1, x: 0, y: 0 }
    paint()
  }

  useEffect(() => {
    reset()
  }, [src])

  useEffect(() => {
    const view = viewportRef.current
    if (!view) return

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
      zoomAt(event.clientX, event.clientY, transform.current.scale * factor)
    }

    const onTouchMove = (event: TouchEvent) => {
      if (pointers.current.size === 0) return
      event.preventDefault()
    }

    view.addEventListener('wheel', onWheel, { passive: false })
    view.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      view.removeEventListener('wheel', onWheel)
      view.removeEventListener('touchmove', onTouchMove)
    }
  }, [])

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const view = viewportRef.current
    if (!view) return
    event.preventDefault()
    view.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    tap.current = { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() }

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      if (a && b) {
        pinch.current = {
          distance: Math.max(1, distance(a, b)),
          scale: transform.current.scale,
        }
      }
      pan.current = null
      tap.current = null
      return
    }

    if (transform.current.scale > 1) {
      pan.current = {
        x: event.clientX,
        y: event.clientY,
        ox: transform.current.x,
        oy: transform.current.y,
      }
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (tap.current && tap.current.id === event.pointerId) {
      if (Math.hypot(event.clientX - tap.current.x, event.clientY - tap.current.y) > TAP_SLOP) {
        tap.current = null
      }
    }

    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      const mid = midpoint(a, b)
      const factor = Math.max(1, distance(a, b)) / pinch.current.distance
      zoomAt(mid.x, mid.y, pinch.current.scale * factor)
      return
    }

    if (pan.current && transform.current.scale > 1) {
      transform.current.x = pan.current.ox + (event.clientX - pan.current.x)
      transform.current.y = pan.current.oy + (event.clientY - pan.current.y)
      paint()
    }
  }

  function endPointer(event: PointerEvent<HTMLDivElement>) {
    const wasTap = tap.current
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    if (pointers.current.size === 0) pan.current = null

    if (
      wasTap &&
      wasTap.id === event.pointerId &&
      performance.now() - wasTap.at < TAP_MS &&
      pointers.current.size === 0
    ) {
      if (transform.current.scale > 1.05) reset()
      else zoomAt(wasTap.x, wasTap.y, TAP_SCALE)
    }
    tap.current = null
  }

  return (
    <div
      ref={viewportRef}
      className="relative h-full min-h-0 w-full cursor-zoom-in touch-none overflow-hidden overscroll-none"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      role="presentation"
    >
      <div
        ref={frameRef}
        className="flex h-full w-full origin-top-left items-center justify-center will-change-transform"
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ filter }}
          className="h-full w-full bg-white object-contain select-none"
        />
      </div>
    </div>
  )
}
