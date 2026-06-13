import { useEffect, useState } from 'react'
import type { Surface } from '../types'

/**
 * The FDA tutorial-unlock card (onboarding P1). A native, runtime-only surface (never persisted —
 * the director re-files it on boot while FDA is missing). Three states driven by props.state:
 * 'locked' (deep-link to System Settings; main polls the TCC probe), 'scanning' (grant detected,
 * Branch-A rescan running), 'granted' (celebrate; the director retires the card after a beat).
 * The button opens Settings via main (shell.openExternal) — sandboxed renderers can't.
 */
export function UnlockWidget({ surface }: { surface: Surface }): JSX.Element {
  const p = surface.props ?? {}
  const state = (p.state as string) || 'locked'
  const appName = (p.appName as string) || 'BlitzOS'
  const sources = Array.isArray(p.sources) ? (p.sources as string[]) : []
  const [opened, setOpened] = useState(false)
  // The Codex drag, same as the pre-board step: the app icon is a native drag source the user can
  // drop straight into the Settings FDA list (covers the "it isn't in the list" dead end).
  const [appIcon, setAppIcon] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void window.agentOS?.onboarding?.preboardState?.().then((s) => {
      if (alive && s.canDrag) setAppIcon(s.appIcon)
    })
    return () => {
      alive = false
    }
  }, [])

  if (state === 'granted')
    return (
      <div className="unlock granted">
        <div className="unlock-mark">✓</div>
        <div className="unlock-head">Personal layer unlocked</div>
        <div className="unlock-sub">New evidence is landing on the board…</div>
      </div>
    )

  if (state === 'scanning')
    return (
      <div className="unlock scanning">
        <div className="unlock-mark spin">◌</div>
        <div className="unlock-head">Reading the personal layer</div>
        <div className="unlock-sub">Messages cadence, Mail, Safari, real screen time…</div>
      </div>
    )

  return (
    <div className="unlock">
      <div className="unlock-row">
        <div className="unlock-mark">🔒</div>
        <div>
          <div className="unlock-head">Unlock the personal layer</div>
          <div className="unlock-sub">The scan so far used zero permissions. One grant deepens the whole board, and everything stays on this Mac.</div>
        </div>
      </div>
      <ul className="unlock-srcs">
        {sources.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <div className="unlock-actions">
        <button
          className="unlock-go"
          onClick={() => {
            setOpened(true)
            void window.agentOS?.onboarding?.openFdaSettings()
          }}
        >
          Open System Settings
        </button>
        <button className="unlock-skip" onClick={() => void window.agentOS?.onboarding?.dismissUnlock()}>
          Not now
        </button>
      </div>
      <div className="unlock-hint unlock-hint-row">
        {appIcon && (
          <span
            className="unlock-drag-tile"
            draggable
            onDragStart={(e) => {
              e.preventDefault()
              window.agentOS?.onboarding?.preboardDrag?.()
            }}
            aria-label={`Drag ${appName} into the Full Disk Access list`}
            title={`Drag into the Full Disk Access list`}
          >
            <img src={appIcon} draggable={false} alt="" />
          </span>
        )}
        <span>
          {opened
            ? `In Privacy & Security → Full Disk Access, enable “${appName}”, or drag this icon straight into the list. I'll notice the moment it lands.`
            : `Grants “${appName}” read access in Privacy & Security → Full Disk Access. Drag the icon into the list if it isn't there.`}
        </span>
      </div>
    </div>
  )
}
