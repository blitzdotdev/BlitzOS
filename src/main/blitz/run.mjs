#!/usr/bin/env node
// blitzscript runner — `blitz run <workflow.mjs>`.
//
// Runs an agent-authored workflow file as plain Node (NO sandbox, full machine access) with the
// three env vars the workflow + llm() rely on, and streams the workflow's stdout straight through
// (its stdout IS the result — RLM's FINAL). There is intentionally NO depth gate here: the leaf is
// TOLD its depth via llm()'s appended metadata; main never refuses recursion (see the plan).
//
//   BLITZ_WS       workspace root      (default: cwd)
//   BLITZ_MEM_DIR  this run's memory   (<ws>/.blitzos/workflows/<id>/, mkdir -p) — RLM "data on disk"
//   BLITZ_DEPTH    0 at the root run   (llm() increments it to 1 on the child env per leaf)

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const [, , sub, ...rest] = process.argv

// `blitz capabilities` — probe THIS machine for the harness/model/effort matrix the orchestrator
// agent needs to author llm() calls (which CLIs are installed + their models/effort). See capabilities.mjs.
if (sub === 'capabilities' || sub === 'caps') {
  const { capabilities, formatCapabilities } = await import('./capabilities.mjs')
  console.log(formatCapabilities(await capabilities()))
  process.exit(0)
}

// `blitz check <workflow.mjs>` — tsc-style validation: syntax + a DRY RUN (llm() returns fallbacks,
// no real spawns) catching runtime errors + infinite loops, BEFORE spending real llm calls. See check.mjs.
if (sub === 'check') {
  if (rest.length === 0) { console.error('usage: blitz check <workflow.mjs>'); process.exit(2) }
  const { check, formatCheck } = await import('./check.mjs')
  const report = await check(rest[0])
  console.log(formatCheck(report))
  process.exit(report.ok ? 0 : 1)
}

if (sub !== 'run' || rest.length === 0) {
  console.error('usage: blitz run <workflow.mjs> [args…]\n       blitz check <workflow.mjs>\n       blitz capabilities')
  process.exit(2)
}

const workflow = resolve(rest[0])
const ws = process.env.BLITZ_WS || process.cwd()
// One memory dir per run. The id is the workflow basename + a short timestamp so re-runs don't
// collide; it stays greppable/resumable on disk under the workspace.
const id = `${rest[0].split('/').pop().replace(/\.[^.]+$/, '')}-${Date.now().toString(36)}`
const memDir = process.env.BLITZ_MEM_DIR || join(ws, '.blitzos', 'workflows', id)
mkdirSync(memDir, { recursive: true })

const child = spawn(process.execPath, [workflow, ...rest.slice(1)], {
  stdio: 'inherit', // stream the workflow's stdout/stderr through; its stdout is the result
  env: { ...process.env, BLITZ_WS: ws, BLITZ_MEM_DIR: memDir, BLITZ_DEPTH: '0' },
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
child.on('error', (e) => { console.error(`blitz run: ${e.message}`); process.exit(1) })
