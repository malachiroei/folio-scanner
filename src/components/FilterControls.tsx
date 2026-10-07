import { Contrast, Image as ImageIcon, Sparkles } from 'lucide-react'
import type { FilterMode } from '../types'

const FILTERS: { id: FilterMode; label: string; hint: string; icon: typeof Sparkles }[] = [
  { id: 'magic', label: 'Magic Color', hint: 'White paper, colored ink', icon: Sparkles },
  { id: 'bw', label: 'B&W', hint: 'Crisp black text', icon: Contrast },
  { id: 'original', label: 'Original', hint: 'Color, straightened', icon: ImageIcon },
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
    <div>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Page filter">
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
              className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl px-2 text-xs font-semibold transition disabled:opacity-40 ${
                selected
                  ? 'bg-moss text-paper shadow-[0_8px_18px_rgba(28,107,86,0.2)]'
                  : 'bg-paper text-ink ring-1 ring-black/10 dark:bg-night-2 dark:text-paper dark:ring-white/10'
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
