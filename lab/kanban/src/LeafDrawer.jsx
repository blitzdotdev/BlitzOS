// The drill-in drawer, shared by both models. Click a leaf → see its REAL session: Asked (the input prompt),
// Did (the agent's FINAL message — its own one-take account of what it did), Returned (the typed output, as
// pretty syntax-highlighted JSON).
import { useLeaf, useLeafSession, Output, Markdown, fmtMs, fmtTok } from './shared.jsx'

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
          <section className="dr-sec">
            <div className="dr-sec-h">Asked</div>
            <div className="dr-card">
              {ask ? <pre className="dr-prompt">{ask}</pre> : <div className="dr-empty">{isFixture ? 'synthetic sample — no captured prompt' : 'no prompt captured'}</div>}
            </div>
          </section>

          <section className="dr-sec">
            <div className="dr-sec-h">Did</div>
            <div className="dr-card">
              {isFixture ? (
                <div className="dr-empty">synthetic sample — run a real script to see the session</div>
              ) : loading ? (
                <div className="dr-empty">loading session…</div>
              ) : sess && sess.final ? (
                <Markdown text={sess.final} />
              ) : (
                <div className="dr-empty">{sess && sess.note ? sess.note : 'no final message captured'}</div>
              )}
            </div>
          </section>

          <section className="dr-sec">
            <div className="dr-sec-h">Returned</div>
            <div className="dr-card">
              {node.status === 'running' ? (
                <div className="dr-empty">still running…</div>
              ) : result !== undefined ? (
                <Output result={result} fallback={node.preview} />
              ) : node.preview && isFixture ? (
                <Output result={node.preview} fallback="" />
              ) : (
                <div className="dr-empty">no output</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
