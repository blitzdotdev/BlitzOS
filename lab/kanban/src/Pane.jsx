// One independent pane: its own script picker, Run-for-real / Replay controls, live event stream, board model, and
// drill-in drawer. Two of these sit side by side (A | B) so each can run a DIFFERENT script at the same time.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ModelA from './ModelA.jsx'
import ModelB from './ModelB.jsx'
import LeafDrawer from './LeafDrawer.jsx'
import IslandChat from './IslandChat.jsx'
import { mergeSkeleton } from './reduce.js'

const SPEEDS = { instant: 0, fast: 250, real: 1500 }

export default function Pane({ model, title, scripts, recordings, onRanReal }) {
  const [script, setScript] = useState('wf-demo.js')
  const [recording, setRecording] = useState('fixture:sample-run')
  const [speed, setSpeed] = useState('fast')
  const [events, setEvents] = useState([])
  const [status, setStatus] = useState('idle')
  const [note, setNote] = useState('')
  const [runId, setRunId] = useState('') // real runId (live) or the recording id (replay); '' for the fixture
  const [skeleton, setSkeleton] = useState([]) // dry-run preflight events: the full planned structure (TODO leaves)
  const [openNode, setOpenNode] = useState(null)
  const esRef = useRef(null)
  const replayRef = useRef(null)
  const seenRef = useRef(new Set())

  // The merged model: every planned leaf (from the skeleton) with its live state overlaid (running/done) or 'queued'.
  const m = useMemo(() => mergeSkeleton(events, skeleton), [events, skeleton])
  const drawerNode = openNode == null ? null : m.nodes[openNode] || null

  const reset = () => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
    if (replayRef.current) {
      clearTimeout(replayRef.current)
      replayRef.current = null
    }
    seenRef.current = new Set()
    setEvents([])
    setSkeleton([])
    setOpenNode(null)
  }
  const pushEvent = useCallback((ev) => {
    const key = ev && ev.seq != null ? ev.seq : Math.random()
    if (seenRef.current.has(key)) return
    seenRef.current.add(key)
    setEvents((prev) => [...prev, ev])
  }, [])

  async function runForReal() {
    reset()
    setStatus('running')
    setNote('starting ' + script + ' …')
    try {
      const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script }) }).then((x) => x.json())
      if (r.error) {
        setStatus('error')
        setNote(r.error)
        return
      }
      setRunId(r.runId)
      setSkeleton(r.skeleton || []) // the full planned structure → phase 2 etc. show in TODO before they run
      setNote('running ' + script + ' (' + r.runId + ')')
      const es = new EventSource('/api/events?runId=' + encodeURIComponent(r.runId))
      esRef.current = es
      es.onmessage = (msg) => {
        let ev
        try {
          ev = JSON.parse(msg.data)
        } catch {
          return
        }
        pushEvent(ev)
        if (ev.type === 'run:done') {
          setStatus(ev.ok ? 'done' : 'error')
          es.close()
          esRef.current = null
          onRanReal && onRanReal()
        }
      }
    } catch (e) {
      setStatus('error')
      setNote('run failed: ' + e)
    }
  }

  async function replay() {
    reset()
    setStatus('replaying')
    try {
      const data = await fetch('/api/recording?id=' + encodeURIComponent(recording)).then((r) => r.json())
      const evs = data.events || []
      setRunId(recording.startsWith('fixture') ? '' : recording)
      setSkeleton(data.skeleton || [])
      setNote('replaying ' + (data.meta?.script || recording))
      const gapCap = SPEEDS[speed] ?? SPEEDS.fast
      let i = 0
      const step = () => {
        if (i >= evs.length) {
          const last = evs[evs.length - 1]
          setStatus(last && last.type === 'run:done' && last.ok === false ? 'error' : 'done')
          return
        }
        const ev = evs[i++]
        pushEvent(ev)
        if (i >= evs.length) return step()
        const realGap = Math.max(0, (evs[i].ts || 0) - (ev.ts || 0))
        replayRef.current = setTimeout(step, gapCap === 0 ? 0 : Math.min(realGap, gapCap))
      }
      step()
    } catch (e) {
      setStatus('error')
      setNote('replay failed: ' + e)
    }
  }

  const Board = model === 'A' ? ModelA : ModelB

  // Show the sample run in-context on load so the board renders inside the island immediately.
  useEffect(() => {
    replay()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="pane">
      <div className="lab-tools">
        <span className="pane-title">{title}</span>
        <span className={`pane-status pane-status-${status}`}>{status}</span>
        <span className="pane-sep" />
        <select value={script} onChange={(e) => setScript(e.target.value)} title="example blitzscript">
          {scripts.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
              {s.demo ? '  ⚡' : ''}
            </option>
          ))}
        </select>
        <button className="pane-go" onClick={runForReal} disabled={status === 'running'}>
          ▶ Run
        </button>
        <span className="pane-sep" />
        <select value={recording} onChange={(e) => setRecording(e.target.value)} title="recording to replay">
          {recordings.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={speed} onChange={(e) => setSpeed(e.target.value)} title="replay speed">
          <option value="instant">instant</option>
          <option value="fast">fast</option>
          <option value="real">realtime</option>
        </select>
        <button onClick={replay}>↻</button>
      </div>

      <div className="isl-stage">
        <IslandChat
          model={m}
          status={status}
          board={<Board model={m} runId={runId} onOpenLeaf={setOpenNode} />}
          drawer={drawerNode ? <LeafDrawer runId={runId} node={drawerNode} onClose={() => setOpenNode(null)} /> : null}
        />
      </div>
    </div>
  )
}
