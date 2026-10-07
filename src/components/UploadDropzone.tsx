import { Upload } from 'lucide-react'
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
      className={`rounded-[28px] border border-dashed p-3 transition ${
        over
          ? 'border-moss bg-moss/10'
          : 'border-black/15 bg-paper/70 dark:border-white/15 dark:bg-night-2/80'
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
        className="flex min-h-24 w-full items-center gap-4 rounded-[22px] px-3 text-left disabled:opacity-40"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-sand text-moss dark:bg-white/8 dark:text-moss-bright">
          <Upload className="size-5" />
        </span>
        <span>
          <span className="block font-semibold">Upload a photo</span>
          <span className="mt-0.5 block text-sm text-mist dark:text-paper/60">
            Drop an image here, or browse your library
          </span>
        </span>
      </button>
    </div>
  )
}
