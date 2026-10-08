import type { Corners } from '../types'

type MagicJob = Promise<HTMLCanvasElement>

const warps = new Map<string, HTMLCanvasElement>()
const magics = new Map<string, HTMLCanvasElement>()
const magicJobs = new Map<string, MagicJob>()

export function pageKey(sourceUrl: string, corners: Corners): string {
  const n = (value: number) => Math.round(value)
  return [
    sourceUrl,
    n(corners.tl.x),
    n(corners.tl.y),
    n(corners.tr.x),
    n(corners.tr.y),
    n(corners.br.x),
    n(corners.br.y),
    n(corners.bl.x),
    n(corners.bl.y),
  ].join(':')
}

export function cachedWarp(key: string): HTMLCanvasElement | null {
  return warps.get(key) ?? null
}

export function cachedMagic(key: string): HTMLCanvasElement | null {
  return magics.get(key) ?? null
}

export function storeWarp(key: string, canvas: HTMLCanvasElement) {
  warps.set(key, canvas)
}

export function storeMagic(key: string, canvas: HTMLCanvasElement) {
  magics.set(key, canvas)
}

export function loadMagic(
  key: string,
  produce: () => HTMLCanvasElement | Promise<HTMLCanvasElement>,
): Promise<HTMLCanvasElement> {
  const ready = magics.get(key)
  if (ready) return Promise.resolve(ready)
  const pending = magicJobs.get(key)
  if (pending) return pending
  const job = new Promise<HTMLCanvasElement>((resolve, reject) => {
    window.setTimeout(() => {
      void Promise.resolve()
        .then(produce)
        .then((canvas) => {
          magics.set(key, canvas)
          resolve(canvas)
        })
        .catch(reject)
        .finally(() => {
          magicJobs.delete(key)
        })
    }, 0)
  })
  magicJobs.set(key, job)
  return job
}
