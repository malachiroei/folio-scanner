import { jsPDF } from 'jspdf'
import type { ScanPage } from '../types'
import { downloadBlob } from './image'

function pageStamp(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('לא ניתן לקרוא עמוד לקובץ ה-PDF.'))
    }
    reader.onerror = () => reject(new Error('לא ניתן לקרוא עמוד לקובץ ה-PDF.'))
    reader.readAsDataURL(blob)
  })
}

function pageFormat(width: number, height: number) {
  const longEdge = 841.89
  const scale = longEdge / Math.max(width, height)
  const pw = width * scale
  const ph = height * scale
  const orientation = pw >= ph ? 'landscape' : 'portrait'
  return { pw, ph, orientation } as const
}

export function pdfFileName() {
  return `folio-${pageStamp()}.pdf`
}

export async function buildPagesPdf(pages: ScanPage[]): Promise<Blob> {
  if (pages.length === 0) throw new Error('הוסף עמוד לפני הייצוא.')

  let doc: jsPDF | null = null
  for (const page of pages) {
    const { pw, ph, orientation } = pageFormat(page.resultWidth, page.resultHeight)
    if (!doc) {
      doc = new jsPDF({
        orientation,
        unit: 'pt',
        format: [pw, ph],
        compress: true,
      })
    } else {
      doc.addPage([pw, ph], orientation)
    }
    const response = await fetch(page.resultUrl)
    if (!response.ok) throw new Error('לא ניתן לקרוא עמוד לקובץ ה-PDF.')
    const dataUrl = await blobToDataUrl(await response.blob())
    doc.addImage(dataUrl, 'JPEG', 0, 0, pw, ph, undefined, 'FAST')
  }

  if (!doc) throw new Error('הוסף עמוד לפני הייצוא.')
  doc.setProperties({ title: 'Folio — סורק מסמכים', creator: 'Folio' })
  return doc.output('blob')
}

export async function exportPagesPdf(pages: ScanPage[]) {
  downloadBlob(await buildPagesPdf(pages), pdfFileName())
}
