// Split-pane lab: Model A (lifecycle matrix kanban) | Model B (IO flow). Each pane runs its OWN script for real and
// streams live WfEvents into its board, so we can compare the two designs side by side on different runs.
import React, { useCallback, useEffect, useState } from 'react'
import Pane from './Pane.jsx'

export default function App() {
  const [scripts, setScripts] = useState([])
  const [recordings, setRecordings] = useState([])

  const loadLists = useCallback(async () => {
    try {
      const s = await fetch('/api/scripts').then((r) => r.json())
      setScripts(s.scripts || [])
      const r = await fetch('/api/recordings').then((r) => r.json())
      setRecordings(r.recordings || [])
    } catch {
      /* lab api not ready */
    }
  }, [])

  useEffect(() => {
    loadLists()
  }, [loadLists])

  return (
    <div className="lab">
      <div className="lab-titlebar">
        <span className="lab-brand">blitz · workflow viz lab</span>
        <span className="lab-hint">preview: the board embedded in the BlitzOS island chat · each pane runs its own script for real · click any card/node for the session</span>
      </div>
      <div className="lab-split">
        <Pane model="A" title="A — lifecycle matrix kanban" scripts={scripts} recordings={recordings} onRanReal={loadLists} />
        <div className="lab-divider" />
        <Pane model="B" title="B — IO flow (click edges)" scripts={scripts} recordings={recordings} onRanReal={loadLists} />
      </div>
    </div>
  )
}
