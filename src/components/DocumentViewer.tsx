import { ChevronLeft, ChevronRight, Crop, Download, FileDown, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { FilterControls } from './FilterControls'
import { Spinner } from './Spinner'

export function DocumentViewer() {
  const {
    pages,
    selectedId,
    busy,
    selectPage,
    movePage,
    deletePage,
    refilterPage,
    editPageCorners,
    downloadPage,
    downloadAll,
    exportPdf,
    closePages,
  } = useScan()

  const selected = pages.find((page) => page.id === selectedId) ?? pages[0]
  if (!selected) return null
  const index = pages.findIndex((page) => page.id === selected.id)

  return (
    <div className="app-bg flex min-h-dvh flex-col text-ink dark:text-paper">
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={closePages}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
          aria-label="חזרה למסך הראשי"
        >
          <ChevronLeft className="dir-icon size-6" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-2xl leading-none font-semibold">עמודים</h1>
          <p className="mt-1 text-xs text-mist dark:text-paper/55">
            {index + 1} מתוך {pages.length}
          </p>
        </div>
        <button
          type="button"
          onClick={() => downloadPage(selected.id)}
          className="grid size-11 place-items-center rounded-2xl hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          aria-label="הורד כתמונה"
        >
          <Download className="size-5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="relative" aria-busy={Boolean(busy)}>
          <img
            src={selected.resultUrl}
            alt={`עמוד ${index + 1}`}
            className="max-h-[46dvh] max-w-full rounded-2xl bg-white object-contain shadow-[0_18px_50px_rgba(20,34,28,0.18)]"
          />
          {busy && (
            <div className="absolute inset-0 grid place-items-center bg-night/30 text-paper">
              <span className="flex items-center gap-2 rounded-full bg-night/80 px-3 py-2 text-sm">
                <Spinner className="size-4" />
                {busy}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="px-4">
        <div className="flex gap-3 overflow-x-auto pb-3">
          {pages.map((page, pageIndex) => {
            const isSelected = page.id === selected.id
            return (
              <button
                key={page.id}
                type="button"
                onClick={() => selectPage(page.id)}
                className={`w-14 shrink-0 rounded-2xl p-0.5 active:scale-[0.98] ${isSelected ? 'ring-2 ring-copper' : ''}`}
                aria-label={`בחר עמוד ${pageIndex + 1}`}
                aria-current={isSelected}
              >
                <img src={page.resultUrl} alt="" className="aspect-[3/4] w-full rounded-md object-cover" />
              </button>
            )
          })}
        </div>
      </div>

      <footer className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <FilterControls
          value={selected.filter}
          disabled={Boolean(busy)}
          onChange={(filter) => void refilterPage(selected.id, filter)}
        />
        <p className="text-center text-xs font-semibold text-mist dark:text-paper/55">שנה סדר עמודים</p>
        <div className="grid grid-cols-4 gap-2">
          <IconAction
            label="הזז אחורה"
            disabled={index <= 0 || Boolean(busy)}
            onClick={() => movePage(selected.id, -1)}
          >
            <ChevronLeft className="dir-icon size-5" />
          </IconAction>
          <IconAction
            label="הזז קדימה"
            disabled={index >= pages.length - 1 || Boolean(busy)}
            onClick={() => movePage(selected.id, 1)}
          >
            <ChevronRight className="dir-icon size-5" />
          </IconAction>
          <IconAction label="התאם פינות" disabled={Boolean(busy)} onClick={() => editPageCorners(selected.id)}>
            <Crop className="size-5" />
          </IconAction>
          <IconAction label="מחק עמוד" disabled={Boolean(busy)} onClick={() => deletePage(selected.id)}>
            <Trash2 className="size-5" />
          </IconAction>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" disabled={Boolean(busy)} onClick={() => void downloadAll()}>
            הורד כתמונה
          </Button>
          <Button disabled={Boolean(busy)} onClick={() => void exportPdf()}>
            <FileDown className="size-4" />
            ייצוא ל-PDF
          </Button>
        </div>
      </footer>
    </div>
  )
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid min-h-12 place-items-center rounded-2xl bg-paper text-ink shadow-[0_6px_16px_rgba(20,34,28,0.05)] ring-1 ring-black/10 active:scale-[0.98] disabled:opacity-40 dark:bg-night-2 dark:text-paper dark:ring-white/10"
    >
      {children}
    </button>
  )
}
