import { describe, expect, it } from "vitest";
import {
  applyNotebookMutation,
  decodeNotebookText,
  detectNotebookNewline,
  parseNotebookDocument,
  resolveNotebookCellIdentifiers,
  serializeNotebookDocument,
  validateNotebookDocument,
  type NotebookDocument,
  type NotebookEditRequest,
} from "../src/runtime/notebook-edit-core.js";

function notebook(cells: unknown[], minor = 5): NotebookDocument {
  return validateNotebookDocument({ nbformat: 4, nbformat_minor: minor, metadata: {}, cells });
}

function request(fields: Partial<NotebookEditRequest> = {}): NotebookEditRequest {
  return { notebook_path: "/work/book.ipynb", new_source: "new", cell_id: "first", ...fields };
}

describe("notebook document validation", () => {
  it.each([
    ["null root", null],
    ["array root", []],
    ["missing cells", { nbformat: 4, nbformat_minor: 5 }],
    ["non-array cells", { nbformat: 4, nbformat_minor: 5, cells: {} }],
    ["non-object cell", { nbformat: 4, nbformat_minor: 5, cells: [null] }],
    ["unsupported cell type", { nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: "raw", source: "x" }] }],
    ["invalid source", { nbformat: 4, nbformat_minor: 5, cells: [{ cell_type: "code", source: ["x", 2] }] }],
    ["missing nbformat", { nbformat_minor: 5, cells: [] }],
    ["string nbformat", { nbformat: "4", nbformat_minor: 5, cells: [] }],
    ["negative nbformat", { nbformat: -1, nbformat_minor: 5, cells: [] }],
    ["fractional nbformat", { nbformat: 4.5, nbformat_minor: 5, cells: [] }],
    ["missing minor", { nbformat: 4, cells: [] }],
    ["string minor", { nbformat: 4, nbformat_minor: "5", cells: [] }],
    ["negative minor", { nbformat: 4, nbformat_minor: -1, cells: [] }],
    ["fractional minor", { nbformat: 4, nbformat_minor: 0.5, cells: [] }],
  ])("rejects %s", (_name, value) => {
    expect(() => validateNotebookDocument(value)).toThrow();
  });

  it("rejects sparse cell and source arrays", () => {
    const cells = new Array(1);
    expect(() => validateNotebookDocument({ nbformat: 4, nbformat_minor: 5, cells })).toThrow(/dense/);
    const source = new Array(1);
    expect(() => validateNotebookDocument({
      nbformat: 4,
      nbformat_minor: 5,
      cells: [{ cell_type: "code", source }],
    })).toThrow(/source/);
  });

  it("parses a valid JSON notebook and reports malformed JSON without disclosing content", () => {
    expect(parseNotebookDocument('{"nbformat":4,"nbformat_minor":5,"cells":[]}').cells).toEqual([]);
    const sentinel = "PRIVATE_NOTEBOOK_SENTINEL";
    let message = "";
    try {
      parseNotebookDocument(`{"${sentinel}": }`);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not valid JSON/);
    expect(message).not.toContain(sentinel);
  });
});

describe("notebook cell identifiers", () => {
  it("makes duplicate real IDs and positional collisions safe for display and lookup", () => {
    const document = notebook([
      { cell_type: "code", source: "first", id: "dup" },
      { cell_type: "markdown", source: "safe duplicate", id: "dup" },
      { cell_type: "code", source: "blocked duplicate", id: "dup" },
      { cell_type: "markdown", source: "owns duplicate fallback", id: "cell-2" },
      { cell_type: "code", source: "safe idless" },
      { cell_type: "markdown", source: "blocked idless" },
      { cell_type: "code", source: "owns idless fallback", id: "cell-5" },
    ]);
    const identifiers = resolveNotebookCellIdentifiers(document.cells);
    expect(identifiers).toEqual([
      { kind: "real", index: 0, identifier: "dup" },
      { kind: "fallback", index: 1, identifier: "cell-1" },
      { kind: "unavailable-fallback", index: 2, fallback: "cell-2", conflictingRealId: "cell-2" },
      { kind: "real", index: 3, identifier: "cell-2" },
      { kind: "fallback", index: 4, identifier: "cell-4" },
      { kind: "unavailable-fallback", index: 5, fallback: "cell-5", conflictingRealId: "cell-5" },
      { kind: "real", index: 6, identifier: "cell-5" },
    ]);

    for (const identifier of identifiers) {
      if (identifier.kind === "unavailable-fallback") continue;
      const result = applyNotebookMutation(document, request({ cell_id: identifier.identifier }));
      expect(result.resolvedIndex).toBe(identifier.index);
    }
  });
});

describe("applyNotebookMutation", () => {
  it("defaults to replace, accepts real and fallback IDs, and preserves source-array meaning", () => {
    const input = notebook([
      { cell_type: "markdown", id: "first", source: ["old\n", "text"], metadata: { keep: true } },
      { cell_type: "code", source: "second", outputs: [] },
    ]);
    const real = applyNotebookMutation(input, request());
    expect(real).toMatchObject({
      mode: "replace",
      resolvedIndex: 0,
      resultingIndex: 0,
      addressedCellId: "first",
      persistedCellId: "first",
      oldSource: "old\ntext",
      newSource: "new",
      cellType: "markdown",
    });
    expect(real.document.cells[0]).toMatchObject({ source: "new", metadata: { keep: true } });

    const fallback = applyNotebookMutation(input, request({ cell_id: "cell-1", new_source: "fallback" }));
    expect(fallback.resolvedIndex).toBe(1);
    expect(fallback.document.cells[1]!.source).toBe("fallback");
  });

  it("gives an exact real cell-N ID precedence and selects the first duplicate real ID", () => {
    const input = notebook([
      { cell_type: "code", id: "dup", source: "zero" },
      { cell_type: "code", id: "cell-2", source: "one" },
      { cell_type: "code", id: "dup", source: "two" },
    ]);
    expect(applyNotebookMutation(input, request({ cell_id: "cell-2" })).resolvedIndex).toBe(1);
    expect(applyNotebookMutation(input, request({ cell_id: "dup" })).resolvedIndex).toBe(0);
  });

  it("rejects missing and out-of-range targets", () => {
    const input = notebook([{ cell_type: "code", id: "first", source: "x" }]);
    expect(() => applyNotebookMutation(input, request({ cell_id: "cell-9" }))).toThrow(/not found/);
    expect(() => applyNotebookMutation(input, request({ cell_id: "missing" }))).toThrow(/not found/);
  });

  it.each([
    ["non-object request", null],
    ["empty path", request({ notebook_path: "" })],
    ["non-string path", request({ notebook_path: 1 as never })],
    ["missing source", request({ new_source: undefined as never })],
    ["non-string source", request({ new_source: 1 as never })],
    ["empty ID", request({ cell_id: "" })],
    ["non-string ID", request({ cell_id: 1 as never })],
    ["invalid type", request({ cell_type: "raw" as never })],
    ["invalid mode", request({ edit_mode: "bogus" as never })],
    ["replace without target", request({ cell_id: undefined })],
    ["delete without target", request({ edit_mode: "delete", cell_id: undefined })],
    ["insert without type", request({ edit_mode: "insert", cell_type: undefined })],
  ])("rejects malformed request: %s", (_name, malformed) => {
    const input = notebook([{ cell_type: "code", id: "first", source: "x" }]);
    expect(() => applyNotebookMutation(input, malformed as NotebookEditRequest)).toThrow();
  });

  it("clears stale code execution state even for identical source and before code-to-markdown conversion", () => {
    const input = notebook([{
      cell_type: "code",
      id: "first",
      source: "same",
      execution_count: 7,
      outputs: [{ output_type: "stream", text: "stale" }],
      custom: "keep",
    }]);
    const result = applyNotebookMutation(input, request({ new_source: "same", cell_type: "markdown" }));
    expect(result).toMatchObject({
      previousCellType: "code",
      cellType: "markdown",
      clearedOutputCount: 1,
      clearedExecutionCount: 1,
    });
    expect(result.document.cells[0]).toMatchObject({
      cell_type: "markdown",
      source: "same",
      outputs: [],
      execution_count: null,
      custom: "keep",
    });
  });

  it("does not synthesize execution fields for markdown-to-code conversion", () => {
    const input = notebook([{ cell_type: "markdown", id: "first", source: "old", attachments: { keep: {} } }]);
    const result = applyNotebookMutation(input, request({ cell_type: "code" }));
    expect(result.document.cells[0]).toEqual({
      cell_type: "code",
      id: "first",
      source: "new",
      attachments: { keep: {} },
    });
    expect(result.clearedOutputCount).toBe(0);
  });

  it("inserts at the beginning or immediately after a target with type-specific fields", () => {
    const input = notebook([{ cell_type: "markdown", id: "first", source: "old" }], 4);
    const beginning = applyNotebookMutation(input, request({ edit_mode: "insert", cell_id: undefined, cell_type: "markdown" }));
    expect(beginning.resultingIndex).toBe(0);
    expect(beginning.document.cells[0]).toEqual({ cell_type: "markdown", metadata: {}, source: "new" });

    const after = applyNotebookMutation(input, request({ edit_mode: "insert", cell_type: "code" }));
    expect(after.resultingIndex).toBe(1);
    expect(after.document.cells[1]).toEqual({
      cell_type: "code",
      metadata: {},
      source: "new",
      execution_count: null,
      outputs: [],
    });
  });

  it("inserts and deletes through fallback IDs without mutating input or unrelated data", () => {
    const input = notebook([
      { cell_type: "markdown", source: "anchor", metadata: { anchorCanary: true } },
      { cell_type: "code", source: "target", metadata: { targetCanary: true }, outputs: [{ keep: true }] },
      { cell_type: "markdown", source: "untouched", attachments: { untouchedCanary: true } },
    ], 4);
    input.metadata = { notebookCanary: true };
    input.custom_top_level = { unknownCanary: true };
    const before = JSON.stringify(input);

    const inserted = applyNotebookMutation(
      input,
      request({ edit_mode: "insert", cell_id: "cell-0", cell_type: "markdown", new_source: "inserted" }),
    );
    expect(inserted.resolvedIndex).toBe(0);
    expect(inserted.resultingIndex).toBe(1);
    expect(inserted.document.metadata).toEqual({ notebookCanary: true });
    expect(inserted.document.custom_top_level).toEqual({ unknownCanary: true });
    expect(inserted.document.cells[0]).toEqual(input.cells[0]);
    expect(inserted.document.cells[2]).toEqual(input.cells[1]);
    expect(inserted.document.cells[3]).toEqual(input.cells[2]);

    const deleted = applyNotebookMutation(input, request({ edit_mode: "delete", cell_id: "cell-1" }));
    expect(deleted.resolvedIndex).toBe(1);
    expect(deleted.document.metadata).toEqual({ notebookCanary: true });
    expect(deleted.document.custom_top_level).toEqual({ unknownCanary: true });
    expect(deleted.document.cells).toEqual([input.cells[0], input.cells[2]]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("omits IDs in old formats, supports nbformat above 4, and retries deterministic modern-ID collisions", () => {
    const old = notebook([{ cell_type: "markdown", id: "first", source: "old" }], 4);
    const oldResult = applyNotebookMutation(old, request({ edit_mode: "insert", cell_type: "markdown" }));
    expect(oldResult.generatedCellId).toBeUndefined();
    expect(oldResult.document.cells[1]).not.toHaveProperty("id");

    const modern = notebook([{ cell_type: "code", id: "deadbeef", source: "old" }]);
    const candidates = ["deadbeef", "12345678-1234-1234-1234-123456789abc"];
    const result = applyNotebookMutation(
      modern,
      request({ edit_mode: "insert", cell_id: "deadbeef", cell_type: "code" }),
      { generateCellIdCandidate: () => candidates.shift()! },
    );
    expect(result.generatedCellId).toBe("12345678");
    expect(result.persistedCellId).toBe("12345678");
    expect(result.document.cells[1]!.id).toBe("12345678");

    const future = validateNotebookDocument({
      nbformat: 5,
      nbformat_minor: 0,
      cells: [{ cell_type: "markdown", id: "first", source: "old" }],
    });
    const futureResult = applyNotebookMutation(
      future,
      request({ edit_mode: "insert", cell_type: "markdown" }),
      { generateCellIdCandidate: () => "ABCDEF12" },
    );
    expect(futureResult.document.cells[1]!.id).toBe("abcdef12");
  });

  it.each([
    "1234567",
    "123456789",
    "12345678123412341234123456789abc",
    "12345678-1234-1234-1234-123456789ab",
    "12345678-1234-1234-1234-123456789abz",
    "{12345678-1234-1234-1234-123456789abc}",
    " 12345678",
  ])("rejects generated ID candidate outside the exact supported shapes: %s", (candidate) => {
    const input = notebook([{ cell_type: "code", id: "first", source: "old" }]);
    expect(() => applyNotebookMutation(
      input,
      request({ edit_mode: "insert", cell_type: "code" }),
      { generateCellIdCandidate: () => candidate },
    )).toThrow(/eight-character hex ID or UUID/);
  });

  it("deletes exactly one final cell and ignores supplied cell_type and new_source", () => {
    const input = notebook([
      { cell_type: "code", id: "first", source: "keep" },
      { cell_type: "markdown", id: "last", source: "remove", attachments: { image: {} } },
    ]);
    const result = applyNotebookMutation(input, request({
      edit_mode: "delete",
      cell_id: "last",
      cell_type: "code",
      new_source: "ignored",
    }));
    expect(result).toMatchObject({
      resolvedIndex: 1,
      resultingIndex: 1,
      cellType: "markdown",
      oldSource: "remove",
      addressedCellId: "last",
      persistedCellId: "last",
    });
    expect(result.newSource).toBeUndefined();
    expect(result.document.cells).toHaveLength(1);
  });

  it("does not mutate input and preserves notebook, cell, output, and prototype-like keys as inert data", () => {
    const input = parseNotebookDocument(`{
      "nbformat": 4,
      "nbformat_minor": 5,
      "metadata": { "notebookCanary": true },
      "__proto__": "root-data",
      "constructor": "root-constructor",
      "prototype": "root-prototype",
      "cells": [{
        "cell_type": "code",
        "id": "first",
        "source": "old",
        "metadata": { "cellCanary": true },
        "outputs": [{ "output_type": "stream", "text": "stale" }],
        "__proto__": "cell-data"
      }, {
        "cell_type": "code",
        "id": "untouched",
        "source": ["keep", " me"],
        "metadata": { "untouchedCellCanary": true },
        "outputs": [{ "output_type": "display_data", "data": { "image/png": "payload", "outputCanary": true } }]
      }]
    }`);
    const before = JSON.stringify(input);
    const result = applyNotebookMutation(input, request());
    expect(JSON.stringify(input)).toBe(before);
    expect(result.document.metadata).toEqual({ notebookCanary: true });
    expect(Object.hasOwn(result.document, "__proto__")).toBe(true);
    expect(Object.hasOwn(result.document, "constructor")).toBe(true);
    expect(Object.hasOwn(result.document, "prototype")).toBe(true);
    expect(Object.getPrototypeOf(result.document)).toBe(Object.prototype);
    expect(Object.hasOwn(result.document.cells[0]!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result.document.cells[0]!)).toBe(Object.prototype);
    expect(result.document.cells[0]!.metadata).toEqual({ cellCanary: true });
    expect(result.document.cells[0]!.outputs).toEqual([]);
    expect(result.document.cells[1]).toEqual(input.cells[1]);
    expect(result.document.cells[1]!.outputs).toEqual([
      { output_type: "display_data", data: { "image/png": "payload", outputCanary: true } },
    ]);
  });
});

describe("notebook serialization", () => {
  const document = notebook([{ cell_type: "markdown", source: "line1\nline2" }]);

  it("chooses the dominant newline and resolves a mixed-newline tie to LF", () => {
    expect(detectNotebookNewline("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectNotebookNewline("a\nb\nc\r\n")).toBe("\n");
    expect(detectNotebookNewline("a\r\nb\n")).toBe("\n");
  });

  it("emits deterministic one-space JSON with LF or CRLF independent of the platform", () => {
    const lf = serializeNotebookDocument(document, { encoding: "utf8", bom: false, newline: "\n" }).toString("utf8");
    expect(lf).toBe(JSON.stringify(document, null, 1));
    expect(lf).toContain('\n "cells": [\n  {');

    const crlf = serializeNotebookDocument(document, { encoding: "utf8", bom: false, newline: "\r\n" }).toString("utf8");
    expect(crlf).toBe(JSON.stringify(document, null, 1).replaceAll("\n", "\r\n"));
    expect(crlf.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("preserves UTF-8 and UTF-16 BOM/encoding choices", () => {
    const formats = [
      { encoding: "utf8", bom: true, newline: "\n", marker: [0xef, 0xbb, 0xbf] },
      { encoding: "utf16le", bom: true, newline: "\n", marker: [0xff, 0xfe] },
      { encoding: "utf16be", bom: true, newline: "\r\n", marker: [0xfe, 0xff] },
    ] as const;
    for (const { marker, ...format } of formats) {
      const bytes = serializeNotebookDocument(document, format);
      expect([...bytes.subarray(0, marker.length)]).toEqual([...marker]);
      const decoded = decodeNotebookText(bytes);
      expect(decoded.format).toEqual(format);
      expect(parseNotebookDocument(decoded.text)).toEqual(document);
    }
  });
});
