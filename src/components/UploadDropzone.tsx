import { ImagePlus } from 'lucide-react'
import { useRef, useState } from 'react'

export function UploadDropzone({
  onFile,
  disabled = false,
}: {
  onFile: (file: File) => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  function take(file: File | undefined) {
    if (!file || disabled) return
    onFile(file)
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setOver(false)
        take(event.dataTransfer.files[0])
      }}
      className={`rounded-2xl shadow-[0_10px_28px_rgba(20,34,28,0.08)] ring-1 transition ${
        over
          ? 'bg-moss/10 ring-moss'
          : 'bg-paper ring-black/8 dark:bg-night-2 dark:ring-white/10'
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(event) => {
          take(event.target.files?.[0])
          event.target.value = ''
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="flex min-h-16 w-full items-center gap-4 rounded-2xl px-4 py-3 text-start active:scale-[0.98] disabled:opacity-40"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-sand text-moss dark:bg-white/8 dark:text-moss-bright">
          <ImagePlus className="size-5" />
        </span>
        <span>
          <span className="block font-semibold">העלאת תמונה מהגלריה</span>
          <span className="mt-0.5 block text-sm text-mist dark:text-paper/60">בחר קובץ או גרור לכאן</span>
        </span>
      </button>
    </div>
  )
}
