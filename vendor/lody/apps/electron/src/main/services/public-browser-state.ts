import type { ElectronPublicBrowserState } from '@lody/shared/electron-ipc'

export type PublicBrowserObservation = {
  committedUrl?: string
  committedTitle?: string
  canGoBack: boolean
  canGoForward: boolean
}

type ElectronNavigationError = {
  code?: unknown
  errno?: unknown
}

export const isNavigationAbortError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as ElectronNavigationError
  return candidate.code === 'ERR_ABORTED' || candidate.code === -3 || candidate.errno === -3
}

export const mergePublicBrowserState = (
  previous: ElectronPublicBrowserState,
  observation: PublicBrowserObservation,
  patch: Partial<ElectronPublicBrowserState> = {}
): ElectronPublicBrowserState => ({
  ...previous,
  // During loadURL(), Chromium still reports the previous committed URL from
  // getURL(). Preserve the requested URL until a commit/failure event provides
  // an explicit replacement, otherwise the renderer navigates back to the old page.
  url: patch.url ?? previous.url ?? observation.committedUrl,
  title: patch.title ?? previous.title ?? observation.committedTitle,
  canGoBack: observation.canGoBack,
  canGoForward: observation.canGoForward,
  ...patch
})
