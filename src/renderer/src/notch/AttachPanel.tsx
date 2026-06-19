// AttachPanel — the attachment section, INJECTED INLINE below the message bar (not a separate view). A composer's
// attach "+" toggles it; the island grows to accommodate it (see notch.css .nh-chassis.nh-wide + island.css
// .isl-attach-wrap). Visual-only (mock): the layout + interactions are real, wiring real apps/tabs/files is later.
// Vertical order (under the message bar): the skills/connectors strip (Deep is one) on TOP, then two equal rounded
// dashed boxes — LEFT = the drop zone (files/apps/tabs), RIGHT = the open-apps list (click a row selects ALL its
// tabs, ▸/▾ expands it to pick individual tabs). Selection state is local + ephemeral here.
import './attach.css'
import { useState } from 'react'
import { MOCK_SKILLS, MOCK_OPEN_APPS, type MockApp } from './mock'

const toggle = (set: Set<string>, id: string): Set<string> => {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

export function AttachPanel(): JSX.Element {
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedTabs, setSelectedTabs] = useState<Set<string>>(new Set())

  // An app's checkbox state is derived from how many of its tabs are selected.
  const appState = (app: MockApp): 'all' | 'some' | 'none' => {
    const sel = app.tabs.filter((t) => selectedTabs.has(t.id)).length
    return sel === 0 ? 'none' : sel === app.tabs.length ? 'all' : 'some'
  }
  // Click an app row → select ALL its tabs (or clear them if already all selected).
  const toggleApp = (app: MockApp): void => {
    const all = appState(app) === 'all'
    setSelectedTabs((prev) => {
      const next = new Set(prev)
      app.tabs.forEach((t) => (all ? next.delete(t.id) : next.add(t.id)))
      return next
    })
  }

  return (
    <div className="att">
      {/* the skills/connectors strip on TOP (same chip style as the tab headers; Deep is one). */}
      <div className="att-skills" role="list">
        {MOCK_SKILLS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`isl-chip att-skill${enabled.has(s.id) ? ' active' : ''}`}
            aria-pressed={enabled.has(s.id)}
            onClick={() => setEnabled((e) => toggle(e, s.id))}
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* two equal rounded dashed boxes at the BOTTOM. */}
      <div className="att-boxes">
        {/* LEFT: the real drop zone (files / apps / tabs). */}
        <div className="att-drop" role="button" tabIndex={0} aria-label="Drop files, apps, or tabs here">
          <div className="att-drop-hint">
            <span className="att-drop-plus" aria-hidden>
              +
            </span>
            <span>Drag files, apps, or tabs here</span>
          </div>
        </div>

        {/* RIGHT: open apps; row = select all tabs, ▸/▾ = expand to pick individual tabs. */}
        <div className="att-apps">
          {MOCK_OPEN_APPS.map((app) => {
            const state = appState(app)
            const isExp = expanded.has(app.id)
            return (
              <div key={app.id} className="att-app-group">
                <div className="att-app">
                  <button
                    type="button"
                    className="att-twisty"
                    aria-label={isExp ? 'Collapse' : 'Expand'}
                    aria-expanded={isExp}
                    onClick={() => setExpanded((e) => toggle(e, app.id))}
                  >
                    {isExp ? '▾' : '▸'}
                  </button>
                  <button type="button" className="att-app-row" onClick={() => toggleApp(app)}>
                    <span className="att-check" data-sel={state} aria-hidden />
                    <span className="att-app-glyph" aria-hidden>
                      {app.glyph}
                    </span>
                    <span className="att-app-name">{app.name}</span>
                    <span className="att-app-count">{app.tabs.length}</span>
                  </button>
                </div>
                {isExp && (
                  <div className="att-tabs">
                    {app.tabs.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="att-tab"
                        onClick={() => setSelectedTabs((s) => toggle(s, t.id))}
                      >
                        <span className="att-check" data-sel={selectedTabs.has(t.id) ? 'all' : 'none'} aria-hidden />
                        <span className="att-tab-title">{t.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default AttachPanel
