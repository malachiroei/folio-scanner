import { Mail, Share2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { readFavoriteEmails, writeFavoriteEmails, type FavoriteEmail } from '../lib/favorite-emails'
import { Button } from './Button'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ShareDrawer({
  onClose,
  onShare,
}: {
  onClose: () => void
  onShare: (email?: string) => Promise<void>
}) {
  const [favorites, setFavorites] = useState<FavoriteEmail[]>(() => readFavoriteEmails())
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<string | null>(null)

  function persist(next: FavoriteEmail[]) {
    setFavorites(next)
    writeFavoriteEmails(next)
  }

  function addFavorite() {
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError('כתובת המייל לא תקינה.')
      return
    }
    if (favorites.some((item) => item.email.toLowerCase() === trimmedEmail.toLowerCase())) {
      setError('הכתובת הזו כבר שמורה.')
      return
    }
    persist([
      ...favorites,
      { id: crypto.randomUUID(), name: trimmedName || trimmedEmail, email: trimmedEmail },
    ])
    setName('')
    setEmail('')
    setError(null)
  }

  async function send(target?: string) {
    setSending(target ?? 'share')
    setError(null)
    try {
      await onShare(target)
      onClose()
    } catch (sendError) {
      console.error(sendError)
      setError('לא ניתן לשלוח את המסמך. נסה שוב.')
    } finally {
      setSending(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-night/45" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="max-h-[min(34rem,88dvh)] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-sand px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-ink shadow-[0_-12px_40px_rgba(20,34,28,0.2)] dark:bg-night dark:text-paper"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="share-title" className="font-display text-2xl font-semibold">
              מועדפים / שליחה מהירה
            </h2>
            <p className="mt-1 text-sm text-mist dark:text-paper/60">
              שיתוף פותח Gmail, Outlook או WhatsApp עם ה-PDF. בלי שיתוף, הקובץ יורד ונפתח מייל.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
            aria-label="סגור"
          >
            <X className="size-5" />
          </button>
        </div>

        <Button className="w-full" disabled={sending !== null} onClick={() => void send()}>
          <Share2 className="size-4" />
          {sending === 'share' ? 'מכין מסמך…' : 'שתף עכשיו'}
        </Button>

        <ul className="mt-4 space-y-2">
          {favorites.length === 0 && (
            <li className="rounded-2xl bg-paper px-3 py-3 text-sm text-mist dark:bg-night-2 dark:text-paper/60">
              אין אנשי קשר שמורים. אפשר להוסיף משרד, הנהלת חשבונות או מייל אישי.
            </li>
          )}
          {favorites.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <button
                type="button"
                disabled={sending !== null}
                onClick={() => void send(item.email)}
                className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-2xl bg-paper px-3 text-start active:scale-[0.98] disabled:opacity-40 dark:bg-night-2"
              >
                <Mail className="size-4 shrink-0 text-moss" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{item.name}</span>
                  <span className="block truncate text-xs text-mist dark:text-paper/55">{item.email}</span>
                </span>
              </button>
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center rounded-2xl bg-paper text-copper active:scale-[0.98] dark:bg-night-2"
                aria-label={`מחק את ${item.name}`}
                onClick={() => persist(favorites.filter((entry) => entry.id !== item.id))}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>

        <form
          className="mt-4 space-y-2"
          onSubmit={(event) => {
            event.preventDefault()
            addFavorite()
          }}
        >
          <label className="block text-sm font-semibold" htmlFor="favorite-name">
            שם הקיצור
          </label>
          <input
            id="favorite-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="משרד"
            className="min-h-12 w-full rounded-2xl bg-paper px-3 dark:bg-night-2"
          />
          <label className="block text-sm font-semibold" htmlFor="favorite-email">
            כתובת מייל
          </label>
          <input
            id="favorite-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            className="min-h-12 w-full rounded-2xl bg-paper px-3 dark:bg-night-2"
          />
          {error && <p className="text-sm text-copper">{error}</p>}
          <Button variant="secondary" className="w-full" type="submit">
            הוסף
          </Button>
        </form>
      </div>
    </div>
  )
}
