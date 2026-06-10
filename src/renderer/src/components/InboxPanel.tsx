import { Surface } from '../types'

// The Action-items inbox — the structured "things only YOU can do" list an agent pushes (sign in, scan a
// QR, approve a send, choose an option) instead of burying it in chat. The human ticks an item → the
// backend resolves it + wakes the agent (a perception moment). Items are file-backed in the workspace
// (.blitzos/state/action-items.json), so the inbox survives a restart. Items live in surface.props.items
// (seeded by App.tsx from the action-item os:action stream + actionList() on load), mirroring the
// activity panel — so this component is a pure renderer.
type ActionItem = {
  id: string
  title: string
  detail?: string
  kind: string
  sessionId?: string
  choices?: string[]
  status: 'pending' | 'done' | 'dismissed'
  createdAt: number
  resolvedAt?: number | null
  resolution?: string | null
}
type ActionApi = {
  actionResolve?: (id: string, resolution?: string) => void
  actionClear?: (id: string) => void
}
const api = (): ActionApi => (window.agentOS as unknown as ActionApi) || {}

const KIND_ICON: Record<string, string> = {
  signin: '🔑',
  approve: '✓',
  choose: '◇',
  scan: '▦',
  info: 'ℹ',
  task: '▢'
}

export function InboxPanel({ surface }: { surface: Surface }): JSX.Element {
  const items = ((surface.props?.items as ActionItem[]) ?? []).slice().sort((a, b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1
    if (b.status === 'pending' && a.status !== 'pending') return 1
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
  const pending = items.filter((i) => i.status === 'pending').length

  return (
    <div className="inbox-panel" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
      <div className="inbox-head">
        <span className="inbox-count">
          {pending > 0 ? <strong>{pending} to do</strong> : <span className="inbox-clear-label">All clear</span>}
          {items.length > pending ? <span className="inbox-done-n"> · {items.length - pending} done</span> : null}
        </span>
      </div>
      <div className="inbox-list">
        {items.length === 0 && <div className="inbox-empty">No action items. When an agent needs you to do something, it appears here.</div>}
        {items.map((it) => {
          const done = it.status !== 'pending'
          return (
            <div key={it.id} className={`inbox-item${done ? ' resolved' : ''}`}>
              <span className="inbox-kind" title={it.kind}>{KIND_ICON[it.kind] || '▢'}</span>
              <div className="inbox-main">
                <div className="inbox-title">{it.title}</div>
                {it.detail && <div className="inbox-detail">{it.detail}</div>}
                {done ? (
                  <div className="inbox-resolved-meta">
                    {it.status === 'dismissed' ? 'dismissed' : it.resolution && it.resolution !== 'done' ? `done · ${it.resolution}` : 'done'}
                  </div>
                ) : it.kind === 'choose' && it.choices && it.choices.length ? (
                  <div className="inbox-choices">
                    {it.choices.map((c) => (
                      <button key={c} className="inbox-choice" onClick={() => api().actionResolve?.(it.id, c)}>
                        {c}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="inbox-actions">
                    <button className="inbox-done-btn" onClick={() => api().actionResolve?.(it.id, 'done')}>
                      ✓ Done
                    </button>
                    <button className="inbox-dismiss-btn" onClick={() => api().actionResolve?.(it.id, 'dismissed')}>
                      Dismiss
                    </button>
                  </div>
                )}
              </div>
              {done && (
                <button className="inbox-x" title="Clear" onClick={() => api().actionClear?.(it.id)}>
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
