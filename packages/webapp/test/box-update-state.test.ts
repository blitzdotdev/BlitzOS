import { describe, expect, it } from 'vitest';
import type { MachineView } from '@blitzos/schema';
import { boxUpdateStatus } from '../src/box-update-state';

// The whole judgement table. Telling a user "up to date" about a machine that
// is behind, or "update available" about a host that can never install one, is
// worse than telling them nothing — so every branch is named here.

function machine(overrides: Partial<MachineView> = {}): MachineView {
  return {
    id: 'machine-one',
    state: 'running',
    machineTypeId: 'cx23@fsn1',
    volumeId: 'volume-one',
    volumeUsedPercent: 62,
    membershipId: 'membership-1',
    error: null,
    boxImage: 'blitz-box:2026-08-31',
    boxImageTarget: 'blitz-box:2026-08-31',
    boxUpdateRequested: false,
    boxUpdateOutcome: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
    ...overrides,
  };
}

describe('boxUpdateStatus', () => {
  it('offers nothing when there is no machine', () => {
    const status = boxUpdateStatus(null);
    expect(status.kind).toBe('no-machine');
    expect(status.canRequest).toBe(false);
  });

  it('reads a machine on the deployment image as up to date', () => {
    const status = boxUpdateStatus(machine());
    expect(status.kind).toBe('up-to-date');
    expect(status.summary).toBe('Up to date.');
    // Nothing to do, so nothing is offered.
    expect(status.canRequest).toBe(false);
  });

  it('offers the update when the machine runs an older image', () => {
    const status = boxUpdateStatus(machine({ boxImage: 'blitz-box:2026-08-01' }));
    expect(status.kind).toBe('available');
    expect(status.canRequest).toBe(true);
  });

  // The manifest pin is why the comparison is on the concrete image: the ref
  // is byte-identical across rebakes, so comparing refs would read every box
  // as current forever.
  it('compares the concrete image, not the ref', () => {
    const behind = machine({
      boxImage: 'blitz-box:2026-08-01',
      boxImageTarget: 'blitz-box:2026-08-31',
    });
    expect(boxUpdateStatus(behind).kind).toBe('available');
  });

  it('says so plainly when the machine has never reported an image', () => {
    const status = boxUpdateStatus(machine({ boxImage: null }));
    expect(status.kind).toBe('unknown');
    expect(status.summary).toContain('has not reported');
    // Asking is still worth doing: the attempt is what makes it report.
    expect(status.canRequest).toBe(true);
  });

  it('shows a requested update as pending and offers no second click', () => {
    const status = boxUpdateStatus(machine({
      boxImage: 'blitz-box:2026-08-01',
      boxUpdateRequested: true,
    }));
    expect(status.kind).toBe('pending');
    expect(status.summary).toContain('five minutes');
    expect(status.canRequest).toBe(false);
  });

  // Every box created before the manifest updater shipped — which is every
  // pre-existing canary box, blitzos-dev included — lands here after one
  // request. The honest answer is that it can never do this in place.
  it('refuses to offer an update a host reported it cannot do', () => {
    const status = boxUpdateStatus(machine({
      boxImage: 'blitz-box:2026-08-01',
      boxUpdateOutcome: 'unsupported',
    }));
    expect(status.kind).toBe('unsupported');
    expect(status.summary).toContain('cannot update in place');
    expect(status.summary).toContain('Recreate it');
    expect(status.canRequest).toBe(false);
  });

  it('will not offer an update to a machine that is not running', () => {
    const status = boxUpdateStatus(machine({
      state: 'stopped',
      boxImage: 'blitz-box:2026-08-01',
    }));
    expect(status.kind).toBe('not-running');
    expect(status.summary).toContain('stopped');
    expect(status.canRequest).toBe(false);
  });

  // Every acquire failure leaves the container alone, and that is the first
  // thing a worried user wants to know. The update is still on offer, because
  // a failed fetch is worth retrying.
  it.each([
    ['pull-failed', 'could not fetch'],
    ['download-failed', 'could not download'],
    ['digest-mismatch', 'damaged image and refused it'],
    ['load-failed', 'could not load'],
  ] as const)('reports %s as leaving the machine untouched', (outcome, phrase) => {
    const status = boxUpdateStatus(machine({
      boxImage: 'blitz-box:2026-08-01',
      boxUpdateOutcome: outcome,
    }));
    expect(status.kind).toBe('available');
    expect(status.canRequest).toBe(true);
    expect(status.lastAttempt).toContain(phrase);
    expect(status.lastAttempt).toContain('left untouched');
  });

  it('reports a rollback as the machine going back to what it had', () => {
    const status = boxUpdateStatus(machine({
      boxImage: 'blitz-box:2026-08-01',
      boxUpdateOutcome: 'rolled-back',
    }));
    expect(status.lastAttempt).toContain('went back to the one it was running');
    expect(status.canRequest).toBe(true);
  });

  it('tells a user whose machine is down that recreating is the way out', () => {
    const status = boxUpdateStatus(machine({
      boxImage: 'blitz-box:2026-08-01',
      boxUpdateOutcome: 'start-failed',
    }));
    expect(status.lastAttempt).toContain('Recreate the machine');
  });

  // A verdict the state line already carries is not repeated underneath it.
  it.each(['updated', 'up-to-date'] as const)('says nothing extra after %s', (outcome) => {
    expect(boxUpdateStatus(machine({ boxUpdateOutcome: outcome })).lastAttempt).toBeNull();
  });
});
