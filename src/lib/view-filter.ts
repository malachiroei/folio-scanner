import type { FilterMode } from '../types'

export function filterCss(filter: FilterMode): string | undefined {
  if (filter === 'gray') return 'grayscale(1)'
  return undefined
}

/** Magic and B&W are real processed images; gray is a CSS filter on the straightened page. */
export function filteredSource(
  filter: FilterMode,
  warpUrl: string,
  magicUrl: string | null,
  bwUrl: string | null = null,
): string {
  if (filter === 'magic' && magicUrl) return magicUrl
  if (filter === 'bw' && bwUrl) return bwUrl
  return warpUrl
}
