// IslandHome — the island's HOME SCREEN (the default view when the island appears on notch hover). V1 keeps Chat as
// the primary app and uses the right side for working/done agent review. Settings are notch chrome, not a widget.
// The black chassis + NotchShape are owned by NotchHost and are INVARIANT; this paints only the interior.
import './island.css'
import { agentGradient } from './agentVisuals'
import type { IslandSession } from './types'
// The Chat widget tile shows the actual Blitz macOS app icon (the pre-masked squircle asset baked by
// ~/superapp/blitz-macos) instead of a generic glyph. The PNG is a dark rounded tile with transparent
// corners, so it sits on the island's black as a clean app icon. (blitz-macos is a separate mac app.)
import blitzAppIcon from '../assets/blitz-app-icon.png'
const isActiveStatus = (value: string): boolean => value === 'working' || value === 'starting'
const isWorkingStatus = (value: string): boolean => value === 'working'
const isWaitingStatus = (value: string): boolean => value === 'waiting'
const isErrorStatus = (value: string): boolean => value === 'error'
// 'reconnecting' is the wake-watchdog's island override (a transient self-healing state), not a raw chat status.
const isReconnectingStatus = (value: string): boolean => value === 'reconnecting'
// The home card's visual bucket. Error/reconnecting must rank ABOVE 'done' so a failed agent never reads as a
// green "Done" success (it shares the not-working/not-waiting shape with a finished agent otherwise).
type HomeState = 'waiting' | 'working' | 'reconnecting' | 'error' | 'done'
const homeStateFor = (value: string): HomeState =>
  isErrorStatus(value) ? 'error' : isReconnectingStatus(value) ? 'reconnecting' : isWaitingStatus(value) ? 'waiting' : isWorkingStatus(value) ? 'working' : 'done'
const CHECK_PATH = 'm5 12 4 4L19 6'
const ALERT_PATH = 'M12 7v6M12 17h.01'

export function IslandHome({
  menuBarH,
  sessions,
  status,
  doneAgentIds,
  onOpenChat,
  onOpenAgent
}: {
  menuBarH: number
  sessions: IslandSession[]
  status: Record<string, string>
  doneAgentIds: string[]
  onOpenChat: () => void
  onOpenAgent: (id: string) => void
}): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  const doneAgents = new Set(doneAgentIds)
  // Live indicator on the Chat icon: pulse if any session is actively working.
  const working = sessions.some((s) => {
    const st = status[s.id] || s.status
    return isActiveStatus(st)
  })
  const railSessions = sessions.filter((s) => {
    const rawStatus = status[s.id] || s.status
    // An errored / reconnecting agent always belongs in the rail — it needs the user's eye, not hiding behind 'done'.
    return isWorkingStatus(rawStatus) || isWaitingStatus(rawStatus) || isErrorStatus(rawStatus) || isReconnectingStatus(rawStatus) || doneAgents.has(s.id)
  })
  return (
    <div className={`nh-island isl-home${railSessions.length ? ' has-working has-home-rail' : ''}`} style={{ paddingTop: top }}>
      <div className="isl-home-layout">
        <div className="isl-home-chat-zone">
          <button type="button" className="isl-app isl-app-chat" onClick={onOpenChat} aria-label="Open Blitz">
            <span className="isl-app-icon">
              <img className="isl-app-icon-img" src={blitzAppIcon} alt="" draggable={false} />
              {working && <span className="isl-app-badge" aria-hidden />}
            </span>
            <span className="isl-app-name">Blitz</span>
          </button>
        </div>
        <section className="isl-home-agents" aria-label="Active agents">
          {railSessions.length > 0 ? (
            <>
              <div className="isl-home-agents-title">Active agents</div>
              <div className="isl-home-working">
                {railSessions.map((s) => {
                  const rawStatus = status[s.id] || s.status
                  const homeState = homeStateFor(rawStatus)
                  return (
                    <button
                      type="button"
                      key={s.id}
                      className="isl-working-agent"
                      data-home-state={homeState}
                      onClick={() => onOpenAgent(s.id)}
                      aria-label={`Open ${s.title} chat`}
                    >
                      <span className="isl-working-agent-icon" style={{ background: agentGradient(s.id) }} aria-hidden />
                      <span className="isl-working-agent-main">
                        <span className="isl-working-agent-name">{s.title}</span>
                        <span className="isl-working-agent-status">
                          {homeState === 'done' ? (
                            <span className="isl-working-agent-check" aria-hidden>
                              <svg viewBox="0 0 24 24" focusable="false">
                                <path d={CHECK_PATH} />
                              </svg>
                            </span>
                          ) : homeState === 'waiting' || homeState === 'error' ? (
                            <span className="isl-working-agent-alert" aria-hidden>
                              <svg viewBox="0 0 24 24" focusable="false">
                                <path d={ALERT_PATH} />
                              </svg>
                            </span>
                          ) : (
                            <span className="isl-working-agent-dot" aria-hidden />
                          )}
                          {homeState === 'done'
                            ? 'Done'
                            : homeState === 'waiting'
                              ? 'Response Needed'
                              : homeState === 'error'
                                ? 'Problem'
                                : homeState === 'reconnecting'
                                  ? 'Reconnecting'
                                  : 'Working'}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="isl-home-empty">No active agents</div>
          )}
        </section>
      </div>
    </div>
  )
}

export default IslandHome
