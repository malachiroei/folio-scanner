import { createContext, useContext } from 'react'
import type { Corners, Draft, EngineStatus, FilterMode, PreviewImage, ScanPage, Screen } from '../types'

export type ScanContextValue = {
  theme: 'light' | 'dark'
  toggleTheme: () => void
  engine: EngineStatus
  retryEngine: () => void
  screen: Screen
  busy: string | null
  toast: string | null
  dismissToast: () => void
  pages: ScanPage[]
  draft: Draft | null
  preview: PreviewImage | null
  selectedId: string | null
  openCamera: () => void
  closeCamera: () => void
  ingestFile: (file: File) => void
  ingestBlob: (blob: Blob) => void
  updateCorners: (corners: Corners) => void
  resetDetection: () => Promise<void>
  useFullFrame: () => void
  confirmCorners: () => void
  backFromCorners: () => void
  backToCorners: () => void
  setFilter: (filter: FilterMode) => void
  retryPreview: () => void
  commitPage: (scanAnother: boolean) => void
  openPages: () => void
  closePages: () => void
  selectPage: (id: string) => void
  movePage: (id: string, direction: -1 | 1) => void
  deletePage: (id: string) => void
  refilterPage: (id: string, filter: FilterMode) => Promise<void>
  editPageCorners: (id: string) => void
  downloadPage: (id: string) => void
  downloadAll: () => Promise<void>
  exportPdf: () => Promise<void>
}

export const ScanContext = createContext<ScanContextValue | null>(null)

export function useScan(): ScanContextValue {
  const value = useContext(ScanContext)
  if (!value) throw new Error('useScan must be used within ScanProvider')
  return value
}
