import { X } from 'lucide-react'

export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-50 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto rise flex max-w-md items-start gap-3 rounded-2xl bg-ink px-4 py-3 text-sm text-paper shadow-2xl dark:bg-paper dark:text-ink"
      >
        <p className="flex-1 leading-5">{message}</p>
        <button
          type="button"
          className="rounded-full p-1 opacity-70 hover:opacity-100"
          aria-label="סגור הודעה"
          onClick={onDismiss}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
