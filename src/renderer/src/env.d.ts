/// <reference types="vite/client" />
import type { AgentOSApi } from '../../preload'

// Note: @types/react already declares the Electron <webview> intrinsic element
// (via WebViewHTMLAttributes), so we do not redeclare it here.

declare global {
  interface Window {
    // Electron preload (AgentOSApi) + optional server-mode fields the browser shim
    // adds when BlitzOS runs as a hosted web app (live web surfaces via a headless
    // browser streamed to a <canvas>). Both optional → Electron compiles unaffected.
    agentOS?: AgentOSApi & {
      serverMode?: boolean
      mountServerSurface?: (canvas: HTMLCanvasElement, surfaceId: string, opts: { w: number; h: number }) => () => void
    }
  }
}

export {}
