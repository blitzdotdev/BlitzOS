// A mock BlitzOS island chat: the black chassis, a tab pill, a short scripted conversation, the live board embedded
// inline as a widget bubble, and a steer bar. This is the preview of how the board reads once ported into the
// island — drive it with the real Run/Replay (lab chrome) above, and the board + closing message react live.
import React from 'react'
import { fmtMs, fmtTok } from './shared.jsx'

export default function IslandChat({ board, model, status, drawer }) {
  const running = status === 'running' || status === 'replaying'
  const done = status === 'done'
  const stats = model.stats
  const leaves = model.nodeOrder.length

  return (
    <div className="island">
      <div className="island-notch" />
      <div className="isl-tabs-mock">
        <span className="isl-chip-mock pen">✎</span>
        <span className="isl-chip-mock active">
          <span className="isl-chip-album" />
          Blitz
          <span className={`isl-chip-dot${running ? ' working' : ''}`} />
        </span>
      </div>

      <div className="isl-feed-mock">
        <div className="isl-msg user">explore features 3 and 5, ground them in the current code, then lay out and critique the best approaches</div>
        <div className="isl-msg agent">
          On it. I’ll ground the current state across the codebase, draft approaches for each feature, critique them on feasibility and cost, then synthesize the strongest path. Here’s the workflow:
        </div>

        <div className="isl-board-bubble">
          <div className="isl-board-cap">
            <span className={`dot${done ? ' done' : running ? ' working' : ''}`} />
            {model.name || 'workflow'}
            {stats ? <span style={{ marginLeft: 'auto', textTransform: 'none', letterSpacing: 0 }}>{fmtMs(stats.ms)} · {stats.calls} agents · {fmtTok(stats.tokens)} tok</span> : running ? <span style={{ marginLeft: 'auto', textTransform: 'none' }}>running…</span> : null}
          </div>
          {board}
          {/* the drill-in panel is scoped to THIS embed frame (the board bubble), not the whole island chat */}
          {drawer}
        </div>

        {done ? (
          <div className="isl-msg agent">
            Done — grounded {leaves ? Math.min(leaves, 5) : 5} areas and worked through {leaves || 'the'} agents. The synthesis is ready above. Want me to write it up as a plan?
          </div>
        ) : running ? (
          <div className="isl-msg agent typing">working through the workflow…</div>
        ) : null}
      </div>

      <div className="isl-composer-mock">
        <button className="isl-attach-mock" tabIndex={-1}>
          +
        </button>
        <div className="isl-bar-mock">Steer this agent…</div>
        <button className="isl-send-mock" tabIndex={-1}>
          ↑
        </button>
      </div>
    </div>
  )
}
