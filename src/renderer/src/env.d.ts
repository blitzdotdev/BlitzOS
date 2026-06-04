/// <reference types="vite/client" />
import type { AgentOSApi } from '../../preload'

// Note: @types/react already declares the Electron <webview> intrinsic element
// (via WebViewHTMLAttributes), so we do not redeclare it here.

declare global {
  interface Window {
    agentOS?: AgentOSApi
  }
}

export {}
