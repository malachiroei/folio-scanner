declare module 'jscanify/client' {
  export default class Jscanify {
    findPaperContour(img: unknown): unknown
    getCornerPoints(contour: unknown): {
      topLeftCorner?: { x: number; y: number }
      topRightCorner?: { x: number; y: number }
      bottomLeftCorner?: { x: number; y: number }
      bottomRightCorner?: { x: number; y: number }
    }
    extractPaper(
      image: CanvasImageSource,
      resultWidth: number,
      resultHeight: number,
      cornerPoints?: {
        topLeftCorner: { x: number; y: number }
        topRightCorner: { x: number; y: number }
        bottomLeftCorner: { x: number; y: number }
        bottomRightCorner: { x: number; y: number }
      },
    ): HTMLCanvasElement | null
    highlightPaper(
      image: CanvasImageSource,
      options?: { color?: string; thickness?: number },
    ): HTMLCanvasElement
  }
}
