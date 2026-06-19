// NotchHost — the stateful shell for the island. Rendered (via a portal to document.body in App.tsx, so it
// escapes the #root-canvas clip) when the island is shown. It owns ALL behavior so IslandPanel stays purely
// visual:
//   - the active "page": page 0 = the new-session view; pages 1..N = the process view of each agent tab.
//   - TAB NAVIGATION: Ctrl+Tab → next, Ctrl+Shift+Tab → prev (wrapping across the session view + the agents);
//     clicking a tab header selects it. There is NO swipe paging — a trackpad swipe natively scrolls the
//     overflow-x tab strip (the headers), it never changes the active tab.
//   - local mock transcript (append on send; visual-only, no backend).
// It wraps IslandPanel in the invariant BLACK chassis (.nh-chassis — the original NotchShape, never changes) and
// hands it the contract props. Show/hide live in App.tsx.
import './notch.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import IslandPanel from './IslandPanel'
import { MOCK_SESSIONS, MOCK_MESSAGES, MOCK_ACTIVITY, type MockMessage } from './mock'

const N = MOCK_SESSIONS.length
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function NotchHost({ menuBarH }: { menuBarH: number }): JSX.Element {
  const [page, setPage] = useState(0) // 0 = session composer; 1..N = process tab (page-1)
  const [attachOpen, setAttachOpen] = useState(false) // the attach "+" injects the attachment panel inline
  const [appended, setAppended] = useState<Record<string, MockMessage[]>>({})
  const sendSeq = useRef(0)

  const view: 'session' | 'process' = page === 0 ? 'session' : 'process'
  const activeIndex = page === 0 ? 0 : page - 1
  const activeId = MOCK_SESSIONS[activeIndex]?.id ?? MOCK_SESSIONS[0].id

  const messages = useMemo(
    () => [...(MOCK_MESSAGES[activeId] ?? []), ...(appended[activeId] ?? [])],
    [activeId, appended]
  )
  const activity = MOCK_ACTIVITY[activeId] ?? []

  const goPage = (next: number): void => setPage((p) => clamp(next, 0, N)) // 0..N

  // Tab navigation by KEYBOARD: Ctrl+Tab → next, Ctrl+Shift+Tab → prev, wrapping across the session view (0) and
  // the agents (1..N). Swiping no longer pages — it natively scrolls the overflow-x tab strip; switching the tab
  // is click or Ctrl(+Shift)+Tab only. Capture phase + preventDefault so it works even with the composer focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (attachOpen) return // while the attachment panel is open, don't shuffle tabs underneath it
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const total = N + 1
        setPage((p) => (p + (e.shiftKey ? total - 1 : 1)) % total)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [attachOpen])

  const onSend = (text: string): void => {
    sendSeq.current += 1
    const m: MockMessage = { id: 'u' + sendSeq.current, role: 'user', text, ts: 'now' }
    setAppended((a) => ({ ...a, [activeId]: [...(a[activeId] ?? []), m] }))
  }

  // The CHASSIS is invariant — black + the original NotchShape (square top, 28px rounded bottom). IslandPanel
  // renders INSIDE it and paints only the interior; it never owns bg or shape.
  // The chassis GROWS (wider) when the attachment panel opens — the island expands to accommodate it.
  return (
    <div className="nhost" data-view={view}>
      <div className={`nh-chassis${attachOpen ? ' nh-wide' : ''}`} data-view={view}>
        <IslandPanel
          sessions={MOCK_SESSIONS}
          page={page}
          onSelectPage={goPage}
          messages={messages}
          activity={activity}
          onSend={onSend}
          menuBarH={menuBarH}
          attachOpen={attachOpen}
          onToggleAttach={() => setAttachOpen((v) => !v)}
        />
      </div>
    </div>
  )
}

export default NotchHost
