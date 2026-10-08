const STORAGE_KEY = 'folio-favorite-emails'

export type FavoriteEmail = {
  id: string
  name: string
  email: string
}

function isFavorite(value: unknown): value is FavoriteEmail {
  if (!value || typeof value !== 'object') return false
  const item = value as FavoriteEmail
  return typeof item.id === 'string' && typeof item.name === 'string' && typeof item.email === 'string'
}

export function readFavoriteEmails(): FavoriteEmail[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isFavorite)
  } catch {
    return []
  }
}

export function writeFavoriteEmails(list: FavoriteEmail[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
}
