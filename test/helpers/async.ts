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

export interface SettlementOptions {
  description: string;
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

/**
 * Wait for `promise` to reach a terminal state, and report the described state at
 * `waitUntil`'s safety ceiling when it never gets there. Use it wherever the claim
 * under test is that something settles *at all* — a bare `await` on a promise that
 * parks reports only an opaque runner timeout.
 *
 * Both arms are armed here, once, on purpose. A rejection is a terminal settlement,
 * so a single-armed predicate would mislabel a legitimate failure ending as a
 * predicate error, and would leave the rejection unhandled besides. That also means
 * this wait says nothing about *which* ending occurred: always assert the outcome as
 * well (`await expect(promise).resolves…` / `.rejects…`), or a swallowed rejection
 * passes for success.
 */
export function settlement(promise: Promise<unknown>, options: SettlementOptions): Promise<void> {
  const terminal = promise.then(() => true, () => true);
  return waitUntil({
    description: options.description,
    predicate: () => terminal,
    describeObserved: options.describeObserved ?? (() => "promise still pending"),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
