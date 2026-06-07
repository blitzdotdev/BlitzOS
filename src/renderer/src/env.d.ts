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
      serverNavigate?: (surfaceId: string, url: string) => void
      serverReload?: (surfaceId: string) => void
      // Multi-workspace launcher (server-mode only; Electron wiring deferred — do NOT add stubs to
      // preload, that would make these non-optional in AgentOSApi and remove the ?. safety net).
      workspaces?: {
        list(): Promise<{ workspaces: Array<{ name: string; path: string; nodeCount: number; updatedAt: number }>; active: string }>
        create(name: string): Promise<{ ok: boolean; name?: string; error?: string }>
        switch(name: string): Promise<{ ok: boolean; active?: string; error?: string }>
      }
      onWorkspace?: (cb: (w: { active: string }) => void) => () => void
    }
  }
}

export {}
