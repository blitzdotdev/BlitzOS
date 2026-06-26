// Reference JSX widget — a labelled status list (lucide-react). Fork for the LOOK: accent kicker,
// hairline-separated rows, an icon + label + bold value each, no boxes. Tokens only.
// SVG gotcha: lucide draws with stroke="currentColor", so theme an icon by setting CSS color (style),
// NOT the `color`/`stroke` attribute (a CSS var in an SVG attr won't resolve).
// props: { kicker, rows?:[{icon?:'activity'|'database'|'globe'|'sync'|'cpu'|'check', label, value }] }
import React from 'react'
import { Activity, Database, Globe, RefreshCw, Cpu, CheckCircle2 } from 'lucide-react'
const ICONS = { activity: Activity, database: Database, globe: Globe, sync: RefreshCw, cpu: Cpu, check: CheckCircle2 }
export default function StatusList(){
  const p = (window.blitz && blitz.props && blitz.props()) || {}
  const rows = Array.isArray(p.rows) && p.rows.length ? p.rows : [
    { icon: 'cpu', label: 'CPU load', value: '42%' },
    { icon: 'database', label: 'Database', value: 'Healthy' },
    { icon: 'globe', label: 'Network', value: '1.2 Gb/s' },
    { icon: 'sync', label: 'Sync', value: 'Live' }
  ]
  return (
    <div style={{height:'100%',display:'flex',flexDirection:'column',padding:'16px 18px',boxSizing:'border-box'}}>
      <div style={{font:'600 9px ui-monospace,monospace',letterSpacing:'.18em',textTransform:'uppercase',color:'var(--blitz-accent)',marginBottom:4}}>{p.kicker || 'System'}</div>
      <div style={{display:'flex',flexDirection:'column',flex:1}}>
        {rows.map((r, i) => {
          const I = ICONS[r.icon] || Activity
          return (
            <div key={i} style={{display:'flex',alignItems:'center',gap:11,flex:1,borderTop:i?'1px solid var(--blitz-hairline)':'none'}}>
              <I size={16} strokeWidth={2} style={{color:'var(--blitz-accent)',flex:'0 0 auto'}}/>
              <div style={{flex:1,fontSize:12.5}}>{r.label}</div>
              <div style={{fontSize:12.5,fontWeight:700,letterSpacing:'-.01em',fontVariantNumeric:'tabular-nums'}}>{r.value}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
