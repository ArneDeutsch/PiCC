export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

/** A promise whose native, idempotent settlement functions are exposed to tests. */
export function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export interface WaitUntilOptions {
  description: string;
  predicate: () => boolean | Promise<boolean>;
  describeObserved?: () => string;
  timeoutMs?: number;
}

const RETRY_INTERVAL_MS = 10;

/**
 * Wait for an observable condition. The timeout is only a safety ceiling for a
 * hung test; callers must not use it as evidence that behavior was fast enough.
 * A predicate may remain pending until an event occurs, avoiding polling.
 */
export function waitUntil({
  description,
  predicate,
  describeObserved,
  timeoutMs = 10_000,
}: WaitUntilOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(reason);
    };

    const timeoutTimer = setTimeout(() => {
      let observed = "";
      if (describeObserved) {
        try {
          observed = `; observed: ${describeObserved()}`;
        } catch (error) {
          observed = `; observed state could not be described (${String(error)})`;
        }
      }
      fail(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}${observed}`));
    }, timeoutMs);

    const check = async (): Promise<void> => {
      try {
        if (await predicate()) {
          succeed();
          return;
        }
        if (!settled) retryTimer = setTimeout(() => void check(), RETRY_INTERVAL_MS);
      } catch (error) {
        fail(error);
      }
    };

    void check();
  });
}
