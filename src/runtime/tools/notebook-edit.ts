import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  defineTool,
  withFileMutationQueue,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  applyNotebookMutation,
  decodeNotebookText,
  parseNotebookDocument,
  serializeNotebookDocument,
  type NotebookCellType,
  type NotebookEditMode,
  type NotebookEditRequest,
  type NotebookMutationResult,
} from "../notebook-edit-core.js";
import { MAX_NOTEBOOK_BYTES } from "../notebook-render.js";
import {
  NotebookSessionState,
  NotebookSizeLimitError,
  canonicalNotebookPath,
  identifyNotebookHandle,
  inspectNotebookHandle,
  normalizeNotebookPath,
  openNotebookFile,
  type NotebookAuthorizationToken,
  type NotebookFileHandle,
  type NotebookTargetIdentity,
} from "../notebook-session.js";

export { normalizeNotebookPath } from "../notebook-session.js";

export const NOTEBOOK_MUTATION_FACTS = Symbol("picc.notebookMutationFacts");

interface NotebookEditInput {
  notebook_path: string;
  new_source: string;
  cell_id?: string;
  cell_type?: NotebookCellType;
  edit_mode?: NotebookEditMode;
}

interface NotebookEditFileOps {
  resolve(path: string): Promise<string>;
  open(path: string, flags: "r" | "r+"): Promise<NotebookFileHandle>;
  identify(
    handle: NotebookFileHandle,
    normalizedPath: string,
    canonicalPath: string,
    afterAwait?: () => void,
  ): Promise<{ target: NotebookTargetIdentity; size: bigint }>;
  inspect(
    handle: NotebookFileHandle,
    normalizedPath: string,
    canonicalPath: string,
    maxBytes: number,
    afterAwait?: () => void,
  ): Promise<{ target: NotebookTargetIdentity; bytes: Buffer }>;
  commit(handle: NotebookFileHandle, bytes: Uint8Array): Promise<void>;
}

export interface NotebookEditToolOptions {
  fileOps?: Partial<NotebookEditFileOps>;
  generateCellIdCandidate?: () => string;
  afterTokenCapture?: () => void | Promise<void>;
  afterCommit?: (phase: "before-refresh" | "before-result") => void | Promise<void>;
}

const DEFAULT_FILE_OPS: NotebookEditFileOps = {
  resolve: canonicalNotebookPath,
  open: openNotebookFile,
  identify: identifyNotebookHandle,
  inspect: inspectNotebookHandle,
  commit: async (handle, bytes) => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
        throw new Error("notebook write made no valid progress");
      }
      offset += bytesWritten;
    }
    await handle.truncate(bytes.byteLength);
  },
};

type FailureKind = "input" | "unread" | "stale" | "fallback" | "cell" | "encoding" | "structure" | "oversize" | "operation" | "abort";

class NotebookFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly invalidates = false,
  ) {
    super(message);
    this.name = "NotebookFailure";
  }
}

interface ProjectedInput {
  values: Partial<NotebookEditInput>;
  normalizedPath?: string;
  pathFailure?: NotebookFailure;
  shapeFailure?: NotebookFailure;
}

function ownDataValue(record: object, key: PropertyKey): { present: boolean; value?: unknown; unsafe?: boolean } {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined) return { present: false };
    if (!("value" in descriptor)) return { present: true, unsafe: true };
    return { present: true, value: descriptor.value };
  } catch {
    return { present: false, unsafe: true };
  }
}

function projectInput(params: unknown, getCwd: () => string): ProjectedInput {
  const projected: ProjectedInput = { values: {} };
  let isArray: boolean;
  try {
    isArray = Array.isArray(params);
  } catch {
    projected.shapeFailure = new NotebookFailure("input", "input must expose ordinary own data properties.");
    return projected;
  }
  if (params === null || typeof params !== "object" || isArray) {
    projected.shapeFailure = new NotebookFailure("input", "input must be an object.");
    return projected;
  }

  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(params);
  } catch {
    projected.shapeFailure = new NotebookFailure("input", "input must expose ordinary own data properties.");
    return projected;
  }
  const allowed = new Set(["notebook_path", "new_source", "cell_id", "cell_type", "edit_mode"]);
  const unexpected = keys.find((key) => typeof key !== "string" || !allowed.has(key));
  if (unexpected !== undefined) {
    const label = typeof unexpected === "string" ? ` "${unexpected.slice(0, 128)}"` : "";
    projected.shapeFailure = new NotebookFailure("input", `unexpected input field${label}.`);
  }

  for (const key of allowed) {
    const property = ownDataValue(params, key);
    if (property.unsafe) {
      projected.shapeFailure ??= new NotebookFailure("input", `field ${key} must be an own data property.`);
      continue;
    }
    if (!property.present) continue;
    Object.defineProperty(projected.values, key, {
      value: property.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  const rawPath = projected.values.notebook_path;
  if (typeof rawPath === "string" && rawPath.length > 0) {
    try {
      projected.normalizedPath = normalizeNotebookPath(rawPath, getCwd());
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("NotebookEdit: ")
        ? error.message.slice("NotebookEdit: ".length)
        : "notebook_path is invalid.";
      projected.pathFailure = new NotebookFailure("input", message);
    }
  }
  return projected;
}

function validateInput(projected: ProjectedInput): NotebookEditInput {
  if (projected.pathFailure !== undefined) throw projected.pathFailure;
  if (projected.shapeFailure !== undefined) throw projected.shapeFailure;
  const raw = projected.values as Record<string, unknown>;
  const notebookPath = raw.notebook_path;
  const newSource = raw.new_source;
  const cellId = raw.cell_id;
  const cellType = raw.cell_type;
  const editMode = raw.edit_mode ?? "replace";
  if (typeof notebookPath !== "string" || notebookPath.length === 0 || projected.normalizedPath === undefined) {
    throw new NotebookFailure("input", "notebook_path must be a non-empty string.");
  }
  if (typeof newSource !== "string") throw new NotebookFailure("input", "new_source must be a string.");
  if (Buffer.byteLength(newSource, "utf8") > MAX_NOTEBOOK_BYTES) {
    throw new NotebookFailure("oversize", `new_source exceeds the ${MAX_NOTEBOOK_BYTES}-byte limit.`);
  }
  if (cellId !== undefined && (typeof cellId !== "string" || cellId.length === 0)) {
    throw new NotebookFailure("input", "cell_id must be a non-empty string when supplied.");
  }
  if (cellType !== undefined && cellType !== "code" && cellType !== "markdown") {
    throw new NotebookFailure("input", 'cell_type must be "code" or "markdown".');
  }
  if (editMode !== "replace" && editMode !== "insert" && editMode !== "delete") {
    throw new NotebookFailure("input", 'edit_mode must be "replace", "insert", or "delete".');
  }
  if (editMode === "insert" && cellType === undefined) {
    throw new NotebookFailure("input", "insert requires cell_type.");
  }
  if (editMode !== "insert" && cellId === undefined) {
    throw new NotebookFailure("input", `${editMode} requires cell_id.`);
  }
  return {
    notebook_path: projected.normalizedPath,
    new_source: newSource,
    ...(cellId === undefined ? {} : { cell_id: cellId as string }),
    ...(cellType === undefined ? {} : { cell_type: cellType }),
    edit_mode: editMode,
  };
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new NotebookFailure("abort", "operation was aborted.");
}

async function useNotebookHandle<T>(handle: NotebookFileHandle, operation: () => Promise<T>): Promise<T> {
  let operationFailed = false;
  try {
    return await operation();
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (!operationFailed) throw closeError;
    }
  }
}

function modernIds(nbformat: number, minor: number): boolean {
  return nbformat > 4 || (nbformat === 4 && minor >= 5);
}

function usesPositionalFallback(request: NotebookEditInput, document: ReturnType<typeof parseNotebookDocument>): boolean {
  if (request.cell_id === undefined || !/^cell-\d+$/.test(request.cell_id)) return false;
  return !document.cells.some((cell) => typeof cell.id === "string" && cell.id === request.cell_id);
}

function languageOf(document: ReturnType<typeof parseNotebookDocument>): unknown {
  const metadata = document.metadata;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const info = (metadata as Record<string, unknown>).language_info;
    if (info !== null && typeof info === "object" && !Array.isArray(info)) {
      return (info as Record<string, unknown>).name ?? "python";
    }
  }
  return "python";
}

function compatibilityCellId(
  request: NotebookEditInput,
  result: NotebookMutationResult,
  supportsIds: boolean,
): string | undefined {
  if (!supportsIds) return undefined;
  return result.mode === "insert" ? result.generatedCellId : request.cell_id;
}

interface NotebookToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<PropertyKey, unknown>;
  isError?: boolean;
}

function successResult(
  request: NotebookEditInput,
  originalFile: string,
  updatedFile: string,
  language: unknown,
  supportsIds: boolean,
  facts: NotebookMutationResult,
): NotebookToolResult {
  const cellId = compatibilityCellId(request, facts, supportsIds);
  const displayId = cellId === undefined ? "undefined" : cellId;
  const text = facts.mode === "replace"
    ? `Updated cell ${displayId} with ${request.new_source}`
    : facts.mode === "insert"
      ? `Inserted cell ${displayId} with ${request.new_source}`
      : `Deleted cell ${displayId}`;
  const details: Record<PropertyKey, unknown> = {
    new_source: request.new_source,
    ...(facts.oldSource === undefined ? {} : { old_source: facts.oldSource }),
    ...(cellId === undefined ? {} : { cell_id: cellId }),
    cell_type: request.cell_type ?? "code",
    language,
    edit_mode: request.edit_mode ?? "replace",
    notebook_path: request.notebook_path,
    original_file: originalFile,
    updated_file: updatedFile,
  };
  details[NOTEBOOK_MUTATION_FACTS] = facts;
  return { content: [{ type: "text", text }], details };
}

function errorMessage(error: unknown, writingStarted: boolean): string {
  if (writingStarted) {
    return "NotebookEdit: writing may have changed the notebook. Inspect and Read it again before retrying.";
  }
  const failure = error instanceof NotebookFailure
    ? error
    : error instanceof NotebookSizeLimitError
      ? new NotebookFailure("oversize", `notebook exceeds the ${error.limit}-byte limit.`, true)
      : new NotebookFailure("unread", "the notebook could not be read or no longer matches the last successful Read. Read it again before retrying.", true);
  return `NotebookEdit: ${failure.message} No changes were written.`;
}

function errorResult(projected: ProjectedInput, error: string): NotebookToolResult {
  const request = projected.values;
  return {
    content: [{ type: "text", text: error }],
    details: {
      new_source: typeof request.new_source === "string" ? request.new_source : "",
      ...(typeof request.cell_id === "string" ? { cell_id: request.cell_id } : {}),
      cell_type: "code",
      language: "python",
      edit_mode: "replace",
      error,
      notebook_path: projected.normalizedPath ?? "",
      original_file: "",
      updated_file: "",
    },
    isError: true,
  };
}

function decodeForEdit(bytes: Uint8Array): ReturnType<typeof decodeNotebookText> {
  if ((bytes[0] === 0x7b && bytes[1] === 0) || (bytes[0] === 0 && bytes[1] === 0x7b)) {
    throw new NotebookFailure("encoding", "notebook text uses unsupported UTF-16 without a BOM.");
  }
  try {
    return decodeNotebookText(bytes);
  } catch {
    throw new NotebookFailure("encoding", "notebook text uses an unsupported or malformed encoding.");
  }
}

function parseForEdit(text: string): ReturnType<typeof parseNotebookDocument> {
  try {
    return parseNotebookDocument(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "Notebook is not valid JSON") {
      throw new NotebookFailure("structure", "notebook is not valid JSON.");
    }
    const cell = /^Notebook cell (\d+) /.exec(message)?.[1];
    const field = /^Notebook field "(nbformat|nbformat_minor|cells)" /.exec(message)?.[1];
    const fact = cell !== undefined ? ` at cell ${cell}` : field !== undefined ? ` in field ${field}` : "";
    throw new NotebookFailure("structure", `notebook structure is unsupported${fact}.`);
  }
}

function mutate(
  document: ReturnType<typeof parseNotebookDocument>,
  request: NotebookEditInput,
  generateCellIdCandidate: () => string,
): NotebookMutationResult {
  try {
    return applyNotebookMutation(document, request as NotebookEditRequest, { generateCellIdCandidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^Notebook cell ".*" was not found$/.test(message)) {
      throw new NotebookFailure("cell", "the requested cell was not found. Read the notebook again and select an ID displayed by Read.");
    }
    throw new NotebookFailure("operation", "the requested notebook operation could not be applied.");
  }
}

export function createNotebookEditTool(
  getCwd: () => string,
  notebookSession: NotebookSessionState,
  options: NotebookEditToolOptions = {},
): ToolDefinition {
  const fileOps: NotebookEditFileOps = { ...DEFAULT_FILE_OPS, ...options.fileOps };
  return defineTool({
    name: "NotebookEdit",
    label: "NotebookEdit",
    description: "Replace, insert, or delete one cell in a Jupyter notebook after reading it with Read.",
    parameters: Type.Object({
      notebook_path: Type.String({ description: "Absolute path to the .ipynb notebook." }),
      new_source: Type.String({ description: "Complete source for the inserted or replacement cell; empty for delete." }),
      cell_id: Type.Optional(Type.String({ description: "Cell identifier shown by Read." })),
      cell_type: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("markdown")])),
      edit_mode: Type.Optional(Type.Union([
        Type.Literal("replace"),
        Type.Literal("insert"),
        Type.Literal("delete"),
      ])),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      const callEpoch = notebookSession.captureCallEpoch();
      const projected = projectInput(params, getCwd);
      let token: NotebookAuthorizationToken | undefined;
      let currentAuthorization: NotebookAuthorizationToken | undefined;
      let writingStarted = false;
      try {
        const request = validateInput(projected);
        let initialTarget: NotebookTargetIdentity;
        try {
          const canonical = await fileOps.resolve(request.notebook_path);
          checkAbort(signal);
          const handle = await fileOps.open(canonical, "r");
          initialTarget = await useNotebookHandle(handle, async () => {
            checkAbort(signal);
            return (await fileOps.identify(
              handle, request.notebook_path, canonical, () => checkAbort(signal),
            )).target;
          });
          checkAbort(signal);
        } catch (error) {
          if (error instanceof NotebookFailure || error instanceof NotebookSizeLimitError) throw error;
          throw new NotebookFailure("unread", "the notebook is missing, unreadable, or not a regular file. Read it successfully before editing.");
        }
        token = notebookSession.authorize(initialTarget, callEpoch);
        currentAuthorization = token;
        if (token === undefined) {
          throw new NotebookFailure("unread", "this notebook has not been successfully Read in the current session, or that Read is stale. Read it again before editing.");
        }
        await options.afterTokenCapture?.();

        return await withFileMutationQueue(request.notebook_path, async () => {
          checkAbort(signal);
          let first: { target: NotebookTargetIdentity; bytes: Buffer };
          try {
            const canonical = await fileOps.resolve(request.notebook_path);
            checkAbort(signal);
            const handle = await fileOps.open(canonical, "r");
            first = await useNotebookHandle(handle, async () => {
              checkAbort(signal);
              const loaded = await fileOps.inspect(
                handle, request.notebook_path, canonical, MAX_NOTEBOOK_BYTES, () => checkAbort(signal),
              );
              checkAbort(signal);
              if (!notebookSession.validate(token!, loaded.target, loaded.bytes)) {
                throw new NotebookFailure("stale", "the notebook changed after the authorizing Read. Read it again before retrying.", true);
              }
              return loaded;
            });
            checkAbort(signal);
          } catch (error) {
            if (error instanceof NotebookFailure) throw error;
            if (error instanceof NotebookSizeLimitError) {
              throw new NotebookFailure("oversize", `notebook exceeds the ${error.limit}-byte limit.`, true);
            }
            throw new NotebookFailure("unread", "the notebook became missing or unreadable. Read it again before retrying.", true);
          }

          const decoded = decodeForEdit(first.bytes);
          const document = parseForEdit(decoded.text);
          if (usesPositionalFallback(request, document) && !token!.fallbackCurrent) {
            throw new NotebookFailure("fallback", "positional cell identifiers are stale after an insert or delete. Read the notebook again before using a cell-N identifier.");
          }
          const facts = mutate(document, request, options.generateCellIdCandidate ?? randomUUID);
          const updatedBytes = serializeNotebookDocument(facts.document, decoded.format);
          if (updatedBytes.byteLength > MAX_NOTEBOOK_BYTES) {
            throw new NotebookFailure("oversize", `updated notebook exceeds the ${MAX_NOTEBOOK_BYTES}-byte limit.`);
          }

          let canonical: string;
          try {
            canonical = await fileOps.resolve(request.notebook_path);
            checkAbort(signal);
            const finalHandle = await fileOps.open(canonical, "r+");
            return await useNotebookHandle(finalHandle, async () => {
              let comparedTarget: NotebookTargetIdentity;
              try {
                checkAbort(signal);
                const compared = await fileOps.inspect(
                  finalHandle, request.notebook_path, canonical, MAX_NOTEBOOK_BYTES, () => checkAbort(signal),
                );
                comparedTarget = compared.target;
                const currentCanonical = await fileOps.resolve(request.notebook_path);
                checkAbort(signal);
                const currentHandle = await fileOps.open(currentCanonical, "r");
                await useNotebookHandle(currentHandle, async () => {
                  checkAbort(signal);
                  const current = await fileOps.inspect(
                    currentHandle, request.notebook_path, currentCanonical, MAX_NOTEBOOK_BYTES, () => checkAbort(signal),
                  );
                  checkAbort(signal);
                  if (currentCanonical !== canonical || current.target.fingerprint !== comparedTarget.fingerprint
                    || !notebookSession.validate(token!, comparedTarget, compared.bytes)
                    || !notebookSession.validate(token!, current.target, current.bytes)) {
                    throw new NotebookFailure("stale", "the notebook changed while the edit was being prepared. Read it again before retrying.", true);
                  }
                });
              } catch (error) {
                if (error instanceof NotebookFailure) throw error;
                if (error instanceof NotebookSizeLimitError) {
                  throw new NotebookFailure("oversize", `notebook exceeds the ${error.limit}-byte limit.`, true);
                }
                throw new NotebookFailure("unread", "the notebook became missing or unreadable. Read it again before retrying.", true);
              }

              checkAbort(signal);
              writingStarted = true;
              await fileOps.commit(finalHandle, updatedBytes);
              // Once commit settles, a newly observed abort is late and must not turn a completed write into failure.
              await options.afterCommit?.("before-refresh");
              currentAuthorization = notebookSession.refreshAfterEdit(
                token!, comparedTarget, updatedBytes, facts.mode !== "replace",
              );
              await options.afterCommit?.("before-result");
              return successResult(
                request,
                decoded.text,
                decodeNotebookText(updatedBytes).text,
                languageOf(document),
                modernIds(document.nbformat, document.nbformat_minor),
                facts,
              );
            });
          } catch (error) {
            if (error instanceof NotebookFailure) throw error;
            if (error instanceof NotebookSizeLimitError) {
              throw new NotebookFailure("oversize", `notebook exceeds the ${error.limit}-byte limit.`, true);
            }
            throw new NotebookFailure("unread", "the notebook became missing or unreadable. Read it again before retrying.", true);
          }
        });
      } catch (error) {
        const invalidates = writingStarted
          || (error instanceof NotebookFailure && error.invalidates)
          || error instanceof NotebookSizeLimitError;
        if (invalidates && currentAuthorization !== undefined) {
          notebookSession.invalidateIfCurrent(currentAuthorization);
        }
        return errorResult(projected, errorMessage(error, writingStarted));
      }
    },
  });
}
