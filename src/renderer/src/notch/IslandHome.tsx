// IslandHome — the island's HOME SCREEN (the default view when the island appears on notch hover). An iPhone-style
// row of widget icons. V1 ships ONE functional widget, Chat (centered), flanked by two dotted-outline placeholders
// for the widgets agents will generate next. Tapping Chat enters the agent session UI (NotchHost flips to 'session').
// Settings are notch chrome, not a widget. The black chassis + NotchShape are owned by NotchHost and are INVARIANT;
// this paints only the interior.
import './island.css'
import type { IslandSession } from './types'

// A speech-bubble glyph for the Chat widget icon.
const CHAT_GLYPH = 'M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z'

export function IslandHome({
  menuBarH,
  sessions,
  status,
  onOpenChat
}: {
  menuBarH: number
  sessions: IslandSession[]
  status: Record<string, string>
  onOpenChat: () => void
}): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  // Live indicator on the Chat icon: pulse if any session is actively working.
  const working = sessions.some((s) => {
    const st = status[s.id] || s.status
    return st === 'working' || st === 'starting'
  })
  return (
    <div className="nh-island isl-home" style={{ paddingTop: top }}>
      <div className="isl-home-grid">
        <span className="isl-app isl-app-empty" aria-hidden>
          <span className="isl-app-icon" />
        </span>
        {/* the middle tile = Chat, centered in the island */}
        <button type="button" className="isl-app isl-app-chat" onClick={onOpenChat} aria-label="Open chat">
          <span className="isl-app-icon">
            <svg viewBox="0 0 24 24" aria-hidden focusable="false">
              <path d={CHAT_GLYPH} fill="currentColor" />
            </svg>
            {working && <span className="isl-app-badge" aria-hidden />}
          </span>
          <span className="isl-app-name">Chat</span>
        </button>
        <span className="isl-app isl-app-empty" aria-hidden>
          <span className="isl-app-icon" />
        </span>
      </div>
    </div>
  )
}

export default IslandHome
