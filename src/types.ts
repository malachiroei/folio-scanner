export type FilterMode = 'magic' | 'bw' | 'original'

export type Point = { x: number; y: number }

export type CornerKey = 'tl' | 'tr' | 'br' | 'bl'

export type Corners = Record<CornerKey, Point>

export type Screen = 'home' | 'camera' | 'prepare' | 'corners' | 'preview' | 'pages'

export type EngineStatus = 'idle' | 'ready' | 'fallback'

export type Draft = {
  sourceUrl: string
  width: number
  height: number
  corners: Corners
  filter: FilterMode
  detected: boolean
  editingId: string | null
}

export type ScanPage = {
  id: string
  sourceUrl: string
  width: number
  height: number
  corners: Corners
  filter: FilterMode
  resultUrl: string
  resultWidth: number
  resultHeight: number
}

export type PreviewImage = {
  url: string
  width: number
  height: number
}
