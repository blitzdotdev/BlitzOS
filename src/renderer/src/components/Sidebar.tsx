import { useDesktop } from '../store'
import { IconPlus, KindIcon } from './Icons'

interface Props {
  onAddBrowser: () => void
}

/** Left dock: + to add a browser, then an icon per open surface. Click to bring it forward at real size. */
export function Sidebar({ onAddBrowser }: Props): JSX.Element {
  const surfaces = useDesktop((s) => s.surfaces)
  const focusAndZoom = useDesktop((s) => s.focusAndZoom)
  const closeSurface = useDesktop((s) => s.closeSurface)
  const updateSurface = useDesktop((s) => s.updateSurface)

  return (
    <div className="sidebar">
      <button className="sidebar-btn" title="New browser window" onClick={onAddBrowser}>
        <IconPlus />
      </button>
      {surfaces.length > 0 && <div className="sidebar-sep" />}
      <div className="sidebar-apps">
        {surfaces.map((s) => (
          <button
            key={s.id}
            className="sidebar-app"
            title={`${s.title}${s.minimized ? ' (minimized)' : ''} — click to bring forward`}
            style={{ opacity: s.minimized ? 0.5 : 1 }}
            onClick={() => {
              if (s.minimized) updateSurface(s.id, { minimized: false })
              focusAndZoom(s.id)
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeSurface(s.id) // middle-click closes
            }}
          >
            <span className="sidebar-app-ic">
              <KindIcon kind={s.kind} />
            </span>
            <span className="sidebar-app-label">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
