import { atom } from 'jotai';
import type { CameraShot } from './tour/camera';

/** Camera targets that exist in the real product fixture. */
export const ONBOARDING_DEBUG_ANCHORS = [
  'window',
  'sidebar',
  'sidebar.workspace-name',
  'stream',
  'composer',
  'composer.run-config',
  'permission',
  'tab-bar',
  'info-bar',
  'side-panel',
  'terminal',
  'studio',
  'phone',
] as const;

export type OnboardingDebugState = {
  /** Null means the current screen's authored anchor remains active. */
  anchor: string | null;
  /** Null means the authored value remains active. */
  zoom: number | null;
  padding: number | null;
  focusX: number | null;
  focusY: number | null;
  showAnchors: boolean;
};

export const DEFAULT_ONBOARDING_DEBUG_STATE: OnboardingDebugState = {
  anchor: null,
  zoom: null,
  padding: null,
  focusX: null,
  focusY: null,
  showAnchors: false,
};

/** Shared by the real overlay and the dev-only inspector. */
export const onboardingDebugAtom = atom<OnboardingDebugState>(DEFAULT_ONBOARDING_DEBUG_STATE);

export function applyOnboardingDebugShot(
  shot: CameraShot,
  debug: OnboardingDebugState
): CameraShot {
  return {
    ...shot,
    ...(debug.anchor === null ? {} : { anchor: debug.anchor }),
    ...(debug.zoom === null ? {} : { zoom: debug.zoom }),
    ...(debug.padding === null ? {} : { padding: debug.padding }),
    ...(debug.focusX === null ? {} : { focusX: debug.focusX }),
    ...(debug.focusY === null ? {} : { focusY: debug.focusY }),
  };
}
