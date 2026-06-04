interface Props {
  onAddBrowser: () => void
}

/** Left sidebar. For now: just a + that adds a browser window to the canvas. */
export function Sidebar({ onAddBrowser }: Props): JSX.Element {
  return (
    <div className="sidebar">
      <button className="sidebar-btn" title="New browser window" onClick={onAddBrowser}>
        +
      </button>
    </div>
  )
}
