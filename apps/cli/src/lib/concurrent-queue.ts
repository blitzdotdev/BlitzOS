/**
 * ConcurrentQueue - 一个通用的并发控制队列
 *
 * 特性：
 * - 同一个 key 的任务串行执行
 * - 不同 key 的任务并发执行
 * - 全局并发数限制
 *
 * 这是一个 pure 的实现，不依赖任何外部类型或 logger
 */
export class ConcurrentQueue<K = string> {
  private readonly chains = new Map<K, Promise<void>>();
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number = 30) {}

  /**
   * 将任务加入队列
   * @param key 任务的分组 key，同一 key 的任务串行执行
   * @param task 要执行的任务
   */
  enqueue<T>(key: K | null, task: () => Promise<T>): Promise<T> {
    const chainKey = key ?? ('__default__' as unknown as K);

    const currentChain = this.chains.get(chainKey) ?? Promise.resolve();

    const resultPromise = currentChain.then(() => this.runWithLimit(task));

    // 更新 chain（忽略结果类型，只关心完成时机）
    const voidChain = resultPromise.then(
      () => {},
      () => {}
    );
    this.chains.set(chainKey, voidChain);

    // chain 完成后清理
    void voidChain.finally(() => {
      if (this.chains.get(chainKey) === voidChain) {
        this.chains.delete(chainKey);
      }
    });

    return resultPromise;
  }

  /**
   * 等待所有任务完成
   */
  async drain(): Promise<void> {
    await Promise.all(Array.from(this.chains.values()));
  }

  /**
   * 等待所有任务完成，带超时
   * @param timeoutMs 超时时间（毫秒）
   * @returns true 如果正常完成，false 如果超时
   */
  async drainWithTimeout(timeoutMs: number): Promise<boolean> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    const result = await Promise.race([this.drain().then(() => 'done' as const), timeoutPromise]);

    clearTimeout(timeoutId!);
    return result === 'done';
  }

  /**
   * 获取活跃任务数
   */
  get active(): number {
    return this.activeCount;
  }

  /**
   * 获取等待中的任务数
   */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /**
   * 带并发限制地执行任务
   */
  private async runWithLimit<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  private release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.activeCount--;
    }
  }
}
