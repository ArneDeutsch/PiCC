import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGrepTool } from "../src/runtime/tools/search-tools.js";

/**
 * Grep parameter-surface and engine-alignment tests (plan §4.8), run against
 * the pure-JS engine (`forceJs: true`) for determinism. Ripgrep-engine parity
 * is covered in search-tools-rg.test.ts.
 */

const CTX = {} as never;

interface RunResult {
  text: string;
  details: Record<string, unknown>;
}

async function run(tool: ToolDefinition, params: unknown): Promise<RunResult> {
  const res = await tool.execute("test-call", params, undefined, undefined, CTX);
  const first = res.content[0] as { type: string; text: string };
  return { text: first.text, details: res.details as Record<string, unknown> };
}

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// Claude Code parameter surface: -n, -A/-B/-C, -o, type, multiline, offset,
// head_limit 0 = unlimited
// ---------------------------------------------------------------------------

describe("Grep parameter surface (JS engine)", () => {
  let dir: string;
  let grep: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-grep-params-");
    // Pin the gitignore root here so ancestor directories cannot interfere.
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(
      path.join(dir, "f.txt"),
      "one\ntwo NEEDLE\nthree\nfour\nfive\nsix NEEDLE\nseven\n",
    );
    fs.writeFileSync(path.join(dir, "t.js"), "typedmark js\n");
    fs.writeFileSync(path.join(dir, "t.py"), "typedmark py\n");
    const bulk = Array.from({ length: 120 }, (_, i) => `bulk line ${i + 1}`).join("\n");
    fs.writeFileSync(path.join(dir, "many.txt"), `${bulk}\n`);
    grep = createGrepTool(() => dir, { forceJs: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows line numbers by default and hides them with -n: false", async () => {
    const numbered = await run(grep, { pattern: "NEEDLE", output_mode: "content" });
    expect(numbered.text).toBe("f.txt:2:two NEEDLE\nf.txt:6:six NEEDLE");
    const plain = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-n": false });
    expect(plain.text).toBe("f.txt:two NEEDLE\nf.txt:six NEEDLE");
  });

  it("supports -C context with ripgrep's chunk shape (- separators, -- between chunks)", async () => {
    const { text } = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-C": 1 });
    expect(text).toBe(
      [
        "f.txt-1-one",
        "f.txt:2:two NEEDLE",
        "f.txt-3-three",
        "--",
        "f.txt-5-five",
        "f.txt:6:six NEEDLE",
        "f.txt-7-seven",
      ].join("\n"),
    );
  });

  it("supports the context alias for -C", async () => {
    const alias = await run(grep, { pattern: "NEEDLE", output_mode: "content", context: 1 });
    const dashC = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-C": 1 });
    expect(alias.text).toBe(dashC.text);
  });

  it("supports -A (after) and -B (before) independently", async () => {
    const after = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-A": 1 });
    expect(after.text).toBe(
      ["f.txt:2:two NEEDLE", "f.txt-3-three", "--", "f.txt:6:six NEEDLE", "f.txt-7-seven"].join(
        "\n",
      ),
    );
    const before = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-B": 1 });
    expect(before.text).toBe(
      ["f.txt-1-one", "f.txt:2:two NEEDLE", "--", "f.txt-5-five", "f.txt:6:six NEEDLE"].join("\n"),
    );
  });

  it("merges overlapping context chunks without a separator", async () => {
    const { text } = await run(grep, { pattern: "NEEDLE", output_mode: "content", "-C": 3 });
    expect(text).not.toContain("--");
    expect(text.split("\n")).toHaveLength(7); // whole file, one chunk
  });

  it("supports -o (only matching parts)", async () => {
    const { text } = await run(grep, { pattern: "NE+DLE", output_mode: "content", "-o": true });
    expect(text).toBe("f.txt:2:NEEDLE\nf.txt:6:NEEDLE");
  });

  it("filters by file type and rejects unknown types", async () => {
    const { text } = await run(grep, { pattern: "typedmark", type: "py" });
    expect(text).toBe("t.py");
    await expect(run(grep, { pattern: "typedmark", type: "nosuchtype" })).rejects.toThrow(
      /unrecognized file type/,
    );
  });

  it("supports multiline mode where patterns span lines", async () => {
    const off = await run(grep, { pattern: "two NEEDLE.three", output_mode: "content" });
    expect(off.text).toBe("No matches found");
    const on = await run(grep, {
      pattern: "two NEEDLE.three",
      output_mode: "content",
      multiline: true,
    });
    expect(on.text).toBe("f.txt:2:two NEEDLE\nf.txt:3:three");
    const count = await run(grep, {
      pattern: "two NEEDLE.three",
      output_mode: "count",
      multiline: true,
    });
    expect(count.text).toBe("f.txt:1"); // multiline matches count as one, like ripgrep
  });

  it("supports offset to skip leading entries", async () => {
    const { text, details } = await run(grep, {
      pattern: "NEEDLE",
      output_mode: "content",
      offset: 1,
    });
    expect(text).toBe("f.txt:6:six NEEDLE\n[Showing entries 2-2 of 2]");
    expect(details.returnedEntries).toBe(1);
    expect(details.totalEntries).toBe(2);
  });

  it("treats head_limit 0 as unlimited (default stays 100)", async () => {
    const capped = await run(grep, { pattern: "bulk", output_mode: "content" });
    expect(capped.details.returnedEntries).toBe(100);
    expect(capped.text).toContain("[Results limited to first 100 of 120 entries]");
    const unlimited = await run(grep, { pattern: "bulk", output_mode: "content", head_limit: 0 });
    expect(unlimited.details.returnedEntries).toBe(120);
    expect(unlimited.text).not.toContain("[Results limited");
  });

  it("ignores content-only flags in files_with_matches mode", async () => {
    const { text } = await run(grep, { pattern: "NEEDLE", "-C": 2, "-n": false, "-o": true });
    expect(text).toBe("f.txt");
  });
});

// ---------------------------------------------------------------------------
// Pattern handling: ripgrep syntax translation and clear errors (no silent
// literal downgrade)
// ---------------------------------------------------------------------------

describe("Grep pattern handling (JS engine)", () => {
  let dir: string;
  let grep: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-grep-pattern-");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, "p.txt"), "Mixed CASE line\nplain line\n");
    grep = createGrepTool(() => dir, { forceJs: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("translates a leading (?i) inline flag instead of searching it literally", async () => {
    const { text } = await run(grep, { pattern: "(?i)mixed case", output_mode: "content" });
    expect(text).toBe("p.txt:1:Mixed CASE line");
  });

  it("translates (?P<name>...) named groups", async () => {
    const { text } = await run(grep, { pattern: "(?P<word>CASE)", output_mode: "content" });
    expect(text).toBe("p.txt:1:Mixed CASE line");
  });

  it("returns a clear error for untranslatable ripgrep-only syntax", async () => {
    await expect(run(grep, { pattern: "(?x)plain line" })).rejects.toThrow(
      /ripgrep regex syntax/,
    );
  });

  it("still falls back to a literal search for patterns invalid in both engines", async () => {
    fs.writeFileSync(path.join(dir, "lit.txt"), "call foo (paren\n");
    const { text } = await run(grep, { pattern: "foo (", output_mode: "content" });
    expect(text).toBe("lit.txt:1:call foo (paren");
  });
});

// ---------------------------------------------------------------------------
// File-set alignment with ripgrep defaults: hidden files, .gitignore
// ---------------------------------------------------------------------------

describe("Grep file-set alignment with ripgrep defaults (JS engine)", () => {
  let dir: string;
  let grep: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-grep-ignore-");
    fs.mkdirSync(path.join(dir, ".git")); // ripgrep honors .gitignore only inside a git repo
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\nbuild/\n*.log\n!keep.log\n");
    fs.writeFileSync(path.join(dir, "root.txt"), "gimark\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "gimark\n");
    fs.writeFileSync(path.join(dir, "keep.log"), "gimark\n");
    fs.writeFileSync(path.join(dir, "other.log"), "gimark\n");
    fs.mkdirSync(path.join(dir, "build"));
    fs.writeFileSync(path.join(dir, "build", "gen.txt"), "gimark\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", ".gitignore"), "local.txt\n");
    fs.writeFileSync(path.join(dir, "sub", "local.txt"), "gimark\n");
    fs.writeFileSync(path.join(dir, "sub", "ok.txt"), "gimark\n");
    fs.writeFileSync(path.join(dir, ".hiddenfile.txt"), "hiddenmark\n");
    fs.mkdirSync(path.join(dir, ".hdir"));
    fs.writeFileSync(path.join(dir, ".hdir", "inner.txt"), "hiddenmark\n");
    grep = createGrepTool(() => dir, { forceJs: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("respects .gitignore, nested .gitignore files, and ! negation", async () => {
    const { text } = await run(grep, { pattern: "gimark" });
    expect(text).toBe("keep.log\nroot.txt\nsub/ok.txt");
  });

  it("skips hidden files and hidden directories", async () => {
    const { text } = await run(grep, { pattern: "hiddenmark" });
    expect(text).toBe("No matches found");
  });

  it("still searches an explicitly named hidden file", async () => {
    const { text } = await run(grep, {
      pattern: "hiddenmark",
      path: ".hiddenfile.txt",
      output_mode: "content",
    });
    expect(text).toBe(".hiddenfile.txt:1:hiddenmark");
  });

  it("does not apply glob/type filters to an explicitly named file (ripgrep behavior)", async () => {
    const { text } = await run(grep, {
      pattern: "gimark",
      path: "root.txt",
      glob: "*.py",
      output_mode: "content",
    });
    expect(text).toBe("root.txt:1:gimark");
  });

  it("ignores .gitignore outside a git repository (ripgrep behavior)", async () => {
    const noRepo = mkTmpDir("picc-grep-norepo-");
    try {
      fs.writeFileSync(path.join(noRepo, ".gitignore"), "ignored.txt\n");
      fs.writeFileSync(path.join(noRepo, "ignored.txt"), "ngmark\n");
      fs.writeFileSync(path.join(noRepo, "plain.txt"), "ngmark\n");
      const local = createGrepTool(() => noRepo, { forceJs: true });
      const { text } = await run(local, { pattern: "ngmark" });
      expect(text).toBe("ignored.txt\nplain.txt");
    } finally {
      fs.rmSync(noRepo, { recursive: true, force: true });
    }
  });
});
