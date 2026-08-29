import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveInitialDesktopPath } from './onboarding-launch-policy.ts'

void test('keeps ordinary development launches on the product surface', () => {
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: false,
      onboardingCompleted: false,
      forceOnboarding: false
    }),
    '/'
  )
})

void test('opens onboarding for incomplete packaged installs', () => {
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: true,
      onboardingCompleted: false,
      forceOnboarding: false
    }),
    '/onboarding'
  )
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: true,
      onboardingCompleted: true,
      forceOnboarding: false
    }),
    '/'
  )
})

void test('allows isolated E2E and design runs to force onboarding', () => {
  assert.equal(
    resolveInitialDesktopPath({
      isPackaged: false,
      onboardingCompleted: true,
      forceOnboarding: true
    }),
    '/onboarding'
  )
})
