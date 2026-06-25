// Reference JSX widget — an animated metric (framer-motion). Fork for the LOOK: a number that springs
// up on mount, a token-accent progress bar, a delta. Tokens only. (div backgrounds/widths CAN use
// var(--blitz-accent) directly — the SVG-attr gotcha only applies to <svg> fills/strokes.)
// props: { kicker, value (number), target?, delta?, up? }
import React, { useEffect } from 'react'
import { motion, useSpring, useTransform } from 'framer-motion'
export default function KpiCounter(){
  const p = (window.blitz && blitz.props && blitz.props()) || {}
  const target = Number(p.value != null ? p.value : 2847)
  const cap = Number(p.target || Math.max(target * 1.15, 1))
  const v = useSpring(0, { stiffness: 48, damping: 18 })
  const n = useTransform(v, (x) => Math.round(x).toLocaleString())
  const w = useTransform(v, (x) => Math.min(100, (x / cap) * 100) + '%')
  useEffect(() => { v.set(target) }, [target])
  return (
    <div style={{height:'100%',display:'flex',flexDirection:'column',justifyContent:'center',gap:11,padding:'0 20px',boxSizing:'border-box'}}>
      <div style={{font:'600 9px ui-monospace,monospace',letterSpacing:'.18em',textTransform:'uppercase',color:'var(--blitz-accent)'}}>{p.kicker || 'Signups · 30d'}</div>
      <motion.div style={{fontSize:44,fontWeight:700,letterSpacing:'-.03em',lineHeight:1,fontVariantNumeric:'tabular-nums'}}>{n}</motion.div>
      <div style={{height:5,borderRadius:5,background:'var(--blitz-hairline)',overflow:'hidden'}}>
        <motion.div style={{height:'100%',width:w,background:'var(--blitz-accent)'}}/>
      </div>
      {p.delta && <div style={{fontSize:11,color:'var(--blitz-text-dim)'}}><span style={{color:p.up===false?'#dc2626':'#16a34a',fontWeight:600}}>{p.up===false?'▼':'▲'} {p.delta}</span> vs last month</div>}
    </div>
  )
}
