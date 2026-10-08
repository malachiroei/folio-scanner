import { ChevronLeft, Crop, Download, FileDown, Plus, Send, Share2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { readQuickRecipient, type QuickRecipient } from '../lib/favorite-emails'
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
    quickSend,
    backToCorners,
    leavePreview,
    retryPreview,
  } = useScan()
  const [sharing, setSharing] = useState<null | 'share' | 'quick'>(null)
  const [sendingMail, setSendingMail] = useState(false)
  const [quickRecipient, setQuickRecipient] = useState<QuickRecipient | null>(() => readQuickRecipient())
  const pageStamp = draft
    ? [
        draft.sourceUrl,
        draft.corners.tl.x,
        draft.corners.tr.x,
        draft.corners.br.x,
        draft.corners.bl.x,
      ].join(':')
    : ''
  const seenPageRef = useRef<string | null>(null)
  useEffect(() => {
    if (!pageStamp || seenPageRef.current === pageStamp) return
    seenPageRef.current = pageStamp
  }, [pageStamp])
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

  function clicked(action: () => void) {
    return () => {
      console.log('Button clicked!')
      action()
    }
  }

  return (
    <div
      className="app-bg pointer-events-auto relative grid h-dvh grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden text-ink dark:text-paper"
      style={{ pointerEvents: 'auto' }}
    >
      <header
        className="pointer-events-auto relative z-50 flex shrink-0 touch-manipulation items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
        style={{ position: 'relative', zIndex: 50, pointerEvents: 'auto' }}
      >
        <button
          type="button"
          onClick={clicked(leavePreview)}
          className="pointer-events-auto flex min-h-11 touch-manipulation items-center gap-2 rounded-2xl pe-3 hover:bg-black/5 active:scale-[0.98] dark:hover:bg-white/8"
          style={{ pointerEvents: 'auto', touchAction: 'manipulation' }}
          aria-label="חזרה למסך הראשי"
        >
          <ChevronLeft className="dir-icon size-6" />
          <span className="font-display text-2xl font-semibold">תצוגה מקדימה</span>
        </button>
      </header>

      <div
        className="pointer-events-none relative z-0 min-h-0 overflow-hidden p-4"
        style={{ pointerEvents: 'none', zIndex: 0 }}
      >
        <div className="flex h-full items-center justify-center">
          {view ? (
            <img
              src={view.src}
              alt="תצוגה מקדימה של המסמך המיושר"
              style={{ filter: view.css, pointerEvents: 'none' }}
              className="pointer-events-none max-h-full max-w-full rounded-2xl bg-white object-contain shadow-[0_18px_50px_rgba(20,34,28,0.18)]"
            />
          ) : (
            <WaitingPage />
          )}
        </div>
      </div>

      <footer
        className="pointer-events-auto relative z-50 shrink-0 touch-manipulation space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        style={{ position: 'relative', zIndex: 50, pointerEvents: 'auto', touchAction: 'manipulation' }}
      >
        <FilterControls
          value={draft.filter}
          onChange={(filter) => {
            console.log('Button clicked!')
            setFilter(filter)
          }}
        />
        {!preview && !busy && (
          <Button variant="secondary" className="w-full" onClick={clicked(retryPreview)}>
            נסה שוב
          </Button>
        )}
        <div className="pointer-events-auto grid grid-cols-3 gap-2" style={{ pointerEvents: 'auto' }}>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1 px-1 py-2 text-xs"
            onClick={clicked(() => void addPage())}
          >
            <Plus className="size-4" />
            הוסף עמוד
          </Button>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1 px-1 py-2 text-xs"
            onClick={clicked(() => void downloadDraft())}
          >
            <Download className="size-4" />
            הורד תמונה
          </Button>
          <Button variant="secondary" className="h-auto flex-col gap-1 px-1 py-2 text-xs" onClick={clicked(backToCorners)}>
            <Crop className="size-4" />
            ערוך חיתוך
          </Button>
        </div>
        <Button
          className="w-full"
          disabled={sendingMail}
          onClick={clicked(() => {
            if (sendingMail) return
            if (!quickRecipient) {
              setSharing('quick')
              return
            }
            const address = quickRecipient.email
            setSendingMail(true)
            void quickSend(address).finally(() => setSendingMail(false))
          })}
        >
          <Send className="size-4" />
          {sendingMail
            ? 'שולח במייל...'
            : quickRecipient?.name.trim()
              ? `שלח ל${quickRecipient.name.trim()}`
              : quickRecipient
                ? `שלח ל${quickRecipient.email}`
                : 'שליחה מהירה'}
        </Button>
        <Button variant="secondary" className="w-full" onClick={clicked(() => setSharing('share'))}>
          <Share2 className="size-4" />
          שלח במייל / שתף
        </Button>
        <Button variant="secondary" className="w-full" onClick={clicked(() => void exportPdf())}>
          <FileDown className="size-4" />
          ייצוא ל-PDF
        </Button>
      </footer>
      <ShareDrawer
        key={sharing ?? 'closed'}
        open={sharing !== null}
        purpose={sharing === 'quick' ? 'quick' : 'share'}
        quickRecipient={quickRecipient}
        onQuickRecipient={setQuickRecipient}
        onClose={() => setSharing(null)}
        onShare={sharePdf}
        onQuickSend={async (email) => {
          setQuickRecipient(readQuickRecipient())
          return quickSend(email)
        }}
      />
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
