import { useEffect, useId, useState } from 'react'
import {
  getDeferredInstallPrompt,
  isStandaloneApp,
  promptAndroidInstall,
  subscribeInstallPrompt,
} from '../lib/pwa-install'

type Guide = 'android' | 'ios' | null

function AndroidMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <path
        fill="currentColor"
        d="M17.6 9.5 19 8.1a.6.6 0 1 0-.9-.8l-1.5 1.5A7.4 7.4 0 0 0 7.4 8.8L5.9 7.3a.6.6 0 1 0-.9.8L6.4 9.5A6.8 6.8 0 0 0 5 14.2v.3h14v-.3a6.8 6.8 0 0 0-1.4-4.7ZM8.4 12.3a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Zm7.2 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6ZM7.2 16h9.6v3.2a1.6 1.6 0 0 1-1.6 1.6h-.4V22a.8.8 0 1 1-1.6 0v-1.2H11.2V22a.8.8 0 1 1-1.6 0v-1.2h-.8A1.6 1.6 0 0 1 7.2 19.2V16Z"
      />
    </svg>
  )
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-6" aria-hidden="true">
      <path
        fill="currentColor"
        d="M16.4 12.4c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.2-2.8.9-3.5.9s-1.8-1-3-0.9c-1.5.1-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 0.8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.3 1.2-2.5 1.2-2.6-.1 0-2.3-.9-2.4-3.5Zm-2.2-6.5c.6-.8 1.1-1.9.9-3-0.9.1-2 .6-2.7 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2-.5 2.8-1.3Z"
      />
    </svg>
  )
}

const GUIDES: Record<Exclude<Guide, null>, { title: string; steps: string[] }> = {
  android: {
    title: 'התקנה לאנדרואיד',
    steps: [
      'לחץ על תפריט 3 הנקודות (⋮) בדפדפן Chrome.',
      'בחר ב-"התקנת אפליקציה" או "הוסף למסך הבית".',
    ],
  },
  ios: {
    title: 'התקנה לאייפון',
    steps: [
      'לחץ על כפתור השיתוף בתחתית המסך (אייקון הריבוע עם החץ למעלה).',
      'גלול ובחר ב-"הוסף למסך הבית".',
      'לחץ על "הוסף" בפינה העליונה.',
    ],
  },
}

export function InstallAppButtons() {
  const titleId = useId()
  const [installed, setInstalled] = useState(false)
  const [canPrompt, setCanPrompt] = useState(false)
  const [guide, setGuide] = useState<Guide>(null)

  useEffect(() => {
    setInstalled(isStandaloneApp())
    setCanPrompt(Boolean(getDeferredInstallPrompt()))
    return subscribeInstallPrompt(() => {
      setInstalled(isStandaloneApp())
      setCanPrompt(Boolean(getDeferredInstallPrompt()))
    })
  }, [])

  useEffect(() => {
    if (!guide) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGuide(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [guide])

  if (installed) return null

  async function onAndroid() {
    if (canPrompt) {
      const prompted = await promptAndroidInstall()
      if (prompted) return
    }
    setGuide('android')
  }

  const modal = guide ? GUIDES[guide] : null

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => void onAndroid()}
          className="flex min-h-16 flex-col items-start gap-2 rounded-2xl bg-night px-4 py-3 text-start text-paper shadow-[0_10px_28px_rgba(14,22,20,0.28)] ring-1 ring-white/10 active:scale-[0.98] dark:bg-night-2"
        >
          <span className="text-moss-bright">
            <AndroidMark />
          </span>
          <span className="text-sm leading-5 font-semibold">התקנה לאנדרואיד</span>
        </button>
        <button
          type="button"
          onClick={() => setGuide('ios')}
          className="flex min-h-16 flex-col items-start gap-2 rounded-2xl bg-night px-4 py-3 text-start text-paper shadow-[0_10px_28px_rgba(14,22,20,0.28)] ring-1 ring-white/10 active:scale-[0.98] dark:bg-night-2"
        >
          <span className="text-moss-bright">
            <AppleMark />
          </span>
          <span className="text-sm leading-5 font-semibold">התקנה לאייפון</span>
        </button>
      </div>

      {modal && (
        <div
          className="fixed inset-0 z-[95] flex items-end justify-center bg-night/55 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px] sm:items-center"
          role="presentation"
          onClick={() => setGuide(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="rise w-full max-w-md rounded-3xl bg-paper p-5 text-ink shadow-2xl ring-1 ring-black/10 dark:bg-night-2 dark:text-paper dark:ring-white/10"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={titleId} className="font-display text-xl font-bold">
              {modal.title}
            </h2>
            <ol className="mt-4 space-y-3">
              {modal.steps.map((step, index) => (
                <li key={step} className="flex gap-3 text-sm leading-6">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-moss text-xs font-bold text-paper">
                    {index + 1}
                  </span>
                  <span className="pt-0.5">{step}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="mt-5 min-h-12 w-full rounded-2xl bg-moss font-semibold text-paper active:scale-[0.98]"
              onClick={() => setGuide(null)}
            >
              הבנתי
            </button>
          </div>
        </div>
      )}
    </>
  )
}
