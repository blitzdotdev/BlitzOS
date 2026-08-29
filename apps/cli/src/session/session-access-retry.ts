import { Data, Duration, Effect, Schedule } from 'effect';
import type { MachineAccessCheckResult } from '@/lib/workspace';

/**
 * Verifying whether a requester may run a turn on this machine has three
 * outcomes, and the distinction is load-bearing:
 *
 * - `allowed` / `denied` are definitive answers from the backend. A `denied`
 *   answer will not change on retry, so the turn is failed.
 * - `indeterminate` means we could NOT reach a verdict (network blip, backend
 *   unreachable, or an auth-looking transport error). Treating this like a deny
 *   permanently drops the user's turn on a transient outage — the bug this
 *   module exists to prevent. Instead we retry with backoff (see
 *   {@link verifyMachineAccessWithRetry}).
 */
export type MachineAccessDenyReason = Extract<
  MachineAccessCheckResult,
  { allowed: false }
>['reason'];

export type MachineAccessVerification =
  | { outcome: 'allowed' }
  | { outcome: 'denied'; reason: MachineAccessDenyReason }
  // `cause` separates a network/transport failure (retry forever) from an
  // auth-looking failure (retry, then escalate to the machine-level handler).
  | { outcome: 'indeterminate'; cause: 'network' | 'auth'; error: string };

/** A definitive authorization denial. Surfaced so the caller can fail the turn. */
export class AccessDenied extends Data.TaggedError('AccessDenied')<{
  readonly reason: MachineAccessDenyReason;
}> {}

/**
 * A non-definitive verification failure. This is retried internally and never
 * surfaces from {@link verifyMachineAccessWithRetry} at runtime; it only appears
 * in the static error type because the type system cannot prove the retry policy
 * loops forever on it.
 */
export class AccessIndeterminate extends Data.TaggedError('AccessIndeterminate')<{
  readonly cause: 'network' | 'auth';
  readonly error: string;
}> {}

export interface AccessRetryOptions {
  /**
   * Performs one verification. Must NOT reject — classify failures into
   * `indeterminate` (the CLI's `canUseMachine` wrapper already does this). A
   * rejection is defensively treated as `indeterminate/network`.
   */
  readonly verify: () => Promise<MachineAccessVerification>;
  /**
   * Invoked exactly once when verification keeps failing with an auth-looking
   * error (likely an invalid/revoked token). A backstop to the authoritative
   * workspace-list detector; retries continue afterward so a token refresh
   * recovers the turn without the user resending.
   */
  readonly onAuthEscalation: () => void;
  /** Consecutive auth-cause failures before escalating. Default 5. */
  readonly escalateAfter?: number;
  /** First backoff delay. Default 2s. */
  readonly baseDelay?: Duration.DurationInput;
  /** Backoff cap. Default 1m. */
  readonly maxDelay?: Duration.DurationInput;
  /** Per-attempt timeout for the verify call. Default 10s. */
  readonly verifyTimeout?: Duration.DurationInput;
  /**
   * Add randomness to delays (anti-thundering-herd). Default true; tests set
   * false for exact, deterministic timing under TestClock.
   */
  readonly jitter?: boolean;
}

/**
 * Verify machine access, retrying transient failures with exponential backoff
 * until the answer is definitive or the fiber is interrupted.
 *
 * - Succeeds (`void`) when access is **allowed**.
 * - Fails with {@link AccessDenied} when the backend **definitively denies**.
 * - Retries forever (capped backoff) while **indeterminate**; escalates once via
 *   `onAuthEscalation` after `escalateAfter` consecutive auth-cause failures.
 *
 * Interruption (e.g. the turn is superseded or the session is unwatched) simply
 * stops the fiber — no failure, no side effects.
 */
export const verifyMachineAccessWithRetry = (
  opts: AccessRetryOptions
): Effect.Effect<void, AccessDenied> =>
  Effect.gen(function* () {
    const escalateAfter = opts.escalateAfter ?? 5;
    // Single-fiber context — no concurrent access, plain `let` suffices over Ref.
    let authFailures = 0;

    const attempt = Effect.tryPromise({
      try: () => opts.verify(),
      // Defensive: the contract says `verify` never rejects, but if it does we
      // treat it as a transient network failure rather than crashing the fiber.
      catch: (error): AccessIndeterminate =>
        new AccessIndeterminate({ cause: 'network', error: String(error) }),
    }).pipe(
      Effect.timeout(opts.verifyTimeout ?? Duration.seconds(10)),
      // A hung verify is just another transient failure → retry.
      Effect.catchTag('TimeoutException', () =>
        Effect.fail(new AccessIndeterminate({ cause: 'network', error: 'verify timed out' }))
      ),
      Effect.flatMap((verification): Effect.Effect<void, AccessDenied | AccessIndeterminate> => {
        if (verification.outcome === 'allowed') {
          return Effect.void;
        }
        if (verification.outcome === 'denied') {
          return Effect.fail(new AccessDenied({ reason: verification.reason }));
        }
        return Effect.fail(
          new AccessIndeterminate({ cause: verification.cause, error: verification.error })
        );
      }),
      // Escalate once after sustained auth failures; keep retrying afterward.
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error._tag === 'AccessIndeterminate' && error.cause === 'auth') {
            authFailures += 1;
            if (authFailures === escalateAfter) {
              opts.onAuthEscalation();
            }
          }
        })
      )
    );

    const cappedBackoff = Schedule.union(
      Schedule.exponential(opts.baseDelay ?? Duration.seconds(2)),
      // union takes the SHORTER delay, so once the exponential exceeds this it
      // settles into a steady interval — i.e. a cap.
      Schedule.spaced(opts.maxDelay ?? Duration.minutes(1))
    );
    const jittered = opts.jitter === false ? cappedBackoff : Schedule.jittered(cappedBackoff);
    // Retry while the failure is indeterminate; a definitive AccessDenied makes
    // `whileInput` false, which stops the schedule and propagates the denial.
    const policy = Schedule.whileInput(
      jittered,
      (error: AccessDenied | AccessIndeterminate) => error._tag === 'AccessIndeterminate'
    );

    yield* Effect.retry(attempt, policy).pipe(
      // The retry policy loops forever on AccessIndeterminate (whileInput), so
      // this is unreachable at runtime. Absorb it here so callers only handle
      // the definitive AccessDenied — no dead branches in the watcher.
      Effect.catchTag('AccessIndeterminate', () => Effect.void)
    );
  });
