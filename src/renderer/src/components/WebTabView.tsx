import { useEffect, useRef } from 'react'
import { useDesktop } from '../store'
import type { SurfaceTab } from '../types'

type WebviewEl = HTMLElement & {
  getWebContentsId?: () => number
  setZoomFactor?: (z: number) => void
  getURL?: () => string
  canGoBack?: () => boolean
  canGoForward?: () => boolean
}

/**
 * ONE <webview> guest = one browser TAB of a web surface. Lazy-then-live: a tab gets its real page once it
 * has been active (SurfaceFrame only renders materialized tabs), then STAYS mounted — hidden via
 * .wt-inactive — when you switch away, so its page/scroll/form/history stay ALIVE. That per-tab liveness
 * used to come from the main-owned WebContentsView host (one view per tab); on the webview architecture it
 * is just N in-DOM <webview> nodes.
 *
 * The ACTIVE tab (a) registers its guest WebContents with main — the agent's read/control/perception target
 * and BrowserNav's element-method buttons + radial-over-web detection find it by data-sid — and (b) folds
 * its url/title up onto the surface. ALL tabs mirror their page state (url/title/loading/favicon/canGoBack/
 * canGoForward) into the store via applyWebTab — renderer-local, replacing the os:web-tab push that the
 * deleted host used to emit. A page's HTML5 <video> fullscreen drives store.pageFullscreenId.
 */
export function WebTabView({
  surfaceId,
  tab,
  active,
  zoom
}: {
  surfaceId: string
  tab: SurfaceTab
  active: boolean
  zoom: number
}): JSX.Element {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const wv = ref.current as WebviewEl | null
    if (!wv) return
    const st = (): ReturnType<typeof useDesktop.getState> => useDesktop.getState()
    const writeTab = (patch: Partial<SurfaceTab>): void => st().applyWebTab({ surfaceId, tabId: tab.id, patch })
    const navState = (): Partial<SurfaceTab> => {
      try {
        return { canGoBack: !!wv.canGoBack?.(), canGoForward: !!wv.canGoForward?.() }
      } catch {
        return {}
      }
    }
    const register = (): void => {
      if (!active) return
      try {
        const id = wv.getWebContentsId?.()
        if (id != null) window.agentOS?.registerWebview?.(surfaceId, id)
      } catch {
        /* guest not attached yet */
      }
    }
    const onDomReady = (): void => {
      try {
        wv.setZoomFactor?.(zoom)
      } catch {
        /* not ready */
      }
      register()
    }
    const onNav = (e: Event): void => {
      const url = (e as unknown as { url?: string }).url || wv.getURL?.() || ''
      writeTab({ ...(url ? { url } : {}), ...navState() })
      if (url && active) st().updateSurface(surfaceId, { url })
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title?: string }).title
      if (!title) return
      writeTab({ title })
      if (active) st().updateSurface(surfaceId, { title })
    }
    const onStart = (): void => writeTab({ loading: true, favicon: '' })
    const onStop = (): void => writeTab({ loading: false, ...navState() })
    const onFav = (e: Event): void => {
      const icons = (e as unknown as { favicons?: string[] }).favicons
      if (icons?.length) writeTab({ favicon: icons[icons.length - 1] })
    }
    const onEnterFs = (): void => st().setPageFullscreen(surfaceId)
    const onLeaveFs = (): void => {
      if (st().pageFullscreenId === surfaceId) st().setPageFullscreen(null)
    }
    const evs: Array<[string, EventListener]> = [
      ['dom-ready', onDomReady as EventListener],
      ['did-navigate', onNav as EventListener],
      ['did-navigate-in-page', onNav as EventListener],
      ['page-title-updated', onTitle as EventListener],
      ['did-start-loading', onStart as EventListener],
      ['did-stop-loading', onStop as EventListener],
      ['page-favicon-updated', onFav as EventListener],
      ['enter-html-full-screen', onEnterFs as EventListener],
      ['leave-html-full-screen', onLeaveFs as EventListener]
    ]
    for (const [k, fn] of evs) wv.addEventListener(k, fn)
    register() // a tab that becomes active AFTER its dom-ready already fired still registers now
    return () => {
      for (const [k, fn] of evs) wv.removeEventListener(k, fn)
    }
  }, [surfaceId, tab.id, active, zoom])

  return (
    <webview
      ref={ref as unknown as React.RefObject<HTMLWebViewElement>}
      // Only the ACTIVE tab carries data-sid: BrowserNav's act() + radial-over-web look it up by it.
      {...(active ? { 'data-sid': surfaceId } : {})}
      className={active ? undefined : 'wt-inactive'}
      src={tab.url || 'about:blank'}
      partition="persist:agentos"
      // @ts-expect-error allowpopups is a valid <webview> attribute, not in React's DOM types
      allowpopups="true"
    />
  )
}
