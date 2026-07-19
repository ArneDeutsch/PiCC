import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGrepTool } from "../src/runtime/tools/search-tools.js";

/**
 * Ripgrep-engine coverage: runs the same queries through the real
 * `rg` binary and the pure-JS fallback and asserts entry-for-entry parity —
 * same files found, same output shape. Skipped when rg is not on PATH.
 */

const rgAvailable = (() => {
  try {
    return spawnSync("rg", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
})();

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

describe.skipIf(!rgAvailable)("Grep tool (ripgrep engine, parity with JS fallback)", () => {
  let dir: string;
  let rgGrep: ToolDefinition;
  let jsGrep: ToolDefinition;

  /** Run the same query through both engines, assert each engine actually ran. */
  async function both(params: Record<string, unknown>): Promise<[RunResult, RunResult]> {
    const rg = await run(rgGrep, params);
    const js = await run(jsGrep, params);
    expect(rg.details.engine).toBe("rg");
    expect(js.details.engine).toBe("js");
    return [rg, js];
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-grep-rg-"));
    // A .git dir makes both engines treat this fixture as the repo root, so
    // .gitignore applies and ancestor directories cannot interfere.
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\nbuild/\n");
    fs.writeFileSync(
      path.join(dir, "a.txt"),
      "hello world\nfoo bar\nmid1\nmid2\nmid3\nfoo again\nlast line\n",
    );
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.js"), "const foo = 1;\nfunction hello() {}\n");
    fs.writeFileSync(path.join(dir, "c.py"), "foo python\n");
    fs.writeFileSync(path.join(dir, "ignored.txt"), "foo ignored\n");
    fs.mkdirSync(path.join(dir, "build"));
    fs.writeFileSync(path.join(dir, "build", "gen.txt"), "foo built\n");
    fs.writeFileSync(path.join(dir, ".hiddenfile.txt"), "foo hiddenfile\n");
    fs.mkdirSync(path.join(dir, ".hdir"));
    fs.writeFileSync(path.join(dir, ".hdir", "h.txt"), "foo hidden\n");
    rgGrep = createGrepTool(() => dir);
    jsGrep = createGrepTool(() => dir, { forceJs: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("files_with_matches: engines agree and both skip hidden + gitignored files", async () => {
    const [rg, js] = await both({ pattern: "foo" });
    expect(rg.text).toBe("a.txt\nc.py\nsub/b.js");
    expect(js.text).toBe(rg.text);
  });

  it("content mode: identical path:line:content output", async () => {
    const [rg, js] = await both({ pattern: "foo", output_mode: "content" });
    expect(rg.text).toBe(
      [
        "a.txt:2:foo bar",
        "a.txt:6:foo again",
        "c.py:1:foo python",
        "sub/b.js:1:const foo = 1;",
      ].join("\n"),
    );
    expect(js.text).toBe(rg.text);
  });

  it("count mode: identical path:count output", async () => {
    const [rg, js] = await both({ pattern: "foo", output_mode: "count" });
    expect(rg.text).toBe("a.txt:2\nc.py:1\nsub/b.js:1");
    expect(js.text).toBe(rg.text);
  });

  it("single-file content search keeps the file name prefix", async () => {
    const [rg, js] = await both({ pattern: "foo", path: "a.txt", output_mode: "content" });
    expect(rg.text).toBe("a.txt:2:foo bar\na.txt:6:foo again");
    expect(js.text).toBe(rg.text);
  });

  it("single-file count search keeps the file name prefix", async () => {
    const [rg, js] = await both({ pattern: "foo", path: "a.txt", output_mode: "count" });
    expect(rg.text).toBe("a.txt:2");
    expect(js.text).toBe(rg.text);
  });

  it("context (-C): identical chunk shape with -- separators", async () => {
    const [rg, js] = await both({
      pattern: "foo",
      path: "a.txt",
      output_mode: "content",
      "-C": 1,
    });
    expect(rg.text).toBe(
      [
        "a.txt-1-hello world",
        "a.txt:2:foo bar",
        "a.txt-3-mid1",
        "--",
        "a.txt-5-mid3",
        "a.txt:6:foo again",
        "a.txt-7-last line",
      ].join("\n"),
    );
    expect(js.text).toBe(rg.text);
  });

  it("context across files: identical -- separators between files", async () => {
    const [rg, js] = await both({ pattern: "hello", output_mode: "content", "-C": 1 });
    expect(rg.text).toBe(
      [
        "a.txt:1:hello world",
        "a.txt-2-foo bar",
        "--",
        "sub/b.js-1-const foo = 1;",
        "sub/b.js:2:function hello() {}",
      ].join("\n"),
    );
    expect(js.text).toBe(rg.text);
  });

  it("-n: false hides line numbers identically", async () => {
    const [rg, js] = await both({
      pattern: "foo",
      path: "a.txt",
      output_mode: "content",
      "-n": false,
    });
    expect(rg.text).toBe("a.txt:foo bar\na.txt:foo again");
    expect(js.text).toBe(rg.text);
  });

  it("-o prints only the matched parts identically", async () => {
    const [rg, js] = await both({
      pattern: "fo+",
      path: "a.txt",
      output_mode: "content",
      "-o": true,
    });
    expect(rg.text).toBe("a.txt:2:foo\na.txt:6:foo");
    expect(js.text).toBe(rg.text);
  });

  it("type filter parity", async () => {
    const [rg, js] = await both({ pattern: "foo", type: "js" });
    expect(rg.text).toBe("sub/b.js");
    expect(js.text).toBe(rg.text);
  });

  it("glob filter parity", async () => {
    const [rg, js] = await both({ pattern: "foo", glob: "*.py" });
    expect(rg.text).toBe("c.py");
    expect(js.text).toBe(rg.text);
  });

  it("passes ripgrep-only patterns like (?i) through to rg untouched", async () => {
    const [rg, js] = await both({ pattern: "(?i)FOO", output_mode: "files_with_matches" });
    expect(rg.text).toBe("a.txt\nc.py\nsub/b.js"); // not a literal "(?i)FOO" search
    expect(js.text).toBe(rg.text);
  });

  it("multiline mode parity (content and count)", async () => {
    const [rg, js] = await both({
      pattern: "foo bar.mid1",
      path: "a.txt",
      output_mode: "content",
      multiline: true,
    });
    expect(rg.text).toBe("a.txt:2:foo bar\na.txt:3:mid1");
    expect(js.text).toBe(rg.text);

    const [rgCount, jsCount] = await both({
      pattern: "foo bar.mid1",
      path: "a.txt",
      output_mode: "count",
      multiline: true,
    });
    expect(rgCount.text).toBe("a.txt:1");
    expect(jsCount.text).toBe(rgCount.text);
  });

  it("case-insensitive (-i) parity", async () => {
    const [rg, js] = await both({ pattern: "HELLO", "-i": true, output_mode: "content" });
    expect(rg.text).toBe("a.txt:1:hello world\nsub/b.js:2:function hello() {}");
    expect(js.text).toBe(rg.text);
  });

  it("normalizes large, fractional, and negative numeric inputs with exact engine parity", async () => {
    const cases = [
      {
        label: "large values; rg rejects the context argument and falls back",
        params: {
          pattern: "foo",
          path: "a.txt",
          output_mode: "content",
          head_limit: Number.MAX_VALUE,
          offset: Number.MAX_VALUE,
          context: Number.MAX_VALUE,
        },
        text: "No entries at offset 1.7976931348623157e+308 (7 total)",
        details: { mode: "content", engine: "js", totalEntries: 7, returnedEntries: 0, truncated: false },
        rgEngine: "js",
      },
      {
        label: "fractions below one",
        params: {
          pattern: "foo",
          path: "a.txt",
          output_mode: "content",
          head_limit: 0.9,
          offset: 0.9,
          context: 0.9,
        },
        text: "No entries at offset 0 (2 total)",
        details: { mode: "content", engine: "js", totalEntries: 2, returnedEntries: 0, truncated: false },
        rgEngine: "rg",
      },
      {
        label: "negative fractions",
        params: {
          pattern: "foo",
          path: "a.txt",
          output_mode: "content",
          head_limit: -0.1,
          offset: -0.1,
          context: -0.1,
        },
        text: "a.txt:2:foo bar\na.txt:6:foo again",
        details: { mode: "content", engine: "js", totalEntries: 2, returnedEntries: 2, truncated: false },
        rgEngine: "rg",
      },
    ] as const;

    for (const testCase of cases) {
      const rg = await run(rgGrep, testCase.params);
      const js = await run(jsGrep, testCase.params);
      expect(js, testCase.label).toEqual({ text: testCase.text, details: testCase.details });
      expect(rg.text, testCase.label).toBe(testCase.text);
      expect(rg.details, testCase.label).toEqual({ ...testCase.details, engine: testCase.rgEngine });
    }
  });

  it("no-match parity", async () => {
    const [rg, js] = await both({ pattern: "zebra-not-present" });
    expect(rg.text).toBe("No matches found");
    expect(js.text).toBe(rg.text);
  });
});
