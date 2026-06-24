import './island.css'
import { useState } from 'react'
import type { IslandSession } from './types'

const ARCHIVED_PREVIEW_CHARS = 68

const archivedMessagePreview = (session: IslandSession): string => {
  const text = String(session.lastMessagePreview || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'No messages yet'
  if (text.length <= ARCHIVED_PREVIEW_CHARS) return text
  return `${text.slice(0, ARCHIVED_PREVIEW_CHARS).trimEnd()}...`
}

export function IslandSettings({
  menuBarH,
  workflowAlwaysShow,
  onToggleWorkflowAlwaysShow,
  showActiveTerminal,
  onToggleActiveTerminal,
  showFakeHomeAgents,
  onToggleFakeHomeAgents,
  archivedSessions,
  onRestoreAgent,
  onDeleteAgent
}: {
  menuBarH: number
  workflowAlwaysShow: boolean
  onToggleWorkflowAlwaysShow: (on: boolean) => void
  showActiveTerminal: boolean
  onToggleActiveTerminal: (on: boolean) => void
  showFakeHomeAgents: boolean
  onToggleFakeHomeAgents: (on: boolean) => void
  archivedSessions: IslandSession[]
  onRestoreAgent: (id: string) => void
  onDeleteAgent: (id: string) => void
}): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  const [archivedOpen, setArchivedOpen] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const archivedCount = archivedSessions.length
  return (
    <div className="nh-island isl-settings" style={{ paddingTop: top }}>
      <div className="isl-settings-head">
        <span className="isl-debug-flag">DEBUG</span>
        <span className="isl-settings-title">Settings</span>
      </div>
      <div className="isl-settings-list">
        <label className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Always show workflow board</span>
            <span className="isl-setting-note">Expand each run instead of a collapsed pill</span>
          </span>
          <input
            className="isl-setting-input"
            type="checkbox"
            checked={workflowAlwaysShow}
            onChange={(e) => onToggleWorkflowAlwaysShow(e.currentTarget.checked)}
          />
          <span className="isl-setting-toggle" aria-hidden>
            <span />
          </span>
        </label>
        <label className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Show active agent terminal</span>
            <span className="isl-setting-note">Read-only</span>
          </span>
          <input
            className="isl-setting-input"
            type="checkbox"
            checked={showActiveTerminal}
            onChange={(e) => onToggleActiveTerminal(e.currentTarget.checked)}
          />
          <span className="isl-setting-toggle" aria-hidden>
            <span />
          </span>
        </label>
        <label className="isl-setting-row">
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Show fake Home agents</span>
            <span className="isl-setting-note">Design preview</span>
          </span>
          <input
            className="isl-setting-input"
            type="checkbox"
            checked={showFakeHomeAgents}
            onChange={(e) => onToggleFakeHomeAgents(e.currentTarget.checked)}
          />
          <span className="isl-setting-toggle" aria-hidden>
            <span />
          </span>
        </label>
        <button
          type="button"
          className={`isl-settings-disclosure${archivedOpen ? ' open' : ''}`}
          aria-expanded={archivedOpen}
          onClick={() => {
            setArchivedOpen((v) => !v)
            setConfirmDeleteId(null)
          }}
        >
          <span className="isl-setting-copy">
            <span className="isl-setting-name">Archived agents</span>
            <span className="isl-setting-note">{archivedCount === 1 ? '1 hidden agent' : `${archivedCount} hidden agents`}</span>
          </span>
          <span className="isl-settings-count">{archivedCount}</span>
          <span className="isl-settings-chevron" aria-hidden>
            {archivedOpen ? '▾' : '▸'}
          </span>
        </button>
        {archivedOpen && (
          <div className="isl-archived-list">
            {archivedSessions.length === 0 ? (
              <div className="isl-archived-empty">No archived agents</div>
            ) : (
              archivedSessions.map((session) => {
                const confirming = confirmDeleteId === session.id
                return (
                  <div key={session.id} className={`isl-archived-row${confirming ? ' confirming' : ''}`}>
                    <span className="isl-archived-main">
                      <span className="isl-archived-title">{session.title}</span>
                      <span className="isl-archived-preview">{archivedMessagePreview(session)}</span>
                    </span>
                    {confirming ? (
                      <span className="isl-archived-confirm">
                        <span>Delete forever?</span>
                        <button type="button" className="isl-archived-btn" onClick={() => setConfirmDeleteId(null)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="isl-archived-btn danger"
                          onClick={() => {
                            onDeleteAgent(session.id)
                            setConfirmDeleteId(null)
                          }}
                        >
                          Delete
                        </button>
                      </span>
                    ) : (
                      <span className="isl-archived-actions">
                        <button type="button" className="isl-archived-btn" onClick={() => onRestoreAgent(session.id)}>
                          Restore
                        </button>
                        <button type="button" className="isl-archived-btn danger" onClick={() => setConfirmDeleteId(session.id)}>
                          Delete
                        </button>
                      </span>
                    )}
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default IslandSettings
