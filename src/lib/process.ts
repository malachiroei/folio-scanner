import type { Corners, FilterMode } from '../types'
import { applyCanvasMagic, renderCanvasDocument, straightenCanvas } from './canvas-scan'

const PROCESS_BUDGET_MS = 3000

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

export async function straightenDocument(
  image: CanvasImageSource,
  corners: Corners,
): Promise<HTMLCanvasElement> {
  await yieldToBrowser()
  return straightenCanvas(image, corners, performance.now() + PROCESS_BUDGET_MS)
}

export function paintFastFilter(source: HTMLCanvasElement, filter: 'gray' | 'bw'): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const context = canvas.getContext('2d')
  if (!context) return source
  context.filter = filter === 'gray' ? 'grayscale(1)' : 'grayscale(1) contrast(2.25) brightness(1.06)'
  context.drawImage(source, 0, 0)
  context.filter = 'none'
  return canvas
}

export async function renderMagic(source: HTMLCanvasElement): Promise<HTMLCanvasElement> {
  await yieldToBrowser()
  return await applyCanvasMagic(source)
}

export async function renderDocument(
  image: CanvasImageSource,
  corners: Corners,
  filter: FilterMode,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  try {
    const warped = await straightenDocument(image, corners)
    if (filter === 'original') return { canvas: warped, width: warped.width, height: warped.height }
    if (filter === 'gray' || filter === 'bw') {
      const canvas = paintFastFilter(warped, filter)
      return { canvas, width: canvas.width, height: canvas.height }
    }
    const canvas = await renderMagic(warped)
    return { canvas, width: canvas.width, height: canvas.height }
  } catch (error) {
    console.error(error)
  }
  return renderWithCanvas(image, corners, filter)
}
