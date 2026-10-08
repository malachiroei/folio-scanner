export type FilterMode = 'magic' | 'bw' | 'gray' | 'original'

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
  detecting: boolean
  snapToken: number
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
  warpUrl: string
  magicUrl: string | null
  resultWidth: number
  resultHeight: number
}

export type PreviewImage = {
  url: string
  warpUrl: string
  magicUrl: string | null
  width: number
  height: number
}
