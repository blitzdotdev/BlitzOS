/// <reference types="vite/client" />

// Build-time constants injected by electron.vite.config.ts
declare const __BUILD_DATE__: string
declare const __GIT_COMMIT__: string
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  readonly VITE_PREVIEW_PUBLIC_BASE_DOMAIN: string
  readonly VITE_SERVER_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
