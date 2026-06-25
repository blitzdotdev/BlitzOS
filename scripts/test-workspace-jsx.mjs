// Restart-survival for jsx/tsx widgets: the real writeWorkspace → readWorkspace boot path. A jsx surface
// must serialize to a .jsx content file (not .html) and rehydrate with lang:"jsx" + props; a loose .jsx
// dropped into a workspace folder must auto-surface as a srcdoc widget (autoKind).
//   node scripts/test-workspace-jsx.mjs
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeWorkspace, readWorkspace, reconcileWorkspace } from '../src/main/workspace.mjs'

const dir = mkdtempSync(join(tmpdir(), 'ws-jsx-'))
let fails = 0
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++ }
const SRC = "import React from 'react'\nexport default function Clock(){ return <div>hi</div> }"

const surf = { id: 'abc-1', kind: 'srcdoc', lang: 'jsx', title: 'My Clock', html: SRC, x: 0, y: 0, w: 320, h: 200, z: 1, props: { format: '12h' } }
writeWorkspace(dir, { surfaces: [surf], camera: { x: 0, y: 0, scale: 1 }, mode: 'desktop' })
const jsxFile = readdirSync(dir).find((f) => f.endsWith('.jsx'))
ok(!!jsxFile, 'jsx surface → a .jsx content file (not .html): ' + jsxFile)
ok(jsxFile && readFileSync(join(dir, jsxFile), 'utf8').includes('export default function Clock'), '.jsx holds the source verbatim')

const back = (readWorkspace(dir)?.surfaces || []).find((s) => s.id === 'abc-1')
ok(!!back, 'surface rehydrates from disk')
ok(back && back.kind === 'srcdoc' && back.lang === 'jsx', 'rehydrated kind:srcdoc lang:jsx → ' + (back && back.kind) + '/' + (back && back.lang))
ok(back && back.html && back.html.includes('export default function Clock'), 'rehydrated html = the JSX source')
ok(back && back.props && back.props.format === '12h', 'rehydrated props survive (format=12h)')

writeFileSync(join(dir, 'dropped.jsx'), 'export default () => <b>dropped</b>')
const dropped = (reconcileWorkspace(dir, { cx: 0, cy: 0 })?.surfaces || []).find((s) => s.html && s.html.includes('dropped'))
ok(dropped && dropped.kind === 'srcdoc' && dropped.lang === 'jsx', 'a loose .jsx auto-surfaces as srcdoc lang:jsx')

console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS')
process.exit(fails ? 1 : 0)
