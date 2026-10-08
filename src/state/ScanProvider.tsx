import { useEffect, useRef, useState, type ReactNode } from 'react'
import { detectDocumentCorners } from '../lib/detect'
import { cornersValid, defaultCorners } from '../lib/geometry'
import { isOpenCvReady, loadOpenCv } from '../lib/opencv'
import {
  canvasToJpegBlob,
  downloadBlob,
  errorMessage,
  loadImage,
  nextFrame,
  normalizeImage,
} from '../lib/image'
import { cachedMagic, cachedWarp, loadMagic, pageKey, storeWarp } from '../lib/page-cache'
import { paintFastFilter, renderMagic, straightenDocument } from '../lib/process'
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
  const processingRef = useRef(false)
  const processingOwner = useRef(0)
  const processedKeyRef = useRef<string | null>(null)
  const userAdjustedRef = useRef(false)
  const detectGen = useRef(0)
  const busyToken = useRef(0)

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

  function beginBusy(label: string) {
    const token = ++busyToken.current
    let closed = false
    const finish = () => {
      if (closed || token !== busyToken.current) return
      closed = true
      busyToken.current += 1
      setBusy(null)
    }
    const timer = window.setTimeout(() => {
      if (!closed && token === busyToken.current) setBusy(label)
    }, 100)
    const failsafe = window.setTimeout(finish, 500)
    return () => {
      closed = true
      window.clearTimeout(timer)
      window.clearTimeout(failsafe)
      if (token !== busyToken.current) return
      busyToken.current += 1
      setBusy(null)
    }
  }

  function replacePreview(next: PreviewImage | null) {
    const previous = previewRef.current
    const keep = new Set<string>()
    if (next?.url) keep.add(next.url)
    if (next?.warpUrl) keep.add(next.warpUrl)
    if (next?.magicUrl) keep.add(next.magicUrl)
    for (const page of pagesRef.current) {
      keep.add(page.resultUrl)
      keep.add(page.warpUrl)
      if (page.magicUrl) keep.add(page.magicUrl)
      keep.add(page.sourceUrl)
    }
    if (previous) {
      const urls = [previous.url, previous.warpUrl, previous.magicUrl]
      for (const url of urls) {
        if (url && !keep.has(url)) URL.revokeObjectURL(url)
      }
    }
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
      const start = () => {
        void locatePage(sourceUrl, width, height, gen)
      }
      const idle = window.requestIdleCallback
      if (typeof idle === 'function') idle(start, { timeout: 80 })
      else start()
    }, 50)
  }

  async function locatePage(sourceUrl: string, width: number, height: number, gen: number) {
    const cancelled = () => gen !== detectGen.current || userAdjustedRef.current
    if (cancelled()) {
      stopDetecting()
      return
    }
    try {
      await nextFrame()
      if (cancelled()) {
        stopDetecting()
        return
      }
      const image = await loadImage(sourceUrl)
      await new Promise((resolve) => window.setTimeout(resolve, 0))
      if (cancelled()) {
        stopDetecting()
        return
      }
      const found = detectDocumentCorners(image, width, height)
      if (cancelled() || !found.detected) {
        stopDetecting()
        return
      }
      applyAutoCorners(found.corners, true)
    } catch (error) {
      console.error(error)
      if (cancelled()) return
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
        filter: 'original' as const,
        detected: false,
        detecting: true,
        snapToken: 0,
        editingId: null,
      }
      draftRef.current = next
      processedKeyRef.current = null
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

  async function raster(url: string): Promise<HTMLCanvasElement> {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('לא ניתן להכין את התמונה.')
    context.drawImage(image, 0, 0)
    return canvas
  }

  async function warpCanvasFor(sourceUrl: string, corners: Corners) {
    const key = pageKey(sourceUrl, corners)
    const cached = cachedWarp(key)
    if (cached) return { key, canvas: cached }
    const image = await loadImage(sourceUrl)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    const canvas = await straightenDocument(image, corners)
    storeWarp(key, canvas)
    return { key, canvas }
  }

  async function blobFor(
    sourceUrl: string,
    corners: Corners,
    filter: FilterMode,
    known: { warpUrl: string; magicUrl: string | null },
  ) {
    if (filter === 'original') {
      const response = await fetch(known.warpUrl)
      if (!response.ok) throw new Error('לא ניתן לקרוא את התמונה.')
      return response.blob()
    }
    if (filter === 'magic' && known.magicUrl) {
      const response = await fetch(known.magicUrl)
      if (!response.ok) throw new Error('לא ניתן לקרוא את התמונה.')
      return response.blob()
    }
    const key = pageKey(sourceUrl, corners)
    let canvas = cachedWarp(key)
    if (!canvas) {
      canvas = known.warpUrl ? await raster(known.warpUrl) : (await warpCanvasFor(sourceUrl, corners)).canvas
      storeWarp(key, canvas)
    }
    if (filter === 'magic') {
      const magic = cachedMagic(key) ?? (await loadMagic(key, () => renderMagic(canvas)))
      return canvasToJpegBlob(magic, 0.93)
    }
    return canvasToJpegBlob(paintFastFilter(canvas, filter), 0.93)
  }

  async function renderPreview(source: Draft) {
    const key = pageKey(source.sourceUrl, source.corners)
    if (processingRef.current) return
    if (processedKeyRef.current === key && previewRef.current) return
    const token = ++requestRef.current
    processingRef.current = true
    processingOwner.current = token
    processedKeyRef.current = key
    const endBusy = beginBusy('מיישר את העמוד…')
    let released = false
    const release = () => {
      if (released) return
      released = true
      endBusy()
    }
    try {
      await nextFrame()
      if (token !== requestRef.current) return
      const warped = await warpCanvasFor(source.sourceUrl, source.corners)
      if (token !== requestRef.current) return
      const warpBlob = await canvasToJpegBlob(warped.canvas, 0.95)
      if (token !== requestRef.current) return
      const warpUrl = URL.createObjectURL(warpBlob)
      replacePreview({
        url: warpUrl,
        warpUrl,
        magicUrl: null,
        width: warped.canvas.width,
        height: warped.canvas.height,
      })
    } catch (error) {
      console.error(error)
      if (token === requestRef.current) {
        processedKeyRef.current = null
        setToast(errorMessage(error))
      }
    } finally {
      if (processingOwner.current === token) processingRef.current = false
      release()
    }
  }

  async function fillMagic(source: Draft) {
    const shot = previewRef.current
    if (!shot || shot.magicUrl || processingRef.current) return
    const token = ++requestRef.current
    processingRef.current = true
    processingOwner.current = token
    const endBusy = beginBusy('מנקה את העמוד…')
    try {
      await nextFrame()
      if (token !== requestRef.current) return
      const key = pageKey(source.sourceUrl, source.corners)
      const warp = cachedWarp(key) ?? (await raster(shot.warpUrl))
      storeWarp(key, warp)
      if (token !== requestRef.current) return
      const magic = cachedMagic(key) ?? (await loadMagic(key, () => renderMagic(warp)))
      if (token !== requestRef.current) return
      const magicBlob = await canvasToJpegBlob(magic, 0.93)
      if (token !== requestRef.current) return
      const magicUrl = URL.createObjectURL(magicBlob)
      const current = previewRef.current
      replacePreview({
        url: magicUrl,
        warpUrl: current?.warpUrl ?? shot.warpUrl,
        magicUrl,
        width: shot.width,
        height: shot.height,
      })
    } catch (error) {
      console.error(error)
      if (token === requestRef.current) setToast(errorMessage(error))
    } finally {
      if (processingOwner.current === token) processingRef.current = false
      endBusy()
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
      void renderPreview(current)
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    }
  }

  function backFromCorners() {
    const current = draftRef.current
    detectGen.current += 1
    requestRef.current += 1
    processingRef.current = false
    processedKeyRef.current = null
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
    processingRef.current = false
    processedKeyRef.current = null
    setBusy(null)
    setScreen('corners')
  }

  function setFilter(filter: FilterMode) {
    const current = draftRef.current
    if (!current) return
    if (current.filter !== filter) {
      const next = { ...current, filter }
      draftRef.current = next
      setDraft(next)
    }
    if (filter === 'magic' && !previewRef.current?.magicUrl) void fillMagic(current)
  }

  function retryPreview() {
    const current = draftRef.current
    if (!current || processingRef.current) return
    processedKeyRef.current = null
    void renderPreview(current)
  }

  function leavePreview() {
    const current = draftRef.current
    if (!current) {
      setScreen('home')
      return
    }
    const saved = current.editingId != null && pagesRef.current.some((page) => page.id === current.editingId)
    const question = saved
      ? 'לחזור למסך הראשי? שינויים אחרונים בעמוד הזה יבוטלו.'
      : 'לצאת בלי לשמור את העמוד?'
    if (!window.confirm(question)) return
    requestRef.current += 1
    processingRef.current = false
    processedKeyRef.current = null
    replacePreview(null)
    if (!pagesRef.current.some((page) => page.sourceUrl === current.sourceUrl)) {
      URL.revokeObjectURL(current.sourceUrl)
    }
    draftRef.current = null
    setDraft(null)
    setScreen('home')
  }

  function rememberPage(page: ScanPage) {
    const prev = pagesRef.current
    const exists = prev.some((item) => item.id === page.id)
    const next = exists
      ? prev.map((item) => {
          if (item.id !== page.id) return item
          const kept = new Set([page.resultUrl, page.warpUrl, page.magicUrl, page.sourceUrl])
          for (const url of [item.resultUrl, item.warpUrl, item.magicUrl]) {
            if (url && !kept.has(url)) URL.revokeObjectURL(url)
          }
          return page
        })
      : [...prev, page]
    pagesRef.current = next
    setPages(next)
    setSelectedId(page.id)
    const draft = draftRef.current
    if (draft && draft.editingId !== page.id && draft.sourceUrl === page.sourceUrl) {
      const linked = { ...draft, editingId: page.id }
      draftRef.current = linked
      setDraft(linked)
    }
  }

  async function bakedPage(): Promise<ScanPage | null> {
    const current = draftRef.current
    const shot = previewRef.current
    if (!current || !shot) return null
    let resultUrl = current.filter === 'original' ? shot.warpUrl : shot.url
    if (current.filter === 'gray' || current.filter === 'bw' || (current.filter === 'magic' && !shot.magicUrl)) {
      const blob = await blobFor(current.sourceUrl, current.corners, current.filter, shot)
      resultUrl = URL.createObjectURL(blob)
    } else if (current.filter === 'magic' && shot.magicUrl) {
      resultUrl = shot.magicUrl
    }
    return {
      id: current.editingId ?? crypto.randomUUID(),
      sourceUrl: current.sourceUrl,
      width: current.width,
      height: current.height,
      corners: current.corners,
      filter: current.filter,
      resultUrl,
      warpUrl: shot.warpUrl,
      magicUrl: shot.magicUrl ?? (current.filter === 'magic' ? resultUrl : null),
      resultWidth: shot.width,
      resultHeight: shot.height,
    }
  }

  function commitPage(scanAnother: boolean) {
    void addPageToDocument(scanAnother ? 'camera' : 'pages')
  }

  async function addPage() {
    await addPageToDocument('camera')
  }

  async function addPageToDocument(nextScreen: 'camera' | 'pages') {
    const endBusy = beginBusy('שומר את העמוד…')
    try {
      const page = await bakedPage()
      if (!page) {
        setToast('אין עמוד להוספה.')
        return
      }
      rememberPage(page)
      requestRef.current += 1
      processingRef.current = false
      processedKeyRef.current = null
      replacePreview(null)
      draftRef.current = null
      setDraft(null)
      setScreen(nextScreen)
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
    }
  }

  async function downloadDraft() {
    const current = draftRef.current
    const shot = previewRef.current
    if (!current || !shot) {
      setToast('אין תמונה להורדה.')
      return
    }
    const endBusy = beginBusy('שומר תמונה…')
    try {
      const blob = await blobFor(current.sourceUrl, current.corners, current.filter, shot)
      const index = pagesRef.current.findIndex((page) => page.id === current.editingId)
      downloadBlob(blob, pageFileName(index >= 0 ? index : pagesRef.current.length))
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
    }
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
    const urls = new Set([page.sourceUrl, page.resultUrl, page.warpUrl])
    if (page.magicUrl) urls.add(page.magicUrl)
    for (const url of urls) URL.revokeObjectURL(url)
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
    const instant = pagesRef.current.map((item) => (item.id === id ? { ...item, filter } : item))
    pagesRef.current = instant
    setPages(instant)
    if (filter === 'original' || (filter === 'magic' && page.magicUrl)) {
      const resultUrl = filter === 'original' ? page.warpUrl : (page.magicUrl ?? page.resultUrl)
      const next = pagesRef.current.map((item) => (item.id === id ? { ...item, filter, resultUrl } : item))
      pagesRef.current = next
      setPages(next)
      return
    }
    const endBusy = beginBusy(filterLabel(filter))
    try {
      const blob = await blobFor(page.sourceUrl, page.corners, filter, page)
      const url = URL.createObjectURL(blob)
      const latest = pagesRef.current.find((item) => item.id === id)
      if (!latest || latest.filter !== filter) {
        URL.revokeObjectURL(url)
        return
      }
      const next = pagesRef.current.map((item) => {
        if (item.id !== id) return item
        if (item.resultUrl !== url && item.resultUrl !== item.warpUrl && item.resultUrl !== item.magicUrl) {
          URL.revokeObjectURL(item.resultUrl)
        }
        return {
          ...item,
          filter,
          resultUrl: url,
          magicUrl: filter === 'magic' ? url : item.magicUrl,
        }
      })
      pagesRef.current = next
      setPages(next)
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
    }
  }

  function editPageCorners(id: string) {
    const page = pagesRef.current.find((item) => item.id === id)
    if (!page) return
    detectGen.current += 1
    userAdjustedRef.current = true
    requestRef.current += 1
    processingRef.current = false
    processedKeyRef.current = null
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
    const endBusy = beginBusy('שומר תמונה…')
    void blobFor(page.sourceUrl, page.corners, page.filter, page)
      .then((blob) => downloadBlob(blob, pageFileName(index)))
      .catch((error: unknown) => {
        console.error(error)
        setToast(errorMessage(error))
      })
      .finally(endBusy)
  }

  async function downloadAll() {
    const list = pagesRef.current
    const endBusy = beginBusy('שומר תמונות…')
    try {
      for (let index = 0; index < list.length; index += 1) {
        const page = list[index]
        if (!page) continue
        const blob = await blobFor(page.sourceUrl, page.corners, page.filter, page)
        downloadBlob(blob, pageFileName(index))
        await new Promise((resolve) => window.setTimeout(resolve, 280))
      }
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
    }
  }

  async function assemblePdfPages() {
    const temps: string[] = []
    if (draftRef.current && previewRef.current) {
      const page = await bakedPage()
      if (page) rememberPage(page)
    }
    const list = pagesRef.current
    if (list.length === 0) throw new Error('הוסף עמוד לפני הייצוא.')
    const ready: ScanPage[] = []
    for (const page of list) {
      if (page.filter === 'original') {
        ready.push({ ...page, resultUrl: page.warpUrl })
        continue
      }
      if (page.filter === 'magic' && (page.magicUrl || page.resultUrl)) {
        ready.push({ ...page, resultUrl: page.magicUrl ?? page.resultUrl })
        continue
      }
      const blob = await blobFor(page.sourceUrl, page.corners, page.filter, page)
      const url = URL.createObjectURL(blob)
      temps.push(url)
      ready.push({ ...page, resultUrl: url })
    }
    return {
      ready,
      release() {
        for (const url of temps) URL.revokeObjectURL(url)
      },
    }
  }

  /** `emailLimit` is the largest PDF in bytes; smaller pages are tried until it fits. */
  async function createPdfFile(emailLimit?: number) {
    const assembled = await assemblePdfPages()
    try {
      const { buildPagesPdf, pdfFileName } = await import('../lib/pdf')
      let blob = await buildPagesPdf(assembled.ready)
      if (emailLimit) {
        for (const step of [
          { maxEdge: 2400, quality: 0.78 },
          { maxEdge: 1900, quality: 0.7 },
        ]) {
          if (blob.size <= emailLimit) break
          blob = await buildPagesPdf(assembled.ready, step)
        }
      }
      return new File([blob], pdfFileName(), { type: 'application/pdf' })
    } finally {
      assembled.release()
    }
  }

  function openMailto(email: string) {
    const href = `mailto:${email}?subject=${encodeURIComponent('סריקת מסמך - Folio')}&body=${encodeURIComponent('מצורף מסמך סרוק.')}`
    const link = document.createElement('a')
    link.href = href
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  async function shareFile(file: File, email?: string) {
    const payload = {
      files: [file],
      title: 'סריקת מסמך - Folio',
      text: email ? `אל: ${email}\nמצורף מסמך סרוק.` : 'מצורף מסמך סרוק.',
    }
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false
    if (!navigator.canShare(payload)) return false
    await navigator.share(payload)
    return true
  }

  async function sharePdf(email?: string) {
    const endBusy = beginBusy('מכין PDF…')
    try {
      await nextFrame()
      const file = await createPdfFile()
      let shared = false
      try {
        shared = await shareFile(file, email)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        console.error(error)
      }
      if (shared) return
      downloadBlob(file, file.name)
      if (email) openMailto(email)
      else setToast('ה-PDF ירד למכשיר. אפשר לצרף אותו למייל.')
    } catch (error) {
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
    }
  }

  async function quickSend(email: string) {
    let file: File | null = null
    try {
      await nextFrame()
      // Base64 adds a third; Vercel accepts about 4.5MB of body, so keep the PDF under ~3.2MB.
      file = await createPdfFile(3_200_000)
      const pdfBase64 = await blobToBase64(file)
      const response = await fetch('/api/send-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: email, pdfBase64, filename: file.name }),
      })
      const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: string } | null
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'שליחת המייל נכשלה.')
      }
      setToast(`המסמך נשלח בהצלחה ל-${email}!`)
      return true
    } catch (error) {
      console.error(error)
      const detail = error instanceof Error ? error.message : 'שליחת המייל נכשלה.'
      setToast(`${detail} אפשר לשתף או להוריד את הקובץ.`)
      try {
        file ??= await createPdfFile()
        downloadBlob(file, file.name)
        await shareFile(file, email)
      } catch (fallbackError) {
        if (fallbackError instanceof DOMException && fallbackError.name === 'AbortError') return false
        console.error(fallbackError)
      }
      return false
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          reject(new Error('לא ניתן לקרוא את ה-PDF.'))
          return
        }
        const marker = 'base64,'
        const splitAt = reader.result.indexOf(marker)
        resolve(splitAt >= 0 ? reader.result.slice(splitAt + marker.length) : reader.result)
      }
      reader.onerror = () => reject(new Error('לא ניתן לקרוא את ה-PDF.'))
      reader.readAsDataURL(blob)
    })
  }

  async function exportPdf() {
    const endBusy = beginBusy('מכין PDF…')
    try {
      await nextFrame()
      const file = await createPdfFile()
      downloadBlob(file, file.name)
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
      console.error(error)
      setToast(errorMessage(error))
    } finally {
      endBusy()
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
    leavePreview,
    setFilter,
    retryPreview,
    commitPage,
    addPage,
    downloadDraft,
    sharePdf,
    quickSend,
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
