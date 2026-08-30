import { jotaiStore } from '@/lib/utils';
import { desktopOnboardingPhaseAtom, type DesktopOnboardingResumePhase } from '@/atoms/onboarding';

// A debug handle for driving the first-run flow on demand.
//
// Packaged startup gating belongs to Electron's main process. This handle is
// only a renderer-side phase driver for an onboarding route that is already
// open; it does not write the native completion marker.
//
// So the reset is a supported operation rather than a trick. Same pattern as
// the Code Collab and presence debug globals already declared in
// `window-globals.d.ts`.
//
//   lodyOnboarding.status()       // where am I?
//   lodyOnboarding.restart()      // replay from the ceremony
//   lodyOnboarding.goto('providers')
//   lodyOnboarding.finish()       // clear the renderer phase

export type OnboardingDevApi = {
  status: () => { phase: DesktopOnboardingResumePhase | null };
  restart: (phase?: DesktopOnboardingResumePhase) => void;
  goto: (phase: DesktopOnboardingResumePhase) => void;
  finish: () => void;
  phases: readonly DesktopOnboardingResumePhase[];
};

const PHASES = [
  'ceremony',
  'login',
  'workspace',
  'providers',
  'projects',
  'firstTask',
  'summary',
] as const satisfies readonly DesktopOnboardingResumePhase[];

function makeApi(): OnboardingDevApi {
  return {
    phases: PHASES,
    status: () => ({
      phase: jotaiStore.get(desktopOnboardingPhaseAtom),
    }),
    restart: (phase = 'ceremony') => {
      jotaiStore.set(desktopOnboardingPhaseAtom, phase);
    },
    goto: (phase) => {
      jotaiStore.set(desktopOnboardingPhaseAtom, phase);
    },
    finish: () => {
      jotaiStore.set(desktopOnboardingPhaseAtom, null);
    },
  };
}

/**
 * Installs the handle. Called from the module that gates the overlay, so it is
 * available whether or not the overlay is currently mounted — which is the
 * whole point, since the usual reason to reach for it is that onboarding has
 * been marked complete and will not mount.
 */
export function installOnboardingDevApi(): void {
  if (typeof window === 'undefined') return;
  // Assigned through a local cast rather than the ambient `Window` declaration:
  // this module is compiled by the Electron app too, and its tsconfig does not
  // pick up this package's global declarations.
  (window as unknown as { lodyOnboarding?: OnboardingDevApi }).lodyOnboarding = makeApi();
}
