import { useState } from 'react'
import { IntegrationStatus } from '../types'
import { IconClose } from './Icons'

interface Props {
  integration: IntegrationStatus
  onClose: () => void
}

export function ConnectPanel({ integration, onClose }: Props): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConfig, setNeedsConfig] = useState(!integration.configured)

  async function signIn(): Promise<void> {
    setBusy(true)
    setError(null)
    const res = await window.agentOS!.integrations.connect(integration.id)
    setBusy(false)
    if (res.ok) {
      onClose()
    } else {
      setError(res.error || 'Sign-in failed')
      setNeedsConfig(!!res.needsConfig)
    }
  }

  return (
    <div className="overlay" onPointerDown={onClose}>
      <div className="panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span className="panel-dot" style={{ background: integration.color }} />
          <h3>Connect {integration.name}</h3>
          <button className="panel-x" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>

        {integration.configured ? (
          <p className="panel-help">
            Opens {integration.name} in your browser. Sign in with the account you already use, hit Allow, and you are
            connected. Nothing to type.
          </p>
        ) : (
          <div className="setup-box">
            <div className="setup-title">One-time setup</div>
            <p className="panel-help">{integration.helpText}</p>
            <button className="link" onClick={() => window.agentOS?.integrations.openExternal(integration.helpUrl)}>
              Open setup page ↗
            </button>
          </div>
        )}

        {busy && <div className="device-box"><div className="device-label">Continue in your browser, then come back…</div></div>}

        {error && (
          <div className="panel-error">
            {error}
            {needsConfig && (
              <div className="panel-error-hint">
                Add this provider's client id + secret to <code>agent-os/integrations.config.json</code> (copy{' '}
                <code>integrations.config.example.json</code>), then try again.
              </div>
            )}
          </div>
        )}

        <div className="panel-actions">
          <button className="link" onClick={() => window.agentOS?.integrations.openExternal(integration.helpUrl)}>
            Setup / docs ↗
          </button>
          <button className="primary" disabled={busy || !integration.configured} onClick={signIn}>
            {busy ? 'Waiting…' : `Sign in with ${integration.name}`}
          </button>
        </div>

        <p className="panel-soon">Soon: a computer-use skill provisions the one-time OAuth app for you, so even this setup is automatic.</p>
      </div>
    </div>
  )
}
