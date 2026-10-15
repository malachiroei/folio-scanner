type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()

function notify() {
  for (const listener of listeners) listener()
}

export function isStandaloneApp() {
  if (typeof window === 'undefined') return false
  const media = window.matchMedia('(display-mode: standalone)').matches
  const ios = 'standalone' in window.navigator && Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
  return media || ios
}

export function getDeferredInstallPrompt() {
  return deferred
}

export function subscribeInstallPrompt(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function captureInstallPrompt() {
  if (typeof window === 'undefined') return
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    notify()
  })
}

export async function promptAndroidInstall() {
  const event = deferred
  if (!event) return false
  deferred = null
  notify()
  await event.prompt()
  await event.userChoice
  return true
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  if (!import.meta.env.PROD) return
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js?v=3')
  })
}
