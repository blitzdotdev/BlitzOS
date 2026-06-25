// Reference JSX widget — a KPI with a sparkline (recharts). Fork for the LOOK: accent kicker, one
// big hero number, a delta, an area sparkline bleeding off the bottom. Tokens only (no hardcoded hex).
// SVG gotcha: recharts colors are SVG attributes — CSS vars DON'T resolve there, so read the themed
// accent via getComputedStyle and pass the concrete value.
// props: { kicker, value, delta, up?, series?:number[] }
import React from 'react'
import { AreaChart, Area, ResponsiveContainer } from 'recharts'
export default function KpiSpark(){
  const p = (window.blitz && blitz.props && blitz.props()) || {}
  const kicker = p.kicker || 'Revenue · 30d', value = p.value || '$48.2k', delta = p.delta || '12.4%'
  const up = p.up !== false
  const series = (Array.isArray(p.series) && p.series.length ? p.series : [40,46,42,58,53,71,66,85,80,97]).map((v,i)=>({i,v}))
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--blitz-accent') || '#e31c30').trim()
  return (
    <div style={{position:'relative',height:'100%',display:'flex',flexDirection:'column',padding:'18px 18px 0',boxSizing:'border-box',overflow:'hidden'}}>
      <div style={{font:'600 9px ui-monospace,monospace',letterSpacing:'.18em',textTransform:'uppercase',color:'var(--blitz-accent)'}}>{kicker}</div>
      <div style={{display:'flex',alignItems:'baseline',gap:9,marginTop:9}}>
        <div style={{fontSize:34,fontWeight:700,letterSpacing:'-.03em',lineHeight:1,fontVariantNumeric:'tabular-nums'}}>{value}</div>
        <div style={{fontSize:12,fontWeight:600,color:up?'#16a34a':'#dc2626'}}>{up?'▲':'▼'} {delta}</div>
      </div>
      <div style={{position:'absolute',left:0,right:0,bottom:0,height:'46%'}}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{top:2,right:0,bottom:0,left:0}}>
            <defs><linearGradient id="kspk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accent} stopOpacity={0.3}/><stop offset="100%" stopColor={accent} stopOpacity={0}/>
            </linearGradient></defs>
            <Area type="monotone" dataKey="v" stroke={accent} strokeWidth={2.5} fill="url(#kspk)"/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
