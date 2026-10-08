import { Camera, Moon, Sun } from 'lucide-react'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { UploadDropzone } from './UploadDropzone'

export function HomeScreen() {
  const { theme, toggleTheme, engine, retryEngine, pages, openCamera, openPages, ingestFile } = useScan()

  return (
    <div className="app-bg min-h-dvh text-ink dark:text-paper">
      <div className="mx-auto flex min-h-dvh w-full max-w-lg flex-col px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-moss dark:text-moss-bright">Folio</p>
            <h1 className="mt-1 font-display text-[2rem] leading-tight font-bold">סורק מסמכים חכם</h1>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            className="grid size-12 shrink-0 place-items-center rounded-2xl bg-paper shadow-[0_8px_24px_rgba(20,34,28,0.08)] ring-1 ring-black/8 active:scale-[0.98] dark:bg-night-2 dark:ring-white/10"
            aria-label={theme === 'dark' ? 'מצב בהיר' : 'מצב כהה'}
          >
            {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </button>
        </header>

        <p className="mt-4 text-base leading-7 text-mist dark:text-paper/70">
          יישור דפים, הלבנת רקע, הסרת צללים וייצוא מהיר ל-PDF. הכל מעובד מקומית במכשיר.
        </p>

        <div className="mt-8 space-y-3">
          <Button className="h-16 w-full text-base shadow-[0_12px_28px_rgba(28,107,86,0.22)]" onClick={openCamera}>
            <Camera className="size-5" />
            סריקה באמצעות מצלמה
          </Button>
          <UploadDropzone onFile={ingestFile} />
        </div>

        {pages.length > 0 && (
          <section className="mt-8 rounded-2xl bg-paper p-4 shadow-[0_12px_32px_rgba(20,34,28,0.08)] ring-1 ring-black/5 dark:bg-night-2 dark:ring-white/10">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-semibold">העמודים שנשמרו</h2>
              <span className="text-sm text-mist dark:text-paper/55">
                {pages.length} {pages.length === 1 ? 'עמוד' : 'עמודים'}
              </span>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2">
              {pages.map((page, index) => (
                <button
                  key={page.id}
                  type="button"
                  onClick={openPages}
                  className="w-16 shrink-0 active:scale-[0.98]"
                  aria-label={`פתח עמוד ${index + 1}`}
                >
                  <img
                    src={page.resultUrl}
                    alt=""
                    className="aspect-[3/4] w-full rounded-2xl bg-white object-cover shadow-md"
                  />
                  <span className="mt-1 block text-center text-xs text-mist">{index + 1}</span>
                </button>
              ))}
            </div>
            <Button variant="secondary" className="mt-3 w-full" onClick={openPages}>
              צפייה וייצוא
            </Button>
          </section>
        )}

        <div className="mt-auto pt-8">
          {engine === 'fallback' && (
            <div className="mb-3 rounded-2xl bg-paper px-4 py-3 text-sm shadow-[0_8px_24px_rgba(20,34,28,0.06)] ring-1 ring-black/8 dark:bg-night-2 dark:ring-white/10">
              <p className="leading-6 text-mist dark:text-paper/70">
                זיהוי השוליים לא זמין. חיתוך ומסננים עדיין עובדים.
              </p>
              <button type="button" className="mt-2 font-semibold text-moss dark:text-moss-bright" onClick={retryEngine}>
                נסה שוב
              </button>
            </div>
          )}
          <p className="text-center text-xs leading-5 text-mist/80 dark:text-paper/40">
            העמודים נשמרים בדפדפן עד לייצוא או רענון
          </p>
        </div>
      </div>
    </div>
  )
}
