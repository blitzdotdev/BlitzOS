// Animated mini-mockups of the REAL Blitz island UI, one per intro slide. These are decorative,
// pointer-events-none reproductions (NOT the live components) sized to read inside the ~660px onboarding
// stage. Each mock loops a short timed sequence via useSequence; the parent remounts the visual (key=slide)
// so the animation restarts cleanly whenever a slide becomes active. Class values mirror the live island
// (island.css / wf.css / IslandHome / IslandPanel / IslandKanban) so the teaser matches the product.
import './onboardingVisuals.css'
import { useEffect, useState } from 'react'
import blitzAppIcon from '../assets/blitz-app-icon.png'
import { agentGradient } from './agentVisuals'

export type IntroVisual = 'home' | 'tabs' | 'connect' | 'workflow' | 'final' | 'requirement'

const CHECK = 'm5 12 4 4L19 6'
const ALERT = 'M12 7v6M12 17h.01'
const PEN = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z'

// Loop a step index through `durations` (ms spent AT each step), restarting at 0. One timer, cleaned on unmount.
function useSequence(durations: number[]): number {
  const [step, setStep] = useState(0)
  useEffect(() => {
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      timer = setTimeout(() => {
        i = (i + 1) % durations.length
        setStep(i)
        tick()
      }, durations[i])
    }
    tick()
    return () => clearTimeout(timer)
    // durations is a stable module constant per call site; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return step
}

const Spin = ({ sm }: { sm?: boolean }): JSX.Element => <span className={`oba-spin${sm ? ' sm' : ''}`} aria-hidden />
const Check = (): JSX.Element => (
  <span className="oba-check" aria-hidden>
    <svg viewBox="0 0 24 24" focusable="false">
      <path d={CHECK} />
    </svg>
  </span>
)
const Alert = (): JSX.Element => (
  <span className="oba-alert" aria-hidden>
    <svg viewBox="0 0 24 24" focusable="false">
      <path d={ALERT} />
    </svg>
  </span>
)

// ── Slide 1: the home grid — Blitz chat icon + a live "Active agents" rail. ───────────────────────────────────
const HOME_TOOLS = ['Reading your inbox…', 'Summarizing the thread…', 'Drafting a reply…', 'Checking your calendar…']

function HomeVisual(): JSX.Element {
  const t = useSequence([1700, 1700, 1700, 1700])
  return (
    <div className="oba-home" aria-hidden>
      <div className="oba-home-chat">
        <div className="oba-home-icon">
          <img src={blitzAppIcon} alt="" draggable={false} />
          <span className="oba-home-badge" />
        </div>
        <span className="oba-home-name">Blitz</span>
      </div>
      <div className="oba-home-agents">
        <div className="oba-home-agents-title">Active agents</div>
        <div className="oba-home-list">
          <div className="oba-agent" data-state="working">
            <span className="oba-agent-icon" style={{ background: agentGradient('3') }} />
            <span className="oba-agent-body">
              <span className="oba-agent-name">Inbox triage</span>
              <span className="oba-agent-status">{HOME_TOOLS[t]}</span>
            </span>
            <Spin />
          </div>
          <div className="oba-agent" data-state="done">
            <span className="oba-agent-icon" style={{ background: agentGradient('6') }} />
            <span className="oba-agent-body">
              <span className="oba-agent-name">Launch plan</span>
              <span className="oba-agent-status">Done</span>
            </span>
            <Check />
          </div>
          <div className="oba-agent" data-state="waiting">
            <span className="oba-agent-icon" style={{ background: agentGradient('9') }} />
            <span className="oba-agent-body">
              <span className="oba-agent-name">CRM research</span>
              <span className="oba-agent-status">Response needed</span>
            </span>
            <Alert />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Slide 2: the chat tab strip — one agent per tab, each with its own conversation. ──────────────────────────
type Dot = 'working' | 'waiting' | 'done'
const TABS: Array<{ id: string; name: string; dot: Dot; msgs: Array<{ role: 'user' | 'agent'; text: string }> }> = [
  {
    id: '0',
    name: 'Blitz',
    dot: 'working',
    msgs: [
      { role: 'user', text: 'Plan my product launch' },
      { role: 'agent', text: 'On it — drafting the checklist now.' }
    ]
  },
  {
    id: '4',
    name: 'Inbox',
    dot: 'waiting',
    msgs: [
      { role: 'user', text: 'Anything urgent in my email?' },
      { role: 'agent', text: '3 need replies. Want me to draft them?' }
    ]
  },
  {
    id: '7',
    name: 'Research',
    dot: 'done',
    msgs: [
      { role: 'user', text: 'Compare the top 3 CRMs' },
      { role: 'agent', text: 'Done — Notion wins on price. Summary above.' }
    ]
  }
]

function TabsVisual(): JSX.Element {
  const active = useSequence([2600, 2600, 2600])
  const tab = TABS[active]
  return (
    <div className="oba-chat" aria-hidden>
      <div className="oba-tabs">
        <span className="oba-tab-new">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d={PEN} />
          </svg>
        </span>
        {TABS.map((x, i) => (
          <span key={x.id} className={`oba-tab${i === active ? ' on' : ''}`}>
            <span className="oba-tab-album" style={{ background: agentGradient(x.id) }} />
            <span className="oba-tab-label">{x.name}</span>
            <span className={`oba-dot oba-dot-${x.dot}`} />
          </span>
        ))}
      </div>
      <div className="oba-feed" key={active}>
        {tab.msgs.map((m, i) => (
          <div key={i} className={`oba-msg oba-msg-${m.role}`} style={{ animationDelay: `${0.05 + i * 0.16}s` }}>
            {m.text}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Slide 3: connect a tab, type a prompt, send → live status. ────────────────────────────────────────────────
const C_PROMPT = 'Reply to the Acme email'
// steps: 0 list · 1 connect tab · 2 collapse panel · 3 type · 4 send · 5 working
const C_SEQ = [1500, 1600, 900, 1700, 950, 3300]

function ConnectVisual(): JSX.Element {
  const step = useSequence(C_SEQ)
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (step !== 3) {
      setTyped('')
      return
    }
    let i = 0
    const id = setInterval(() => {
      i += 1
      setTyped(C_PROMPT.slice(0, i))
      if (i >= C_PROMPT.length) clearInterval(id)
    }, 1300 / (C_PROMPT.length + 3))
    return () => clearInterval(id)
  }, [step])

  const connected = step >= 1
  const showSend = step === 3 && typed.length > 0
  return (
    <div className="oba-connect" aria-hidden>
      <div className="oba-connect-body">
        {step <= 2 && (
          <div className={`oba-attach${step >= 2 ? ' collapsed' : ''}`}>
            <div className="oba-attach-grid">
              <div className={`oba-drop${connected ? ' filled' : ''}`}>
                {connected ? (
                  <span className="oba-conn-pill">
                    <span className="oba-fav" data-c="g">G</span>
                    Gmail · Inbox
                  </span>
                ) : (
                  <span className="oba-drop-hint">Drag a tab or app here</span>
                )}
              </div>
              <div className="oba-apps">
                <div className="oba-app">
                  <span className="oba-twisty">▾</span>
                  <span className="oba-chrome" />
                  <span className="oba-app-name">Chrome</span>
                  <span className="oba-app-count">3</span>
                </div>
                <div className="oba-srctabs">
                  <div className={`oba-srctab${connected ? ' connected' : ''}`}>
                    <span className="oba-fav" data-c="g">G</span>
                    Gmail · Inbox
                  </div>
                  <div className="oba-srctab">
                    <span className="oba-fav" data-c="a">A</span>
                    Acme · Pricing
                  </div>
                  <div className="oba-srctab">
                    <span className="oba-fav" data-c="c">C</span>
                    Calendar · June
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {step >= 4 && (
          <div className="oba-feed bottom" key="sent">
            <div className="oba-msg oba-msg-user">{C_PROMPT}</div>
            {step >= 5 && (
              <div className="oba-status">
                <div className="oba-status-head">
                  <Spin sm />
                  <span className="oba-status-label">Working…</span>
                </div>
                <div className="oba-status-rows">
                  <div className="oba-status-row" style={{ animationDelay: '0.1s' }}>
                    Reading the Gmail tab
                  </div>
                  <div className="oba-status-row" style={{ animationDelay: '0.7s' }}>
                    Drafting a reply
                  </div>
                  <div className="oba-status-row latest" style={{ animationDelay: '1.4s' }}>
                    Opening the compose window
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="oba-composer">
        <span className="oba-attach-btn">{step <= 2 ? '×' : '+'}</span>
        <div className="oba-bar">
          <span className="oba-bar-field">
            {step === 3 && typed.length > 0 ? (
              <>
                {typed}
                <span className="oba-caret" />
              </>
            ) : (
              <span className="oba-ph">Message Blitz</span>
            )}
          </span>
          <span className={`oba-send${showSend ? '' : ' hide'}`}>↑</span>
        </div>
      </div>
    </div>
  )
}

// ── Slide 4: a workflow pill in chat → expand into a kanban board, cards moving to done. ──────────────────────
// Two cards keeps the fully-expanded board (worst case: both stacked in Done) inside the 200px stage.
const W_CARDS = [
  { id: 'a', label: 'Check the headline', out: 'Clear, but the CTA is buried.', model: 'sonnet' },
  { id: 'b', label: 'Test mobile nav', out: 'Menu overlaps the logo < 380px.', model: 'haiku' }
]
// steps: 0 pill only · 1 expand (all to-do) · 2 A doing · 3 A done/B doing · 4 B done/C doing · 5 all done
const W_SEQ = [1700, 1500, 1400, 1400, 1400, 2400]
type Col = 'todo' | 'doing' | 'done'
function colFor(idx: number, step: number): Col {
  // card i moves todo → doing at step (i+2), → done at step (i+3)
  const enterDoing = idx + 2
  const enterDone = idx + 3
  if (step >= enterDone || step >= 5) return 'done'
  if (step >= enterDoing) return 'doing'
  return 'todo'
}

function WorkflowVisual(): JSX.Element {
  const step = useSequence(W_SEQ)
  const open = step >= 1
  const done = step >= 5
  const cards = W_CARDS.map((c, i) => ({ ...c, col: colFor(i, step) }))
  const col = (c: Col): typeof cards => cards.filter((x) => x.col === c)
  return (
    <div className="oba-wf" aria-hidden>
      <div className={`oba-wf-ctx${open ? ' hidden' : ''}`}>
        <div className="oba-msg oba-msg-user">Audit my landing page</div>
      </div>
      <div className={`oba-wf-pill${done ? ' done' : ''}${step === 1 ? ' pressing' : ''}`}>
        <span className="oba-wf-caret">{open ? '▾' : '▸'}</span>
        <span className="oba-dot oba-wf-dot" />
        <span className="oba-wf-status">{done ? 'workflow done' : 'workflow running'}</span>
        <span className="oba-wf-stats">2 agents · 1 phase</span>
      </div>
      <div className={`oba-board-wrap${open ? ' open' : ''}`}>
        <div className="oba-board">
          <div className="oba-kb-head">
            <span className="oba-kb-phase">Landing page</span>
            <span className="oba-kb-col todo">To do</span>
            <span className="oba-kb-col doing">Doing</span>
            <span className="oba-kb-col done">Done</span>
          </div>
          <div className="oba-kb-row">
            <span className="oba-kb-rowh">
              <span className="oba-kb-rowh-name">Audit</span>
              <span className="oba-kb-rowh-n">3 agents</span>
            </span>
            {(['todo', 'doing', 'done'] as Col[]).map((c) => (
              <span key={c} className="oba-kb-cell">
                {col(c).map((card) => (
                  <span key={card.id} className={`oba-kc oba-kc-${card.col}`}>
                    <span className="oba-kc-label-row">
                      <span className="oba-kc-label">{card.label}</span>
                      <span className="oba-kc-model">{card.model}</span>
                    </span>
                    {card.col === 'done' && <span className="oba-kc-out">{card.out}</span>}
                    {card.col === 'doing' && <span className="oba-kc-spark" />}
                  </span>
                ))}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// The completion hero — same framed stage + Blitz icon language as the intro slides, with a "ready"
// pulse and a green confirmation badge, so the finish reads as part of the same sequence.
export function OnboardingDoneHero(): JSX.Element {
  return (
    <div className="oba-stage oba-done" aria-hidden>
      <span className="oba-done-ring r1" />
      <span className="oba-done-ring r2" />
      <span className="oba-done-ring r3" />
      <span className="oba-done-icon">
        <img src={blitzAppIcon} alt="" draggable={false} />
        <span className="oba-done-badge">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d={CHECK} />
          </svg>
        </span>
      </span>
    </div>
  )
}

export function OnboardingVisual({ kind }: { kind: IntroVisual }): JSX.Element | null {
  if (kind === 'final' || kind === 'requirement') return null
  return (
    <div className="oba-stage" aria-hidden>
      {kind === 'home' && <HomeVisual />}
      {kind === 'tabs' && <TabsVisual />}
      {kind === 'connect' && <ConnectVisual />}
      {kind === 'workflow' && <WorkflowVisual />}
    </div>
  )
}

export default OnboardingVisual
