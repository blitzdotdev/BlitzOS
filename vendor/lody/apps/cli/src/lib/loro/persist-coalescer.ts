/**
 * Collapses a burst of persist requests into one flush per debounce window.
 *
 * The Streams transport asks the repo to persist once per remote sync event. Each
 * request used to run its own `repo.flush()`, which on a busy workspace measured
 * 3.6 flushes/second at ~61ms each — roughly 20% of a core spent re-flushing, and
 * long enough to starve the event loop the machine presence heartbeat rides on.
 *
 * A flush persists EVERYTHING pending, so N requests genuinely only need one. The
 * invariant that makes this safe: any request that arrives while a flush is in
 * flight is covered by the NEXT flush, which is always scheduled. Nothing is
 * dropped, and the rate is bounded without starving — unlike a plain trailing
 * debounce, a continuous stream of requests still gets a flush every
 * `debounceMs + flush duration`.
 */
export type PersistCoalescerOptions<Reason extends string> = {
  readonly debounceMs: number;
  /** Runs one flush covering every reason accumulated so far. */
  readonly flush: (reasons: readonly Reason[]) => Promise<void>;
  readonly onError?: (error: unknown, reasons: readonly Reason[]) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
};

export class PersistCoalescer<Reason extends string> {
  private readonly pending = new Set<Reason>();
  private timer: unknown = null;
  private running = false;

  constructor(private readonly options: PersistCoalescerOptions<Reason>) {}

  /** Request a flush. Returns immediately; the flush runs on the debounce edge. */
  request(reason: Reason): void {
    this.pending.add(reason);
    this.pump();
  }

  /** True while a flush is in flight or one is scheduled. */
  get busy(): boolean {
    return this.running || this.timer !== null || this.pending.size > 0;
  }

  /**
   * Run any scheduled flush now instead of waiting out the debounce window.
   * Used on teardown, so a pending window cannot swallow the last persist.
   */
  async flushNow(): Promise<void> {
    this.cancelTimer();
    await this.drain();
  }

  /** Drop any scheduled flush without running it. */
  cancel(): void {
    this.cancelTimer();
    this.pending.clear();
  }

  private cancelTimer(): void {
    if (this.timer === null) {
      return;
    }
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
    clear(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.timer !== null || this.running || this.pending.size === 0) {
      return;
    }
    const set =
      this.options.setTimer ??
      ((callback: () => void, delayMs: number) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
      });
    this.timer = set(() => {
      this.timer = null;
      void this.drain();
    }, this.options.debounceMs);
  }

  private async drain(): Promise<void> {
    if (this.running || this.pending.size === 0) {
      return;
    }
    const reasons = [...this.pending].sort();
    this.pending.clear();
    this.running = true;
    try {
      await this.options.flush(reasons);
    } catch (error) {
      this.options.onError?.(error, reasons);
    } finally {
      this.running = false;
    }
    // Requests that landed during the flush open a fresh window rather than
    // running back-to-back, so a steady stream cannot pin the event loop.
    this.pump();
  }
}
