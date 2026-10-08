import { Blend, Contrast, Image as ImageIcon, Sparkles } from 'lucide-react'
import type { FilterMode } from '../types'

const FILTERS: { id: FilterMode; label: string; hint: string; icon: typeof Sparkles }[] = [
  { id: 'magic', label: 'צבע קסם', hint: 'נייר לבן ודיו צבעונית', icon: Sparkles },
  { id: 'bw', label: 'שחור לבן', hint: 'טקסט שחור וחד', icon: Contrast },
  { id: 'gray', label: 'גווני אפור', hint: 'ללא צבע, אחרי יישור', icon: Blend },
  { id: 'original', label: 'מקורי', hint: 'צבע מקורי, אחרי יישור', icon: ImageIcon },
]

export function FilterControls({
  value,
  onChange,
  disabled = false,
}: {
  value: FilterMode
  onChange: (filter: FilterMode) => void
  disabled?: boolean
}) {
  const active = FILTERS.find((filter) => filter.id === value) ?? FILTERS[0]

  return (
    <div className="rounded-2xl bg-paper/80 p-2 shadow-[0_8px_24px_rgba(20,34,28,0.06)] ring-1 ring-black/5 dark:bg-night-2/80 dark:ring-white/10">
      <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="מסנן עמוד">
        {FILTERS.map((filter) => {
          const selected = filter.id === value
          const Icon = filter.icon
          return (
            <button
              key={filter.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onChange(filter.id)}
              className={`pointer-events-auto flex min-h-16 touch-manipulation flex-col items-center justify-center gap-1 rounded-2xl px-1 text-[11px] leading-tight font-semibold transition active:scale-[0.98] disabled:opacity-40 ${
                selected
                  ? 'bg-moss text-paper shadow-[0_8px_18px_rgba(28,107,86,0.2)]'
                  : 'bg-sand/70 text-ink dark:bg-white/6 dark:text-paper'
              }`}
            >
              <Icon className="size-4" />
              {filter.label}
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-center text-xs text-mist dark:text-paper/55">{active.hint}</p>
    </div>
  )
}
