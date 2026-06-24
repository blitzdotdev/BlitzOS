import { useEffect, useState } from 'react'

// The user-facing "Connect" entry (radial / launcher menu → 'connect'). Lists the connectable browser tabs
// (Chrome via the Connector extension + Safari via Apple Events) and macOS app windows (the BlitzOS
// helper), and connects one into BlitzOS as a per-source tool provider. The heavy lifting is all in main
// (electronConnections); this is a thin picker over the os:conn-* IPC.

type Tab = { tabId: number | string; title?: string; url?: string; browser?: string }
type Win = { windowId: number; app?: string; title?: string; bundleId?: string }

// the preload bridge (window.agentOS.connections) — typed loosely to avoid coupling to the preload d.ts
type ConnBridge = {
  listTabs(): Promise<{ tabs?: Tab[]; error?: string }>
  listWindows(): Promise<{ windows?: Win[]; error?: string }>
  connectTab(id: number | string): Promise<{ error?: string }>
  connectWindow(id: number): Promise<{ error?: string }>
}

export function ConnectPicker({ onClose }: { onClose: () => void }): JSX.Element {
  const conn = (window as unknown as { agentOS?: { connections?: ConnBridge } }).agentOS?.connections
  const [tabs, setTabs] = useState<Tab[]>([])
  const [windows, setWindows] = useState<Win[]>([])
  const [status, setStatus] = useState('Loading…')
  const [busy, setBusy] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setStatus('Loading…')
    const t: { tabs?: Tab[]; error?: string } = conn ? await conn.listTabs() : { error: 'unavailable' }
    const w: { windows?: Win[]; error?: string } = conn ? await conn.listWindows() : { error: 'unavailable' }
    setTabs(Array.isArray(t.tabs) ? t.tabs : [])
    setWindows(Array.isArray(w.windows) ? w.windows : [])
    const notes: string[] = []
    if (t.error) notes.push('tabs: ' + t.error)
    if (w.error) notes.push('windows: ' + w.error)
    setStatus(notes.join('   ') || ((t.tabs?.length || 0) + (w.windows?.length || 0) === 0 ? 'Nothing connectable yet — open a tab in Chrome/Safari, or a macOS app window.' : ''))
  }
  useEffect(() => {
    void refresh()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function connectTab(id: number | string): Promise<void> {
    setBusy('t' + id)
    const r = await conn?.connectTab(id)
    setBusy(null)
    if (r && !r.error) onClose()
    else setStatus(r?.error || 'connect failed')
  }
  async function connectWindow(id: number): Promise<void> {
    setBusy('w' + id)
    const r = await conn?.connectWindow(id)
    setBusy(null)
    if (r && !r.error) onClose()
    else setStatus(r?.error || 'connect failed')
  }
  // Chrome is driven extension-free via Apple Events — nothing to install. Show the one-time toggle Chrome needs.
  function showChromeSetup(): void {
    setStatus('To connect Chrome, turn on Chrome ▸ View ▸ Developer ▸ “Allow JavaScript from Apple Events” once, then open a tab and click ↻. Its tabs then appear here.')
  }

  return (
    <div className="connect-picker-backdrop" onPointerDown={onClose}>
      <div className="connect-picker" onPointerDown={(e) => e.stopPropagation()}>
        <header className="connect-picker-head">
          <span>Connect a tab or window</span>
          <button className="connect-picker-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {status && <div className="connect-picker-status">{status}</div>}
        <div className="connect-picker-cols">
          <section className="connect-picker-col">
            <h4>
              Browser tabs <button className="connect-picker-refresh" onClick={() => void refresh()} title="Refresh">↻</button>
            </h4>
            {tabs.length === 0 && <div className="connect-picker-empty">No connectable tabs yet — connect Chrome below, or open a tab in Safari.</div>}
            {tabs.map((t) => (
              <button key={String(t.tabId)} className="connect-picker-row" disabled={!!busy} onClick={() => void connectTab(t.tabId)}>
                <span className="connect-picker-badge">{t.browser || 'tab'}</span>
                <span className="connect-picker-title">{t.title || t.url || String(t.tabId)}</span>
              </button>
            ))}
            {/* Chrome path is ALWAYS available (not hidden when Safari/other tabs exist): if no Chrome tab is
                connected, show the one-time Apple-Events toggle Chrome needs. */}
            {!tabs.some((t) => t.browser === 'chrome') && (
              <button className="connect-picker-install" onClick={showChromeSetup}>
                + Connect Chrome
              </button>
            )}
          </section>
          <section className="connect-picker-col">
            <h4>
              App windows <button className="connect-picker-refresh" onClick={() => void refresh()} title="Refresh">↻</button>
            </h4>
            {windows.length === 0 && <div className="connect-picker-empty">No windows (needs the BlitzOS helper + Accessibility on macOS).</div>}
            {(() => {
              // A window's own title is often empty; falling back to the app name made multiple windows of
              // one app indistinguishable ("Safari / Safari"). Number them per-app instead so each row is unique.
              const seen: Record<string, number> = {}
              return windows.map((w) => {
                const app = w.app || 'app'
                const n = (seen[app] = (seen[app] || 0) + 1)
                const real = (w.title || '').trim()
                const label = real && real !== app ? real : `window ${n}`
                return (
                  <button key={w.windowId} className="connect-picker-row" disabled={!!busy} onClick={() => void connectWindow(w.windowId)}>
                    <span className="connect-picker-badge">{app}</span>
                    <span className="connect-picker-title">{label}</span>
                  </button>
                )
              })
            })()}
          </section>
        </div>
      </div>
    </div>
  )
}
