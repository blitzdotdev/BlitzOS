import './island.css'

export function IslandSettings({
  menuBarH,
  showActiveTerminal,
  onToggleActiveTerminal
}: {
  menuBarH: number
  showActiveTerminal: boolean
  onToggleActiveTerminal: (on: boolean) => void
}): JSX.Element {
  const top = Math.max(28, menuBarH) + 8
  return (
    <div className="nh-island isl-settings" style={{ paddingTop: top }}>
      <div className="isl-settings-head">
        <span className="isl-debug-flag">DEBUG</span>
        <span className="isl-settings-title">Settings</span>
      </div>
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
    </div>
  )
}

export default IslandSettings
