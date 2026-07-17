import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  defineTool,
  generateDiffString,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/**
 * `MultiEdit`: an atomic, sequential multi-edit tool — the Claude Code
 * `MultiEdit` shape ported onto PiCC.
 *
 * A model calls it with a single `file_path` and an ordered array of edits,
 * each `{ old_string, new_string, replace_all? }`. The edits are applied
 * **sequentially to one in-memory running buffer** (edit N sees the result of
 * edit N−1) and the file is written **once**, only after every edit matched
 * successfully. If any edit fails the whole call throws before that write, so
 * the file on disk is left byte-untouched (all-or-nothing).
 *
 * Matching is **exact substring** matching against the current (LF-normalized)
 * buffer — deliberately no fuzzy / smart-quote / dash / whitespace
 * normalization, unlike Pi's `edit` tool. This is the more faithful port of
 * Claude's `MultiEdit`.
 *
 * Path resolution is a plain `path.resolve(getCwd(), file_path)` — no `~` /
 * `@` / `file://` / unicode-space expansion. The permission engine matches
 * path-scoped deny rules on exactly this resolution, so any divergent transform
 * would be a deny bypass. The whole read → compute → write runs inside the
 * exported `withFileMutationQueue`, which keys on `realpath` and therefore
 * serializes against concurrent `Edit` / `Write` / `MultiEdit` on the same
 * file.
 */

const BOM = "﻿";

interface NormalizedEdit {
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

// ---------------------------------------------------------------------------
// Encoding / line-ending helpers (reimplemented — Pi's are private)
// ---------------------------------------------------------------------------

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith(BOM) ? { bom: BOM, text: content.slice(1) } : { bom: "", text: content };
}

/** Detect the file's dominant line ending — the first `\r\n`-vs-`\n` wins. */
function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// ---------------------------------------------------------------------------
// Pure matcher core (exported-shaped, exercised directly by the unit suite)
// ---------------------------------------------------------------------------

/** Count non-overlapping occurrences of a non-empty needle. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Replace the first occurrence of a non-empty needle. */
function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

/**
 * Apply the edits sequentially to a single running buffer and return the
 * composed (still LF-normalized) result. Throws — naming the failing edit
 * index and reason — the moment any edit cannot be applied, so the caller can
 * bail out before writing anything.
 *
 * `fileExists` distinguishes an edit of an existing file (buffer starts as its
 * LF-normalized content) from a file-creation batch (buffer starts empty and
 * the first edit must have an empty `old_string`).
 */
export function applyEdits(
  startBuffer: string,
  fileExists: boolean,
  edits: NormalizedEdit[],
  filePath: string,
): string {
  const total = edits.length;
  let buffer = startBuffer;
  for (let i = 0; i < total; i++) {
    const { oldString, newString, replaceAll } = edits[i] as NormalizedEdit;
    const where = total === 1 ? "the edit" : `edits[${i}]`;

    if (oldString === "") {
      // Empty old_string is a file-creation directive: valid only as the first
      // edit when the target file does not exist. The buffer then becomes
      // new_string and later edits apply to it.
      if (i === 0 && !fileExists) {
        if (newString === "") {
          throw new Error(
            `MultiEdit: ${where} for ${filePath} has an empty old_string and new_string — nothing to create.`,
          );
        }
        buffer = newString;
        continue;
      }
      throw new Error(
        `MultiEdit: ${where} for ${filePath} has an empty old_string. An empty old_string is only ` +
          `allowed as the first edit when creating a new file` +
          (fileExists
            ? " (this file already exists — use a non-empty old_string matching the text to change)."
            : " (it is not the first edit)."),
      );
    }

    // Non-empty old_string. If the file does not exist and this is the opening
    // edit, there is nothing to match against — a clear file-not-found error.
    if (i === 0 && !fileExists) {
      throw new Error(
        `MultiEdit: cannot edit ${filePath} — the file does not exist. To create it, make the ` +
          `first edit's old_string empty.`,
      );
    }

    if (oldString === newString) {
      throw new Error(
        `MultiEdit: ${where} for ${filePath} has identical old_string and new_string — they must differ.`,
      );
    }

    const occurrences = countOccurrences(buffer, oldString);
    if (occurrences === 0) {
      // The classic sequential-multi-edit failure: for a later edit, the text is
      // most often absent because an EARLIER edit in this same batch already
      // rewrote or consumed it — say so, so the model corrects against the
      // post-edit content instead of retrying the same literal.
      const priorHint =
        i > 0
          ? " If an earlier edit in this batch already changed this text, match against the updated content it produced."
          : "";
      throw new Error(
        `MultiEdit: ${where}: old_string was not found in ${filePath}. It must match exactly, ` +
          `including all whitespace and newlines.${priorHint}`,
      );
    }
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `MultiEdit: ${where}: old_string is not unique in ${filePath} (${occurrences} occurrences). ` +
          `Provide more surrounding context to make it unique, or set replace_all.`,
      );
    }

    buffer = replaceAll ? buffer.split(oldString).join(newString) : replaceFirst(buffer, oldString, newString);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Input validation (runtime — the unit harness bypasses the typebox schema)
// ---------------------------------------------------------------------------

function getErrCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function isENOENT(err: unknown): boolean {
  return getErrCode(err) === "ENOENT";
}

function validateInput(params: unknown): { filePath: string; edits: NormalizedEdit[] } {
  const raw = params as { file_path?: unknown; edits?: unknown };
  if (typeof raw.file_path !== "string" || raw.file_path.length === 0) {
    throw new Error("MultiEdit: file_path is required and must be a non-empty string.");
  }
  if (!Array.isArray(raw.edits) || raw.edits.length === 0) {
    throw new Error("MultiEdit: edits must contain at least one edit.");
  }
  const edits: NormalizedEdit[] = raw.edits.map((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`MultiEdit: edits[${i}] must be an object with old_string and new_string.`);
    }
    const e = entry as { old_string?: unknown; new_string?: unknown; replace_all?: unknown };
    if (typeof e.old_string !== "string") {
      throw new Error(`MultiEdit: edits[${i}].old_string must be a string.`);
    }
    if (typeof e.new_string !== "string") {
      throw new Error(`MultiEdit: edits[${i}].new_string must be a string.`);
    }
    if (e.replace_all !== undefined && typeof e.replace_all !== "boolean") {
      throw new Error(`MultiEdit: edits[${i}].replace_all must be a boolean when provided.`);
    }
    return { oldString: e.old_string, newString: e.new_string, replaceAll: e.replace_all === true };
  });
  return { filePath: raw.file_path, edits };
}

export function createMultiEditTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: "MultiEdit",
    label: "MultiEdit",
    description:
      "Apply multiple exact-string edits to a single file in one atomic, sequential step. " +
      "Each edit is { old_string, new_string, replace_all? } and is applied to the running " +
      "result of the previous edits (later edits see earlier edits' output). Matching is exact " +
      "(no fuzzy normalization); without replace_all each old_string must match exactly once " +
      "(zero or multiple matches is an error). An empty old_string on the first edit creates a " +
      "new file whose contents are new_string. If any edit fails, nothing is written and the " +
      "file is left unchanged.",
    parameters: Type.Object({
      file_path: Type.String({
        description: "Path to the file to edit (relative to the working directory, or absolute).",
      }),
      edits: Type.Array(
        Type.Object({
          old_string: Type.String({
            description:
              "Exact text to replace in the current buffer (the result of prior edits). Empty " +
              "only for the first edit to create a new file.",
          }),
          new_string: Type.String({
            description: "Replacement text. Empty string is a valid deletion.",
          }),
          replace_all: Type.Optional(
            Type.Boolean({
              description:
                "Replace every occurrence of old_string. When false (default) old_string must be unique.",
            }),
          ),
        }),
        {
          minItems: 1,
          description: "Ordered edits applied sequentially to one running buffer.",
        },
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { filePath, edits } = validateInput(params);
      const absPath = path.resolve(getCwd(), filePath);

      return withFileMutationQueue(absPath, async () => {
        // Do not reject from an abort listener: that would release the mutation
        // queue while an in-flight fs op may still settle. Checking
        // signal.aborted after each await observes the same aborts while
        // keeping the queue locked until the current op has finished.
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();

        let rawContent: string | undefined;
        try {
          rawContent = await readFile(absPath, "utf-8");
        } catch (err) {
          throwIfAborted();
          if (isENOENT(err)) {
            rawContent = undefined; // nonexistent — only editable via empty-old_string creation
          } else {
            const c = getErrCode(err);
            throw new Error(`MultiEdit: could not read ${filePath}. ${c ? `Error code: ${c}` : String(err)}.`);
          }
        }
        throwIfAborted();

        const fileExists = rawContent !== undefined;

        let bom = "";
        let ending: "\n" | "\r\n" = "\n";
        let originalBuffer = "";
        if (rawContent !== undefined) {
          const stripped = stripBom(rawContent);
          bom = stripped.bom;
          ending = detectLineEnding(stripped.text);
          originalBuffer = normalizeToLF(stripped.text);
        }
        // Note: on the file-creation path the buffer starts as the raw new_string
        // (see applyEdits) and any later edits match against it verbatim — the
        // model authored that content in this same call, so exact matching of it
        // is intended; only pre-existing file content is LF-normalized for matching.

        // Compute every edit in memory; applyEdits throws before any write if
        // one fails, leaving the file byte-untouched (atomic).
        const composed = applyEdits(originalBuffer, fileExists, edits, filePath);

        let finalContent: string;
        if (!fileExists) {
          // File-creation path: there is no pre-existing ending to preserve, so
          // write the composed buffer verbatim (no BOM, no EOL restoration).
          finalContent = composed;
        } else {
          // Normalize the composed buffer to LF once BEFORE restoring endings so
          // a `\r\n` that arrived inside a new_string does not become `\r\r\n`.
          finalContent = bom + restoreLineEndings(normalizeToLF(composed), ending);
        }

        throwIfAborted();
        await writeFile(absPath, finalContent, "utf-8");
        // No post-write abort check: once the single write commits, the file is in
        // its intended final state, so throwing "aborted" here would falsely tell
        // the model the edit failed (and a retry would then miss the now-applied text).

        // Diff is computed on LF-normalized content for a stable display.
        const diffResult = generateDiffString(originalBuffer, normalizeToLF(composed));
        const message = fileExists
          ? `Successfully applied ${edits.length} edit(s) to ${filePath}.`
          : `Created ${filePath} with ${edits.length} edit(s).`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            filePath,
            edits: edits.length,
            created: !fileExists,
            diff: diffResult.diff,
            firstChangedLine: diffResult.firstChangedLine,
          },
        };
      });
    },
  });
}
