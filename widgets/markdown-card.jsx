// Reference JSX widget — a styled markdown card (react-markdown + remark-gfm). Fork for the LOOK:
// map markdown elements to the OS type scale (an h2 becomes the accent kicker) so prose matches the OS.
// Tokens only. props: { markdown }
import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
const KICK = { font:'600 9px ui-monospace,monospace', letterSpacing:'.18em', textTransform:'uppercase', color:'var(--blitz-accent)', marginBottom:10 }
const COMPONENTS = {
  h2: ({ children }) => <div style={KICK}>{children}</div>,
  h1: ({ children }) => <div style={KICK}>{children}</div>,
  p: ({ children }) => <p style={{ margin:'0 0 10px', fontSize:13, lineHeight:1.55 }}>{children}</p>,
  ul: ({ children }) => <ul style={{ margin:0, paddingLeft:15, fontSize:12.5, lineHeight:1.75 }}>{children}</ul>,
  del: ({ children }) => <del style={{ color:'var(--blitz-text-dim)' }}>{children}</del>,
  a: ({ children, href }) => <a href={href} style={{ color:'var(--blitz-accent)' }}>{children}</a>
}
export default function MarkdownCard(){
  const p = (window.blitz && blitz.props && blitz.props()) || {}
  const md = p.markdown || '## Release 0.2\n\nShipped **JSX widgets** — React at runtime.\n\n- charts, springs, markdown\n- ~~build step~~ zero build\n- forkable single file'
  return (
    <div style={{ height:'100%', padding:'16px 18px', boxSizing:'border-box', overflow:'auto', color:'var(--blitz-text)' }}>
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{md}</Markdown>
    </div>
  )
}
