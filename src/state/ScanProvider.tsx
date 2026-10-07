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

  useEffect(() => {
    draftRef.current = draft
    pagesRef.current = pages
    previewRef.current = preview
  }, [draft, pages, preview])

  useEffect(() => {
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
    setToast('Retrying the vision engine in the background.')
    beginVisionLoad()
  }

  function dismissToast() {
    setToast(null)
  }

  async function ingestBlob(blob: Blob) {
    setScreen('prepare')
    const visionReady = isOpenCvReady()
    setBusy(visionReady ? 'Finding the page…' : 'Preparing photo…')
    if (!visionReady) setToast('Preparing this photo. Edge detection will catch up in the background.')
    await nextFrame()
    let normalized: { url: string; width: number; height: number } | null = null
    try {
      normalized = await normalizeImage(blob)
      const image = await loadImage(normalized.url)
      const found = visionReady
        ? detectDocumentCorners(image, normalized.width, normalized.height)
        : { corners: defaultCorners(normalized.width, normalized.height, 0.07), detected: false }
      setDraft({
        sourceUrl: normalized.url,
        width: normalized.width,
        height: normalized.height,
        corners: found.corners,
        filter: 'magic',
        detected: found.detected,
        editingId: null,
      })
      setScreen('corners')
      window.setTimeout(() => beginVisionLoad(), 0)
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
      setToast('Choose a JPEG, PNG, or WebP photo.')
      return
    }
    void ingestBlob(file)
  }

  function updateCorners(corners: Corners) {
    setDraft((current) => (current ? { ...current, corners, detected: true } : current))
  }

  async function resetDetection() {
    const current = draftRef.current
    if (!current) return
    if (!isOpenCvReady()) {
      setDraft((draftNow) =>
        draftNow
          ? {
              ...draftNow,
              corners: defaultCorners(draftNow.width, draftNow.height, 0.07),
              detected: false,
            }
          : draftNow,
      )
      setToast('Edge detection needs the vision engine. Drag the pins, or retry from the home screen.')
      return
    }
    setBusy('Finding the page…')
    try {
      await nextFrame()
      const image = await loadImage(current.sourceUrl)
      const found = detectDocumentCorners(image, current.width, current.height)
      setDraft((draftNow) =>
        draftNow ? { ...draftNow, corners: found.corners, detected: found.detected } : draftNow,
      )
    } catch (error) {
      setToast(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  function useFullFrame() {
    setDraft((current) =>
      current
        ? { ...current, corners: defaultCorners(current.width, current.height, 0.015), detected: true }
        : current,
    )
  }

  async function renderPreview(source: Draft, filter: FilterMode) {
    const token = ++requestRef.current
    setBusy(filter === 'original' ? 'Straightening…' : 'Cleaning the page…')
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
      if (token === requestRef.current) setToast(errorMessage(error))
    } finally {
      if (token === requestRef.current) setBusy(null)
    }
  }

  function confirmCorners() {
    const current = draftRef.current
    if (!current) return
    if (!cornersValid(current.corners, current.width, current.height)) {
      setToast('Drag the pins so they frame the page without crossing.')
      return
    }
    setScreen('preview')
    void renderPreview(current, current.filter)
  }

  function backFromCorners() {
    const current = draftRef.current
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
    setBusy(filter === 'original' ? 'Straightening…' : 'Cleaning the page…')
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
    setBusy('Building PDF…')
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
