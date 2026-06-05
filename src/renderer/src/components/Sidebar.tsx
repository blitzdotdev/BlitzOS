import { useDesktop } from '../store'
import { SurfaceKind } from '../types'

interface Props {
  onAddBrowser: () => void
}

const KIND_ICON: Record<SurfaceKind, string> = {
  web: '🌐',
  app: '▦',
  srcdoc: '⚡',
  native: '🗒'
}

/** Left dock: + to add a browser, then an icon per open surface. Click to bring it forward at real size. */
export function Sidebar({ onAddBrowser }: Props): JSX.Element {
  const surfaces = useDesktop((s) => s.surfaces)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)

  return (
    <div className="sidebar">
      <button className="sidebar-btn" title="New browser window" onClick={onAddBrowser}>
        +
      </button>
      {surfaces.length > 0 && <div className="sidebar-sep" />}
      <div className="sidebar-apps">
        {surfaces.map((s) => (
          <button
            key={s.id}
            className="sidebar-app"
            title={`${s.title} — click to bring forward`}
            onClick={() => focusAndZoom(s.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeSurface(s.id) // middle-click closes
            }}
          >
            <span className="sidebar-app-ic">{KIND_ICON[s.kind] ?? '▢'}</span>
            <span className="sidebar-app-label">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
