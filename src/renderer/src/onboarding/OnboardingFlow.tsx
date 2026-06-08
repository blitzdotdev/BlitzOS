import { useEffect, useRef, useState } from 'react'
import { FAKE_QUESTIONS } from './questions'

/**
 * Full-screen onboarding overlay: a light "OS boot" sequence over a frosted copy of
 * the user's wallpaper, then agent-style multiple-choice questions, then it unmounts
 * to reveal Desktop 1.
 *
 * This is the FLOW only — questions are fake (questions.ts), and there is no agent
 * generation or Desktop-1 seeding yet (a separate agent owns both). It forces the
 * light theme regardless of the global theme so the boot always reads as a clean OS.
 */
export function OnboardingFlow({ onComplete }: { onComplete: () => void }): JSX.Element {
  const [phase, setPhase] = useState<'boot' | 'questions'>('boot')
  const wallpaper = useWallpaper()
  return (
    <div className="onb" data-theme="light">
      <div className="onb-wall" style={wallpaper ? { backgroundImage: `url("${wallpaper}")` } : undefined} />
      <div className="onb-veil" />
      <div className="onb-content">
        {phase === 'boot' ? <BootScreen onDone={() => setPhase('questions')} /> : <QuestionFlow onDone={onComplete} />}
      </div>
    </div>
  )
}

/** Best-effort frosted wallpaper from main; null → the CSS light gradient shows through. */
function useWallpaper(): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    window.agentOS
      ?.getWallpaper?.()
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return url
}

// "Blitz" breathes while a progress bar fills — simulating the context scrape +
// question generation a separate agent does in production (here it's just a timer).
function BootScreen({ onDone }: { onDone: () => void }): JSX.Element {
  const [progress, setProgress] = useState(0)
  const done = useRef(false)
  useEffect(() => {
    const DUR = 2800
    const start = performance.now()
    let raf = 0
    const tick = (t: number): void => {
      const p = Math.min(1, (t - start) / DUR)
      setProgress(p)
      if (p < 1) raf = requestAnimationFrame(tick)
      else if (!done.current) {
        done.current = true
        window.setTimeout(onDone, 450)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [onDone])
  const stages = ['Waking up', 'Reading your Mac', 'Personalizing your questions']
  const stage = stages[Math.min(stages.length - 1, Math.floor(progress * stages.length))]
  return (
    <div className="boot">
      <div className="boot-mark">Blitz</div>
      <div className="boot-bar">
        <div className="boot-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <div className="boot-stage">{stage}</div>
    </div>
  )
}

interface Answer {
  choice?: string
  text?: string
}

// Questions, one at a time: click an option, optionally type more context, advance.
function QuestionFlow({ onDone }: { onDone: () => void }): JSX.Element {
  const [i, setI] = useState(0)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  const q = FAKE_QUESTIONS[i]
  const total = FAKE_QUESTIONS.length
  const last = i === total - 1
  const a = answers[q.id] ?? {}
  const answered = !!a.choice || !!a.text?.trim()

  const patch = (p: Partial<Answer>): void => setAnswers((prev) => ({ ...prev, [q.id]: { ...prev[q.id], ...p } }))
  const next = (): void => (last ? onDone() : setI((n) => n + 1))

  return (
    <div className="onb-q" key={q.id}>
      <div className="onb-q-count">
        {String(i + 1).padStart(2, '0')} <span>/ {String(total).padStart(2, '0')}</span>
      </div>
      <h1 className="onb-q-prompt">{q.prompt}</h1>
      <div className="onb-q-opts">
        {q.options.map((opt) => (
          <button key={opt} className={`onb-opt${a.choice === opt ? ' sel' : ''}`} onClick={() => patch({ choice: opt })}>
            {opt}
          </button>
        ))}
      </div>
      <textarea
        className="onb-q-more"
        placeholder="Add more context…"
        value={a.text ?? ''}
        rows={2}
        onChange={(e) => patch({ text: e.target.value })}
      />
      <div className="onb-q-actions">
        <button className="onb-skip" onClick={next}>
          Skip
        </button>
        <button className="onb-next" disabled={!answered} onClick={next}>
          {last ? 'Enter Desktop' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
