// The drill-in drawer, shared by both models. Click a leaf → see its REAL session: Asked (the input prompt),
// Did (the leaf's claude rollout: text turns + tool calls + results), Returned (the typed output, human-readable).
import React from 'react'
import { useLeaf, useLeafSession, Output, fmtMs, fmtTok } from './shared.jsx'

function Step({ s }) {
  if (s.kind === 'text') return <div className="dr-step dr-text">{s.text}</div>
  if (s.kind === 'tool')
    return (
      <div className="dr-step dr-tool">
        <span className="dr-tool-name">{s.name}</span>
        <code className="dr-tool-in">{s.input}</code>
      </div>
    )
  if (s.kind === 'result') return <div className="dr-step dr-result">{s.text}</div>
  return null
}

export default function LeafDrawer({ runId, node, onClose }) {
  const terminal = node && node.status !== 'running'
  const leaf = useLeaf(runId, node && node.nodeId, terminal)
  const { sess, loading } = useLeafSession(runId, node && node.nodeId, !!node)
  if (!node) return null
  const ask = (leaf && leaf.prompt) || (sess && sess.ask) || (node && node.prompt) || '' // node.prompt = planned (queued)
  const result = leaf ? leaf.result : undefined
  const isFixture = !runId || runId.startsWith('fixture')

  return (
    <div className="dr-scrim" onClick={onClose}>
      <div className="dr" onClick={(e) => e.stopPropagation()}>
        <div className="dr-head">
          <span className={`dr-dot dr-${node.status}`} />
          <span className="dr-label">{node.label}</span>
          {node.model ? <span className="dr-model">{node.model}</span> : null}
          <span className="dr-stats">
            {node.status}
            {node.ms ? ' · ' + fmtMs(node.ms) : ''}
            {node.tokens ? ' · ' + fmtTok(node.tokens) + ' tok' : ''}
          </span>
          <button className="dr-x" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div className="dr-body">
          <div className="dr-sec">
            <div className="dr-sec-h">Asked</div>
            {ask ? <pre className="dr-prompt">{ask}</pre> : <div className="dr-empty">{isFixture ? 'synthetic sample — no captured prompt' : 'no prompt captured'}</div>}
          </div>

          <div className="dr-sec">
            <div className="dr-sec-h">Did{sess && sess.steps ? ` · ${sess.steps.length} steps` : ''}</div>
            {isFixture ? (
              <div className="dr-empty">synthetic sample — run a real script to see the session</div>
            ) : loading ? (
              <div className="dr-empty">loading session…</div>
            ) : sess && sess.steps && sess.steps.length ? (
              <div className="dr-timeline">
                {sess.steps.map((s, i) => (
                  <Step s={s} key={i} />
                ))}
              </div>
            ) : (
              <div className="dr-empty">{sess && sess.note ? sess.note : 'no tool steps (a single-turn answer)'}</div>
            )}
          </div>

          <div className="dr-sec">
            <div className="dr-sec-h">Returned</div>
            {node.status === 'running' ? (
              <div className="dr-empty">still running…</div>
            ) : result !== undefined ? (
              <div className="dr-returned">
                <Output result={result} fallback={node.preview} />
              </div>
            ) : node.preview ? (
              <div className="dr-returned">
                <Output result={node.preview} fallback="" />
              </div>
            ) : (
              <div className="dr-empty">no output</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
