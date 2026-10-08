import { jsPDF } from 'jspdf'
import type { ScanPage } from '../types'
import { canvasToJpegBlob, downloadBlob, loadImage } from './image'

/** Page image: long edge ~3000px (about 300 DPI on A4) at JPEG 85%, roughly 1MB per text page. */
export const PDF_MAX_EDGE = 3000
export const PDF_JPEG_QUALITY = 0.85

export type PdfOptions = { maxEdge?: number; quality?: number }

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

/** Page size in points. The long edge is A4 (841.89pt); the aspect follows the image. */
function pageFormat(width: number, height: number) {
  const longEdge = 841.89
  const scale = longEdge / Math.max(width, height)
  const pw = width * scale
  const ph = height * scale
  const orientation = pw >= ph ? 'landscape' : 'portrait'
  return { pw, ph, orientation } as const
}

/** Re-encode a stored page at the PDF size and quality so the file stays small enough to email. */
async function encodePage(url: string, maxEdge: number, quality: number): Promise<string> {
  const image = await loadImage(url)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('לא ניתן לקרוא עמוד לקובץ ה-PDF.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  try {
    return await blobToDataUrl(await canvasToJpegBlob(canvas, quality))
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
}

export function pdfFileName() {
  return `folio-${pageStamp()}.pdf`
}

export async function buildPagesPdf(pages: ScanPage[], options: PdfOptions = {}): Promise<Blob> {
  if (pages.length === 0) throw new Error('הוסף עמוד לפני הייצוא.')
  const maxEdge = options.maxEdge ?? PDF_MAX_EDGE
  const quality = options.quality ?? PDF_JPEG_QUALITY

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
    const dataUrl = await encodePage(page.resultUrl, maxEdge, quality)
    doc.addImage(dataUrl, 'JPEG', 0, 0, pw, ph, undefined, 'FAST')
  }

  if (!doc) throw new Error('הוסף עמוד לפני הייצוא.')
  doc.setProperties({ title: 'Folio — סורק מסמכים', creator: 'Folio' })
  return doc.output('blob')
}

export async function exportPagesPdf(pages: ScanPage[]) {
  downloadBlob(await buildPagesPdf(pages), pdfFileName())
}
