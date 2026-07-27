export type NotebookEditMode = "replace" | "insert" | "delete";
export type NotebookCellType = "code" | "markdown";
export type NotebookEncoding = "utf8" | "utf16le" | "utf16be";
export type NotebookNewline = "\n" | "\r\n";

export interface NotebookCell extends Record<string, unknown> {
  cell_type: NotebookCellType;
  source: string | string[];
}

export interface NotebookDocument extends Record<string, unknown> {
  nbformat: number;
  nbformat_minor: number;
  cells: NotebookCell[];
}

export interface NotebookEditRequest {
  notebook_path: string;
  new_source: string;
  cell_id?: string;
  cell_type?: NotebookCellType;
  edit_mode?: NotebookEditMode;
}

export interface NotebookMutationOptions {
  generateCellIdCandidate?: () => string;
}

export interface NotebookMutationResult {
  document: NotebookDocument;
  mode: NotebookEditMode;
  resolvedIndex?: number;
  resultingIndex: number;
  cellType: NotebookCellType;
  previousCellType?: NotebookCellType;
  oldSource?: string;
  newSource?: string;
  addressedCellId?: string;
  generatedCellId?: string;
  persistedCellId?: string;
  clearedOutputCount: number;
  clearedExecutionCount: number;
}

export type NotebookCellIdentifier =
  | { kind: "real"; index: number; identifier: string }
  | { kind: "fallback"; index: number; identifier: string }
  | {
      kind: "unavailable-fallback";
      index: number;
      fallback: string;
      conflictingRealId: string;
    };

export interface NotebookSerializationFormat {
  encoding: NotebookEncoding;
  bom: boolean;
  newline: NotebookNewline;
}

export interface DecodedNotebookText {
  text: string;
  format: NotebookSerializationFormat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDenseStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index) || typeof value[index] !== "string") return false;
  }
  return true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Validate the notebook fields needed for safe cell mutation and return the same document. */
export function validateNotebookDocument(value: unknown): NotebookDocument {
  if (!isRecord(value)) throw new Error("Notebook document must be a JSON object");
  if (!isNonNegativeInteger(value.nbformat)) {
    throw new Error('Notebook field "nbformat" must be a non-negative integer');
  }
  if (!isNonNegativeInteger(value.nbformat_minor)) {
    throw new Error('Notebook field "nbformat_minor" must be a non-negative integer');
  }
  if (!Array.isArray(value.cells)) throw new Error('Notebook field "cells" must be an array');

  for (let index = 0; index < value.cells.length; index++) {
    if (!Object.hasOwn(value.cells, index)) {
      throw new Error(`Notebook field "cells" must be dense (missing cell ${index})`);
    }
    const cell = value.cells[index];
    if (!isRecord(cell)) throw new Error(`Notebook cell ${index} must be an object`);
    if (cell.cell_type !== "code" && cell.cell_type !== "markdown") {
      throw new Error(`Notebook cell ${index} has invalid "cell_type"`);
    }
    if (typeof cell.source !== "string" && !isDenseStringArray(cell.source)) {
      throw new Error(`Notebook cell ${index} has invalid "source"`);
    }
  }
  return value as NotebookDocument;
}

/** Parse and validate an ordinary JSON notebook document. */
export function parseNotebookDocument(jsonText: string): NotebookDocument {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error("Notebook is not valid JSON");
  }
  return validateNotebookDocument(value);
}

/** Resolve the identifiers safe to advertise for the complete cell array. */
export function resolveNotebookCellIdentifiers(cells: readonly unknown[]): NotebookCellIdentifier[] {
  const firstRealIdIndexes = new Map<string, number>();
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    if (!isRecord(cell) || typeof cell.id !== "string" || cell.id.length === 0) continue;
    if (!firstRealIdIndexes.has(cell.id)) firstRealIdIndexes.set(cell.id, index);
  }

  return cells.map((cell, index) => {
    const realId = isRecord(cell) && typeof cell.id === "string" && cell.id.length > 0
      ? cell.id
      : undefined;
    if (realId !== undefined && firstRealIdIndexes.get(realId) === index) {
      return { kind: "real", index, identifier: realId };
    }
    const fallback = `cell-${index}`;
    if (firstRealIdIndexes.has(fallback)) {
      return {
        kind: "unavailable-fallback",
        index,
        fallback,
        conflictingRealId: fallback,
      };
    }
    return { kind: "fallback", index, identifier: fallback };
  });
}

function copyRecord<T extends Record<string, unknown>>(record: T): T {
  const copy = {} as T;
  for (const key of Object.keys(record)) {
    Object.defineProperty(copy, key, {
      value: record[key],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy;
}

function sourceText(source: string | string[]): string {
  return typeof source === "string" ? source : source.join("");
}

function realCellId(cell: NotebookCell): string | undefined {
  return typeof cell.id === "string" && cell.id.length > 0 ? cell.id : undefined;
}

function validateRequest(request: NotebookEditRequest): NotebookEditMode {
  if (!isRecord(request)) throw new Error("Notebook edit request must be an object");
  if (typeof request.notebook_path !== "string" || request.notebook_path.length === 0) {
    throw new Error('Notebook edit field "notebook_path" must be a non-empty string');
  }
  if (typeof request.new_source !== "string") {
    throw new Error('Notebook edit field "new_source" must be a string');
  }
  const mode = request.edit_mode ?? "replace";
  if (mode !== "replace" && mode !== "insert" && mode !== "delete") {
    throw new Error('Notebook edit field "edit_mode" must be replace, insert, or delete');
  }
  if (request.cell_id !== undefined && (typeof request.cell_id !== "string" || request.cell_id.length === 0)) {
    throw new Error('Notebook edit field "cell_id" must be a non-empty string when supplied');
  }
  if (request.cell_type !== undefined && request.cell_type !== "code" && request.cell_type !== "markdown") {
    throw new Error('Notebook edit field "cell_type" must be code or markdown');
  }
  if (mode === "insert" && request.cell_type === undefined) {
    throw new Error('Notebook insert requires "cell_type"');
  }
  if (mode !== "insert" && request.cell_id === undefined) {
    throw new Error(`Notebook ${mode} requires "cell_id"`);
  }
  return mode;
}

function resolveTargetIndex(cells: readonly NotebookCell[], cellId: string): number {
  const realIndex = cells.findIndex((cell) => realCellId(cell) === cellId);
  if (realIndex >= 0) return realIndex;

  const fallback = /^cell-(\d+)$/.exec(cellId);
  if (fallback !== null) {
    const index = Number(fallback[1]);
    if (Number.isSafeInteger(index) && index < cells.length) return index;
  }
  throw new Error(`Notebook cell "${cellId}" was not found`);
}

function supportsCellIds(document: NotebookDocument): boolean {
  return document.nbformat > 4 || (document.nbformat === 4 && document.nbformat_minor >= 5);
}

function normalizeGeneratedId(candidate: string): string {
  if (/^[0-9a-fA-F]{8}$/.test(candidate)) return candidate.toLowerCase();
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(candidate)) {
    return candidate.slice(0, 8).toLowerCase();
  }
  throw new Error("Notebook cell ID generator must return an eight-character hex ID or UUID");
}

function generateUniqueCellId(document: NotebookDocument, options: NotebookMutationOptions): string {
  if (options.generateCellIdCandidate === undefined) {
    throw new Error("Notebook insert requires a cell ID candidate generator for this nbformat");
  }
  const existing = new Set(
    document.cells.map(realCellId).filter((id): id is string => id !== undefined),
  );
  for (let attempt = 0; attempt < 1024; attempt++) {
    const candidate = normalizeGeneratedId(options.generateCellIdCandidate());
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("Notebook cell ID generator could not produce a collision-free ID");
}

/** Apply one Claude-compatible cell mutation without modifying the input document. */
export function applyNotebookMutation(
  input: NotebookDocument,
  request: NotebookEditRequest,
  options: NotebookMutationOptions = {},
): NotebookMutationResult {
  const document = validateNotebookDocument(input);
  const mode = validateRequest(request);
  const cells = document.cells.slice();
  const updatedDocument = copyRecord(document);
  updatedDocument.cells = cells;

  if (mode === "insert") {
    const resolvedIndex = request.cell_id === undefined
      ? undefined
      : resolveTargetIndex(document.cells, request.cell_id);
    const resultingIndex = resolvedIndex === undefined ? 0 : resolvedIndex + 1;
    const generatedCellId = supportsCellIds(document) ? generateUniqueCellId(document, options) : undefined;
    const inserted: NotebookCell = request.cell_type === "code"
      ? { cell_type: "code", metadata: {}, source: request.new_source, execution_count: null, outputs: [] }
      : { cell_type: "markdown", metadata: {}, source: request.new_source };
    if (generatedCellId !== undefined) inserted.id = generatedCellId;
    cells.splice(resultingIndex, 0, inserted);
    return {
      document: updatedDocument,
      mode,
      resolvedIndex,
      resultingIndex,
      cellType: request.cell_type!,
      newSource: request.new_source,
      generatedCellId,
      persistedCellId: generatedCellId,
      clearedOutputCount: 0,
      clearedExecutionCount: 0,
    };
  }

  const addressedCellId = request.cell_id!;
  const resolvedIndex = resolveTargetIndex(document.cells, addressedCellId);
  const originalCell = document.cells[resolvedIndex]!;
  const previousCellType = originalCell.cell_type;
  const oldSource = sourceText(originalCell.source);
  const persistedCellId = realCellId(originalCell);

  if (mode === "delete") {
    cells.splice(resolvedIndex, 1);
    return {
      document: updatedDocument,
      mode,
      resolvedIndex,
      resultingIndex: resolvedIndex,
      cellType: previousCellType,
      previousCellType,
      oldSource,
      addressedCellId,
      persistedCellId,
      clearedOutputCount: 0,
      clearedExecutionCount: 0,
    };
  }

  const replacement = copyRecord(originalCell);
  let clearedOutputCount = 0;
  let clearedExecutionCount = 0;
  if (previousCellType === "code") {
    clearedOutputCount = Array.isArray(originalCell.outputs) ? originalCell.outputs.length : 0;
    clearedExecutionCount = originalCell.execution_count === null || originalCell.execution_count === undefined ? 0 : 1;
    replacement.outputs = [];
    replacement.execution_count = null;
  }
  replacement.source = request.new_source;
  if (request.cell_type !== undefined) replacement.cell_type = request.cell_type;
  cells[resolvedIndex] = replacement;

  return {
    document: updatedDocument,
    mode,
    resolvedIndex,
    resultingIndex: resolvedIndex,
    cellType: replacement.cell_type,
    previousCellType,
    oldSource,
    newSource: request.new_source,
    addressedCellId,
    persistedCellId,
    clearedOutputCount,
    clearedExecutionCount,
  };
}

/** Detect the dominant newline convention in decoded notebook text. */
export function detectNotebookNewline(text: string): NotebookNewline {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function decodeText(bytes: Uint8Array, encoding: "utf-8" | "utf-16le" | "utf-16be"): string {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Notebook contains invalid ${encoding.toUpperCase()} text`);
  }
}

/** Decode supported notebook bytes and retain the format needed for serialization. */
export function decodeNotebookText(bytes: Uint8Array): DecodedNotebookText {
  const buffer = Buffer.from(bytes);
  let text: string;
  let encoding: NotebookEncoding;
  let bom: boolean;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    bom = true;
    text = decodeText(buffer.subarray(2), "utf-16le");
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be";
    bom = true;
    text = decodeText(buffer.subarray(2), "utf-16be");
  } else if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    encoding = "utf8";
    bom = true;
    text = decodeText(buffer.subarray(3), "utf-8");
  } else {
    encoding = "utf8";
    bom = false;
    text = decodeText(buffer, "utf-8");
  }
  return { text, format: { encoding, bom, newline: detectNotebookNewline(text) } };
}

function encodeUtf16Be(text: string): Buffer {
  const littleEndian = Buffer.from(text, "utf16le");
  const bigEndian = Buffer.allocUnsafe(littleEndian.length);
  for (let index = 0; index < littleEndian.length; index += 2) {
    bigEndian[index] = littleEndian[index + 1]!;
    bigEndian[index + 1] = littleEndian[index]!;
  }
  return bigEndian;
}

/** Serialize one-space-indented notebook JSON in the caller-selected text format. */
export function serializeNotebookDocument(
  document: NotebookDocument,
  format: NotebookSerializationFormat,
): Buffer {
  validateNotebookDocument(document);
  const lfText = JSON.stringify(document, null, 1);
  const text = format.newline === "\r\n" ? lfText.replaceAll("\n", "\r\n") : lfText;
  let body: Buffer;
  let marker = Buffer.alloc(0);
  switch (format.encoding) {
    case "utf8":
      body = Buffer.from(text, "utf8");
      if (format.bom) marker = Buffer.from([0xef, 0xbb, 0xbf]);
      break;
    case "utf16le":
      body = Buffer.from(text, "utf16le");
      if (format.bom) marker = Buffer.from([0xff, 0xfe]);
      break;
    case "utf16be":
      body = encodeUtf16Be(text);
      if (format.bom) marker = Buffer.from([0xfe, 0xff]);
      break;
  }
  return Buffer.concat([marker, body]);
}
