// widget-jsx.ts — the React seam for jsx/tsx widgets: lazy-load sucrase, compile through the
// pure core (widget-jsx-core.mjs), cache by source hash (results AND errors, bounded), and
// hand SurfaceFrame a ready-to-mount srcdoc body. The iframe is NOT mounted until the compile
// resolves (a placeholder div renders instead) so each widget document loads exactly once —
// no double blitz:init handshake, no wasted esm.sh fetches.
import { useEffect, useState } from 'react'
import { useDesktop } from './store'
import { Surface } from './types'
import { hashSource, compileJsxSource, composeJsxSrcdoc, errorCardHtml } from './widget-jsx-core.mjs'
import registry from '../../../widgets/runtime/registry.json'

export type JsxWidgetState = {
  /** true when this surface is a jsx/tsx widget (lang set and not 'html') */
  active: boolean
  /** the composed srcdoc body (compiled widget, or the error card) — null while compiling */
  srcdoc: string | null
  /** compile error text (also folded into props.lastError for the agent) */
  error: string | null
}

export function isJsxLang(lang: string | undefined): lang is 'jsx' | 'tsx' {
  return lang === 'jsx' || lang === 'tsx'
}

// hash -> { srcdoc, error } — survives unmount/remount (tab switches, folder peeks) and is
// shared with SurfacePreview via peekJsxSrcdoc. Bounded FIFO: widgets are few and recompiles
// are cheap; this only needs to stop unbounded growth across long sessions.
const cache = new Map<string, { srcdoc: string; error: string | null }>()
const CACHE_MAX = 64
let sucrasePromise: Promise<typeof import('sucrase')> | null = null

function compileInto(html: string, lang: 'jsx' | 'tsx'): Promise<{ srcdoc: string; error: string | null }> {
  const key = hashSource(html, lang)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  sucrasePromise ??= import('sucrase')
  return sucrasePromise.then(({ transform }) => {
    // re-check: a concurrent mount of the same source may have filled the key while sucrase loaded
    const again = cache.get(key)
    if (again) return again
    const r = compileJsxSource(transform, html, lang)
    const entry = r.ok
      ? { srcdoc: composeJsxSrcdoc(r.js, registry as Record<string, string>), error: null }
      : { srcdoc: errorCardHtml(r.error, lang), error: r.error }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
    cache.set(key, entry)
    return entry
  })
}

/** Synchronous cache peek for SurfacePreview (never compiles — previews must stay cheap). */
export function peekJsxSrcdoc(html: string, lang: 'jsx' | 'tsx'): string | null {
  return cache.get(hashSource(html, lang))?.srcdoc ?? null
}

/**
 * The SurfaceFrame hook. For non-jsx surfaces it is inert ({active:false}). For jsx/tsx it
 * compiles (cached) and reports a compile error into props.lastError so the agent can read it
 * from list_state (success clears a stale one; runtime errors arrive separately via the
 * bootstrap's blitz:jsxerr message, handled in SurfaceFrame's bridge listener).
 */
export function useJsxWidget(surface: Surface): JsxWidgetState {
  const active = surface.kind === 'srcdoc' && isJsxLang(surface.lang)
  const html = surface.html ?? ''
  const lang = isJsxLang(surface.lang) ? surface.lang : 'jsx'
  const [state, setState] = useState<{ srcdoc: string; error: string | null } | null>(() =>
    active ? cache.get(hashSource(html, lang)) ?? null : null
  )

  useEffect(() => {
    if (!active) return
    let stale = false
    compileInto(html, lang).then((entry) => {
      if (!stale) setState(entry)
    })
    return () => {
      stale = true
    }
  }, [active, html, lang])

  // Compile verdict -> props.lastError (set on failure, cleared on success) so the agent sees
  // it in list_state. Guarded by current value to avoid no-op prop churn (each write re-posts
  // blitz:props and persists).
  useEffect(() => {
    if (!active || !state) return
    const cur = useDesktop.getState().surfaces.find((s) => s.id === surface.id)?.props?.lastError
    if (state.error && cur !== state.error) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: state.error })
    else if (!state.error && cur) useDesktop.getState().updateSurfaceProps(surface.id, { lastError: undefined })
  }, [active, state, surface.id])

  if (!active) return { active: false, srcdoc: null, error: null }
  return { active: true, srcdoc: state?.srcdoc ?? null, error: state?.error ?? null }
}
