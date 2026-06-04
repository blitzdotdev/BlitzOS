import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // @agent-socket/sdk is ESM-only; bundle it into the CJS main output instead
    // of externalizing (Electron's main can't require() an ESM-only package).
    // ws stays external (CJS, fine to require).
    plugins: [externalizeDepsPlugin({ exclude: ['@agent-socket/sdk'] })]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
