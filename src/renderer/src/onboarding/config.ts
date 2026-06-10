// Onboarding visibility — flip ONBOARDING_MODE to control when the boot+onboarding flow shows.
//   'always'       — every launch (use this while iterating on the flow)
//   'first-launch' — only until completed once, then never again
//   'off'          — never
export const ONBOARDING_MODE: 'always' | 'first-launch' | 'off' = 'always'

const DONE_KEY = 'blitzos.onboarded.v1'

export function shouldShowOnboarding(): boolean {
  if (ONBOARDING_MODE === 'off') return false
  if (ONBOARDING_MODE === 'always') return true
  try {
    return localStorage.getItem(DONE_KEY) !== '1'
  } catch {
    return true
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(DONE_KEY, '1')
  } catch {
    /* private mode / storage disabled — onboarding just shows again next launch */
  }
}
