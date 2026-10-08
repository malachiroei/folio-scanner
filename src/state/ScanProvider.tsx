import { useEffect, useRef, useState, type ReactNode } from 'react'
import { detectDocumentCorners } from '../lib/detect'
import { cornersValid, defaultCorners } from '../lib/geometry'
import { isOpenCvReady, loadOpenCv } from '../lib/opencv'
import {
  canvasToJpegBlob,
  downloadUrl,
  errorMessage,
  loadImage,
  nextFrame,
  normalizeImage,
} from '../lib/image'
import { renderDocument } from '../lib/process'
import type { Corners, Draft, EngineStatus, FilterMode, PreviewImage, ScanPage, Screen } from '../types'
import { ScanContext } from './scan-context'

function readTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem('folio-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function pageFileName(index: number) {
  return `folio-page-${String(index + 1).padStart(2, '0')}.jpg`
}

function filterLabel(filter: FilterMode) {
  if (filter === 'original') return 'מיישר את העמוד…'
  if (filter === 'gray') return 'ממיר לגווני אפור…'
  return 'מנקה את העמוד…'
}

export function ScanProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme)
  const [engine, setEngine] = useState<EngineStatus>('idle')
  const [screen, setScreen] = useState<Screen>('home')
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pages, setPages] = useState<ScanPage[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState<PreviewImage | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const draftRef = useRef(draft)
  const pagesRef = useRef(pages)
  const previewRef = useRef(preview)
  const requestRef = useRef(0)
  const userAdjustedRef = useRef(false)
  const detectGen = useRef(0)

  useEffect(() => {
    draftRef.current = draft
    pagesRef.current = pages
    previewRef.current = preview
  }, [draft, pages, preview])

  useEffect(() => {
    document.documentElement.lang = 'he'
    document.documentElement.dir = 'rtl'
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    localStorage.setItem('folio-theme', theme)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0e1614' : '#efe7da')
  }, [theme])

  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(id)
  }, [toast])

  useEffect(() => {
    const report = (error: unknown) => {
      console.error(error)
      setToast(errorMessage(error))
    }
    const onError = (event: ErrorEvent) => {
      if (event.target !== window) return
      report(event.error ?? event.message)
    }
    const onRejection = (event: PromiseRejectionEvent) => report(event.reason)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  function replacePreview(next: PreviewImage | null) {
    const previous = previewRef.current
    if (previous && previous.url !== next?.url) URL.revokeObjectURL(previous.url)
    previewRef.current = next
    setPreview(next)
  }

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  function beginVisionLoad() {
    if (isOpenCvReady()) {
      setEngine('ready')
      return
    }
    void loadOpenCv()
      .then(() => setEngine('ready'))
      .catch(() => setEngine((status) => (status === 'ready' ? status : 'fallback')))
  }

  function retryEngine() {
    setToast('מנסה לטעון שוב את מנוע הזיהוי ברקע.')
    beginVisionLoad()
  }

  function dismissToast() {
    setToast(null)
  }

  function applyAutoCorners(corners: Corners, detected: boolean) {
    if (userAdjustedRef.current) return
    setDraft((current) =>
      current
        ? {
            ...current,
            corners,
            detected,
            detecting: false,
            snapToken: current.snapToken + 1,
          }
        : current,
    )
  }

  function stopDetecting() {
    setDraft((current) => (current ? { ...current, detecting: false } : current))
  }

  function scheduleLocate(sourceUrl: string, width: number, height: number) {
    const gen = ++detectGen.current

    window.setTimeout(() => {
      const started = performance.now()
      const expired = () => performance.now() - started > 1000 || gen !== detectGen.current
      const idle = window.requestIdleCallback
      const start = () => {
        void locatePage(sourceUrl, width, height, gen, expired)
      }
      if (typeof idle === 'function') idle(start, { timeout: 50 })
      else start()
    }, 50)
  }

  async function locatePage(
    sourceUrl: string,
    width: number,
    height: number,
    gen: number,
    expired: () => boolean,
  ) {
    if (expired() || userAdjustedRef.current) {
      stopDetecting()
      return
    }
    if (!isOpenCvReady()) {
      stopDetecting()
      return
    }
    try {
      await nextFrame()
      if (expired() || userAdjustedRef.current) {
        stopDetecting()
        return
      }
      const image = await loadImage(sourceUrl)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      if (expired() || userAdjustedRef.current || gen !== detectGen.current) {
        stopDetecting()
        return
      }
      const found = detectDocumentCorners(image, width, height)
      if (expired() || userAdjustedRef.current || gen !== detectGen.current || !found.detected) {
        stopDetecting()
        return
      }
      applyAutoCorners(found.corners, true)
    } catch (error) {
      console.error(error)
      stopDetecting()
      setToast(errorMessage(error))
    }
  }

  async function ingestBlob(blob: Blob) {
    setScreen('prepare')
    setBusy('מכין את התמונה…')
    await nextFrame()
    let normalized: { url: string; width: number; height: number } | null = null
    try {
      normalized = await normalizeImage(blob)
      userAdjustedRef.current = false
      const next = {
        sourceUrl: normalized.url,
        width: normalized.width,
        height: normalized.height,
        corners: defaultCorners(normalized.width, normalized.height, 0.1),
        filter: 'magic' as const,
        detected: false,
        detecting: true,
        snapToken: 0,
        editingId: null,
      }
      draftRef.current = next
      setDraft(next)
      setBusy(null)
      setScreen('corners')
      scheduleLocate(normalized.url, normalized.width, normalized.height)
    } catch (error) {
      if (normalized) URL.revokeObjectURL(normalized.url)
      setToast(errorMessage(error))
      setScreen('home')
    } finally {
      setBusy(null)
    }
  }

  function ingestFile(file: File) {
    if (file.type && !file.type.startsWith('image/')) {
      setToast('בחר תמונת JPEG, PNG או WebP.')
      return
    }
    void ingestBlob(file)
  }

  function updateCorners(corners: Corners) {
    userAdjustedRef.current = true
    const current = draftRef.current
    if (!current) return
    const next = { ...current, corners, detected: true, detecting: false }
    draftRef.current = next
    setDraft(next)
  }

  async function resetDetection() {
    const current = draftRef.current
    if (!current) return
    userAdjustedRef.current = false
    const next = {
      ...current,
      corners: defaultCorners(current.width, current.height, 0.1),
      detected: false,
      detecting: true,
    }
    draftRef.current = next
    setDraft(next)
    scheduleLocate(current.sourceUrl, current.width, current.height)
  }

  function resetPins() {
    const current = draftRef.current
    if (!current) return
    detectGen.current += 1
    userAdjustedRef.current = true
    const next = {
      ...current,
      corners: defaultCorners(current.width, current.height, 0.1),
      detected: false,
      detecting: false,
    }
    draftRef.current = next
    setDraft(next)
  }

  function useFullFrame() {
    const current = draftRef.current
    if (!current) return
    detectGen.current += 1
    userAdjustedRef.current = true
    const next = {
      ...current,
      corners: defaultCorners(current.width, current.height, 0.015),
      detected: true,
      detecting: false,
    }
    draftRef.current = next
    setDraft(next)
  }

  async function renderPreview(source: Draft, filter: FilterMode) {
    const token = ++requestRef.current
    setBusy(filterLabel(filter))
    try {
      await nextFrame()
      const image = await loadImage(source.sourceUrl)
      const rendered = await renderDocument(image, source.corners, filter)
      if (token !== requestRef.current) return
      const blob = await canvasToJpegBlob(rendered.canvas, 0.93)
      if (token !== requestRef.current) return
      replacePreview({
        url: URL.createObjectURL(blob),
        width: rendered.width,
        height: rendered.height,
      })
    } catch (error) {
      console.error(error)
      if (token === requestRef.current) setToast(errorMessage(error))
    } finally {
      if (token === requestRef.current) setBusy(null)
    }
  }

  function confirmCorners() {
    const current = draftRef.current
    if (!current) {
      console.error('confirmCorners: no page is ready to process')
      setToast('אין עמוד לעיבוד.')
      return
    }
    if (!cornersValid(current.corners, current.width, current.height)) {
      console.error('confirmCorners: pins are not a perfect quad, continuing', current.corners)
    }
    try {
      setScreen('preview')
      window.setTimeout(() => beginVisionLoad(), 50)
      void renderPreview(current, current.filter)
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    }
  }

  function backFromCorners() {
    const current = draftRef.current
    detectGen.current += 1
    requestRef.current += 1
    replacePreview(null)
    setBusy(null)
    if (current?.editingId) {
      setDraft(null)
      setScreen('pages')
      return
    }
    if (current) URL.revokeObjectURL(current.sourceUrl)
    setDraft(null)
    setScreen('home')
  }

  function backToCorners() {
    requestRef.current += 1
    setBusy(null)
    setScreen('corners')
  }

  function setFilter(filter: FilterMode) {
    const current = draftRef.current
    if (!current) return
    const next = { ...current, filter }
    draftRef.current = next
    setDraft(next)
    void renderPreview(next, filter)
  }

  function retryPreview() {
    const current = draftRef.current
    if (!current) return
    void renderPreview(current, current.filter)
  }

  function commitPage(scanAnother: boolean) {
    const current = draftRef.current
    const shot = previewRef.current
    if (!current || !shot) return
    const page: ScanPage = {
      id: current.editingId ?? crypto.randomUUID(),
      sourceUrl: current.sourceUrl,
      width: current.width,
      height: current.height,
      corners: current.corners,
      filter: current.filter,
      resultUrl: shot.url,
      resultWidth: shot.width,
      resultHeight: shot.height,
    }
    previewRef.current = null
    setPreview(null)
    setPages((prev) => {
      if (!current.editingId) return [...prev, page]
      return prev.map((item) => {
        if (item.id !== current.editingId) return item
        if (item.resultUrl !== page.resultUrl) URL.revokeObjectURL(item.resultUrl)
        return page
      })
    })
    setDraft(null)
    setSelectedId(page.id)
    setScreen(scanAnother ? 'camera' : 'pages')
  }

  function openPages() {
    const list = pagesRef.current
    setSelectedId((current) =>
      current && list.some((page) => page.id === current) ? current : (list.at(-1)?.id ?? null),
    )
    setScreen('pages')
  }

  function selectPage(id: string) {
    setSelectedId(id)
  }

  function movePage(id: string, direction: -1 | 1) {
    setPages((prev) => {
      const index = prev.findIndex((page) => page.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const copy = [...prev]
      const [item] = copy.splice(index, 1)
      if (!item) return prev
      copy.splice(target, 0, item)
      return copy
    })
  }

  function deletePage(id: string) {
    const prev = pagesRef.current
    const page = prev.find((item) => item.id === id)
    if (!page) return
    URL.revokeObjectURL(page.sourceUrl)
    URL.revokeObjectURL(page.resultUrl)
    const next = prev.filter((item) => item.id !== id)
    pagesRef.current = next
    setPages(next)
    if (next.length === 0) {
      setSelectedId(null)
      setScreen('home')
      return
    }
    if (selectedId === id) {
      const index = prev.findIndex((item) => item.id === id)
      setSelectedId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? null)
    }
  }

  async function refilterPage(id: string, filter: FilterMode) {
    const page = pagesRef.current.find((item) => item.id === id)
    if (!page || page.filter === filter) return
    const token = ++requestRef.current
    setBusy(filterLabel(filter))
    try {
      await nextFrame()
      const image = await loadImage(page.sourceUrl)
      const rendered = await renderDocument(image, page.corners, filter)
      if (token !== requestRef.current) return
      const blob = await canvasToJpegBlob(rendered.canvas, 0.93)
      const url = URL.createObjectURL(blob)
      if (token !== requestRef.current) {
        URL.revokeObjectURL(url)
        return
      }
      setPages((prev) =>
        prev.map((item) => {
          if (item.id !== id) return item
          URL.revokeObjectURL(item.resultUrl)
          return {
            ...item,
            filter,
            resultUrl: url,
            resultWidth: rendered.width,
            resultHeight: rendered.height,
          }
        }),
      )
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      if (token === requestRef.current) setBusy(null)
    }
  }

  function editPageCorners(id: string) {
    const page = pagesRef.current.find((item) => item.id === id)
    if (!page) return
    detectGen.current += 1
    userAdjustedRef.current = true
    requestRef.current += 1
    replacePreview(null)
    setBusy(null)
    setDraft({
      sourceUrl: page.sourceUrl,
      width: page.width,
      height: page.height,
      corners: page.corners,
      filter: page.filter,
      detected: true,
      detecting: false,
      snapToken: 0,
      editingId: page.id,
    })
    setScreen('corners')
  }

  function downloadPage(id: string) {
    const list = pagesRef.current
    const index = list.findIndex((page) => page.id === id)
    const page = list[index]
    if (!page || index < 0) return
    downloadUrl(page.resultUrl, pageFileName(index))
  }

  async function downloadAll() {
    const list = pagesRef.current
    for (let index = 0; index < list.length; index += 1) {
      const page = list[index]
      if (!page) continue
      downloadUrl(page.resultUrl, pageFileName(index))
      await new Promise((resolve) => window.setTimeout(resolve, 280))
    }
  }

  async function exportPdf() {
    const list = pagesRef.current
    if (list.length === 0) return
    setBusy('מכין PDF…')
    try {
      await nextFrame()
      const { exportPagesPdf } = await import('../lib/pdf')
      await exportPagesPdf(list)
      try {
        const { default: confetti } = await import('canvas-confetti')
        void confetti({
          particleCount: 90,
          spread: 70,
          startVelocity: 34,
          origin: { y: 0.75 },
          colors: ['#fbf7f0', '#e7a06a', '#1c6b56', '#ffffff'],
          disableForReducedMotion: true,
        })
      } catch (error) {
        console.error(error)
      }
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const value = {
    theme,
    toggleTheme,
    engine,
    retryEngine,
    screen,
    busy,
    toast,
    dismissToast,
    pages,
    draft,
    preview,
    selectedId,
    openCamera: () => setScreen('camera'),
    closeCamera: () => setScreen('home'),
    ingestFile,
    ingestBlob,
    updateCorners,
    resetDetection,
    resetPins,
    useFullFrame,
    confirmCorners,
    backFromCorners,
    backToCorners,
    setFilter,
    retryPreview,
    commitPage,
    openPages,
    closePages: () => setScreen('home'),
    selectPage,
    movePage,
    deletePage,
    refilterPage,
    editPageCorners,
    downloadPage,
    downloadAll,
    exportPdf,
  }

  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>
}
