import type { FilterMode } from '../types'

export function filterCss(filter: FilterMode): string | undefined {
  if (filter === 'gray') return 'grayscale(1)'
  if (filter === 'bw') return 'grayscale(1) contrast(2.25) brightness(1.06)'
  return undefined
}

export function filteredSource(filter: FilterMode, warpUrl: string, magicUrl: string | null): string {
  if (filter === 'magic' && magicUrl) return magicUrl
  return warpUrl
}
