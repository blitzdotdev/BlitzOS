import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyResolvedWindowTheme,
  getInitialMainWindowThemeSource,
  getMainWindowBackgroundColor,
  getMainWindowTitleBarOverlay,
  resolveNativeWindowTheme
} from './window-theme.ts'

void test('forces onboarding window chrome light until the product takes over', () => {
  assert.equal(getInitialMainWindowThemeSource('/onboarding'), 'light')
  assert.equal(getInitialMainWindowThemeSource('/'), 'system')
  assert.equal(getInitialMainWindowThemeSource(), 'system')
})

void test('maps Electron shouldUseDarkColors onto the resolved window theme', () => {
  assert.equal(resolveNativeWindowTheme(true), 'dark')
  assert.equal(resolveNativeWindowTheme(false), 'light')
})

void test('retints window chrome when the OS appearance changes', () => {
  const calls = []
  const window = {
    setBackgroundColor: (color) => {
      calls.push(['background', color])
    },
    setTitleBarOverlay: (overlay) => {
      calls.push(['overlay', overlay])
    }
  }

  applyResolvedWindowTheme(window, 'dark', 'darwin')
  assert.deepEqual(calls, [['background', getMainWindowBackgroundColor('dark')]])

  calls.length = 0
  applyResolvedWindowTheme(window, 'light', 'win32')
  assert.deepEqual(calls, [
    ['background', getMainWindowBackgroundColor('light')],
    ['overlay', getMainWindowTitleBarOverlay('light')]
  ])
})
