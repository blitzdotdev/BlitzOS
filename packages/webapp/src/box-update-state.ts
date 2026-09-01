import type { BoxUpdateOutcome, MachineView } from '@blitzos/schema';

/**
 * What the My machine dialog can honestly say about a machine's box image.
 *
 * Kept out of the component because the interesting part is the judgement, not
 * the markup: a machine can be up to date, behind, unable to update at all, or
 * simply unknown, and telling a user the wrong one of those is worse than
 * telling them nothing. It is pure, so `test/box-update-state.test.ts` covers
 * the whole table without rendering anything.
 */
export type BoxUpdateKind =
  /** No machine row, so there is nothing to update. */
  | 'no-machine'
  /** An update is requested and the host has not reported back yet. */
  | 'pending'
  /** This machine's host updater predates the manifest branch and reported
   * `unsupported`. It can never install this deployment's image in place. */
  | 'unsupported'
  /** The machine is not running, so replacing its container is not on offer. */
  | 'not-running'
  /** The machine has never reported an image, so the comparison has no answer. */
  | 'unknown'
  | 'up-to-date'
  | 'available';

export interface BoxUpdateStatus {
  kind: BoxUpdateKind;
  /** The one-line summary shown beside the button. */
  summary: string;
  /** What the last attempt did, when the state above does not already say it.
   * Null when there was no attempt, or when it told us nothing new. */
  lastAttempt: string | null;
  /** Whether asking for an update now could accomplish anything. */
  canRequest: boolean;
}

/**
 * What the host's last verdict means for the person reading it.
 *
 * Only the outcomes that leave something worth saying return a sentence.
 * `updated`, `up-to-date` and `unsupported` are already carried by the kind,
 * so repeating them under the status line would just be noise.
 *
 * Every acquire failure says the machine was left alone, because that is the
 * updater's invariant and it is the thing a worried user wants to know first.
 */
function lastAttemptSentence(outcome: BoxUpdateOutcome | null): string | null {
  switch (outcome) {
    case 'rolled-back':
      return 'The last attempt could not start the new image, so your machine went back to the one it was running.';
    case 'start-failed':
      return 'The last attempt left no container running. Recreate the machine if it is still down.';
    case 'pull-failed':
      return 'The last attempt could not fetch the new image. Your machine was left untouched.';
    case 'download-failed':
      return 'The last attempt could not download the new image. Your machine was left untouched.';
    case 'digest-mismatch':
      return 'The last attempt downloaded a damaged image and refused it. Your machine was left untouched.';
    case 'load-failed':
      return 'The last attempt could not load the new image. Your machine was left untouched.';
    default:
      return null;
  }
}

export function boxUpdateStatus(machine: MachineView | null): BoxUpdateStatus {
  if (machine === null) {
    return {
      kind: 'no-machine',
      summary: 'You have no machine yet.',
      lastAttempt: null,
      canRequest: false,
    };
  }
  const lastAttempt = lastAttemptSentence(machine.boxUpdateOutcome);

  // Pending outranks everything: an update is already on its way, and the
  // image the row still reports is the one it is on its way from.
  if (machine.boxUpdateRequested) {
    return {
      kind: 'pending',
      summary: 'Update requested. Your machine picks it up within five minutes and restarts.',
      lastAttempt: null,
      canRequest: false,
    };
  }
  // A host that answered `unsupported` will answer it again. Saying "update
  // available" and handing over a button that cannot work would be a lie, and
  // this covers every box created before the manifest updater shipped.
  if (machine.boxUpdateOutcome === 'unsupported') {
    return {
      kind: 'unsupported',
      summary: 'This machine’s host cannot update in place. Recreate it to move to the new image.',
      lastAttempt: null,
      canRequest: false,
    };
  }
  if (machine.state !== 'running') {
    return {
      kind: 'not-running',
      summary: `A machine that is ${machine.state} cannot update. Start it first.`,
      lastAttempt,
      canRequest: false,
    };
  }
  // Never reported. Asking is still worth doing — the attempt is what makes
  // the machine report — but the answer is not known yet, and guessing
  // "up to date" here is how a stale box looks current forever.
  if (machine.boxImage === null) {
    return {
      kind: 'unknown',
      summary: 'This machine has not reported which image it runs.',
      lastAttempt,
      canRequest: true,
    };
  }
  if (machine.boxImage === machine.boxImageTarget) {
    return {
      kind: 'up-to-date',
      summary: 'Up to date.',
      lastAttempt,
      canRequest: false,
    };
  }
  return {
    kind: 'available',
    summary: 'Update available.',
    lastAttempt,
    canRequest: true,
  };
}
