export type CvMat = {
  rows: number
  cols: number
  data: Uint8Array
  data32S: Int32Array
  data32F: Float32Array
  delete: () => void
  clone: () => CvMat
  convertTo: (dst: CvMat, type: number) => void
}

export type CvMatVector = {
  size: () => number
  get: (index: number) => CvMat
  push_back: (mat: CvMat) => void
  delete: () => void
}

export type Cv = {
  Mat: new (...args: unknown[]) => CvMat
  MatVector: new () => CvMatVector
  Size: new (width: number, height: number) => object
  Scalar: new (...values: number[]) => object
  CLAHE: new (clipLimit: number, tileGridSize: object) => {
    apply: (src: CvMat, dst: CvMat) => void
    delete: () => void
  }
  imread: (source: CanvasImageSource) => CvMat
  imshow: (canvas: HTMLCanvasElement, mat: CvMat) => void
  cvtColor: (src: CvMat, dst: CvMat, code: number) => void
  resize: (src: CvMat, dst: CvMat, size: object, fx: number, fy: number, interp: number) => void
  GaussianBlur: (
    src: CvMat,
    dst: CvMat,
    ksize: object,
    sigmaX: number,
    sigmaY?: number,
    borderType?: number,
  ) => void
  bilateralFilter: (
    src: CvMat,
    dst: CvMat,
    d: number,
    sigmaColor: number,
    sigmaSpace: number,
  ) => void
  Canny: (src: CvMat, dst: CvMat, threshold1: number, threshold2: number) => void
  threshold: (src: CvMat, dst: CvMat, thresh: number, maxval: number, type: number) => number
  dilate: (src: CvMat, dst: CvMat, kernel: CvMat) => void
  getStructuringElement: (shape: number, ksize: object) => CvMat
  findContours: (
    image: CvMat,
    contours: CvMatVector,
    hierarchy: CvMat,
    mode: number,
    method: number,
  ) => void
  contourArea: (contour: CvMat) => number
  arcLength: (contour: CvMat, closed: boolean) => number
  approxPolyDP: (curve: CvMat, approx: CvMat, epsilon: number, closed: boolean) => void
  isContourConvex: (contour: CvMat) => boolean
  minAreaRect: (points: CvMat) => {
    center: { x: number; y: number }
    size: { width: number; height: number }
    angle: number
  }
  RotatedRect: { points: (rect: unknown) => { x: number; y: number }[] }
  matFromArray: (rows: number, cols: number, type: number, array: number[]) => CvMat
  getPerspectiveTransform: (src: CvMat, dst: CvMat) => CvMat
  warpPerspective: (
    src: CvMat,
    dst: CvMat,
    transform: CvMat,
    dsize: object,
    flags: number,
    borderMode: number,
    borderValue: object,
  ) => void
  extractChannel: (src: CvMat, dst: CvMat, channel: number) => void
  insertChannel: (src: CvMat, dst: CvMat, channel: number) => void
  divide: (src1: CvMat, src2: CvMat, dst: CvMat, scale?: number) => void
  max: (src1: CvMat, src2: CvMat, dst: CvMat) => void
  min: (src1: CvMat, src2: CvMat, dst: CvMat) => void
  addWeighted: (
    src1: CvMat,
    alpha: number,
    src2: CvMat,
    beta: number,
    gamma: number,
    dst: CvMat,
  ) => void
  LUT: (src: CvMat, lut: CvMat, dst: CvMat) => void
  morphologyEx: (src: CvMat, dst: CvMat, op: number, kernel: CvMat) => void
  adaptiveThreshold: (
    src: CvMat,
    dst: CvMat,
    maxValue: number,
    adaptiveMethod: number,
    thresholdType: number,
    blockSize: number,
    c: number,
  ) => void
  COLOR_RGBA2GRAY: number
  COLOR_RGBA2RGB: number
  COLOR_RGB2Lab: number
  COLOR_Lab2RGB: number
  COLOR_GRAY2RGB: number
  INTER_AREA: number
  INTER_LINEAR: number
  THRESH_BINARY: number
  THRESH_BINARY_INV: number
  THRESH_OTSU: number
  RETR_LIST: number
  CHAIN_APPROX_SIMPLE: number
  MORPH_RECT: number
  MORPH_ELLIPSE: number
  MORPH_CLOSE: number
  CV_8U: number
  CV_32F: number
  CV_32FC2: number
  ADAPTIVE_THRESH_GAUSSIAN_C: number
  BORDER_REPLICATE: number
}

type BootCv = Partial<Cv> & {
  onRuntimeInitialized?: () => void
  then?: (onFulfilled: (cv: Cv) => void) => Promise<Cv>
}

declare global {
  var cv: BootCv | undefined
}

const OPENCV_SOURCES = [
  'https://docs.opencv.org/4.8.0/opencv.js',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.8.0-release.1/dist/opencv.js',
]

const LOAD_TIMEOUT_MS = 10_000

let loading: Promise<Cv> | null = null

function isReady(cv: BootCv | undefined): cv is Cv {
  return Boolean(cv && typeof cv.Mat === 'function' && typeof cv.warpPerspective === 'function')
}

export function isOpenCvReady(): boolean {
  return isReady(globalThis.cv)
}

export function getCv(): Cv {
  const cv = globalThis.cv
  if (!isReady(cv)) {
    throw new Error('Vision engine is not ready yet.')
  }
  return cv
}

export function loadOpenCv(): Promise<Cv> {
  if (isReady(globalThis.cv)) return Promise.resolve(globalThis.cv)
  loading ??= startLoading().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

function startLoading(): Promise<Cv> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const failAll = () => {
      reject(new Error('The vision engine did not load. Basic adjustments are still available.'))
    }

    const attempt = (index: number) => {
      const remaining = LOAD_TIMEOUT_MS - (Date.now() - started)
      if (index >= OPENCV_SOURCES.length || remaining <= 0) {
        failAll()
        return
      }
      const source = OPENCV_SOURCES[index]
      if (!source) {
        failAll()
        return
      }
      void loadSource(source, remaining).then(
        (cv) => resolve(cv),
        () => attempt(index + 1),
      )
    }

    attempt(0)
  })
}

function loadSource(src: string, budgetMs: number): Promise<Cv> {
  return new Promise((resolve, reject) => {
    let settled = false
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.opencvSrc = src

    const finish = (error: Error | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      window.clearInterval(poll)
      script.onload = null
      script.onerror = null
      if (!error && isReady(globalThis.cv)) {
        resolve(globalThis.cv)
        return
      }
      script.remove()
      reject(error ?? new Error('OpenCV.js did not initialize'))
    }

    const timer = window.setTimeout(() => finish(new Error('OpenCV.js timed out')), budgetMs)
    const poll = window.setInterval(() => {
      if (isReady(globalThis.cv)) finish(null)
    }, 100)

    const previous = globalThis.cv
    const runtime = previous && typeof previous === 'object' ? previous : {}
    const earlier = runtime.onRuntimeInitialized
    runtime.onRuntimeInitialized = () => {
      earlier?.()
      if (isReady(globalThis.cv)) finish(null)
    }
    globalThis.cv = runtime

    script.onload = () => {
      if (isReady(globalThis.cv)) finish(null)
    }
    script.onerror = () => finish(new Error('OpenCV.js failed to download'))
    document.head.appendChild(script)
  })
}

export class MatBin {
  private mats: { delete: () => void }[] = []

  keep<T extends { delete: () => void }>(mat: T): T {
    this.mats.push(mat)
    return mat
  }

  release() {
    for (let i = this.mats.length - 1; i >= 0; i -= 1) {
      try {
        this.mats[i]?.delete()
      } catch {
        // A matrix can already have been released by a parent vector.
      }
    }
    this.mats = []
  }
}
