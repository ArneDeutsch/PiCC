import { createHash } from "node:crypto";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

export const MAX_NOTEBOOK_SESSION_RECORDS = 64;
const MAX_NOTEBOOK_PATH_CHARS = 32_768;
const MAX_RESTORED_GENERATION = Number.MAX_SAFE_INTEGER - 1_000_000;
const MAX_NOTEBOOK_SESSION_BRANCH_ENTRIES = 1_000_000;
const READ_CHUNK_BYTES = 64 * 1024;

export interface NotebookTargetIdentity {
  normalizedPath: string;
  canonicalPath: string;
  fingerprint: string;
}

export interface NotebookReadSnapshot {
  identity: string;
  digest: string;
  generation: number;
  fallbackCurrent: boolean;
}

export interface SerializedNotebookSession {
  version: 1;
  generation: number;
  records: NotebookReadSnapshot[];
}

export interface NotebookAuthorizationToken extends NotebookReadSnapshot {}

export interface NotebookSessionOptions {
  onChange?: (snapshot: SerializedNotebookSession) => void;
}

export type NotebookSessionSource = NotebookSessionState | (() => NotebookSessionState);

/** Capture the conversation state once at the synchronous start of a tool call. */
export function resolveNotebookSession(source: NotebookSessionSource): NotebookSessionState {
  return typeof source === "function" ? source() : source;
}

export const NOTEBOOK_SESSION_CUSTOM_TYPE = "picc-notebook-session";

/**
 * Select only the newest notebook-session custom entry from a branch without
 * invoking branch- or entry-controlled accessors.
 */
export function newestNotebookSessionSnapshot(branch: unknown): unknown {
  if (safeArrayCheck(branch) !== true) return undefined;
  const entries = branch as unknown[];
  const length = dataProperty(entries, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length)
    || length < 0 || length > MAX_NOTEBOOK_SESSION_BRANCH_ENTRIES) return undefined;
  for (let index = length - 1; index >= 0; index--) {
    const entry = ownArrayData(entries, index);
    if (entry === null || typeof entry !== "object" || safeArrayCheck(entry) !== false) continue;
    if (dataProperty(entry, "type") !== "custom"
      || dataProperty(entry, "customType") !== NOTEBOOK_SESSION_CUSTOM_TYPE) continue;
    return dataProperty(entry, "data");
  }
  return undefined;
}

export interface NotebookFileHandle {
  stat(options: { bigint: true }): Promise<{ isFile(): boolean; size: bigint; dev: bigint; ino: bigint }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  write(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesWritten: number }>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

export class NotebookSizeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Notebook exceeds the ${limit}-byte limit`);
    this.name = "NotebookSizeLimitError";
  }
}

function hash(parts: readonly (string | Uint8Array)[]): string {
  const digest = createHash("sha256");
  for (const part of parts) digest.update(part);
  return digest.digest("hex");
}

export function notebookBytesDigest(bytes: Uint8Array): string {
  return hash([bytes]);
}

function identityFingerprint(canonicalPath: string, device: bigint | number, inode: bigint | number): string {
  return hash([canonicalPath, "\0", String(device), "\0", String(inode)]);
}

function failPath(field: string, reason: string): never {
  throw new Error(`NotebookEdit: ${field} ${reason}`);
}

function looksWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//");
}

/** Lexically normalize a notebook path using the policy semantics of one platform. */
export function normalizeNotebookPathForPlatform(
  input: string,
  cwd: string,
  platform: NodeJS.Platform,
): string {
  if (typeof input !== "string" || input.length === 0) failPath("notebook_path", "must be a non-empty string.");
  if (input.length > MAX_NOTEBOOK_PATH_CHARS) failPath("notebook_path", "is too long.");
  if (input.includes("\0")) failPath("notebook_path", "must not contain NUL.");
  const paths = platform === "win32" ? path.win32 : path.posix;

  if (platform === "win32") {
    const value = input.replaceAll("/", "\\");
    if (/^(?:\\\\[?.]\\|\\[?.]\\|\\\?\?\\)/.test(value)) {
      failPath("notebook_path", "must not use a Windows device namespace.");
    }
    if (/^[a-zA-Z]:[^\\]/.test(value)) failPath("notebook_path", "must not be drive-relative.");
    if (/^\\(?!\\)/.test(value)) failPath("notebook_path", "must not be rooted on the current drive.");
    if (value.startsWith("\\\\")) {
      const pieces = value.slice(2).split("\\");
      if (pieces.length < 2 || !pieces[0] || !pieces[1]) failPath("notebook_path", "contains a malformed UNC path.");
    }
    const absolute = paths.isAbsolute(value) ? paths.normalize(value) : paths.resolve(cwd, value);
    if (!/^[a-zA-Z]:\\/.test(absolute) && !absolute.startsWith("\\\\")) {
      failPath("notebook_path", "must resolve to a native absolute path.");
    }
    if (paths.extname(absolute) !== ".ipynb") failPath("notebook_path", 'must have the case-sensitive extension ".ipynb".');
    return absolute;
  }

  if (looksWindowsAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.includes("\\")) {
    failPath("notebook_path", "must use a native POSIX path.");
  }
  const absolute = paths.isAbsolute(input) ? paths.normalize(input) : paths.resolve(cwd, input);
  if (paths.extname(absolute) !== ".ipynb") failPath("notebook_path", 'must have the case-sensitive extension ".ipynb".');
  return absolute;
}

/** Resolve relative input against the current cwd without changing its policy-visible target. */
export function normalizeNotebookPath(input: string, cwd: string): string {
  return normalizeNotebookPathForPlatform(input, cwd, process.platform);
}

export async function canonicalNotebookPath(normalizedPath: string): Promise<string> {
  return realpath(normalizedPath);
}

export async function openNotebookFile(filePath: string, flags: "r" | "r+"): Promise<NotebookFileHandle> {
  return open(filePath, flags) as Promise<FileHandle> as Promise<NotebookFileHandle>;
}

/** Derive an existing regular-file identity from one already-open file description. */
export async function identifyNotebookHandle(
  handle: NotebookFileHandle,
  normalizedPath: string,
  canonicalPath: string,
  afterAwait?: () => void,
): Promise<{ target: NotebookTargetIdentity; size: bigint }> {
  const info = await handle.stat({ bigint: true });
  afterAwait?.();
  if (!info.isFile()) throw new Error("Notebook target is not a regular file");
  return {
    target: {
      normalizedPath,
      canonicalPath,
      fingerprint: identityFingerprint(canonicalPath, info.dev, info.ino),
    },
    size: info.size,
  };
}

/** Derive identity and bounded exact bytes from one already-open file description. */
export async function inspectNotebookHandle(
  handle: NotebookFileHandle,
  normalizedPath: string,
  canonicalPath: string,
  maxBytes: number,
  afterAwait?: () => void,
): Promise<{ target: NotebookTargetIdentity; bytes: Buffer }> {
  const identified = await identifyNotebookHandle(handle, normalizedPath, canonicalPath, afterAwait);
  if (identified.size > BigInt(maxBytes)) throw new NotebookSizeLimitError(maxBytes);

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    afterAwait?.();
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new NotebookSizeLimitError(maxBytes);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return {
    target: identified.target,
    bytes: Buffer.concat(chunks, total),
  };
}

export async function resolveNotebookTarget(normalizedPath: string): Promise<NotebookTargetIdentity> {
  const canonicalPath = await canonicalNotebookPath(normalizedPath);
  const handle = await openNotebookFile(canonicalPath, "r");
  try {
    return (await identifyNotebookHandle(handle, normalizedPath, canonicalPath)).target;
  } finally {
    await handle.close();
  }
}

/** Read through one file handle with bounded accumulation and reject when bytes exceed the cap. */
export async function readNotebookBytesBounded(filePath: string, maxBytes: number): Promise<Buffer> {
  const canonicalPath = await canonicalNotebookPath(filePath);
  const handle = await openNotebookFile(canonicalPath, "r");
  try {
    return (await inspectNotebookHandle(handle, filePath, canonicalPath, maxBytes)).bytes;
  } finally {
    await handle.close();
  }
}

function dataProperty(record: object, key: PropertyKey): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownArrayData(records: unknown[], index: number): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(records, String(index));
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeArrayCheck(value: unknown): boolean | undefined {
  try {
    return Array.isArray(value);
  } catch {
    return undefined;
  }
}

function parseSnapshot(value: unknown): NotebookReadSnapshot | undefined {
  if (value === null || typeof value !== "object" || safeArrayCheck(value) !== false) return undefined;
  const identity = dataProperty(value, "identity");
  const digest = dataProperty(value, "digest");
  const generation = dataProperty(value, "generation");
  const fallbackCurrent = dataProperty(value, "fallbackCurrent");
  if (typeof identity !== "string" || !/^[0-9a-f]{64}$/.test(identity)
    || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)
    || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation <= 0
    || generation > MAX_RESTORED_GENERATION
    || typeof fallbackCurrent !== "boolean") return undefined;
  return { identity, digest, generation, fallbackCurrent };
}

export class NotebookSessionState {
  private readonly records = new Map<string, NotebookReadSnapshot>();
  private generation = 0;
  private hydrated = false;
  private readonly onChange?: (snapshot: SerializedNotebookSession) => void;

  constructor(options: NotebookSessionOptions = {}) {
    this.onChange = options.onChange;
  }

  captureCallEpoch(): number {
    return this.generation;
  }

  authorize(target: NotebookTargetIdentity, callEpoch: number): NotebookAuthorizationToken | undefined {
    const record = this.records.get(target.fingerprint);
    if (record === undefined || record.generation > callEpoch) return undefined;
    return { ...record };
  }

  validate(token: NotebookAuthorizationToken, target: NotebookTargetIdentity, bytes: Uint8Array): boolean {
    const current = this.records.get(token.identity);
    return current !== undefined
      && current.generation === token.generation
      && target.fingerprint === token.identity
      && notebookBytesDigest(bytes) === token.digest;
  }

  recordRead(target: NotebookTargetIdentity, bytes: Uint8Array): NotebookAuthorizationToken {
    return this.store(target, bytes, true);
  }

  refreshAfterEdit(
    token: NotebookAuthorizationToken,
    target: NotebookTargetIdentity,
    bytes: Uint8Array,
    reordered: boolean,
  ): NotebookAuthorizationToken {
    const current = this.records.get(token.identity);
    if (current === undefined || current.generation !== token.generation) {
      throw new Error("Notebook snapshot changed before refresh");
    }
    return this.store(target, bytes, reordered ? false : current.fallbackCurrent);
  }

  invalidateIfCurrent(token: NotebookAuthorizationToken): void {
    const current = this.records.get(token.identity);
    if (current?.generation !== token.generation) return;
    this.records.delete(token.identity);
    this.changed();
  }

  serialize(): SerializedNotebookSession {
    return {
      version: 1,
      generation: this.generation,
      records: [...this.records.values()].slice(-MAX_NOTEBOOK_SESSION_RECORDS).map((record) => ({ ...record })),
    };
  }

  restore(value: unknown): void {
    if (this.hydrated) return;
    if (value === null || typeof value !== "object" || safeArrayCheck(value) !== false) return;
    const version = dataProperty(value, "version");
    const generation = dataProperty(value, "generation");
    const records = dataProperty(value, "records");
    if (version !== 1 || typeof generation !== "number" || !Number.isSafeInteger(generation)
      || generation < 0 || generation > MAX_RESTORED_GENERATION || safeArrayCheck(records) !== true) return;
    const recordArray = records as unknown[];
    const recordCount = dataProperty(recordArray, "length");
    if (typeof recordCount !== "number" || !Number.isSafeInteger(recordCount)
      || recordCount < 0 || recordCount > MAX_NOTEBOOK_SESSION_RECORDS) return;

    const valid: NotebookReadSnapshot[] = [];
    const identities = new Set<string>();
    const generations = new Set<number>();
    for (let index = 0; index < recordCount; index++) {
      const property = ownArrayData(recordArray, index);
      if (property === undefined) return;
      const record = parseSnapshot(property);
      if (record === undefined || record.generation > generation
        || identities.has(record.identity) || generations.has(record.generation)) return;
      identities.add(record.identity);
      generations.add(record.generation);
      valid.push(record);
    }

    for (const record of valid) this.records.set(record.identity, record);
    this.generation = generation;
    this.hydrated = true;
  }

  clone(options: NotebookSessionOptions = {}): NotebookSessionState {
    const copy = new NotebookSessionState(options);
    copy.restore(this.serialize());
    return copy;
  }

  private store(
    target: NotebookTargetIdentity,
    bytes: Uint8Array,
    fallbackCurrent: boolean,
  ): NotebookAuthorizationToken {
    if (this.generation >= MAX_RESTORED_GENERATION) {
      throw new Error("Notebook session generation exhausted");
    }
    this.generation++;
    this.hydrated = true;
    const record: NotebookReadSnapshot = {
      identity: target.fingerprint,
      digest: notebookBytesDigest(bytes),
      generation: this.generation,
      fallbackCurrent,
    };
    this.records.delete(target.fingerprint);
    this.records.set(target.fingerprint, record);
    while (this.records.size > MAX_NOTEBOOK_SESSION_RECORDS) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    this.changed();
    return { ...record };
  }

  private changed(): void {
    if (this.onChange === undefined) return;
    try {
      this.onChange(this.serialize());
    } catch {
      // Persistence observation must not turn a completed Read/Edit state transition into failure.
    }
  }
}
