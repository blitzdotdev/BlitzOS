#!/usr/bin/env node
// compile-widget.mjs — the per-widget compile GATE (the enrichment agent runs this before posting an edit,
// and CI/dev can lint a widget). Uses the EXACT renderer compile core (widget-jsx-core.mjs) + sucrase, so a
// PASS here means the renderer's Sucrase strip will also succeed. SYNTAX/parse only (no type-check, no
// runtime) — the same class the renderer surfaces as props.lastError. Usage: node scripts/compile-widget.mjs <file.jsx|tsx>
import { readFileSync } from 'node:fs'
import { transform } from 'sucrase'
import { compileJsxSource } from '../src/renderer/src/widget-jsx-core.mjs'

const file = process.argv[2]
if (!file) { console.error('usage: node scripts/compile-widget.mjs <file.jsx|tsx>'); process.exit(2) }
const lang = file.endsWith('.tsx') ? 'tsx' : 'jsx'
let src
try { src = readFileSync(file, 'utf8') } catch (e) { console.error('cannot read ' + file + ': ' + (e && e.message)); process.exit(2) }

const r = compileJsxSource(transform, src, lang)
if (r.ok) { console.log('PASS ' + file + ' (' + r.js.length + ' bytes of ESM)'); process.exit(0) }
console.error('FAIL ' + file + '\n  ' + r.error)
process.exit(1)
