import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'

// jscanify reads a global `cv`. ES modules do not fall back to window.cv,
// so bind that name to the OpenCV runtime once it has been loaded.
function jscanifyCvProxy(): Plugin {
  return {
    name: 'jscanify-cv-proxy',
    transform(code, id) {
      const normalized = id.split('\\').join('/')
      if (!normalized.includes('/jscanify/src/jscanify.js')) return null
      const banner = `const cv = new Proxy(Object.create(null), {
  get(_target, prop) {
    const real = globalThis.cv
    if (!real) return undefined
    const value = real[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
});
`
      return { code: banner + code, map: null }
    },
  }
}

export default defineConfig({
  plugins: [jscanifyCvProxy(), react(), tailwindcss()],
  optimizeDeps: {
    exclude: ['jscanify'],
  },
  server: {
    host: true,
  },
  preview: {
    host: true,
  },
})
