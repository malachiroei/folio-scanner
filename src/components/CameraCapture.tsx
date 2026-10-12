import { Images, SwitchCamera, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { detectDocumentCorners } from '../lib/detect'
import { distance } from '../lib/geometry'
import { useScan } from '../state/scan-context'
import type { CaptureHint, Corners } from '../types'

/** Live detection runs about every 140ms on a 240px copy of the video frame. */
const LIVE_INTERVAL_MS = 140
const LIVE_EDGE = 240
const LIVE_MISSES_BEFORE_CLEAR = 5

type LiveQuad = { corners: Corners; width: number; height: number; at: number }

/** A live outline older than this no longer matches what the camera sees. */
const LIVE_MAX_AGE_MS = 900

function blend(from: Corners, to: Corners, amount: number): Corners {
  const mix = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
  })
  return { tl: mix(from.tl, to.tl), tr: mix(from.tr, to.tr), br: mix(from.br, to.br), bl: mix(from.bl, to.bl) }
}

type ImageCaptureInstance = {
  takePhoto: (settings?: { imageWidth?: number; imageHeight?: number }) => Promise<Blob>
  getPhotoCapabilities?: () => Promise<{ imageWidth?: { max?: number }; imageHeight?: { max?: number } }>
}
type ImageCaptureConstructor = new (track: MediaStreamTrack) => ImageCaptureInstance

function cameraMessage(error: unknown): string {
  if (!window.isSecureContext) {
    return 'המצלמה דורשת דף מאובטח (https או localhost). עדיין אפשר להעלות תמונה.'
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'הגישה למצלמה חסומה. אשר אותה בדפדפן, או העלה תמונה.'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'לא נמצאה מצלמה זמינה. העלה תמונה במקום.'
    }
    if (error.name === 'NotReadableError') {
      return 'המצלמה בשימוש באפליקציה אחרת.'
    }
  }
  return 'לא ניתן להפעיל את המצלמה. העלה תמונה במקום.'
}

export function CameraCapture() {
  const { closeCamera, ingestBlob, ingestFile } = useScan()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const nativeRef = useRef<HTMLInputElement>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const [quad, setQuad] = useState<LiveQuad | null>(null)
  const quadRef = useRef<LiveQuad | null>(null)

  // Live page outline: a light pass on a 240px copy of the current frame, never blocking the video.
  useEffect(() => {
    if (!ready) return
    let stopped = false
    let timer = 0
    let frame = 0
    let current: LiveQuad | null = null
    let misses = 0

    const tick = () => {
      if (stopped) return
      const video = videoRef.current
      if (video && video.videoWidth > 0 && video.readyState >= 2 && !document.hidden) {
        const width = video.videoWidth
        const height = video.videoHeight
        const found = detectDocumentCorners(video, width, height, { maxEdge: LIVE_EDGE, live: true })
        if (found.detected) {
          misses = 0
          const jump = distance(found.corners.tl, current?.corners.tl ?? found.corners.tl)
          const smooth = current && current.width === width && jump < width * 0.25
          current = {
            corners: smooth && current ? blend(current.corners, found.corners, 0.55) : found.corners,
            width,
            height,
            at: performance.now(),
          }
          quadRef.current = current
          setQuad(current)
        } else {
          misses += 1
          if (misses >= LIVE_MISSES_BEFORE_CLEAR && current) {
            current = null
            quadRef.current = null
            setQuad(null)
          }
        }
      }
      timer = window.setTimeout(() => {
        frame = requestAnimationFrame(tick)
      }, LIVE_INTERVAL_MS)
    }

    timer = window.setTimeout(() => {
      frame = requestAnimationFrame(tick)
    }, LIVE_INTERVAL_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
      quadRef.current = null
      setQuad(null)
    }
  }, [ready, facing])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const view = video
    let stream: MediaStream | null = null
    let cancelled = false
    setReady(false)
    setError(null)

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('הדפדפן הזה לא יכול לפתוח את המצלמה. העלה תמונה במקום.')
        return
      }
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: facing },
              width: { ideal: 3840 },
              height: { ideal: 2160 },
            },
          })
        } catch (first) {
          if (first instanceof DOMException && (first.name === 'NotAllowedError' || first.name === 'SecurityError')) {
            throw first
          }
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        view.srcObject = stream
        streamRef.current = stream
        try {
          await view.play()
        } catch (playError) {
          // A interrupted play() (e.g. fast unmount) is harmless; the stream is still attached.
          console.warn(playError)
        }
        if (!cancelled) setReady(true)
      } catch (err) {
        console.error(err)
        if (!cancelled) setError(cameraMessage(err))
      }
    }

    void start()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
      if (streamRef.current === stream) streamRef.current = null
      view.srcObject = null
    }
  }, [facing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeCamera()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeCamera])

  /** Full sensor photo (e.g. 12MP) through ImageCapture, or null when the browser cannot. */
  async function takeSensorPhoto(): Promise<Blob | null> {
    const track = streamRef.current?.getVideoTracks()[0]
    const Capture = (window as unknown as { ImageCapture?: ImageCaptureConstructor }).ImageCapture
    if (!track || !Capture || track.readyState !== 'live') return null
    try {
      const imageCapture = new Capture(track)
      let settings: { imageWidth?: number; imageHeight?: number } | undefined
      try {
        const capabilities = await imageCapture.getPhotoCapabilities?.()
        const width = capabilities?.imageWidth?.max
        const height = capabilities?.imageHeight?.max
        if (width && height) settings = { imageWidth: width, imageHeight: height }
      } catch {
        // Some browsers expose takePhoto but not capabilities. The default photo is still full size.
      }
      try {
        return await imageCapture.takePhoto(settings)
      } catch {
        return await imageCapture.takePhoto()
      }
    } catch (err) {
      console.warn('ImageCapture failed, using the video frame', err)
      return null
    }
  }

  /** The outline tracked live at the moment of the tap, as 0..1 fractions of the video frame. */
  function liveHint(mirrored: boolean): CaptureHint | undefined {
    const live = quadRef.current
    if (!live || performance.now() - live.at > LIVE_MAX_AGE_MS) return undefined
    const unit = (point: { x: number; y: number }) => ({ x: point.x / live.width, y: point.y / live.height })
    return {
      corners: { tl: unit(live.corners.tl), tr: unit(live.corners.tr), br: unit(live.corners.br), bl: unit(live.corners.bl) },
      aspect: live.width / live.height,
      mirrored,
    }
  }

  async function capture() {
    if (capturing) return
    setCapturing(true)
    // Taken before the (slow) photo call, so it describes what the user framed when tapping.
    const hint = liveHint(false)
    try {
      const photo = await takeSensorPhoto()
      if (photo && photo.size > 0) {
        ingestBlob(photo, hint)
        return
      }
      captureFrame(hint && facing === 'user' ? { ...hint, mirrored: true } : hint)
    } finally {
      setCapturing(false)
    }
  }

  function captureFrame(hint?: CaptureHint) {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const scale = Math.min(1, 4000 / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    if (facing === 'user') {
      context.translate(width, 0)
      context.scale(-1, 1)
    }
    context.drawImage(video, 0, 0, width, height)
    canvas.toBlob(
      (blob) => {
        if (blob) ingestBlob(blob, hint)
      },
      'image/jpeg',
      0.95,
    )
  }

  return (
    <div className="fixed inset-0 z-40 flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden bg-black text-white">
      <div className="relative min-h-0 flex-1 overflow-hidden">
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-contain ${facing === 'user' ? '-scale-x-100' : ''}`}
        autoPlay
        muted
        playsInline
      />
      {quad && (
        <svg
          viewBox={`0 0 ${quad.width} ${quad.height}`}
          preserveAspectRatio="xMidYMid meet"
          className={`pointer-events-none absolute inset-0 h-full w-full ${facing === 'user' ? '-scale-x-100' : ''}`}
          aria-hidden="true"
        >
          <polygon
            points={[quad.corners.tl, quad.corners.tr, quad.corners.br, quad.corners.bl]
              .map((point) => `${point.x},${point.y}`)
              .join(' ')}
            fill="rgba(231,160,106,0.16)"
            stroke="#e7a06a"
            strokeWidth={3}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {[quad.corners.tl, quad.corners.tr, quad.corners.br, quad.corners.bl].map((point, index) => (
            <circle key={index} cx={point.x} cy={point.y} r={quad.width * 0.012} fill="#fff" stroke="#e7a06a" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
      )}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={closeCamera}
          className="grid size-11 place-items-center rounded-full bg-black/50"
          aria-label="סגור מצלמה"
        >
          <X className="size-5" />
        </button>
        <p className="rounded-full bg-black/50 px-3 py-1 text-xs">מקם את הדף בתוך המסגרת</p>
        <span className="size-11" />
      </div>

      {error && (
        <div className="absolute inset-x-5 top-24 z-10 rounded-2xl bg-black/70 px-4 py-3 text-sm leading-5">
          <p>{error}</p>
          <button
            type="button"
            className="mt-3 min-h-11 w-full rounded-xl bg-white px-4 py-2 font-semibold text-black"
            onClick={() => nativeRef.current?.click()}
          >
            צלם או בחר תמונה
          </button>
        </div>
      )}
      <input
        ref={nativeRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) ingestFile(file)
        }}
      />

      </div>
      <div className="relative z-10 flex shrink-0 items-center justify-between px-8 pt-3 pb-[max(1rem,env(safe-area-inset-bottom,16px))]">
        <button
          type="button"
          className="grid size-12 place-items-center rounded-full bg-white/15"
          aria-label="העלאת תמונה מהגלריה"
          onClick={() => fileRef.current?.click()}
        >
          <Images className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => void capture()}
          disabled={!ready || capturing}
          aria-label="צילום"
          className="grid size-20 place-items-center rounded-full border-4 border-white disabled:opacity-40"
        >
          <span className="size-14 rounded-full bg-white active:scale-95" />
        </button>
        <button
          type="button"
          className="grid size-12 place-items-center rounded-full bg-white/15"
          aria-label="החלפת מצלמה"
          onClick={() => setFacing((current) => (current === 'environment' ? 'user' : 'environment'))}
        >
          <SwitchCamera className="size-5" />
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) ingestFile(file)
        }}
      />
    </div>
  )
}
