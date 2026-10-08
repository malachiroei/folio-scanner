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

const QUICK_KEY = 'folio-quick-recipient'

export type QuickRecipient = {
  name: string
  email: string
}

export function readQuickRecipient(): QuickRecipient | null {
  try {
    const raw = localStorage.getItem(QUICK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const item = parsed as QuickRecipient
    if (typeof item.email !== 'string' || !item.email.includes('@')) return null
    return { name: typeof item.name === 'string' ? item.name : '', email: item.email }
  } catch {
    return null
  }
}

export function writeQuickRecipient(recipient: QuickRecipient | null) {
  if (!recipient) {
    localStorage.removeItem(QUICK_KEY)
    return
  }
  localStorage.setItem(QUICK_KEY, JSON.stringify(recipient))
}
