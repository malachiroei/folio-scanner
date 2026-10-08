import { ChevronLeft, Crop, Download, FileDown, Plus } from 'lucide-react'
import { filteredSource, filterCss } from '../lib/view-filter'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { FilterControls } from './FilterControls'
import { Spinner } from './Spinner'

export function PreviewScreen() {
  const { draft, preview, busy, setFilter, addPage, downloadDraft, exportPdf, backToCorners, leavePreview, retryPreview } =
    useScan()
  if (!draft) return null
  const view = preview
    ? {
        src: filteredSource(draft.filter, preview.warpUrl, preview.magicUrl ?? (preview.url === preview.warpUrl ? null : preview.url)),
        css: filterCss(draft.filter),
      }
    : null

  return (
    <div className="app-bg flex h-dvh flex-col overflow-hidden text-ink dark:text-paper">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={leavePreview}
          className="flex min-h-11 items-center gap-2 rounded-2xl pe-3 hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          aria-label="חזרה למסך הראשי"
        >
          <ChevronLeft className="dir-icon size-6" />
          <span className="font-display text-2xl font-semibold">תצוגה מקדימה</span>
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="relative max-h-full max-w-full" aria-busy={Boolean(busy)}>
          {view ? (
            <img
              src={view.src}
              alt="תצוגה מקדימה של המסמך המיושר"
              style={{ filter: view.css }}
              className="max-h-full max-w-full rounded-2xl bg-white object-contain shadow-[0_18px_50px_rgba(20,34,28,0.18)]"
            />
          ) : (
            <div className="grid h-64 w-56 place-items-center rounded-2xl bg-paper text-moss shadow-lg dark:bg-night-2">
              <Spinner className="size-8" />
            </div>
          )}
          {busy && view && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <span className="grid size-12 place-items-center rounded-full bg-night/55 text-paper shadow-lg">
                <Spinner className="size-5" />
              </span>
            </div>
          )}
        </div>
      </div>

      <footer className="shrink-0 space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <FilterControls value={draft.filter} onChange={setFilter} />
        {!preview && !busy && (
          <Button variant="secondary" className="w-full" onClick={retryPreview}>
            נסה שוב
          </Button>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1 px-1 py-2 text-xs"
            disabled={!preview}
            onClick={() => void addPage()}
          >
            <Plus className="size-4" />
            הוסף עמוד
          </Button>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1 px-1 py-2 text-xs"
            disabled={!preview}
            onClick={() => void downloadDraft()}
          >
            <Download className="size-4" />
            הורד תמונה
          </Button>
          <Button variant="secondary" className="h-auto flex-col gap-1 px-1 py-2 text-xs" onClick={backToCorners}>
            <Crop className="size-4" />
            ערוך חיתוך
          </Button>
        </div>
        <Button className="w-full" disabled={!preview} onClick={() => void exportPdf()}>
          <FileDown className="size-4" />
          ייצוא ל-PDF
        </Button>
      </footer>
    </div>
  )
}
