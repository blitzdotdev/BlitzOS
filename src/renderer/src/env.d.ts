/// <reference types="vite/client" />
import type { AgentOSApi } from '../../preload'

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
      // NOTE: `workspaces` lives in AgentOSApi (preload) now — it exists in BOTH modes (the Electron
      // preload + the server shim mirror it), so it is not redeclared here.
    }
  }
}

export {}
