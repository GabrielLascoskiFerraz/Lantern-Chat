export type RelayOperationErrorCode =
  | 'RELAY_UNAVAILABLE'
  | 'OPERATION_PENDING'
  | 'ATTACHMENT_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SESSION_RECONNECTING'
  | 'TIMEOUT'
  | 'UNKNOWN';

export class RelayOperationError extends Error {
  constructor(
    public readonly code: RelayOperationErrorCode,
    message: string,
    public readonly recoverable = true,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'RelayOperationError';
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    timer.unref?.();
  });

export const retryDelayMs = (attempt: number, baseMs = 500, maxMs = 30_000): number => {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(exponential * jitter);
};

interface QueueTask<T> {
  priority: number;
  sequence: number;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class PriorityTaskQueue {
  private active = 0;
  private sequence = 0;
  private readonly pending: Array<QueueTask<unknown>> = [];

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('A concorrência da fila deve ser positiva.');
    }
  }

  get size(): number {
    return this.pending.length;
  }

  get activeCount(): number {
    return this.active;
  }

  enqueue<T>(run: () => Promise<T>, priority = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        priority,
        sequence: this.sequence++,
        run,
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.pending.sort((left, right) =>
        right.priority !== left.priority
          ? right.priority - left.priority
          : left.sequence - right.sequence
      );
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift()!;
      this.active += 1;
      void task.run().then(task.resolve, task.reject).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }
}

export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('A capacidade do semáforo deve ser positiva.');
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.capacity) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiters.shift()?.();
  }
}
