import { ChevronLeft } from 'lucide-react'
import { useScan } from '../state/scan-context'
import { Button } from './Button'
import { FilterControls } from './FilterControls'
import { Spinner } from './Spinner'

export function PreviewScreen() {
  const { draft, preview, busy, setFilter, commitPage, backToCorners, retryPreview } = useScan()
  if (!draft) return null

  return (
    <div className="app-bg flex min-h-dvh flex-col text-ink dark:text-paper">
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={backToCorners}
          className="grid size-11 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
          aria-label="Back to corners"
        >
          <ChevronLeft className="size-6" />
        </button>
        <h1 className="font-display text-2xl">Preview</h1>
      </header>

      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div className="relative max-h-full max-w-full" aria-busy={Boolean(busy)}>
          {preview ? (
            <img
              src={preview.url}
              alt="Straightened document preview"
              className="max-h-[58dvh] max-w-full rounded-sm bg-white object-contain shadow-[0_18px_50px_rgba(20,34,28,0.18)]"
            />
          ) : (
            <div className="grid h-64 w-56 place-items-center rounded-sm bg-paper text-moss shadow-lg dark:bg-night-2">
              <Spinner className="size-8" />
            </div>
          )}
          {busy && preview && (
            <div className="absolute inset-0 grid place-items-center rounded-sm bg-night/35 text-paper">
              <span className="flex items-center gap-2 rounded-full bg-night/80 px-3 py-2 text-sm">
                <Spinner className="size-4" />
                {busy}
              </span>
            </div>
          )}
        </div>
      </div>

      <footer className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <FilterControls value={draft.filter} onChange={setFilter} disabled={Boolean(busy)} />
        {!preview && !busy && (
          <Button variant="secondary" className="w-full" onClick={retryPreview}>
            Try again
          </Button>
        )}
        {draft.editingId ? (
          <Button className="w-full" disabled={!preview || Boolean(busy)} onClick={() => commitPage(false)}>
            Save page
          </Button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={!preview || Boolean(busy)} onClick={() => commitPage(false)}>
              Add page
            </Button>
            <Button disabled={!preview || Boolean(busy)} onClick={() => commitPage(true)}>
              Scan next
            </Button>
          </div>
        )}
      </footer>
    </div>
  )
}
