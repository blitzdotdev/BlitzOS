/**
 * Coalesces concurrent calls for the same key onto a single in-flight Promise.
 *
 * The cleanup branch compares promise identity before deleting so a late
 * finalizer from an earlier call cannot evict a newer entry that replaced it.
 */
export class InFlightDedupe<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  async run(key: K, factory: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) {
      return await existing;
    }

    let wrapped: Promise<V>;
    wrapped = factory().finally(() => {
      if (this.inFlight.get(key) === wrapped) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, wrapped);
    return await wrapped;
  }

  size(): number {
    return this.inFlight.size;
  }
}
