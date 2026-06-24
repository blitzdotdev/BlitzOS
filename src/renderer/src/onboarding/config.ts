// Onboarding visibility — flip ONBOARDING_MODE to control when the boot+onboarding flow shows.
//   'always'       — every launch (use this while iterating on the flow)
//   'first-launch' — only until completed once, then never again
//   'off'          — never
export const ONBOARDING_MODE: 'always' | 'first-launch' | 'off' = 'first-launch'

const DONE_KEY = 'blitzos.onboarded.v1'

export function shouldShowOnboarding(): boolean {
  // Server-mode (browser preview): the onboarding flow is entirely Electron-native — FDA/TCC permission
  // grants, the computer-use helper, and the local scan are IPC calls with NO backend routes, so it can't
  // run here (and trying crashes the renderer on the missing IPC). Show the desktop directly.
  try { if ((window as { agentOS?: { serverMode?: boolean } }).agentOS?.serverMode) return false } catch { /* bridge not ready */ }
  if (ONBOARDING_MODE === 'off') return false
  try { if (window.agentOS?.onboarding?.forceVisible) return true } catch { /* bridge not ready */ }
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
