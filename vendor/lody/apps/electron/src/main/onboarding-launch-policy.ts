export type InitialDesktopPath = '/' | '/onboarding'

export function resolveInitialDesktopPath(input: {
  isPackaged: boolean
  onboardingCompleted: boolean
  forceOnboarding: boolean
}): InitialDesktopPath {
  if (input.forceOnboarding) return '/onboarding'
  if (!input.isPackaged) return '/'
  return input.onboardingCompleted ? '/' : '/onboarding'
}
