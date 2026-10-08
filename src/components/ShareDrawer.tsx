import { Mail, Share2, Star, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import {
  readFavoriteEmails,
  writeFavoriteEmails,
  writeQuickRecipient,
  type FavoriteEmail,
  type QuickRecipient,
} from '../lib/favorite-emails'
import { Button } from './Button'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ShareDrawer({
  open,
  purpose,
  quickRecipient,
  onQuickRecipient,
  onClose,
  onShare,
  onQuickSend,
}: {
  open: boolean
  purpose: 'share' | 'quick'
  quickRecipient: QuickRecipient | null
  onQuickRecipient: (recipient: QuickRecipient) => void
  onClose: () => void
  onShare: (email?: string) => Promise<void>
  onQuickSend: (email: string) => Promise<boolean>
}) {
  const [favorites, setFavorites] = useState<FavoriteEmail[]>(() => readFavoriteEmails())
  const [name, setName] = useState(() => quickRecipient?.name ?? '')
  const [email, setEmail] = useState(() => quickRecipient?.email ?? '')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState<string | null>(null)

  function persist(next: FavoriteEmail[]) {
    setFavorites(next)
    writeFavoriteEmails(next)
  }

  function rememberQuick(recipient: QuickRecipient) {
    writeQuickRecipient(recipient)
    onQuickRecipient(recipient)
    if (!favorites.some((item) => item.email.toLowerCase() === recipient.email.toLowerCase())) {
      persist([
        ...favorites,
        { id: crypto.randomUUID(), name: recipient.name || recipient.email, email: recipient.email },
      ])
    }
  }

  function recipientFromForm(): QuickRecipient | null {
    const trimmedName = name.trim()
    const trimmedEmail = email.trim()
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setError('כתובת המייל לא תקינה.')
      return null
    }
    setError(null)
    return { name: trimmedName, email: trimmedEmail }
  }

  async function saveQuick(sendNow: boolean) {
    const recipient = recipientFromForm()
    if (!recipient) return
    rememberQuick(recipient)
    if (!sendNow) return
    setSending('quick')
    try {
      const sent = await onQuickSend(recipient.email)
      if (sent) onClose()
      else setError('השליחה נכשלה. אפשר לשתף או להוריד את הקובץ.')
    } catch (sendError) {
      console.error(sendError)
      setError('לא ניתן לשלוח את המסמך. נסה שוב.')
    } finally {
      setSending(null)
    }
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

  if (!open) return null

  return createPortal(
    <div
      className="pointer-events-auto fixed inset-0 z-[80] flex items-end justify-center bg-night/45"
      role="presentation"
      onClick={onClose}
    >
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
              {purpose === 'quick'
                ? 'שמור נמען פעם אחת. השליחה המהירה שולחת את ה-PDF ישירות למייל, בלי חלון השיתוף.'
                : 'שיתוף פותח Gmail, Outlook או WhatsApp עם ה-PDF. בלי שיתוף, הקובץ יורד ונפתח מייל.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="pointer-events-auto grid size-11 shrink-0 touch-manipulation place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/8"
            aria-label="סגור"
          >
            <X className="size-5" />
          </button>
        </div>

        <form
          className="space-y-2 rounded-2xl bg-paper p-3 dark:bg-night-2"
          onSubmit={(event) => {
            event.preventDefault()
            void saveQuick(purpose === 'quick')
          }}
        >
          <p className="text-sm font-semibold">נמען לשליחה מהירה</p>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="רועי"
            aria-label="שם הנמען המהיר"
            className="pointer-events-auto min-h-12 w-full touch-manipulation rounded-2xl bg-sand px-3 dark:bg-night"
          />
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            aria-label="מייל הנמען המהיר"
            className="pointer-events-auto min-h-12 w-full touch-manipulation rounded-2xl bg-sand px-3 dark:bg-night"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" type="button" onClick={() => void saveQuick(false)}>
              שמור נמען
            </Button>
            <Button type="submit">
              <Star className="size-4" />
              {sending === 'quick' ? 'שולח במייל...' : 'שמור ושלח'}
            </Button>
          </div>
          {error && <p className="text-sm text-copper">{error}</p>}
        </form>

        <Button className="mt-3 w-full" variant="secondary" onClick={() => void send()}>
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
                onClick={() => void send(item.email)}
                className="pointer-events-auto flex min-h-12 min-w-0 flex-1 touch-manipulation items-center gap-2 rounded-2xl bg-paper px-3 text-start active:scale-[0.98] disabled:opacity-40 dark:bg-night-2"
              >
                <Mail className="size-4 shrink-0 text-moss" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">{item.name}</span>
                  <span className="block truncate text-xs text-mist dark:text-paper/55">{item.email}</span>
                </span>
              </button>
              <button
                type="button"
                className="pointer-events-auto grid size-11 shrink-0 touch-manipulation place-items-center rounded-2xl bg-paper text-moss active:scale-[0.98] dark:bg-night-2"
                aria-label={`קבע את ${item.name} כנמען מהיר`}
                onClick={() => rememberQuick({ name: item.name, email: item.email })}
              >
                <Star
                  className="size-4"
                  fill={quickRecipient?.email.toLowerCase() === item.email.toLowerCase() ? 'currentColor' : 'none'}
                />
              </button>
              <button
                type="button"
                className="pointer-events-auto grid size-11 shrink-0 touch-manipulation place-items-center rounded-2xl bg-paper text-copper active:scale-[0.98] dark:bg-night-2"
                aria-label={`מחק את ${item.name}`}
                onClick={() => persist(favorites.filter((entry) => entry.id !== item.id))}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>,
    document.body,
  )
}
