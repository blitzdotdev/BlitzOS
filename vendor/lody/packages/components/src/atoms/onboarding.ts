import { atomWithStorage } from 'jotai/utils';
import type { LocalProjectId, MachineId } from '@lody/shared';

export type DesktopOnboardingResumePhase =
  | 'ceremony'
  | 'login'
  | 'workspace'
  | 'providers'
  | 'projects'
  | 'firstTask'
  | 'summary';

export type DesktopOnboardingProjectSelection =
  | {
      kind: 'local';
      machineId: MachineId;
      localProjectId: LocalProjectId;
      name: string;
    }
  | {
      kind: 'github';
      repoFullName: string;
      name: string;
    };

export interface DesktopOnboardingDraft {
  agentConfigId: string | null;
  project: DesktopOnboardingProjectSelection | null;
}

/**
 * Last reached phase in the onboarding flow. Persisted so reload / external
 * redirect (GitHub install, OAuth) returns the user to the same screen.
 * `null` means the flow has not begun.
 */
export const desktopOnboardingPhaseAtom = atomWithStorage<DesktopOnboardingResumePhase | null>(
  'lody-desktop-onboarding-phase',
  null
);

export const desktopOnboardingDraftAtom = atomWithStorage<DesktopOnboardingDraft>(
  'lody-desktop-onboarding-draft',
  { agentConfigId: null, project: null }
);
