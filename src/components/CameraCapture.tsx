import { Images, SwitchCamera, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useScan } from '../state/scan-context'

function cameraMessage(error: unknown): string {
  if (!window.isSecureContext) {
    return 'The camera needs a secure page (https or localhost). You can still upload a photo.'
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
      return 'Camera permission is blocked. Allow it in the browser, or upload a photo.'
    }
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      return 'No usable camera was found. Upload a photo instead.'
    }
    if (error.name === 'NotReadableError') {
      return 'The camera is busy in another app.'
    }
  }
  return 'The camera could not start. Upload a photo instead.'
}

export function CameraCapture() {
  const { closeCamera, ingestBlob, ingestFile } = useScan()
  const videoRef = useRef<HTMLVideoElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

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
        setError('This browser cannot open the camera. Upload a photo instead.')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: facing },
            width: { ideal: 2560 },
            height: { ideal: 1920 },
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        view.srcObject = stream
        await view.play()
        if (!cancelled) setReady(true)
      } catch (err) {
        if (!cancelled) setError(cameraMessage(err))
      }
    }

    void start()
    return () => {
      cancelled = true
      stream?.getTracks().forEach((track) => track.stop())
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

  function capture() {
    const video = videoRef.current
    if (!video || !video.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const context = canvas.getContext('2d')
    if (!context) return
    if (facing === 'user') {
      context.translate(canvas.width, 0)
      context.scale(-1, 1)
    }
    context.drawImage(video, 0, 0)
    canvas.toBlob(
      (blob) => {
        if (blob) ingestBlob(blob)
      },
      'image/jpeg',
      0.95,
    )
  }

  return (
    <div className="fixed inset-0 z-40 bg-black text-white">
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-contain ${facing === 'user' ? '-scale-x-100' : ''}`}
        autoPlay
        muted
        playsInline
      />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={closeCamera}
          className="grid size-11 place-items-center rounded-full bg-black/50"
          aria-label="Close camera"
        >
          <X className="size-5" />
        </button>
        <p className="rounded-full bg-black/50 px-3 py-1 text-xs tracking-wide">Fit the page in frame</p>
        <span className="size-11" />
      </div>

      {error && (
        <div className="absolute inset-x-5 top-24 rounded-2xl bg-black/70 px-4 py-3 text-sm leading-5">
          {error}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between px-8 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          className="grid size-12 place-items-center rounded-full bg-white/15"
          aria-label="Upload a photo instead"
          onClick={() => fileRef.current?.click()}
        >
          <Images className="size-5" />
        </button>
        <button
          type="button"
          onClick={capture}
          disabled={!ready}
          aria-label="Capture photo"
          className="grid size-20 place-items-center rounded-full border-4 border-white disabled:opacity-40"
        >
          <span className="size-14 rounded-full bg-white active:scale-95" />
        </button>
        <button
          type="button"
          className="grid size-12 place-items-center rounded-full bg-white/15"
          aria-label="Switch camera"
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
