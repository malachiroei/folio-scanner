import { jsPDF } from 'jspdf'
import type { ScanPage } from '../types'
import { canvasToJpegBlob, downloadBlob, loadImage } from './image'

/** Page image: keep the 125% scan (4042px long edge) without a second downscale. */
export const PDF_MAX_EDGE = 4096
export const PDF_JPEG_QUALITY = 0.95

/** A page stored at full size is embedded as is (no second JPEG pass) when it is smaller than this. */
const REUSE_LIMIT_BYTES = 4_000_000

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

const A4_LONG = 841.89
const A4_SHORT = 595.28

/**
 * Page size in points, orientation strictly from the image: landscape when wider than tall.
 * A page with A4 proportions gets exact A4 (841.89 x 595.28 pt); other shapes keep their aspect.
 */
function pageFormat(width: number, height: number) {
  const landscape = width > height
  const long = Math.max(width, height)
  const short = Math.min(width, height)
  const ratio = long / Math.max(1, short)
  const isA4 = Math.abs(ratio - Math.SQRT2) < 0.04
  const scale = A4_LONG / long
  const pLong = A4_LONG
  const pShort = isA4 ? A4_SHORT : short * scale
  return {
    pw: landscape ? pLong : pShort,
    ph: landscape ? pShort : pLong,
    orientation: landscape ? 'landscape' : 'portrait',
  } as const
}

/** Re-encode a stored page at the PDF size and quality so the file stays small enough to email. */
async function encodePage(url: string, maxEdge: number, quality: number): Promise<string> {
  if (quality >= PDF_JPEG_QUALITY) {
    const stored = await fetch(url).then((response) => response.blob()).catch(() => null)
    if (stored && stored.type === 'image/jpeg' && stored.size <= REUSE_LIMIT_BYTES) {
      const size = await createImageBitmap(stored).catch(() => null)
      const fits = size ? Math.max(size.width, size.height) <= maxEdge : false
      size?.close()
      if (fits) return await blobToDataUrl(stored)
    }
  }
  const image = await loadImage(url)
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('לא ניתן לקרוא עמוד לקובץ ה-PDF.')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
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
  for (const [index, page] of pages.entries()) {
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
    doc.addImage(dataUrl, 'JPEG', 0, 0, pw, ph, `p${index + 1}`, 'FAST')
  }

  if (!doc) throw new Error('הוסף עמוד לפני הייצוא.')
  doc.setProperties({ title: 'סורק מסמכים', creator: 'סורק מסמכים' })
  return doc.output('blob')
}

export async function exportPagesPdf(pages: ScanPage[]) {
  downloadBlob(await buildPagesPdf(pages), pdfFileName())
}
