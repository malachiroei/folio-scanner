export function isIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** Older iPads grant getUserMedia but never paint a live preview. Use the system Camera app instead. */
export function isIPad() {
  if (typeof navigator === 'undefined') return false
  if (/iPad/.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

function desktopConstraints(facing: 'environment' | 'user'): MediaTrackConstraints {
  return {
    facingMode: { ideal: facing },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  }
}

async function pickBackCamera(stream: MediaStream, facing: 'environment' | 'user') {
  if (!isIOS() || facing !== 'environment') return stream
  try {
    const current = stream.getVideoTracks()[0]
    const label = current?.label ?? ''
    const looksFront = /front|user|face|selfie|קדמ/i.test(label)
    if (label && !looksFront) return stream
    const devices = await navigator.mediaDevices.enumerateDevices()
    const cams = devices.filter((device) => device.kind === 'videoinput')
    if (cams.length === 0) return stream
    const currentId = current?.getSettings().deviceId
    const back = cams.find((device) => /back|rear|environment|אחור/i.test(device.label))
    if (!back?.deviceId || back.deviceId === currentId) return stream
    const next = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { deviceId: { exact: back.deviceId } },
    })
    stream.getTracks().forEach((track) => track.stop())
    return next
  } catch {
    return stream
  }
}

export async function acquireCameraStream(facing: 'environment' | 'user'): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('no-getUserMedia')
  }
  const attempts: MediaStreamConstraints[] = isIOS()
    ? [
        { audio: false, video: true },
        { audio: false, video: { facingMode: facing } },
        { audio: false, video: { facingMode: { ideal: facing } } },
      ]
    : [
        { audio: false, video: desktopConstraints(facing) },
        { audio: false, video: { facingMode: facing } },
        { audio: false, video: true },
      ]

  let lastError: unknown
  let stream: MediaStream | null = null
  for (const constraints of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
      break
    } catch (error) {
      lastError = error
      if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
        throw error
      }
    }
  }
  if (!stream) throw lastError ?? new Error('no-camera')
  return await pickBackCamera(stream, facing)
}

let primed: Promise<MediaStream> | null = null
let primedFacing: 'environment' | 'user' | null = null

/** Start getUserMedia in the same tap that opens the camera — required on iPad Safari. */
export function primeCameraGesture(facing: 'environment' | 'user') {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return
  primedFacing = facing
  primed = acquireCameraStream(facing).catch((error) => {
    primed = null
    throw error
  })
}

export async function consumePrimedCamera(facing: 'environment' | 'user') {
  const pending = primed
  const sameFacing = primedFacing === facing
  primed = null
  primedFacing = null
  if (pending && sameFacing) {
    try {
      return await pending
    } catch {
      // Permission may already be granted; try a fresh request.
    }
  }
  return acquireCameraStream(facing)
}

export function primeVideo(video: HTMLVideoElement) {
  video.muted = true
  video.defaultMuted = true
  video.playsInline = true
  video.autoplay = true
  video.controls = false
  video.disablePictureInPicture = true
  video.setAttribute('playsinline', 'true')
  video.setAttribute('webkit-playsinline', 'true')
  video.setAttribute('muted', '')
  video.setAttribute('autoplay', '')
}

export async function attachCameraStream(video: HTMLVideoElement, stream: MediaStream) {
  primeVideo(video)
  video.srcObject = stream
  for (const track of stream.getVideoTracks()) {
    track.enabled = true
  }
  const tryPlay = () => {
    void video.play().catch(() => undefined)
  }
  video.addEventListener('loadedmetadata', tryPlay)
  video.addEventListener('canplay', tryPlay)
  video.addEventListener('playing', tryPlay)
  tryPlay()
  await waitForVideo(video, stream)
  await video.play().catch(() => undefined)
}

async function waitForVideo(video: HTMLVideoElement, stream: MediaStream) {
  if (video.videoWidth > 0 && video.readyState >= 2) return
  await new Promise<void>((resolve, reject) => {
    const track = stream.getVideoTracks()[0]
    const finish = (ok: boolean) => {
      window.clearTimeout(timer)
      video.removeEventListener('loadedmetadata', onReady)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('playing', onReady)
      video.removeEventListener('canplay', onReady)
      track?.removeEventListener('unmute', onUnmute)
      if (ok || video.videoWidth > 0) resolve()
      else reject(new Error('video-timeout'))
    }
    const onReady = () => {
      if (video.videoWidth > 0) finish(true)
    }
    const onUnmute = () => {
      void video.play().then(() => onReady()).catch(() => undefined)
    }
    const timer = window.setTimeout(() => finish(false), 5000)
    video.addEventListener('loadedmetadata', onReady)
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('playing', onReady)
    video.addEventListener('canplay', onReady)
    track?.addEventListener('unmute', onUnmute)
    void video.play().catch(() => undefined)
  })
}
