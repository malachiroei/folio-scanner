import { Resend } from 'resend'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_PDF_CHARS = 4_500_000

type SendBody = {
  success: true
} | {
  error: string
}

export type SendScanResult = {
  status: number
  body: SendBody
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function pdfPayload(value: unknown): string {
  const raw = textValue(value).replace(/\s/g, '')
  const marker = 'base64,'
  const splitAt = raw.indexOf(marker)
  return splitAt >= 0 ? raw.slice(splitAt + marker.length) : raw
}

function pdfName(value: unknown): string {
  const base = textValue(value).split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[^\w.-]+/g, '')
  if (!cleaned || cleaned.length > 120) return 'scanned-document.pdf'
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`
}

export async function sendScan(input: unknown): Promise<SendScanResult> {
  const body = typeof input === 'string' ? safeJson(input) : input
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'גוף הבקשה לא תקין.' } }
  }
  const record = body as { to?: unknown; pdfBase64?: unknown; filename?: unknown }
  const to = textValue(record.to)
  const pdfBase64 = pdfPayload(record.pdfBase64)
  if (!EMAIL_PATTERN.test(to)) {
    return { status: 400, body: { error: 'כתובת המייל לא תקינה.' } }
  }
  if (!pdfBase64 || !/^[A-Za-z0-9+/=]+$/.test(pdfBase64)) {
    return { status: 400, body: { error: 'קובץ ה-PDF חסר או לא תקין.' } }
  }
  if (pdfBase64.length > MAX_PDF_CHARS) {
    return { status: 413, body: { error: 'ה-PDF גדול מדי לשליחה במייל.' } }
  }

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    return { status: 500, body: { error: 'שרת המייל לא מוגדר.' } }
  }

  const resend = new Resend(apiKey)
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM || 'Folio Scanner <onboarding@resend.dev>',
    to,
    subject: `סריקת מסמך - Folio (${new Date().toLocaleDateString('he-IL')})`,
    text: 'מצורף קובץ PDF של המסמך שנסרק באפליקציית Folio.',
    attachments: [{ filename: pdfName(record.filename), content: pdfBase64 }],
  })
  if (error) {
    return { status: 502, body: { error: error.message || 'שליחת המייל נכשלה.' } }
  }
  return { status: 200, body: { success: true } }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

type ApiRequest = {
  method?: string
  body?: unknown
}

type ApiResponse = {
  status: (code: number) => { json: (body: SendBody) => void }
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' })
    return
  }
  const result = await sendScan(req.body)
  res.status(result.status).json(result.body)
}
