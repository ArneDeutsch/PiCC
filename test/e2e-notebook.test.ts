import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_PATH,
  cliMissing,
  createE2ELive,
  readJsonLines,
  TEST_TIMEOUT_MS,
} from "./helpers/e2e-live.js";

const { runPi, cleanup } = createE2ELive();
afterEach(cleanup);

const MACHINE_PRESENTATION = /\u001b|[○●✗■╭╮╰╯│─]|notebook write|Ctrl\+O|\bexpansion\b|\bexpand(?:ed|s|ing|able)?\b/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(isRecord(value), label).toBe(true);
  if (!isRecord(value)) throw new Error(`Expected ${label} to be an object`);
  return value;
}

function expectNoMachinePresentation(value: unknown, source: string): void {
  if (typeof value === "string") {
    expect(value, source).not.toMatch(MACHINE_PRESENTATION);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoMachinePresentation(entry, `${source}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      expectNoMachinePresentation(entry, `${source}.${key}`);
    }
  }
}

function toolMessage(request: { messages: Array<Record<string, unknown>> }, callId: string): Record<string, unknown> {
  const message = request.messages.find((entry) => entry.role === "tool" && entry.tool_call_id === callId);
  expect(message, `model-facing result for ${callId}`).toBeDefined();
  return message!;
}

function textContent(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("");
}

interface NotebookEditDetails extends Record<string, string> {
  readonly new_source: string;
  readonly cell_id: string;
  readonly cell_type: string;
  readonly language: string;
  readonly edit_mode: string;
  readonly notebook_path: string;
  readonly original_file: string;
  readonly updated_file: string;
}

interface NotebookEditRecord {
  readonly content: unknown;
  readonly details: NotebookEditDetails;
}

function notebookEditResult(records: readonly Record<string, unknown>[], callId: string): NotebookEditRecord {
  const matches = records.flatMap((record) => {
    if (record.type !== "message_end" || !isRecord(record.message)) return [];
    const message = record.message;
    return message.role === "toolResult" && message.toolName === "NotebookEdit" &&
      message.toolCallId === callId ? [message] : [];
  });
  expect(matches, `JSON NotebookEdit result for ${callId}`).toHaveLength(1);
  const message = matches[0]!;
  const details = requireRecord(message.details, `NotebookEdit details for ${callId}`);
  const requiredDetails = [
    "new_source", "cell_id", "cell_type", "language", "edit_mode",
    "notebook_path", "original_file", "updated_file",
  ] as const;
  const allStrings = Object.values(details).every((value) => typeof value === "string") &&
    requiredDetails.every((key) => typeof details[key] === "string");
  expect(allStrings, `NotebookEdit string details for ${callId}`).toBe(true);
  if (!allStrings) throw new Error(`Expected complete string details for NotebookEdit ${callId}`);
  return { content: message.content, details: details as NotebookEditDetails };
}

describe.skipIf(cliMissing)("e2e notebook: real Pi Read to NotebookEdit workflow", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(`Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`);
  }

  it("edits a materialized notebook through fallback and stable IDs without leaking TUI presentation", async () => {
    let fixtureOriginal = "";
    const replacementSource = "print('fallback replaced')";
    const insertedSource = "## Inserted after log";
    const result = await runPi({
      fixture: "full-surface",
      modeArgs: ["--mode", "json", "-p", "read and edit the notebook"],
      prompt: "unused",
      setup(fixtureDir) {
        fixtureOriginal = fs.readFileSync(path.join(fixtureDir, "analysis.ipynb"), "utf8");
      },
      script: [
        { toolCalls: [{ name: "read", args: { path: "analysis.ipynb" } }] },
        { toolCalls: [{
          name: "NotebookEdit",
          args: {
            notebook_path: "analysis.ipynb",
            new_source: replacementSource,
            cell_id: "cell-1",
            cell_type: "code",
            edit_mode: "replace",
          },
        }] },
        { toolCalls: [{
          name: "NotebookEdit",
          args: {
            notebook_path: "analysis.ipynb",
            new_source: insertedSource,
            cell_id: "log",
            cell_type: "markdown",
            edit_mode: "insert",
          },
        }] },
        { toolCalls: [{
          name: "NotebookEdit",
          args: {
            notebook_path: "analysis.ipynb",
            new_source: "",
            cell_id: "intro",
            cell_type: "markdown",
            edit_mode: "delete",
          },
        }] },
        { text: "NOTEBOOK_EDIT_COMPLETE" },
      ],
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.requests).toHaveLength(5);
    const advertised = result.requests[0]!.tools?.find((tool) =>
      isRecord(tool.function) && tool.function.name === "NotebookEdit");
    expect(advertised, "transported NotebookEdit schema").toBeDefined();
    const advertisedFunction = requireRecord(advertised?.function, "NotebookEdit function advertisement");
    expect(advertisedFunction.name).toBe("NotebookEdit");
    const parameters = requireRecord(advertisedFunction.parameters, "NotebookEdit parameters");
    expect(parameters.type).toBe("object");
    expect(parameters.required).toEqual(["notebook_path", "new_source"]);
    expect(parameters.additionalProperties).toBe(false);
    const properties = requireRecord(parameters.properties, "NotebookEdit properties");
    expect(Object.keys(properties).sort()).toEqual([
      "cell_id", "cell_type", "edit_mode", "new_source", "notebook_path",
    ]);
    for (const name of ["notebook_path", "new_source", "cell_id"] as const) {
      expect(requireRecord(properties[name], `NotebookEdit ${name}`).type).toBe("string");
    }
    expect(requireRecord(properties.cell_type, "NotebookEdit cell_type").anyOf).toEqual([
      { const: "code", type: "string" },
      { const: "markdown", type: "string" },
    ]);
    expect(requireRecord(properties.edit_mode, "NotebookEdit edit_mode").anyOf).toEqual([
      { const: "replace", type: "string" },
      { const: "insert", type: "string" },
      { const: "delete", type: "string" },
    ]);

    const readText = textContent(toolMessage(result.requests[1]!, "call_0_0"));
    expect(readText).toContain("=== Cell 0 (markdown, id=intro) ===");
    expect(readText).toContain("=== Cell 1 (code, id=cell-1) ===");
    expect(readText).toContain("=== Cell 2 (code, id=log) ===");
    expect(readText).toContain("=== Cell 3 (code, id=plot) ===");
    expect(readText).toContain("print('replace through fallback')");
    expect(readText).toContain("stale fallback output");
    expect(readText).toContain("training complete");
    expect(readText).toContain("image/png");
    expect(textContent(toolMessage(result.requests[2]!, "call_1_0"))).toBe(
      `Updated cell cell-1 with ${replacementSource}`,
    );
    const insertModelText = textContent(toolMessage(result.requests[3]!, "call_2_0"));
    expect(insertModelText).toMatch(/^Inserted cell [0-9a-f]{8} with ## Inserted after log$/u);
    expect(textContent(toolMessage(result.requests[4]!, "call_3_0"))).toBe("Deleted cell intro");

    const records = readJsonLines(result.stdout);
    expectNoMachinePresentation(records, "decoded JSON output");
    expectNoMachinePresentation(result.stdout, "raw JSON stdout");
    expectNoMachinePresentation(result.stderr, "JSON stderr");

    const replace = notebookEditResult(records, "call_1_0");
    const insert = notebookEditResult(records, "call_2_0");
    const remove = notebookEditResult(records, "call_3_0");
    const notebookPath = path.join(result.fixture, "analysis.ipynb");
    expect(replace.content).toEqual([{ type: "text", text: `Updated cell cell-1 with ${replacementSource}` }]);
    expect(replace.details).toEqual({
      new_source: replacementSource,
      old_source: "print('replace through fallback')",
      cell_id: "cell-1",
      cell_type: "code",
      language: "python",
      edit_mode: "replace",
      notebook_path: notebookPath,
      original_file: fixtureOriginal,
      updated_file: expect.any(String),
    });
    const insertedId = insert.details.cell_id;
    expect(insertedId).toMatch(/^[0-9a-f]{8}$/u);
    expect(insert.content).toEqual([{ type: "text", text: `Inserted cell ${insertedId} with ${insertedSource}` }]);
    expect(insert.details).toEqual({
      new_source: insertedSource,
      cell_id: insertedId,
      cell_type: "markdown",
      language: "python",
      edit_mode: "insert",
      notebook_path: notebookPath,
      original_file: replace.details.updated_file,
      updated_file: expect.any(String),
    });
    expect(remove.content).toEqual([{ type: "text", text: "Deleted cell intro" }]);
    expect(remove.details).toEqual({
      new_source: "",
      old_source: "# Analysis\n\nA short notebook whose code cell renders a plot.",
      cell_id: "intro",
      cell_type: "markdown",
      language: "python",
      edit_mode: "delete",
      notebook_path: notebookPath,
      original_file: insert.details.updated_file,
      updated_file: fs.readFileSync(notebookPath, "utf8"),
    });

    const afterReplace = JSON.parse(replace.details.updated_file);
    const afterInsert = JSON.parse(insert.details.updated_file);
    const finalNotebook = JSON.parse(remove.details.updated_file);
    expect(afterReplace.cells[1]).toMatchObject({
      source: replacementSource,
      execution_count: null,
      outputs: [],
      metadata: { fixture_canary: "fallback-cell-metadata" },
    });
    expect(afterInsert.cells.map((cell: any) => cell.id ?? "fallback")).toEqual([
      "intro", "fallback", "log", insertedId, "plot",
    ]);
    expect(finalNotebook.cells.map((cell: any) => cell.id ?? "fallback")).toEqual([
      "fallback", "log", insertedId, "plot",
    ]);
    expect(finalNotebook.cells.map((cell: any) => cell.source)).toEqual([
      replacementSource,
      ["print('training complete')"],
      insertedSource,
      ["fig"],
    ]);
    expect(finalNotebook.metadata).toEqual({
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    });
    expect(finalNotebook.cells[0]).toMatchObject({
      cell_type: "code",
      metadata: { fixture_canary: "fallback-cell-metadata" },
      execution_count: null,
      outputs: [],
    });
    expect(finalNotebook.cells[1]).toMatchObject({
      id: "log",
      metadata: {},
      execution_count: 1,
      outputs: [{ output_type: "stream", name: "stdout", text: ["training complete\n"] }],
    });
    expect(finalNotebook.cells[2]).toMatchObject({
      id: insertedId,
      cell_type: "markdown",
      metadata: {},
    });
    expect(finalNotebook.cells[3]).toMatchObject({
      id: "plot",
      metadata: {},
      execution_count: 2,
      outputs: [{
        output_type: "display_data",
        metadata: {},
        data: {
          "text/plain": ["<Figure size 640x480 with 1 Axes>"],
          "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAAAAADhZOFXAAAADElEQVR4nGNgoA4AAABIAAEuuDx+AAAAAElFTkSuQmCC",
        },
      }],
    });
  }, TEST_TIMEOUT_MS);
});
