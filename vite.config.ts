import { readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin as RolldownPlugin } from 'rolldown'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

// jscanify is a UMD bundle: it has no ESM default export, and it reads a
// global `cv`. Expose OpenCV through that name and publish the constructor.
const cvBanner = `const cv = new Proxy(Object.create(null), {
  get(_target, prop) {
    const real = globalThis.cv
    if (!real) return undefined
    const value = real[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
});
`

function adaptJscanifySource(source: string): string {
  if (source.includes('export default globalThis.jscanify')) return source
  const patched = source.replace('})(this, function () {', '})(globalThis, function () {')
  return `${cvBanner}${patched}\nexport default globalThis.jscanify;\n`
}

function isJscanifyEntry(id: string): boolean {
  const normalized = id.split('\\').join('/').split('?')[0] ?? id
  return normalized.endsWith('/jscanify/src/jscanify.js')
}

const jscanifyRolldownPlugin: RolldownPlugin = {
  name: 'jscanify-cv-proxy',
  load(id) {
    if (!isJscanifyEntry(id)) return null
    const filePath = id.split('?')[0] ?? id
    return adaptJscanifySource(readFileSync(filePath, 'utf8'))
  },
}

function jscanifyCvProxy(): Plugin {
  return {
    name: 'jscanify-cv-proxy',
    transform(code, id) {
      if (!isJscanifyEntry(id)) return null
      const next = adaptJscanifySource(code)
      if (next === code) return null
      return { code: next, map: null }
    },
  }
}

export default defineConfig({
  plugins: [jscanifyCvProxy(), react(), tailwindcss()],
  optimizeDeps: {
    include: ['jscanify/client'],
    rolldownOptions: {
      plugins: [jscanifyRolldownPlugin],
    },
  },
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
})
