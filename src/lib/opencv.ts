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
  minAreaRect: (points: CvMat) => { center: { x: number; y: number } }
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
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
  'https://docs.opencv.org/4.12.0/opencv.js',
]

let loading: Promise<Cv> | null = null

function isReady(cv: BootCv | undefined): cv is Cv {
  return Boolean(cv && typeof cv.Mat === 'function' && typeof cv.warpPerspective === 'function')
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
  return new Promise((resolve, reject) => {
    const attempt = (index: number) => {
      if (index >= OPENCV_SOURCES.length) {
        reject(new Error('Could not load the vision engine. Check your connection and try again.'))
        return
      }

      const script = document.createElement('script')
      script.src = OPENCV_SOURCES[index]
      script.async = true
      let settled = false
      let poll = 0
      let timer = 0

      const succeed = (cv: Cv) => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        window.clearInterval(poll)
        globalThis.cv = cv
        resolve(cv)
      }

      const fail = () => {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        window.clearInterval(poll)
        script.remove()
        attempt(index + 1)
      }

      timer = window.setTimeout(fail, 50000)
      poll = window.setInterval(() => {
        const ready = globalThis.cv
        if (isReady(ready)) succeed(ready)
      }, 250)

      script.onload = () => {
        const current = globalThis.cv
        if (isReady(current)) {
          succeed(current)
          return
        }
        if (current && typeof current.then === 'function') {
          current.then((ready) => succeed(ready)).catch(() => fail())
          return
        }
        if (current) {
          const previous = current.onRuntimeInitialized
          current.onRuntimeInitialized = () => {
            previous?.()
            const ready = globalThis.cv
            if (isReady(ready)) succeed(ready)
            else fail()
          }
        }
        window.setTimeout(() => {
          const ready = globalThis.cv
          if (!settled && isReady(ready)) succeed(ready)
          else if (!settled && !current) fail()
        }, 400)
      }

      script.onerror = () => fail()
      document.head.appendChild(script)
    }

    attempt(0)
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
