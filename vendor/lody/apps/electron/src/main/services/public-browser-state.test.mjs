import assert from 'node:assert/strict'
import test from 'node:test'
import { isNavigationAbortError, mergePublicBrowserState } from './public-browser-state.ts'

void test('recognizes structured Electron navigation abort errors', () => {
  assert.equal(isNavigationAbortError({ code: 'ERR_ABORTED', errno: -3 }), true)
  assert.equal(isNavigationAbortError({ code: -3 }), true)
  assert.equal(isNavigationAbortError({ errno: -3 }), true)
})

void test('does not hide real or unstructured navigation failures', () => {
  assert.equal(isNavigationAbortError({ code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }), false)
  assert.equal(
    isNavigationAbortError(new Error("ERR_ABORTED (-3) loading 'https://example.com/'")),
    false
  )
})

void test('keeps a requested URL authoritative until Chromium commits the navigation', () => {
  const previous = {
    browserId: 'session-browser-1',
    phase: 'ready',
    url: 'https://old.example/',
    title: 'Old page',
    canGoBack: false,
    canGoForward: false
  }

  const requested = mergePublicBrowserState(
    previous,
    {
      committedUrl: 'https://old.example/',
      committedTitle: 'Old page',
      canGoBack: false,
      canGoForward: false
    },
    { phase: 'loading', url: 'https://new.example/' }
  )
  const loading = mergePublicBrowserState(requested, {
    committedUrl: 'https://old.example/',
    committedTitle: 'Old page',
    canGoBack: false,
    canGoForward: false
  })

  assert.equal(loading.url, 'https://new.example/')
  assert.equal(loading.phase, 'loading')
})

void test('accepts the committed URL from an explicit navigation event', () => {
  const loading = {
    browserId: 'session-browser-1',
    phase: 'loading',
    url: 'https://new.example/',
    title: 'Old page',
    canGoBack: false,
    canGoForward: false
  }

  const committed = mergePublicBrowserState(
    loading,
    {
      committedUrl: 'https://new.example/',
      committedTitle: 'New page',
      canGoBack: true,
      canGoForward: false
    },
    { phase: 'ready', url: 'https://new.example/', title: 'New page' }
  )

  assert.equal(committed.url, 'https://new.example/')
  assert.equal(committed.title, 'New page')
  assert.equal(committed.canGoBack, true)
})
