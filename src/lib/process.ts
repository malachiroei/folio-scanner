import type { Corners, FilterMode } from '../types'
import {
  applyCanvasBlackWhite,
  applyCanvasMagic,
  desaturateCanvas,
  renderCanvasDocument,
  straightenCanvas,
} from './canvas-scan'

const PROCESS_BUDGET_MS = 45_000

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0)
  })
}

async function renderWithCanvas(
  image: CanvasImageSource,
  corners: Corners,
  filter: FilterMode,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const canvas = await renderCanvasDocument(image, corners, filter)
  return { canvas, width: canvas.width, height: canvas.height }
}

/** Perspective warp to a strict A4 page, portrait or landscape as the corners dictate, 2800-3508px on the long edge. */
export async function straightenDocument(
  image: CanvasImageSource,
  corners: Corners,
): Promise<HTMLCanvasElement> {
  await yieldToBrowser()
  return straightenCanvas(image, corners, performance.now() + PROCESS_BUDGET_MS)
}

/** Instant grayscale through the 2D context filter. */
export function paintFastFilter(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d')
  if (!context) return desaturateCanvas(source)
  context.filter = 'grayscale(1)'
  context.drawImage(source, 0, 0)
  context.filter = 'none'
  return canvas
}

/** Magic scan: white balance + Bradley-Roth text, protected photos. Yields to the UI while it runs. */
export async function renderMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  await yieldToBrowser()
  return await applyCanvasMagic(source)
}

/** Adaptive black and white document. Yields to the UI while it runs. */
export async function renderBlackWhite(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  await yieldToBrowser()
  return await applyCanvasBlackWhite(source)
}

export async function renderDocument(
  image: CanvasImageSource,
  corners: Corners,
  filter: FilterMode,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  try {
    const warped = await straightenDocument(image, corners)
    if (filter === 'original') return { canvas: warped, width: warped.width, height: warped.height }
    if (filter === 'gray') {
      const canvas = paintFastFilter(warped)
      return { canvas, width: canvas.width, height: canvas.height }
    }
    const canvas = filter === 'bw' ? await renderBlackWhite(warped) : await renderMagic(warped)
    return { canvas, width: canvas.width, height: canvas.height }
  } catch (error) {
    console.error(error)
  }
  return renderWithCanvas(image, corners, filter)
}
