import { ChevronLeft, Crop, Download, FileDown, Plus, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { filteredSource, filterCss } from '../lib/view-filter'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { FilterControls } from './FilterControls'
import { ShareDrawer } from './ShareDrawer'
import { Spinner } from './Spinner'

export function PreviewScreen() {
  const {
    draft,
    preview,
    busy,
    setFilter,
    addPage,
    downloadDraft,
    exportPdf,
    sharePdf,
    backToCorners,
    leavePreview,
    retryPreview,
  } = useScan()
  const [sharing, setSharing] = useState(false)
  const view = preview
    ? {
        src: filteredSource(
          draft?.filter ?? 'original',
          preview.warpUrl,
          preview.magicUrl ?? (preview.url === preview.warpUrl ? null : preview.url),
        ),
        css: draft ? filterCss(draft.filter) : undefined,
      }
    : null

  if (!draft) return null

  return (
    <div className="app-bg relative flex h-dvh flex-col overflow-hidden text-ink dark:text-paper">
      <header className="pointer-events-auto relative z-30 flex shrink-0 touch-manipulation items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={leavePreview}
          className="pointer-events-auto flex min-h-11 touch-manipulation items-center gap-2 rounded-2xl pe-3 hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          aria-label="חזרה למסך הראשי"
        >
          <ChevronLeft className="dir-icon size-6" />
          <span className="font-display text-2xl font-semibold">תצוגה מקדימה</span>
        </button>
      </header>

      <div className="pointer-events-none relative z-0 flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
        <div className="relative max-h-full max-w-full">
          {view ? (
            <img
              src={view.src}
              alt="תצוגה מקדימה של המסמך המיושר"
              style={{ filter: view.css }}
              className="pointer-events-none max-h-full max-w-full rounded-2xl bg-white object-contain shadow-[0_18px_50px_rgba(20,34,28,0.18)]"
            />
          ) : (
            <WaitingPage />
          )}
        </div>
      </div>

      <footer
        className="pointer-events-auto relative z-30 shrink-0 touch-manipulation space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
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
            onClick={() => void addPage()}
          >
            <Plus className="size-4" />
            הוסף עמוד
          </Button>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1 px-1 py-2 text-xs"
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
        <Button variant="secondary" className="w-full" onClick={() => setSharing(true)}>
          <Share2 className="size-4" />
          שלח במייל / שתף
        </Button>
        <Button className="w-full" onClick={() => void exportPdf()}>
          <FileDown className="size-4" />
          ייצוא ל-PDF
        </Button>
      </footer>
      {sharing && <ShareDrawer onClose={() => setSharing(false)} onShare={sharePdf} />}
    </div>
  )
}

function WaitingPage() {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const failsafe = window.setTimeout(() => setVisible(false), 500)
    return () => window.clearTimeout(failsafe)
  }, [])
  if (!visible) return null
  return (
    <div className="pointer-events-none grid h-64 w-56 place-items-center rounded-2xl bg-paper text-moss shadow-lg dark:bg-night-2">
      <Spinner className="size-8" />
    </div>
  )
}
