type WebWorkerRequestClientRestartReason = string;

export interface WebWorkerRequestClient {
  readonly request: <Input, Output, Meta = unknown>(
    options: WebWorkerRequestOptions<Input, Output, Meta>
  ) => Promise<Output>;
  readonly postToExistingWorker: (
    message: unknown,
    transferList?: readonly Transferable[]
  ) => boolean;
  readonly finish: (id: number, result: unknown) => void;
  readonly getPending: <Meta = unknown>(id: number) => WebWorkerPendingRequest<Meta> | undefined;
  readonly hasPending: (id: number) => boolean;
  readonly restart: (reason: WebWorkerRequestClientRestartReason) => void;
  readonly resetForTests: () => void;
}

interface WebWorkerRequestClientOptions<Response> {
  readonly createWorker: () => Worker;
  readonly handleMessage: (input: {
    readonly message: Response;
    readonly client: WebWorkerRequestClient;
  }) => void;
  readonly handleWorkerError?: (input: {
    readonly event: ErrorEvent;
    readonly client: WebWorkerRequestClient;
  }) => void;
  readonly onRestart?: (reason: WebWorkerRequestClientRestartReason) => void;
}

interface WebWorkerRequestOptions<Input, Output, Meta> {
  readonly input: Input;
  readonly timeoutMs: number;
  readonly defaultTimeoutMs: number;
  readonly fallbackResult: Output;
  readonly timeoutFallbackResult?: Output;
  readonly postMessageFallbackResult?: (error: unknown) => Output;
  readonly restartFallbackResult?: (reason: WebWorkerRequestClientRestartReason) => Output;
  readonly timeoutRestartReason: WebWorkerRequestClientRestartReason;
  readonly postMessageRestartReason: WebWorkerRequestClientRestartReason;
  readonly meta?: Meta;
  readonly onPostMessageError?: (error: unknown) => void;
  readonly postMessage: (input: {
    readonly worker: Worker;
    readonly id: number;
    readonly request: Input;
  }) => void | Promise<void>;
}

interface WebWorkerPendingRequest<Meta = unknown> {
  readonly id: number;
  readonly meta: Meta | undefined;
}

interface PendingJob {
  readonly id: number;
  readonly meta: unknown;
  readonly fallbackResult: unknown;
  readonly restartFallbackResult:
    | ((reason: WebWorkerRequestClientRestartReason) => unknown)
    | undefined;
  readonly resolve: (value: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export function createWebWorkerRequestClient<Response>(
  options: WebWorkerRequestClientOptions<Response>
): WebWorkerRequestClient {
  return new WebWorkerRequestClientImpl(options);
}

// Centralize browser worker lifecycle without hiding each worker's protocol shape.
// Rejected: per-client pending maps duplicated timeout/restart bugs; rejected: a fully
// generic RPC envelope would obscure custom messages like row reads and text chunk streaming.
class WebWorkerRequestClientImpl<Response> implements WebWorkerRequestClient {
  private readonly createWorker: WebWorkerRequestClientOptions<Response>['createWorker'];
  private readonly handleMessage: WebWorkerRequestClientOptions<Response>['handleMessage'];
  private readonly handleWorkerError: WebWorkerRequestClientOptions<Response>['handleWorkerError'];
  private readonly onRestart: WebWorkerRequestClientOptions<Response>['onRestart'];
  private readonly pendingJobs = new Map<number, PendingJob>();
  private worker: Worker | null = null;
  private nextJobId = 1;

  constructor(options: WebWorkerRequestClientOptions<Response>) {
    this.createWorker = options.createWorker;
    this.handleMessage = options.handleMessage;
    this.handleWorkerError = options.handleWorkerError;
    this.onRestart = options.onRestart;
  }

  request<Input, Output, Meta = unknown>(
    options: WebWorkerRequestOptions<Input, Output, Meta>
  ): Promise<Output> {
    if (typeof Worker === 'undefined') {
      return Promise.resolve(options.fallbackResult);
    }
    const activeWorker = this.ensureWorker();
    return new Promise((resolve) => {
      const id = this.nextJobId;
      this.nextJobId += 1;
      const job: PendingJob = {
        id,
        meta: options.meta,
        fallbackResult: options.fallbackResult,
        restartFallbackResult: options.restartFallbackResult,
        resolve: (value) => resolve(value as Output),
      };
      this.pendingJobs.set(id, job);
      job.timer = setTimeout(
        () => {
          this.finish(id, options.timeoutFallbackResult ?? options.fallbackResult);
          this.restart(options.timeoutRestartReason);
        },
        normalizeTimeoutMs(options.timeoutMs, options.defaultTimeoutMs)
      );
      try {
        const postResult = options.postMessage({
          worker: activeWorker,
          id,
          request: options.input,
        });
        if (isPromiseLike(postResult)) {
          void postResult.catch((error: unknown) => {
            options.onPostMessageError?.(error);
            this.finish(id, options.postMessageFallbackResult?.(error) ?? options.fallbackResult);
            this.restart(options.postMessageRestartReason);
          });
        }
      } catch (error) {
        options.onPostMessageError?.(error);
        this.finish(id, options.postMessageFallbackResult?.(error) ?? options.fallbackResult);
        this.restart(options.postMessageRestartReason);
      }
    });
  }

  postToExistingWorker(message: unknown, transferList: readonly Transferable[] = []): boolean {
    if (this.worker === null) {
      return false;
    }
    this.worker.postMessage(message, [...transferList]);
    return true;
  }

  finish(id: number, result: unknown): void {
    const job = this.pendingJobs.get(id);
    if (job === undefined) {
      return;
    }
    this.pendingJobs.delete(id);
    if (job.timer !== undefined) {
      clearTimeout(job.timer);
    }
    job.resolve(result);
  }

  getPending<Meta = unknown>(id: number): WebWorkerPendingRequest<Meta> | undefined {
    const job = this.pendingJobs.get(id);
    if (job === undefined) {
      return undefined;
    }
    return {
      id: job.id,
      meta: job.meta as Meta | undefined,
    };
  }

  hasPending(id: number): boolean {
    return this.pendingJobs.has(id);
  }

  restart(reason: WebWorkerRequestClientRestartReason): void {
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const id of Array.from(this.pendingJobs.keys())) {
      const job = this.pendingJobs.get(id);
      this.finish(id, job?.restartFallbackResult?.(reason) ?? job?.fallbackResult);
    }
    this.onRestart?.(reason);
  }

  resetForTests(): void {
    if (this.worker !== null) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const id of Array.from(this.pendingJobs.keys())) {
      const job = this.pendingJobs.get(id);
      this.finish(id, job?.fallbackResult);
    }
    this.nextJobId = 1;
  }

  private ensureWorker(): Worker {
    if (this.worker !== null) {
      return this.worker;
    }
    const nextWorker = this.createWorker();
    nextWorker.onmessage = (event: MessageEvent<Response>) => {
      this.handleMessage({ message: event.data, client: this });
    };
    nextWorker.onerror = (event) => {
      if (this.handleWorkerError !== undefined) {
        this.handleWorkerError({ event, client: this });
        return;
      }
      this.restart('error');
    };
    this.worker = nextWorker;
    return nextWorker;
  }
}

function normalizeTimeoutMs(timeoutMs: number, defaultTimeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return defaultTimeoutMs;
  }
  return timeoutMs;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}
