import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createMultiEditTool } from "../src/runtime/tools/multi-edit.js";

/**
 * MultiEdit unit suite (Layer 1). Runs `createMultiEditTool(() => dir)`
 * against temp files directly via `.execute` — no model, no SDK. Fixtures use
 * explicit byte literals ("\r\n", "﻿") so the same bytes land on Windows and
 * Linux; the encoding cases must pass on both platforms.
 */

const CTX = {} as never;
const BOM = "﻿";

interface RunResult {
  text: string;
  details: Record<string, unknown>;
}

async function run(
  tool: ToolDefinition,
  params: unknown,
  signal?: AbortSignal,
): Promise<RunResult> {
  const res = await tool.execute("t", params, signal, undefined, CTX);
  const first = res.content[0] as { type: string; text: string };
  return { text: first.text, details: res.details as Record<string, unknown> };
}

/** Read a file's exact decoded contents (BOM char + line endings preserved). */
function readExact(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

let dir: string;
let tool: ToolDefinition;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-multiedit-"));
  tool = createMultiEditTool(() => dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------

describe("MultiEdit sequential application & atomicity", () => {
  it("(1) applies edits sequentially — edit 2 matches text produced by edit 1", async () => {
    const p = write("seq.txt", "foo\n");
    await run(tool, {
      file_path: "seq.txt",
      edits: [
        { old_string: "foo", new_string: "bar" },
        { old_string: "bar", new_string: "baz" },
      ],
    });
    expect(readExact(p)).toBe("baz\n");
  });

  it("(2) rolls back atomically when a later edit fails — file byte-identical", async () => {
    const p = write("atomic.txt", "aaa\nbbb\n");
    const before = readExact(p);
    await expect(
      run(tool, {
        file_path: "atomic.txt",
        edits: [
          { old_string: "aaa", new_string: "AAA" },
          { old_string: "zzz", new_string: "z" },
        ],
      }),
    ).rejects.toThrow(/not found/i);
    expect(readExact(p)).toBe(before);
  });

  it("(3) rolls back when edit 1 succeeds and edit 2 is ambiguous (no partial write)", async () => {
    const p = write("rollback.txt", "hello\ndup\ndup\n");
    const before = readExact(p);
    const call = run(tool, {
      file_path: "rollback.txt",
      edits: [
        { old_string: "hello", new_string: "hi" },
        { old_string: "dup", new_string: "x" },
      ],
    });
    await expect(call).rejects.toThrow(/not unique/i);
    // The error must name the failing edit index (contract: multi-edit batches
    // report which edit failed) — a regression that dropped the label would
    // otherwise keep the reason-only assertion green.
    await expect(call).rejects.toThrow(/edits\[1\]/);
    expect(readExact(p)).toBe(before);
  });

  it("(4) errors on a non-unique old_string without replace_all", async () => {
    const p = write("dup.txt", "dup\ndup\n");
    const before = readExact(p);
    await expect(
      run(tool, { file_path: "dup.txt", edits: [{ old_string: "dup", new_string: "x" }] }),
    ).rejects.toThrow(/not unique|2 occurrences/i);
    expect(readExact(p)).toBe(before);
  });

  it("(5) replace_all replaces every occurrence; a sibling non-replace_all edit stays single-match", async () => {
    const p = write("all.txt", "x x x\nonly-once\n");
    await run(tool, {
      file_path: "all.txt",
      edits: [
        { old_string: "x", new_string: "y", replace_all: true },
        { old_string: "only-once", new_string: "done" },
      ],
    });
    expect(readExact(p)).toBe("y y y\ndone\n");
  });

  it("(6) an absent old_string is a not-found error with replace_all false AND true", async () => {
    const p = write("absent.txt", "abc\n");
    const before = readExact(p);
    await expect(
      run(tool, {
        file_path: "absent.txt",
        edits: [{ old_string: "zzz", new_string: "q", replace_all: false }],
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      run(tool, {
        file_path: "absent.txt",
        edits: [{ old_string: "zzz", new_string: "q", replace_all: true }],
      }),
    ).rejects.toThrow(/not found/i);
    expect(readExact(p)).toBe(before);
  });
});

describe("MultiEdit input & existence validation", () => {
  it("(7) rejects an empty edits array", async () => {
    write("empty.txt", "a\n");
    await expect(run(tool, { file_path: "empty.txt", edits: [] })).rejects.toThrow(
      /at least one edit/i,
    );
  });

  it("(8) reports file-not-found for a non-empty first edit on a missing file", async () => {
    await expect(
      run(tool, { file_path: "missing.txt", edits: [{ old_string: "a", new_string: "b" }] }),
    ).rejects.toThrow(/does not exist/i);
    expect(fs.existsSync(path.join(dir, "missing.txt"))).toBe(false);
  });

  it("(11) rejects an edit whose old_string equals new_string", async () => {
    const p = write("same.txt", "a\n");
    const before = readExact(p);
    await expect(
      run(tool, { file_path: "same.txt", edits: [{ old_string: "a", new_string: "a" }] }),
    ).rejects.toThrow(/must differ/i);
    expect(readExact(p)).toBe(before);
  });

  it("(14) treats new_string='' as a valid deletion", async () => {
    const p = write("del.txt", "abcXYZdef\n");
    await run(tool, { file_path: "del.txt", edits: [{ old_string: "XYZ", new_string: "" }] });
    expect(readExact(p)).toBe("abcdef\n");
  });
});

describe("MultiEdit path resolution", () => {
  it("(12) resolves relative and absolute file_path against the injected getCwd", async () => {
    const rel = write("rel.txt", "one\n");
    await run(tool, { file_path: "rel.txt", edits: [{ old_string: "one", new_string: "1" }] });
    expect(readExact(rel)).toBe("1\n");

    const abs = write("abs.txt", "two\n");
    await run(tool, {
      file_path: path.join(dir, "abs.txt"),
      edits: [{ old_string: "two", new_string: "2" }],
    });
    expect(readExact(abs)).toBe("2\n");
  });

  it("(17) resolves ~-prefixed paths literally, never expanding to the home directory", async () => {
    // A future switch to Pi's resolveToCwd (~/file:// expansion) would edit the
    // wrong file and fail this test — the deny-rule bypass this guards against.
    const literalDir = path.join(dir, "~");
    fs.mkdirSync(literalDir);
    const literalFile = path.join(literalDir, "x.txt");
    fs.writeFileSync(literalFile, "hello\n");

    await run(tool, {
      file_path: "~/x.txt",
      edits: [{ old_string: "hello", new_string: "bye" }],
    });

    expect(readExact(literalFile)).toBe("bye\n");
    expect(fs.existsSync(path.join(os.homedir(), "x.txt"))).toBe(false);
  });
});

describe("MultiEdit file creation via empty old_string", () => {
  it("(13a) creates a new file when the first edit's old_string is empty", async () => {
    await run(tool, {
      file_path: "created.txt",
      edits: [{ old_string: "", new_string: "line1\nline2\n" }],
    });
    expect(readExact(path.join(dir, "created.txt"))).toBe("line1\nline2\n");
  });

  it("(13a) applies later edits to the just-created buffer", async () => {
    await run(tool, {
      file_path: "created2.txt",
      edits: [
        { old_string: "", new_string: "a\nb\n" },
        { old_string: "a", new_string: "A" },
      ],
    });
    expect(readExact(path.join(dir, "created2.txt"))).toBe("A\nb\n");
  });

  it("(13b) rejects an empty old_string on an existing file", async () => {
    const p = write("exists.txt", "x\n");
    const before = readExact(p);
    await expect(
      run(tool, { file_path: "exists.txt", edits: [{ old_string: "", new_string: "y" }] }),
    ).rejects.toThrow(/already exists/i);
    expect(readExact(p)).toBe(before);
  });

  it("(13c) rejects an empty old_string as a non-first edit even while creating", async () => {
    await expect(
      run(tool, {
        file_path: "created3.txt",
        edits: [
          { old_string: "", new_string: "hi\n" },
          { old_string: "", new_string: "again" },
        ],
      }),
    ).rejects.toThrow(/not the first edit/i);
    expect(fs.existsSync(path.join(dir, "created3.txt"))).toBe(false);
  });
});

describe("MultiEdit encoding & line endings", () => {
  it("(9) preserves a leading UTF-8 BOM", async () => {
    const p = write("bom.txt", `${BOM}hello\nworld\n`);
    await run(tool, { file_path: "bom.txt", edits: [{ old_string: "hello", new_string: "hi" }] });
    expect(readExact(p)).toBe(`${BOM}hi\nworld\n`);
  });

  it("(10) keeps a uniform-CRLF file CRLF on untouched lines", async () => {
    const p = write("crlf.txt", "a\r\nb\r\nc\r\n");
    await run(tool, { file_path: "crlf.txt", edits: [{ old_string: "b", new_string: "B" }] });
    expect(readExact(p)).toBe("a\r\nB\r\nc\r\n");
  });

  it("(10) keeps a uniform-LF file LF on untouched lines", async () => {
    const p = write("lf.txt", "a\nb\nc\n");
    await run(tool, { file_path: "lf.txt", edits: [{ old_string: "b", new_string: "B" }] });
    expect(readExact(p)).toBe("a\nB\nc\n");
  });

  it("(10) collapses a genuinely mixed-EOL file to the detected ending", async () => {
    // First occurrence is CRLF, so CRLF is detected and the lone LF collapses.
    const p = write("mixed.txt", "a\r\nb\nc\r\n");
    await run(tool, { file_path: "mixed.txt", edits: [{ old_string: "b", new_string: "B" }] });
    expect(readExact(p)).toBe("a\r\nB\r\nc\r\n");
  });

  it("(15) a new_string containing \\r\\n in a CRLF file does not become \\r\\r\\n", async () => {
    const p = write("insert-crlf.txt", "a\r\nb\r\nc\r\n");
    await run(tool, {
      file_path: "insert-crlf.txt",
      edits: [{ old_string: "b", new_string: "X\r\nY" }],
    });
    expect(readExact(p)).toBe("a\r\nX\r\nY\r\nc\r\n");
    expect(readExact(p)).not.toContain("\r\r\n");
  });
});

describe("MultiEdit abort discipline", () => {
  it("(16) a pre-aborted signal throws and leaves the file byte-unchanged", async () => {
    const p = write("abort.txt", "keep\n");
    const before = readExact(p);
    const controller = new AbortController();
    controller.abort();
    await expect(
      run(
        tool,
        { file_path: "abort.txt", edits: [{ old_string: "keep", new_string: "changed" }] },
        controller.signal,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(readExact(p)).toBe(before);
  });
});
