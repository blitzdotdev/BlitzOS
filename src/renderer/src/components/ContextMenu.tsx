// A small right-click menu (New Folder / New Board / …). A full-screen transparent backdrop closes it
// on any outside click or another right-click (the standard overlay backdrop pattern); the menu card stops the
// pointer so clicks inside don't dismiss before the item fires. Positioned at the click point, nudged
// back on-screen so it never overflows the viewport.
export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }): JSX.Element {
  // keep the menu fully on-screen (estimate ~220×(36/item); clamp to the viewport)
  const estW = 240
  const estH = items.length * 34 + 12
  const left = Math.min(x, window.innerWidth - estW - 8)
  const top = Math.min(y, window.innerHeight - estH - 8)
  return (
    <div className="context-menu-backdrop" onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }}>
      <div className="context-menu" style={{ left: Math.max(8, left), top: Math.max(8, top) }} onPointerDown={(e) => e.stopPropagation()}>
        {items.map((it, i) => (
          <button
            key={i}
            className="context-menu-item"
            disabled={it.disabled}
            onClick={() => {
              if (!it.disabled) it.onClick()
              onClose()
            }}
          >
            {it.label}
          </button>
        ))}
      </div>
    </div>
  )
}
