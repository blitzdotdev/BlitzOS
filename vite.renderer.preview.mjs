// Throwaway config: serve ONLY the renderer (React canvas) over HTTP so it can be
// previewed in a browser / tunneled. The real app runs via `electron-vite dev`
// inside Electron; this exists purely to get a browseable link on a headless box.
//
// It also injects a browser-only mock of `window.agentOS` (preview/agentos-shim.js)
// as a classic head script, so the integration widgets render in a plain browser.
// The shim guards on an existing window.agentOS and is never loaded by Electron.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const shim = readFileSync(resolve('preview/agentos-shim.js'), 'utf8')
// Tell the renderer whether the backend is in server mode (live web surfaces via a
// headless browser). Set the flag BEFORE the shim runs so SurfaceFrame can branch.
const serverMode = process.env.BLITZ_SERVER_MODE === '1'
const headScript = `window.__BLITZ_SERVER_MODE__=${JSON.stringify(serverMode)};\n` + shim

export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: { '@renderer': resolve('src/renderer/src') }
  },
  plugins: [
    react(),
    {
      name: 'agentos-preview-shim',
      transformIndexHtml(html) {
        return {
          html,
          // classic (non-module) script runs during parse, before the deferred
          // module entry — so window.agentOS exists before React's effects run.
          tags: [{ tag: 'script', injectTo: 'head-prepend', children: headScript }]
        }
      }
    }
  ],
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    allowedHosts: true, // accept the *.trycloudflare.com Host header
    // Same-origin path to the standalone integrations backend (preview/backend.mjs),
    // so the renderer's fetch('/api/...') and the OAuth callback both route here.
    // ws:true so the /api/os/stream screencast WebSocket proxies to the backend too.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, ws: true } }
  }
})
