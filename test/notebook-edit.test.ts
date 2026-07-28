import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NotebookSessionState,
  identifyNotebookHandle,
  inspectNotebookHandle,
  newestNotebookSessionSnapshot,
  normalizeNotebookPathForPlatform,
  readNotebookBytesBounded,
  resolveNotebookTarget,
} from "../src/runtime/notebook-session.js";
import { decodeNotebookText } from "../src/runtime/notebook-edit-core.js";
import { MAX_NOTEBOOK_BYTES } from "../src/runtime/notebook-render.js";
import { createNotebookEditTool } from "../src/runtime/tools/notebook-edit.js";
import { deferred } from "./helpers/async.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { minor?: number; newline?: "\n" | "\r\n"; bom?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-notebook-edit-"));
  dirs.push(dir);
  const file = path.join(dir, "book.ipynb");
  const document = {
    cells: [
      { cell_type: "code", id: "real-code", metadata: {}, source: "old", execution_count: 2, outputs: [{ output_type: "stream", text: "old output" }] },
      { cell_type: "markdown", id: "real-md", metadata: { keep: true }, source: ["hello\n", "world"] },
    ],
    metadata: { language_info: { name: "julia" }, keep: { nested: true } },
    nbformat: 4,
    nbformat_minor: options.minor ?? 5,
  };
  let text = JSON.stringify(document, null, 1);
  if (options.newline === "\r\n") text = text.replaceAll("\n", "\r\n");
  const bytes = Buffer.from(text);
  fs.writeFileSync(file, options.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes);
  return { dir, file };
}

async function authorize(state: NotebookSessionState, file: string): Promise<void> {
  const target = await resolveNotebookTarget(file);
  state.recordRead(target, await readNotebookBytesBounded(target.canonicalPath, 25 * 1024 * 1024));
}

interface TestToolResult {
  content: Array<{ type: string; text?: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

function editor(dir: string, state: NotebookSessionState, options?: Parameters<typeof createNotebookEditTool>[2]) {
  const tool = createNotebookEditTool(() => dir, state, options);
  return async (params: unknown, signal?: AbortSignal): Promise<TestToolResult> =>
    tool.execute("call", params as never, signal, undefined, {} as never) as unknown as Promise<TestToolResult>;
}

function resultText(result: Awaited<ReturnType<ReturnType<typeof editor>>>): string {
  return (result.content[0] as { text: string }).text;
}

function stringDetails(result: TestToolResult): Record<string, unknown> {
  return Object.fromEntries(Object.keys(result.details).map((key) => [key, result.details[key]]));
}

describe("NotebookEdit authorization and mutation", () => {
  it("captures a session resolver once before path work and keeps that state for the whole call", async () => {
    const { dir, file } = fixture();
    const authorized = new NotebookSessionState();
    await authorize(authorized, file);
    let active = authorized;
    let resolutions = 0;
    const tool = createNotebookEditTool(
      () => dir,
      () => {
        resolutions++;
        return active;
      },
      { afterTokenCapture: () => { active = new NotebookSessionState(); } },
    );

    const result = await tool.execute("call", {
      notebook_path: "book.ipynb",
      new_source: "captured state",
      cell_id: "real-code",
    } as never, undefined, undefined, {} as never) as unknown as TestToolResult;

    expect(result.isError).not.toBe(true);
    expect(resolutions).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("captured state");
  });

  it("rejects edit-before-read without touching the file", async () => {
    const { dir, file } = fixture();
    const before = fs.readFileSync(file);
    const result = await editor(dir, new NotebookSessionState())({ notebook_path: "book.ipynb", new_source: "new", cell_id: "real-code" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("Read");
    expect(resultText(result)).toContain("No changes were written.");
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("replaces sequentially, clears stale code execution state, and returns Claude-shaped output", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state);
    const first = await run({ notebook_path: file, new_source: "print(2)", cell_id: "real-code", cell_type: "markdown", edit_mode: "replace" });
    expect(resultText(first)).toBe("Updated cell real-code with print(2)");
    expect(first.details).toMatchObject({
      new_source: "print(2)", old_source: "old", cell_id: "real-code", cell_type: "markdown",
      language: "julia", edit_mode: "replace", notebook_path: file,
    });
    const saved = JSON.parse(decodeNotebookText(fs.readFileSync(file)).text);
    expect(saved.metadata.keep).toEqual({ nested: true });
    expect(saved.cells[0]).toMatchObject({ cell_type: "markdown", source: "print(2)", execution_count: null, outputs: [] });

    const second = await run({ notebook_path: file, new_source: "again", cell_id: "real-code" });
    expect(second.isError).not.toBe(true);
    expect(JSON.parse(decodeNotebookText(fs.readFileSync(file)).text).cells[0].source).toBe("again");
  });

  it("detects an external same-size change and recovers after a fresh read", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const originalStat = fs.statSync(file);
    const changed = fs.readFileSync(file, "utf8").replace('"old"', '"NEW"');
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, originalStat.atime, originalStat.mtime);
    const run = editor(dir, state);
    const stale = await run({ notebook_path: file, new_source: "x", cell_id: "real-code" });
    expect(stale.isError).toBe(true);
    expect(resultText(stale)).toContain("Read it again");
    expect(fs.readFileSync(file, "utf8")).toBe(changed);
    await authorize(state, file);
    expect((await run({ notebook_path: file, new_source: "ok", cell_id: "real-code" })).isError).not.toBe(true);
  });

  it("makes positional IDs stale after insertion while retaining exact real IDs", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state, { generateCellIdCandidate: () => "1234abcd" });
    const inserted = await run({ notebook_path: file, new_source: "new cell", cell_id: "cell-0", cell_type: "code", edit_mode: "insert" });
    expect(resultText(inserted)).toBe("Inserted cell 1234abcd with new cell");
    const beforeStale = fs.readFileSync(file);
    const stale = await run({ notebook_path: file, new_source: "bad", cell_id: "cell-1" });
    expect(resultText(stale)).toContain("positional cell identifiers are stale");
    expect(fs.readFileSync(file)).toEqual(beforeStale);
    expect((await run({ notebook_path: file, new_source: "exact", cell_id: "real-md" })).isError).not.toBe(true);
    await authorize(state, file);
    expect((await run({ notebook_path: file, new_source: "fresh", cell_id: "cell-2" })).isError).not.toBe(true);
  });

  it("deterministically rejects a second same-generation queued edit after the first refreshes state", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const firstRead = deferred<void>();
    const release = deferred<void>();
    let inspections = 0;
    const run = editor(dir, state, { fileOps: { inspect: async (...args) => {
      inspections++;
      if (inspections === 2) {
        firstRead.resolve();
        await release.promise;
      }
      return inspectNotebookHandle(...args);
    } } });
    const a = run({ notebook_path: file, new_source: "A", cell_id: "real-code" });
    await firstRead.promise;
    const b = run({ notebook_path: file, new_source: "B", cell_id: "real-code" });
    release.resolve();
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult.isError).not.toBe(true);
    expect(bResult.isError).toBe(true);
    expect(resultText(bResult)).toContain("changed after the authorizing Read");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("A");
    const c = await run({ notebook_path: file, new_source: "C", cell_id: "real-code" });
    expect(c.isError).not.toBe(true);
  });

  it("catches an external change in the final pre-write reread", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    let inspections = 0;
    const run = editor(dir, state, { fileOps: { inspect: async (...args) => {
      inspections++;
      if (inspections === 3) {
        const target = args[2];
        const changed = fs.readFileSync(target, "utf8").replace('"old"', '"EXT"');
        fs.writeFileSync(target, changed);
      }
      return inspectNotebookHandle(...args);
    } } });
    const result = await run({ notebook_path: file, new_source: "ours", cell_id: "real-code" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("changed while the edit was being prepared");
    expect(fs.readFileSync(file, "utf8")).toContain('"EXT"');
    expect(fs.readFileSync(file, "utf8")).not.toContain('"ours"');
  });

  it("preserves a UTF-8 BOM and CRLF convention", async () => {
    const { dir, file } = fixture({ newline: "\r\n", bom: true });
    const state = new NotebookSessionState();
    await authorize(state, file);
    await editor(dir, state)({ notebook_path: file, new_source: "line1\nline2", cell_id: "real-code" });
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const text = bytes.subarray(3).toString("utf8");
    expect(text).toContain("\r\n");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("pins delete output and the requested-type/default compatibility quirk", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state);
    const markdown = await run({ notebook_path: file, new_source: "changed markdown", cell_id: "real-md" });
    expect(markdown.details).toMatchObject({ cell_type: "code", old_source: "hello\nworld" });
    const deleted = await run({ notebook_path: file, new_source: "ignored", cell_id: "real-md", edit_mode: "delete", cell_type: "markdown" });
    expect(resultText(deleted)).toBe("Deleted cell real-md");
    expect(deleted.details).toMatchObject({ cell_id: "real-md", cell_type: "markdown", edit_mode: "delete" });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells).toHaveLength(1);
  });

  it("uses Claude's default compatibility fields for recoverable errors", async () => {
    const { dir, file } = fixture();
    const result = await editor(dir, new NotebookSessionState())({
      notebook_path: file, new_source: "source", cell_id: "missing", cell_type: "markdown", edit_mode: "delete",
    });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      new_source: "source", cell_id: "missing", cell_type: "code", language: "python",
      edit_mode: "replace", original_file: "", updated_file: "", error: expect.any(String),
    });
  });

  it("pins old-format undefined text and omitted structured cell ID", async () => {
    const { dir, file } = fixture({ minor: 4 });
    const state = new NotebookSessionState();
    await authorize(state, file);
    const result = await editor(dir, state)({ notebook_path: file, new_source: "old format", cell_id: "real-code" });
    expect(resultText(result)).toBe("Updated cell undefined with old format");
    expect(result.details).not.toHaveProperty("cell_id");
    const deleted = await editor(dir, state)({ notebook_path: file, new_source: "", cell_id: "real-code", edit_mode: "delete" });
    expect(resultText(deleted)).toBe("Deleted cell undefined");
    expect(deleted.details).not.toHaveProperty("cell_id");
  });

  it("invalidates state when a write changes bytes and then throws, without claiming no write", async () => {
    const { dir, file } = fixture();
    const observed: Array<ReturnType<NotebookSessionState["serialize"]>> = [];
    const state = new NotebookSessionState({ onChange: (snapshot) => observed.push(snapshot) });
    await authorize(state, file);
    observed.length = 0;
    const run = editor(dir, state, { fileOps: { commit: async (handle, bytes) => {
      await handle.write(bytes, 0, bytes.byteLength, 0);
      await handle.truncate(bytes.byteLength);
      throw new Error("late failure");
    } } });
    const failed = await run({ notebook_path: file, new_source: "written", cell_id: "real-code" });
    expect(failed.isError).toBe(true);
    expect(resultText(failed)).toContain("may have changed");
    expect(resultText(failed)).not.toContain("No changes were written");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("written");
    expect(observed.at(-1)?.records).toEqual([]);
    const retry = await editor(dir, state)({ notebook_path: file, new_source: "retry", cell_id: "real-code" });
    expect(retry.isError).toBe(true);
  });
});

describe("NotebookEdit compatibility, failure, and filesystem matrix", () => {
  it("covers the complete schema-bypass field matrix without writes or secret leakage", async () => {
    const { dir, file } = fixture();
    const run = editor(dir, new NotebookSessionState());
    const before = fs.readFileSync(file);
    const cases: Array<{ input: unknown; message: string; normalized?: boolean }> = [
      { input: null, message: "input must be an object" },
      { input: undefined, message: "input must be an object" },
      { input: 1, message: "input must be an object" },
      { input: "x", message: "input must be an object" },
      { input: true, message: "input must be an object" },
      { input: [], message: "input must be an object" },
      { input: { notebook_path: file, new_source: "x", cell_id: "real-code", surprise: "SECRET_FIELD" }, message: "unexpected input field", normalized: true },
      { input: { new_source: "x", cell_id: "real-code" }, message: "notebook_path must be a non-empty string" },
      { input: { notebook_path: 4, new_source: "x", cell_id: "real-code" }, message: "notebook_path must be a non-empty string" },
      { input: { notebook_path: "book.txt", new_source: "x", cell_id: "real-code" }, message: "notebook_path", normalized: false },
      { input: { notebook_path: file, cell_id: "real-code" }, message: "new_source must be a string", normalized: true },
      { input: { notebook_path: file, new_source: 4, cell_id: "real-code" }, message: "new_source must be a string", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: 4 }, message: "cell_id must be a non-empty string", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: "" }, message: "cell_id must be a non-empty string", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: "real-code", cell_type: 4 }, message: "cell_type must be", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: "real-code", cell_type: "raw" }, message: "cell_type must be", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: "real-code", edit_mode: 4 }, message: "edit_mode must be", normalized: true },
      { input: { notebook_path: file, new_source: "x", cell_id: "real-code", edit_mode: "move" }, message: "edit_mode must be", normalized: true },
      { input: { notebook_path: file, new_source: "x" }, message: "replace requires cell_id", normalized: true },
      { input: { notebook_path: file, new_source: "x", edit_mode: "delete" }, message: "delete requires cell_id", normalized: true },
      { input: { notebook_path: file, new_source: "x", edit_mode: "insert" }, message: "insert requires cell_type", normalized: true },
    ];
    for (const testCase of cases) {
      const result = await run(testCase.input);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(testCase.message);
      expect(resultText(result)).not.toContain("SECRET");
      expect(result.details.notebook_path).toBe(testCase.normalized ? file : "");
      expect(fs.readFileSync(file)).toEqual(before);
    }

    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "notebook_path", {
      enumerable: true,
      get() { getterCalls++; return file; },
    });
    const accessorResult = await run(accessor);
    expect(resultText(accessorResult)).toContain("field notebook_path must be an own data property");
    expect(getterCalls).toBe(0);

    const descriptorThrowing = new Proxy(
      { notebook_path: file, new_source: "x", cell_id: "real-code" },
      { getOwnPropertyDescriptor(target, key) {
        if (key === "new_source") throw new Error("SECRET_DESCRIPTOR");
        return Reflect.getOwnPropertyDescriptor(target, key);
      } },
    );
    const descriptorResult = await run(descriptorThrowing);
    expect(resultText(descriptorResult)).toContain("field new_source must be an own data property");
    expect(resultText(descriptorResult)).not.toContain("SECRET_DESCRIPTOR");
    expect(descriptorResult.details.notebook_path).toBe(file);

    const ownKeysThrowing = new Proxy({}, { ownKeys() { throw new Error("SECRET_PROXY"); } });
    expect(resultText(await run(ownKeysThrowing))).not.toContain("SECRET_PROXY");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const revokedResult = await run(revoked.proxy);
    expect(revokedResult.isError).toBe(true);
    expect(resultText(revokedResult)).toContain("ordinary own data properties");
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it("pins nullish-only language projection and complete success details", async () => {
    for (const [languageInfo, expected] of [
      [{ name: "" }, ""],
      [{ name: null }, "python"],
      [{}, "python"],
      [undefined, "python"],
    ] as const) {
      const { dir, file } = fixture();
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (languageInfo === undefined) delete doc.metadata.language_info;
      else doc.metadata.language_info = languageInfo;
      fs.writeFileSync(file, JSON.stringify(doc, null, 1));
      const state = new NotebookSessionState();
      await authorize(state, file);
      const before = decodeNotebookText(fs.readFileSync(file)).text;
      const result = await editor(dir, state)({ notebook_path: file, new_source: "next", cell_id: "real-code" });
      expect(result.details.language).toBe(expected);
      expect(result.details.original_file).toBe(before);
      expect(result.details.updated_file).toBe(decodeNotebookText(fs.readFileSync(file)).text);
      expect(result.details).not.toHaveProperty("error");
    }
  });

  it("pins exact Claude text and string-key details for every mode and representative errors", async () => {
    for (const scenario of [
      { mode: "replace" as const, input: { new_source: "replace source", cell_id: "real-code" }, text: "Updated cell real-code with replace source", id: "real-code", old: "old", type: "code" },
      { mode: "insert" as const, input: { new_source: "insert source", cell_id: "real-code", cell_type: "markdown" as const, edit_mode: "insert" as const }, text: "Inserted cell abcdef12 with insert source", id: "abcdef12", type: "markdown" },
      { mode: "delete" as const, input: { new_source: "ignored", cell_id: "real-code", edit_mode: "delete" as const }, text: "Deleted cell real-code", id: "real-code", old: "old", type: "code" },
    ]) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const original = fs.readFileSync(file, "utf8");
      const result = await editor(dir, state, { generateCellIdCandidate: () => "abcdef12" })({ notebook_path: file, ...scenario.input });
      expect(resultText(result)).toBe(scenario.text);
      const expected: Record<string, unknown> = {
        new_source: scenario.input.new_source,
        ...(scenario.old === undefined ? {} : { old_source: scenario.old }),
        cell_id: scenario.id,
        cell_type: scenario.type,
        language: "julia",
        edit_mode: scenario.mode,
        notebook_path: file,
        original_file: original,
        updated_file: fs.readFileSync(file, "utf8"),
      };
      expect(stringDetails(result)).toEqual(expected);
      expect(stringDetails(result)).not.toHaveProperty("error");
    }

    for (const mode of ["replace", "delete"] as const) {
      const { dir, file } = fixture({ minor: 4 });
      const state = new NotebookSessionState();
      await authorize(state, file);
      const original = fs.readFileSync(file, "utf8");
      const input = { notebook_path: file, new_source: mode === "replace" ? "legacy" : "", cell_id: "real-code", edit_mode: mode };
      const result = await editor(dir, state)(input);
      expect(resultText(result)).toBe(mode === "replace" ? "Updated cell undefined with legacy" : "Deleted cell undefined");
      expect(stringDetails(result)).toEqual({
        new_source: input.new_source,
        old_source: "old",
        cell_type: "code",
        language: "julia",
        edit_mode: mode,
        notebook_path: file,
        original_file: original,
        updated_file: fs.readFileSync(file, "utf8"),
      });
    }

    const { dir, file } = fixture();
    const unread = await editor(dir, new NotebookSessionState())({
      notebook_path: "book.ipynb", new_source: "source", cell_id: "missing", cell_type: "markdown", edit_mode: "delete",
    });
    expect(resultText(unread)).toBe("NotebookEdit: this notebook has not been successfully Read in the current session, or that Read is stale. Read it again before editing. No changes were written.");
    expect(stringDetails(unread)).toEqual({
      new_source: "source", cell_id: "missing", cell_type: "code", language: "python", edit_mode: "replace",
      error: resultText(unread), notebook_path: file, original_file: "", updated_file: "",
    });
    const invalid = await editor(dir, new NotebookSessionState())({ notebook_path: "book.ipynb", new_source: 3, cell_id: "real-code" });
    expect(resultText(invalid)).toBe("NotebookEdit: new_source must be a string. No changes were written.");
    expect(stringDetails(invalid)).toEqual({
      new_source: "", cell_id: "real-code", cell_type: "code", language: "python", edit_mode: "replace",
      error: resultText(invalid), notebook_path: file, original_file: "", updated_file: "",
    });
  });

  it("classifies malformed JSON, malformed UTF-8, unsupported BOM-less UTF-16, and missing files without raw errors", async () => {
    for (const [name, bytes, expected] of [
      ["malformed.ipynb", Buffer.from("{bad json"), "not valid JSON"],
      ["bad-utf8.ipynb", Buffer.from([0xef, 0xbb, 0xbf, 0xff]), "malformed encoding"],
      ["utf16-no-bom.ipynb", Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, cells: [] }), "utf16le"), "UTF-16 without a BOM"],
    ] as const) {
      const { dir } = fixture();
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      const state = new NotebookSessionState();
      await authorize(state, file);
      const result = await editor(dir, state)({ notebook_path: file, new_source: "x", cell_id: "cell-0" });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(expected);
      expect(resultText(result)).not.toContain(dir);
    }

    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    fs.unlinkSync(file);
    const missing = await editor(dir, state)({ notebook_path: file, new_source: "x", cell_id: "real-code" });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain("missing, unreadable");
    expect(resultText(missing)).not.toContain("ENOENT");
  });

  it("pins modern fallback addressing separately from persisted and generated IDs", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state, { generateCellIdCandidate: () => "abcdef12" });
    const replaced = await run({ notebook_path: file, new_source: "fallback", cell_id: "cell-0" });
    expect(resultText(replaced)).toBe("Updated cell cell-0 with fallback");
    expect(replaced.details.cell_id).toBe("cell-0");
    const inserted = await run({ notebook_path: file, new_source: "inserted", cell_id: "real-code", cell_type: "markdown", edit_mode: "insert" });
    expect(resultText(inserted)).toBe("Inserted cell abcdef12 with inserted");
    expect(inserted.details.cell_id).toBe("abcdef12");
  });

  it("rejects oversized source without writes while retaining usable authorization", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const initial = fs.readFileSync(file);
    const sourceFailure = await editor(dir, state)({ notebook_path: file, new_source: "x".repeat(MAX_NOTEBOOK_BYTES + 1), cell_id: "real-code" });
    expect(resultText(sourceFailure)).toContain(`${MAX_NOTEBOOK_BYTES}-byte limit`);
    expect(fs.readFileSync(file)).toEqual(initial);
    const target = await resolveNotebookTarget(file);
    const token = state.authorize(target, state.captureCallEpoch());
    expect(token).toBeDefined();
    expect(state.validate(token!, target, initial)).toBe(true);
  });

  it("rejects oversized final output without writes while retaining usable authorization", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.metadata.pad = "";
    const base = Buffer.byteLength(JSON.stringify(doc, null, 1));
    doc.metadata.pad = "x".repeat(MAX_NOTEBOOK_BYTES - base - 32);
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    await authorize(state, file);
    const before = fs.readFileSync(file);
    const finalFailure = await editor(dir, state)({ notebook_path: file, new_source: "y".repeat(256), cell_id: "real-code" });
    expect(finalFailure.isError).toBe(true);
    expect(resultText(finalFailure)).toContain(`updated notebook exceeds the ${MAX_NOTEBOOK_BYTES}-byte limit`);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const target = await resolveNotebookTarget(file);
    const token = state.authorize(target, state.captureCallEpoch());
    expect(token).toBeDefined();
    expect(state.validate(token!, target, before)).toBe(true);
  });

  it("preserves UTF-16LE/BE BOMs and newline conventions", async () => {
    for (const encoding of ["le", "be"] as const) {
      const { dir, file } = fixture({ newline: "\r\n" });
      const text = fs.readFileSync(file, "utf8");
      const le = Buffer.from(text, "utf16le");
      const body = encoding === "le" ? le : Buffer.from(le).map((_, index, bytes) => bytes[index ^ 1]!);
      const bom = encoding === "le" ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
      fs.writeFileSync(file, Buffer.concat([bom, body]));
      const state = new NotebookSessionState();
      await authorize(state, file);
      const result = await editor(dir, state)({ notebook_path: file, new_source: "utf16", cell_id: "real-code" });
      expect(result.isError).not.toBe(true);
      const saved = fs.readFileSync(file);
      expect(saved.subarray(0, 2)).toEqual(bom);
      expect(decodeNotebookText(saved).format).toMatchObject({ encoding: `utf16${encoding}`, bom: true, newline: "\r\n" });
    }
  });

  it("requires a fresh Read for positional fallback after delete while retaining the real cell-N witness", async () => {
    const { dir, file } = fixture();
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.cells[1].id = "cell-1";
    fs.writeFileSync(file, JSON.stringify(doc, null, 1));
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state);
    expect((await run({ notebook_path: file, new_source: "", cell_id: "real-code", edit_mode: "delete" })).isError).not.toBe(true);
    const beforeFallback = fs.readFileSync(file);
    const stale = await run({ notebook_path: file, new_source: "must-not-write", cell_id: "cell-0" });
    expect(resultText(stale)).toContain("positional cell identifiers are stale");
    expect(fs.readFileSync(file)).toEqual(beforeFallback);
    const exact = await run({ notebook_path: file, new_source: "still exact", cell_id: "cell-1" });
    expect(exact.isError).not.toBe(true);
    await authorize(state, file);
    const fresh = await run({ notebook_path: file, new_source: "fresh positional", cell_id: "cell-0" });
    expect(fresh.isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0]).toMatchObject({ id: "cell-1", source: "fresh positional" });
  });

  it("serializes aliases in one queue, authorizes either spelling, and rejects repoints", async () => {
    const first = fixture();
    const second = fixture();
    const aliasDir = path.join(first.dir, "alias");
    fs.symlinkSync(first.dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const alias = path.join(aliasDir, "book.ipynb");
    const state = new NotebookSessionState();
    await authorize(state, first.file);
    const entered = deferred<void>();
    const release = deferred<void>();
    let commits = 0;
    const run = editor(first.dir, state, { fileOps: { commit: async (handle, bytes) => {
      commits++;
      if (commits === 1) { entered.resolve(); await release.promise; }
      const written = await handle.write(bytes, 0, bytes.byteLength, 0);
      if (written.bytesWritten !== bytes.byteLength) throw new Error("short");
      await handle.truncate(bytes.byteLength);
    } } });
    const a = run({ notebook_path: alias, new_source: "alias-A", cell_id: "real-code" });
    await entered.promise;
    const b = run({ notebook_path: first.file, new_source: "alias-B", cell_id: "real-code" });
    release.resolve();
    expect((await a).isError).not.toBe(true);
    expect((await b).isError).toBe(true);
    expect(JSON.parse(fs.readFileSync(first.file, "utf8")).cells[0].source).toBe("alias-A");

    fs.rmSync(aliasDir, { recursive: true, force: true });
    fs.symlinkSync(second.dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const repointed = await run({ notebook_path: alias, new_source: "bad", cell_id: "real-code" });
    expect(repointed.isError).toBe(true);
    expect(fs.readFileSync(second.file, "utf8")).not.toContain("bad");

    fs.rmSync(aliasDir, { recursive: true, force: true });
    fs.symlinkSync(first.dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const returned = await run({ notebook_path: alias, new_source: "returned", cell_id: "real-code" });
    expect(returned.isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(first.file, "utf8")).cells[0].source).toBe("returned");
  });

  it("detects pathname replacement after retained-handle validation and does not mutate either object", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const detached = path.join(dir, "detached.ipynb");
    let inspections = 0;
    const run = editor(dir, state, { fileOps: { inspect: async (...args) => {
      const loaded = await inspectNotebookHandle(...args);
      inspections++;
      if (inspections === 2) {
        fs.renameSync(file, detached);
        fs.copyFileSync(detached, file);
      }
      return loaded;
    } } });
    const result = await run({ notebook_path: file, new_source: "ours", cell_id: "real-code" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("changed while");
    expect(fs.readFileSync(file, "utf8")).not.toContain("ours");
    expect(fs.readFileSync(detached, "utf8")).not.toContain("ours");
  });

  it("does not globally lock different notebook paths", async () => {
    const a = fixture();
    const b = fixture();
    const state = new NotebookSessionState();
    await authorize(state, a.file);
    await authorize(state, b.file);
    const entered = deferred<void>();
    const release = deferred<void>();
    const runA = editor(a.dir, state, { fileOps: { commit: async (handle, bytes) => {
      entered.resolve(); await release.promise;
      await handle.write(bytes, 0, bytes.byteLength, 0); await handle.truncate(bytes.byteLength);
    } } });
    const pendingA = runA({ notebook_path: a.file, new_source: "A", cell_id: "real-code" });
    await entered.promise;
    const resultB = await editor(b.dir, state)({ notebook_path: b.file, new_source: "B", cell_id: "real-code" });
    expect(resultB.isError).not.toBe(true);
    release.resolve();
    expect((await pendingA).isError).not.toBe(true);
  });

  it("keeps a C token captured after A valid when older B rejects", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const aCommit = deferred<void>();
    const releaseA = deferred<void>();
    const bRead = deferred<void>();
    const releaseB = deferred<void>();
    let commits = 0;
    let inspections = 0;
    let captures = 0;
    const run = editor(dir, state, {
      afterTokenCapture: () => {
        captures++;
        if (captures === 2) releaseA.resolve();
        if (captures === 3) releaseB.resolve();
      },
      fileOps: {
        inspect: async (...args) => {
          inspections++;
          if (inspections === 4) { bRead.resolve(); await releaseB.promise; }
          return inspectNotebookHandle(...args);
        },
        commit: async (handle, bytes) => {
          commits++;
          if (commits === 1) { aCommit.resolve(); await releaseA.promise; }
          await handle.write(bytes, 0, bytes.byteLength, 0); await handle.truncate(bytes.byteLength);
        },
      },
    });
    const a = run({ notebook_path: file, new_source: "A", cell_id: "real-code" });
    await aCommit.promise;
    const b = run({ notebook_path: file, new_source: "B", cell_id: "real-code" });
    await bRead.promise;
    const c = run({ notebook_path: file, new_source: "C", cell_id: "real-code" });
    expect((await a).isError).not.toBe(true);
    expect((await b).isError).toBe(true);
    expect((await c).isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("C");
  });

  it("keeps C valid when its epoch precedes B rejection but its token follows it", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const aCommit = deferred<void>();
    const releaseA = deferred<void>();
    const bRead = deferred<void>();
    const releaseB = deferred<void>();
    const bDone = deferred<void>();
    let commits = 0;
    let inspections = 0;
    let captures = 0;
    const run = editor(dir, state, {
      afterTokenCapture: () => {
        captures++;
        if (captures === 2) releaseA.resolve();
      },
      fileOps: {
        identify: async (...args) => {
          const identified = await identifyNotebookHandle(...args);
          if (captures === 2) { releaseB.resolve(); await bDone.promise; }
          return identified;
        },
        inspect: async (...args) => {
          inspections++;
          if (inspections === 4) { bRead.resolve(); await releaseB.promise; }
          return inspectNotebookHandle(...args);
        },
        commit: async (handle, bytes) => {
          commits++;
          if (commits === 1) { aCommit.resolve(); await releaseA.promise; }
          await handle.write(bytes, 0, bytes.byteLength, 0); await handle.truncate(bytes.byteLength);
        },
      },
    });
    const a = run({ notebook_path: file, new_source: "A", cell_id: "real-code" });
    await aCommit.promise;
    const b = run({ notebook_path: file, new_source: "B", cell_id: "real-code" });
    await bRead.promise;
    const observedB = b.then((result) => { bDone.resolve(); return result; });
    const c = run({ notebook_path: file, new_source: "C", cell_id: "real-code" });
    expect((await a).isError).not.toBe(true);
    expect((await observedB).isError).toBe(true);
    expect((await c).isError).not.toBe(true);
  });

  it("sanitizes injected access failures and invalidates only a captured current token", async () => {
    for (const seam of ["resolve", "open", "inspect"] as const) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      let calls = 0;
      const raw = `SECRET_OS_${seam}_${path.join(dir, "canonical-target")}`;
      const fileOps = seam === "resolve"
        ? { resolve: async (value: string) => { if (++calls === 2) throw new Error(raw); return fs.realpathSync(value); } }
        : seam === "open"
          ? { open: async (...args: Parameters<typeof import("node:fs/promises").open>) => {
              if (++calls === 2) throw new Error(raw);
              return (await import("node:fs/promises")).open(...args) as never;
            } }
          : { inspect: async (...args: Parameters<typeof inspectNotebookHandle>) => {
              if (++calls === 2) throw new Error(raw);
              return inspectNotebookHandle(...args);
            } };
      const run = editor(dir, state, { fileOps: fileOps as never });
      const failed = await run({ notebook_path: file, new_source: "x", cell_id: "real-code" });
      expect(failed.isError).toBe(true);
      expect(resultText(failed)).not.toContain("SECRET_OS");
      expect(resultText(failed)).not.toContain("canonical-target");
      expect((await editor(dir, state)({ notebook_path: file, new_source: "retry", cell_id: "real-code" })).isError).toBe(true);
    }
  });

  it("retains authorization for deterministic operation failures", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const run = editor(dir, state);
    const missing = await run({ notebook_path: file, new_source: "x", cell_id: "missing" });
    expect(resultText(missing)).toContain("select an ID displayed by Read");
    expect((await run({ notebook_path: file, new_source: "valid", cell_id: "real-code" })).isError).not.toBe(true);
  });

  it("marks every post-write phase failure uncertain and invalidates its matching snapshot", async () => {
    for (const phase of ["before-refresh", "before-result"] as const) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const failed = await editor(dir, state, { afterCommit: (at) => {
        if (at === phase) throw new Error(`post-write ${phase}`);
      } })({ notebook_path: file, new_source: phase, cell_id: "real-code" });
      expect(failed.isError).toBe(true);
      expect(resultText(failed)).toContain("Inspect and Read");
      expect(resultText(failed)).not.toContain("No changes were written");
      expect((await editor(dir, state)({ notebook_path: file, new_source: "retry", cell_id: "real-code" })).isError).toBe(true);
    }
  });

  it("treats a final-handle close failure as post-write uncertainty", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const { open } = await import("node:fs/promises");
    const failed = await editor(dir, state, { fileOps: { open: async (target, flags) => {
      const handle = await open(target, flags);
      if (flags !== "r+") return handle as never;
      return {
        stat: handle.stat.bind(handle), read: handle.read.bind(handle), write: handle.write.bind(handle),
        truncate: handle.truncate.bind(handle),
        close: async () => { await handle.close(); throw new Error("SECRET_CLOSE"); },
      };
    } } })({ notebook_path: file, new_source: "closed", cell_id: "real-code" });
    expect(failed.isError).toBe(true);
    expect(resultText(failed)).toContain("Inspect and Read");
    expect(resultText(failed)).not.toContain("SECRET_CLOSE");
    expect((await editor(dir, state)({ notebook_path: file, new_source: "retry", cell_id: "real-code" })).isError).toBe(true);
  });

  it("fires change observation only after committed bytes and refreshed state are visible", async () => {
    const { dir, file } = fixture();
    const observations: Array<{ source: string; generation: number }> = [];
    const state = new NotebookSessionState({ onChange: (snapshot) => {
      observations.push({
        source: JSON.parse(decodeNotebookText(fs.readFileSync(file)).text).cells[0].source,
        generation: snapshot.generation,
      });
    } });
    await authorize(state, file);
    observations.length = 0;
    const result = await editor(dir, state)({ notebook_path: file, new_source: "observed", cell_id: "real-code" });
    expect(result.isError).not.toBe(true);
    expect(observations).toEqual([{ source: "observed", generation: 2 }]);
  });

  it("closes every handle when an injected open returns into an abort", async () => {
    const { open } = await import("node:fs/promises");
    for (const abortingOpen of [1, 2, 3, 4]) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const controller = new AbortController();
      let opens = 0;
      let selectedCloses = 0;
      const result = await editor(dir, state, { fileOps: { open: async (target, flags) => {
        const native = await open(target, flags);
        opens++;
        const selected = opens === abortingOpen;
        if (selected) controller.abort();
        return {
          stat: native.stat.bind(native), read: native.read.bind(native), write: native.write.bind(native),
          truncate: native.truncate.bind(native),
          close: async () => { if (selected) selectedCloses++; await native.close(); },
        };
      } } })({ notebook_path: file, new_source: `abort-${abortingOpen}`, cell_id: "real-code" }, controller.signal);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("aborted");
      expect(selectedCloses).toBe(1);
    }
  });

  it("preserves stale diagnosis and invalidation when cleanup also fails", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"old"', '"NEW"'));
    const { open } = await import("node:fs/promises");
    let opens = 0;
    const result = await editor(dir, state, { fileOps: { open: async (target, flags) => {
      const native = await open(target, flags);
      opens++;
      if (opens !== 2) return native as never;
      return {
        stat: native.stat.bind(native), read: native.read.bind(native), write: native.write.bind(native),
        truncate: native.truncate.bind(native),
        close: async () => { await native.close(); throw new Error("SECRET_CLOSE"); },
      };
    } } })({ notebook_path: file, new_source: "ours", cell_id: "real-code" });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("changed after the authorizing Read");
    expect(resultText(result)).not.toContain("SECRET_CLOSE");
    expect(state.serialize().records).toEqual([]);
  });

  it("completes partial writes and treats no-progress or partial-then-throw writes as uncertain", async () => {
    const { open } = await import("node:fs/promises");
    {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const positions: number[] = [];
      const result = await editor(dir, state, { fileOps: { open: async (target, flags) => {
        const native = await open(target, flags);
        if (flags !== "r+") return native as never;
        return {
          stat: native.stat.bind(native), read: native.read.bind(native), truncate: native.truncate.bind(native), close: native.close.bind(native),
          write: async (buffer, offset, length, position) => {
            positions.push(position ?? -1);
            return native.write(buffer, offset, Math.min(length, 17), position);
          },
        };
      } } })({ notebook_path: file, new_source: "partial progress success", cell_id: "real-code" });
      expect(result.isError).not.toBe(true);
      expect(positions.length).toBeGreaterThan(1);
      expect(positions[0]).toBe(0);
      expect(positions.every((position, index) => index === 0 || position > positions[index - 1]!)).toBe(true);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("partial progress success");
    }

    for (const failure of ["zero", "after-progress"] as const) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const before = fs.readFileSync(file);
      let writes = 0;
      const result = await editor(dir, state, { fileOps: { open: async (target, flags) => {
        const native = await open(target, flags);
        if (flags !== "r+") return native as never;
        return {
          stat: native.stat.bind(native), read: native.read.bind(native), truncate: native.truncate.bind(native), close: native.close.bind(native),
          write: async (buffer, offset, length, position) => {
            writes++;
            if (failure === "zero") return { bytesWritten: 0, buffer };
            if (writes === 1) return native.write(buffer, offset, Math.min(length, 128), position);
            throw new Error("SECRET_SHORT_WRITE");
          },
        };
      } } })({ notebook_path: file, new_source: `failure-${failure}`, cell_id: "real-code" });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("may have changed");
      expect(resultText(result)).not.toContain("SECRET_SHORT_WRITE");
      if (failure === "zero") expect(fs.readFileSync(file)).toEqual(before);
      else expect(fs.readFileSync(file)).not.toEqual(before);
      expect(state.serialize().records).toEqual([]);
    }
  });

  it("checks aborts before and inside the queue, after awaits, and immediately prewrite", async () => {
    for (const point of ["before", "inside", "after-read", "prewrite"] as const) {
      const { dir, file } = fixture();
      const state = new NotebookSessionState();
      await authorize(state, file);
      const controller = new AbortController();
      let resolves = 0;
      let inspections = 0;
      const run = editor(dir, state, { fileOps: {
        resolve: async (value) => {
          resolves++;
          if ((point === "before" && resolves === 1) || (point === "inside" && resolves === 2)) controller.abort();
          return fs.realpathSync(value);
        },
        inspect: async (...args) => {
          const result = await inspectNotebookHandle(...args);
          inspections++;
          if ((point === "after-read" && inspections === 1) || (point === "prewrite" && inspections === 3)) controller.abort();
          return result;
        },
      } });
      const before = fs.readFileSync(file);
      const result = await run({ notebook_path: file, new_source: point, cell_id: "real-code" }, controller.signal);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("aborted");
      expect(resultText(result)).toContain("No changes were written");
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });

  it("does not turn an abort raised after commit into failure", async () => {
    const { dir, file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const controller = new AbortController();
    const run = editor(dir, state, { fileOps: { commit: async (handle, bytes) => {
      await handle.write(bytes, 0, bytes.byteLength, 0);
      await handle.truncate(bytes.byteLength);
      controller.abort();
    } } });
    const result = await run({ notebook_path: file, new_source: "committed", cell_id: "real-code" }, controller.signal);
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).cells[0].source).toBe("committed");
  });
});

describe("NotebookSessionState", () => {
  it("projects only the newest matching custom entry without invoking unsafe accessors or falling back", () => {
    const older = { version: 1, generation: 0, records: [] };
    let getterCalls = 0;
    const newest = Object.defineProperty({
      type: "custom",
      customType: "picc-notebook-session",
    }, "data", { get() { getterCalls++; return older; } });
    const branch = [
      { type: "custom", customType: "picc-notebook-session", data: older },
      { type: "message", customType: "picc-notebook-session", data: "ignored" },
      newest,
    ];

    expect(newestNotebookSessionSnapshot(branch)).toBeUndefined();
    expect(getterCalls).toBe(0);

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => newestNotebookSessionSnapshot(revoked.proxy)).not.toThrow();
    expect(newestNotebookSessionSnapshot(revoked.proxy)).toBeUndefined();
    const oversized: unknown[] = [];
    oversized.length = 1_000_001;
    expect(newestNotebookSessionSnapshot(oversized)).toBeUndefined();
  });

  it("keeps alias snapshots field-private, restores unchanged identity, rejects changed identity, and clones independently", async () => {
    const { dir, file } = fixture();
    const aliasDir = path.join(dir, "snapshot-alias");
    fs.symlinkSync(dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const alias = path.join(aliasDir, "book.ipynb");
    const observed: unknown[] = [];
    const state = new NotebookSessionState({ onChange: (snapshot) => observed.push(snapshot) });
    const aliasTarget = await resolveNotebookTarget(alias);
    state.recordRead(aliasTarget, await readNotebookBytesBounded(alias, MAX_NOTEBOOK_BYTES));
    expect(observed).toHaveLength(1);
    const serialized = state.serialize();
    expect(Object.keys(serialized.records[0]!).sort()).toEqual([
      "digest", "fallbackCurrent", "generation", "identity", "normalizedPath",
    ]);
    expect(serialized.records[0]!.normalizedPath).toBe(alias);
    expect(serialized.records[0]!.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(serialized.records[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(serialized.records[0]!.identity).not.toContain(fs.realpathSync(file));
    expect(serialized.records[0]!.digest).not.toContain("old");

    const restored = new NotebookSessionState();
    restored.restore(serialized);
    expect(restored.authorize(await resolveNotebookTarget(alias), restored.captureCallEpoch())).toBeDefined();
    const clone = restored.clone();
    const token = restored.authorize(await resolveNotebookTarget(file), restored.captureCallEpoch())!;
    restored.invalidateIfCurrent(token);
    expect(clone.authorize(await resolveNotebookTarget(alias), clone.captureCallEpoch())).toBeDefined();

    const replacement = path.join(dir, "replacement.ipynb");
    fs.copyFileSync(file, replacement);
    fs.renameSync(replacement, file);
    expect(clone.authorize(await resolveNotebookTarget(alias), clone.captureCallEpoch())).toBeUndefined();
  });

  it("fails closed at generation exhaustion without rebasing or reusing token generations", async () => {
    const first = fixture();
    const second = fixture();
    const seed = new NotebookSessionState();
    await authorize(seed, first.file);
    const record = seed.serialize().records[0]!;
    const state = new NotebookSessionState();
    const lastGeneration = Number.MAX_SAFE_INTEGER - 1_000_000;
    state.restore({ version: 1, generation: lastGeneration, records: [{ ...record, generation: lastGeneration }] });
    const before = state.serialize();
    const originalToken = state.authorize(await resolveNotebookTarget(first.file), state.captureCallEpoch());
    expect(originalToken?.generation).toBe(lastGeneration);
    await expect(async () => state.recordRead(
      await resolveNotebookTarget(second.file),
      await readNotebookBytesBounded(second.file, MAX_NOTEBOOK_BYTES),
    )).rejects.toThrow("generation exhausted");
    expect(state.serialize()).toEqual(before);
    expect(state.authorize(await resolveNotebookTarget(first.file), state.captureCallEpoch())?.generation).toBe(lastGeneration);
  });

  it("does not let restore roll back an instance after it has issued newer state", async () => {
    const { file } = fixture();
    const state = new NotebookSessionState();
    const target = await resolveNotebookTarget(file);
    const bytes = await readNotebookBytesBounded(file, MAX_NOTEBOOK_BYTES);
    const oldToken = state.recordRead(target, bytes);
    const oldSnapshot = state.serialize();
    const currentToken = state.recordRead(target, bytes);
    const currentSnapshot = state.serialize();

    state.restore(oldSnapshot);

    expect(state.serialize()).toEqual(currentSnapshot);
    expect(state.validate(oldToken, target, bytes)).toBe(false);
    expect(state.validate(currentToken, target, bytes)).toBe(true);
    expect(state.authorize(target, state.captureCallEpoch())?.generation).toBe(currentToken.generation);
  });

  it("makes restore total for revoked root, records array, and record proxies", async () => {
    const { file } = fixture();
    const state = new NotebookSessionState();
    await authorize(state, file);
    const baseline = state.serialize();
    const root = Proxy.revocable({}, {});
    root.revoke();
    expect(() => state.restore(root.proxy)).not.toThrow();

    const records = Proxy.revocable([], {});
    records.revoke();
    expect(() => state.restore({ version: 1, generation: 1, records: records.proxy })).not.toThrow();

    const record = Proxy.revocable({}, {});
    record.revoke();
    expect(() => state.restore({ version: 1, generation: 1, records: [record.proxy] })).not.toThrow();
    expect(state.serialize()).toEqual(baseline);
  });

  it("bounds restore before traversal and rejects malformed or unsafe generations without changing state", async () => {
    const first = fixture();
    const second = fixture();
    const state = new NotebookSessionState();
    await authorize(state, first.file);
    const baseline = state.serialize();
    const validRecord = baseline.records[0]!;
    const invalidInputs = [
      { version: 1, generation: 70, records: Array.from({ length: 70 }, () => validRecord) },
      { version: 1, generation: Number.MAX_SAFE_INTEGER, records: [] },
      { version: 1, generation: 2, records: [{ ...validRecord, generation: 2 }, { ...validRecord, normalizedPath: second.file, generation: 2 }] },
      { version: 1, generation: 1, records: [{ ...validRecord, digest: "bad" }] },
      { version: 1, generation: 1, records: Object.defineProperty([], "0", { get() { throw new Error("getter"); } }) },
    ];
    for (const invalid of invalidInputs) {
      state.restore(invalid);
      expect(state.serialize()).toEqual(baseline);
    }

    const secondTarget = await resolveNotebookTarget(second.file);
    const secondBytes = await readNotebookBytesBounded(second.file, MAX_NOTEBOOK_BYTES);
    state.recordRead(secondTarget, secondBytes);
    const generations = state.serialize().records.map((record) => record.generation);
    expect(new Set(generations).size).toBe(generations.length);
    expect(generations.every(Number.isSafeInteger)).toBe(true);
  });
});

describe("notebook path normalization", () => {
  it.each([
    ["/work/book.ipynb", "/cwd", "linux", "/work/book.ipynb"],
    ["book.ipynb", "/cwd", "linux", "/cwd/book.ipynb"],
    ["C:\\work\\book.ipynb", "C:\\cwd", "win32", "C:\\work\\book.ipynb"],
    ["book.ipynb", "C:\\cwd", "win32", "C:\\cwd\\book.ipynb"],
    ["\\\\server\\share\\book.ipynb", "C:\\cwd", "win32", "\\\\server\\share\\book.ipynb"],
  ] as const)("accepts native path %s", (input, cwd, platform, expected) => {
    expect(normalizeNotebookPathForPlatform(input, cwd, platform)).toBe(expected);
  });

  it.each([
    ["C:\\work\\book.ipynb", "/cwd", "linux"], ["C:book.ipynb", "C:\\cwd", "win32"],
    ["\\book.ipynb", "C:\\cwd", "win32"], ["\\\\?\\C:\\book.ipynb", "C:\\cwd", "win32"],
    ["\\\\server\\\\book.ipynb", "C:\\cwd", "win32"], ["book.IPYNB", "/cwd", "linux"],
    ["bad\0book.ipynb", "/cwd", "linux"], ["/work/book.ipynb", "C:\\cwd", "win32"],
  ] as const)("rejects non-native or malformed path %s", (input, cwd, platform) => {
    expect(() => normalizeNotebookPathForPlatform(input, cwd, platform)).toThrow(/notebook_path/);
  });
});
