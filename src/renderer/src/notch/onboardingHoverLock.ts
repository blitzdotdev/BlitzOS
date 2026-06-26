// Hover lock for the onboarding TCC permission step (the screen showing the 3 Mac-access reqs). While that step
// is up, the user drags the BlitzOS icon OUT of the island into System Settings, so the island must NOT open or
// close on hover (a hover-retract would yank it away mid-drag). Only the ⌥Space toggle works during that step.
//
// A module-level boolean (the project's external-store convention) so IslandOnboarding can flip it and App's
// imperative mousemove handler can read it synchronously, with no prop-drilling and no remount fragility.
let locked = false

export function setOnboardingHoverLock(value: boolean): void {
  locked = !!value
}

export function isOnboardingHoverLocked(): boolean {
  return locked
}
