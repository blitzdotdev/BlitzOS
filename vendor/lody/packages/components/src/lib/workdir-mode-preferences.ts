import type { LocalProjectId } from '@lody/shared';
import type { WorkdirMode } from '@/components/shared/workdir-mode-selector';

const GLOBAL_WORKDIR_MODE_KEY = 'lody.workdirMode.global';
const projectWorkdirModeKey = (localProjectId: LocalProjectId) =>
  `lody.workdirMode.byProject.${localProjectId}`;

const parseWorkdirMode = (value: string | null): WorkdirMode | null => {
  return value === 'local' || value === 'worktree' ? value : null;
};

export function readWorkdirModePreference(localProjectId: LocalProjectId): WorkdirMode {
  if (typeof window === 'undefined') return 'local';
  const projectMode = parseWorkdirMode(localStorage.getItem(projectWorkdirModeKey(localProjectId)));
  if (projectMode) return projectMode;
  return parseWorkdirMode(localStorage.getItem(GLOBAL_WORKDIR_MODE_KEY)) ?? 'local';
}

export function writeWorkdirModePreference(
  localProjectId: LocalProjectId,
  mode: WorkdirMode
): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(projectWorkdirModeKey(localProjectId), mode);
  } catch {
    // Local preference only; ignore quota/privacy failures.
  }
}
