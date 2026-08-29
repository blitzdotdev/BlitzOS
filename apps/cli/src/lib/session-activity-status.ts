import { SessionStatusFactory, type SessionStatus } from '@lody/shared';

/**
 * Decisions for async, post-hoc session status writes that run outside the
 * visible active scope (Codex image-generation activity sync, permission
 * resolution restore). These callbacks can fire after the turn ended and its
 * active presence was cleared; without active presence a working-status write
 * is a lie — the presence entry cannot be kept alive while meta status stays
 * stuck non-idle.
 *
 * Rule: never write a working status without active presence. Stuck statuses
 * left behind by crashes are the dispatch watcher's stale-status recovery job,
 * not these callbacks'.
 */

/**
 * What (if anything) the Codex image-generation activity sync should write.
 * Returns the status to write, or null to leave the status untouched.
 */
export const resolveImageGenerationStatusWrite = (input: {
  hasActiveImageGeneration: boolean;
  hasActivePresence: boolean;
  status: SessionStatus | undefined;
}): SessionStatus | null => {
  if (!input.hasActivePresence) {
    return null;
  }
  if (input.status?.type === 'idle') {
    return null;
  }
  if (input.hasActiveImageGeneration) {
    if (input.status?.type === 'requestPermission') {
      return null;
    }
    return SessionStatusFactory.running('image_generation');
  }
  if (input.status?.type === 'running' && input.status.activity === 'image_generation') {
    return SessionStatusFactory.running();
  }
  return null;
};

/**
 * Whether permission resolution should restore `running` status.
 * `status: 'unknown'` means the doc could not report a status (test doubles);
 * historically that defaulted to restoring, but only active presence makes
 * the restored status sustainable.
 */
export const shouldRestoreRunningAfterPermission = (input: {
  hasActivePresence: boolean;
  status: SessionStatus | undefined | 'unknown';
}): boolean => {
  if (!input.hasActivePresence) {
    return false;
  }
  if (input.status === 'unknown') {
    return true;
  }
  return input.status?.type === 'requestPermission' || input.status?.type === 'running';
};
