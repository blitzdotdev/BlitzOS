#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../..', import.meta.url).pathname
const source = readFileSync(join(root, 'src/main/onboarding.ts'), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true
  }
}).outputText

const module = { exports: {} }
const require = (id) => {
  if (id === 'electron') return { app: { getAppPath: () => root, getName: () => 'BlitzOS' }, ipcMain: {}, shell: {} }
  if (id === 'node:child_process') return { execFileSync: () => '', spawn: () => ({ stderr: { on() {} }, on() {} }) }
  if (id === './osActions') {
    return {
      osCreateSurface: () => 'surface-id',
      osUpdateSurface() {},
      osCloseSurface() {},
      osCreateWorkspace() {},
      osSwitchWorkspace() {},
      osWorkspaceContext: () => ({ workspace_path: tmpdir() }),
      osGoToPrimary() {},
      osSay() {},
      osGetState: () => ({ surfaces: [] }),
      osKickBrain() {},
      osRestartBrain() {},
      osClearBrainContext() {}
    }
  }
  if (id === './computer-use-helper') return { computerUseHelper: () => ({}) }
  if (id === './browser-import') return { importGoogleSignin: () => {}, importSources: () => {} }
  if (id === './widget-catalog.mjs') return { getWidgetSource: () => ({ html: '<div></div>' }) }
  if (id === './onboarding-board.mjs') {
    return {
      buildBoardPlan: () => [],
      unlockCardProps: () => ({}),
      findUnlockSlot: () => null,
      BRANCH_A_LAYOUT: {}
    }
  }
  return requireActual(id)
}
const requireActual = await import('node:module').then(({ createRequire }) => createRequire(import.meta.url))

vm.runInNewContext(compiled, { exports: module.exports, module, require, process, Buffer, console, setInterval, clearInterval, setTimeout }, { filename: 'onboarding.ts' })

const { replaceRestartAnchor, refreshRestartAnchor } = module.exports

const anchorA = ['## Restart anchor', '', '- Scope: A'].join('\n')
const anchorB = ['## Restart anchor', '', '- Scope: B'].join('\n')
assert.equal(
  replaceRestartAnchor('# Notepad\n\nHuman text', anchorA),
  '# Notepad\n\nHuman text\n\n## Restart anchor\n\n- Scope: A'
)
assert.equal(
  replaceRestartAnchor(`# Notepad\n\nHuman text\n\n${anchorA}\n\n## Other\n\nKeep me`, anchorB),
  '# Notepad\n\nHuman text\n\n## Restart anchor\n\n- Scope: B\n\n## Other\n\nKeep me'
)

const ws = mkdtempSync(join(tmpdir(), 'blitzos-onboarding-anchor-'))
try {
  const dir = join(ws, '.blitzos/onboarding')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(ws, 'notepad.md'), '# Notepad\n\nHuman note')
  writeFileSync(join(dir, 'profile.md'), [
    '# Profile',
    '',
    '- Scope: Agent OS testing',
    '- Autonomy: Reversible checks can proceed.',
    '- Confirmation boundary: Ask before account writes.',
    '- Current priority: Make onboarding reliable.'
  ].join('\n'))
  refreshRestartAnchor(ws)
  const updated = readFileSync(join(ws, 'notepad.md'), 'utf8')
  assert.match(updated, /Human note/)
  assert.match(updated, /- Scope: Agent OS testing/)
  assert.match(updated, /- Autonomy: Reversible checks can proceed\./)
  assert.match(updated, /- Confirm before: Ask before account writes\./)
  assert.match(updated, /- Priority: Make onboarding reliable\./)
  // The active initiative is intentionally NOT persisted, so the anchor must not carry it.
  assert.doesNotMatch(updated, /Active initiative/)
  assert.doesNotMatch(updated, /Next reversible action/)

  refreshRestartAnchor(ws)
  const second = readFileSync(join(ws, 'notepad.md'), 'utf8')
  assert.equal((second.match(/## Restart anchor/g) || []).length, 1)
} finally {
  rmSync(ws, { recursive: true, force: true })
}

console.log('onboarding restart anchor regression passed')
