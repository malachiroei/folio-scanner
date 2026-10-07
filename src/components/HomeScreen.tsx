import { Camera, Moon, Sun } from 'lucide-react'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { Spinner } from './Spinner'
import { UploadDropzone } from './UploadDropzone'

export function HomeScreen() {
  const { theme, toggleTheme, engine, retryEngine, pages, openCamera, openPages, ingestFile } = useScan()

  return (
    <div className="app-bg min-h-dvh text-ink dark:text-paper">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold tracking-[0.22em] text-moss uppercase dark:text-moss-bright">
              Folio
            </p>
            <h1 className="mt-1 font-display text-5xl leading-none">Scan</h1>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="grid size-11 place-items-center rounded-full bg-paper ring-1 ring-black/10 dark:bg-night-2 dark:ring-white/10"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </button>
        </header>

        <p className="mt-4 max-w-sm text-base leading-6 text-mist dark:text-paper/70">
          Square the page, lift the shadows, and keep the ink. Everything runs on this device.
        </p>

        <div className="mt-8 space-y-3">
          <Button className="h-16 w-full text-base" onClick={openCamera}>
            <Camera className="size-5" />
            Scan with camera
          </Button>
          <UploadDropzone onFile={ingestFile} />
        </div>

        {pages.length > 0 && (
          <section className="mt-8">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-semibold">This batch</h2>
              <span className="text-sm text-mist dark:text-paper/55">
                {pages.length} {pages.length === 1 ? 'page' : 'pages'}
              </span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {pages.map((page, index) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={openPages}
                  className="w-16 shrink-0"
                  aria-label={`Open page ${index + 1}`}
                >
                  <img
                    src={page.resultUrl}
                    alt=""
                    className="aspect-[3/4] w-full rounded-lg bg-white object-cover shadow-md"
                  />
                  <span className="mt-1 block text-center text-xs text-mist">{index + 1}</span>
                </button>
              ))}
            </div>
            <Button variant="secondary" className="mt-3 w-full" onClick={openPages}>
              Review and export
            </Button>
          </section>
        )}

        <div className="mt-auto pt-8">
          <div aria-live="polite">
            {engine === 'loading' && (
              <div className="flex items-center gap-2 text-sm text-mist dark:text-paper/60">
                <Spinner className="size-4" />
                <span>Loading vision engine… You can scan now.</span>
              </div>
            )}
            {engine === 'ready' && (
              <div className="flex items-center gap-2 text-sm text-mist dark:text-paper/60">
                <span className="size-2 rounded-full bg-moss-bright" />
                Ready to scan
              </div>
            )}
            {engine === 'fallback' && (
              <div className="rounded-2xl bg-paper px-4 py-3 text-sm ring-1 ring-copper/40 dark:bg-night-2">
                <p className="font-semibold text-ink dark:text-paper">Vision engine didn’t load</p>
                <p className="mt-1 leading-5 text-mist dark:text-paper/70">
                  You can still capture and upload. Cropping, straightening, and contrast work without it.
                </p>
                <button
                  type="button"
                  className="mt-3 rounded-xl bg-moss px-3 py-2 text-sm font-semibold text-paper"
                  onClick={retryEngine}
                >
                  Retry vision engine
                </button>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-mist/80 dark:text-paper/40">
            Pages stay in this tab until you export them.
          </p>
        </div>
      </div>
    </div>
  )
}
