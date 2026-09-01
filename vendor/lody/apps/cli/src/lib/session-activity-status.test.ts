import { describe, expect, it } from 'vitest';
import { SessionStatusFactory } from '@lody/shared';

import {
  resolveImageGenerationStatusWrite,
  shouldRestoreRunningAfterPermission,
} from './session-activity-status';

describe('resolveImageGenerationStatusWrite', () => {
  it('marks image generation while active presence is live', () => {
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: true,
        hasActivePresence: true,
        status: SessionStatusFactory.running(),
      })
    ).toEqual(SessionStatusFactory.running('image_generation'));
  });

  it('never writes a working status without active presence', () => {
    // The status chain rides on ACP events and can drain after the turn scope
    // released active presence; meta must not stay stuck non-idle.
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: true,
        hasActivePresence: false,
        status: SessionStatusFactory.running(),
      })
    ).toBeNull();
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: false,
        hasActivePresence: false,
        status: SessionStatusFactory.running('image_generation'),
      })
    ).toBeNull();
  });

  it('does not override a permission request', () => {
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: true,
        hasActivePresence: true,
        status: SessionStatusFactory.requestPermission(),
      })
    ).toBeNull();
  });

  it('does not resurrect an idle session while finalization still owns presence', () => {
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: true,
        hasActivePresence: true,
        status: SessionStatusFactory.idle(),
      })
    ).toBeNull();
  });

  it('restores plain running only from the image-generation activity', () => {
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: false,
        hasActivePresence: true,
        status: SessionStatusFactory.running('image_generation'),
      })
    ).toEqual(SessionStatusFactory.running());
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: false,
        hasActivePresence: true,
        status: SessionStatusFactory.running(),
      })
    ).toBeNull();
    expect(
      resolveImageGenerationStatusWrite({
        hasActiveImageGeneration: false,
        hasActivePresence: true,
        status: SessionStatusFactory.idle(),
      })
    ).toBeNull();
  });
});

describe('shouldRestoreRunningAfterPermission', () => {
  it('restores running while active presence is live', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.requestPermission(),
      })
    ).toBe(true);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.running(),
      })
    ).toBe(true);
  });

  it('never restores running without active presence', () => {
    // Permission resolution arrives via a mirror subscription and can fire
    // after the turn ended (e.g. cancelled or crashed while waiting).
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: false,
        status: SessionStatusFactory.requestPermission(),
      })
    ).toBe(false);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: false,
        status: 'unknown',
      })
    ).toBe(false);
  });

  it('does not resurrect an idle session', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: SessionStatusFactory.idle(),
      })
    ).toBe(false);
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: undefined,
      })
    ).toBe(false);
  });

  it('defaults to restoring when the doc cannot report a status', () => {
    expect(
      shouldRestoreRunningAfterPermission({
        hasActivePresence: true,
        status: 'unknown',
      })
    ).toBe(true);
  });
});
