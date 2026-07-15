import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGlobTool, createGrepTool } from "../src/runtime/tools/search-tools.js";
import { TaskStore, createTaskTools } from "../src/runtime/tools/task-tools.js";
import { DEGRADED_TOOLS, createDegradeStub } from "../src/runtime/tools/degrade-stubs.js";
import {
  createWebFetchTool,
  createWebSearchTool,
  htmlToText,
} from "../src/runtime/tools/web-tools.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Grep (forced JS fallback for determinism)
// ---------------------------------------------------------------------------

describe("Grep tool (JS fallback)", () => {
  let dir: string;
  let grep: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-grep-");
    fs.writeFileSync(path.join(dir, "a.txt"), "hello world\nfoo bar\nHello Again\nfoo (paren\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.js"), "const foo = 1;\nfunction hello() {}\n");
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "skip.txt"), "hello world\n");
    fs.writeFileSync(
      path.join(dir, "bin.dat"),
      Buffer.concat([Buffer.from("hello"), Buffer.from([0, 1, 2]), Buffer.from("world")]),
    );
    fs.writeFileSync(
      path.join(dir, "big.txt"),
      `hello big\n${"x".repeat(2 * 1024 * 1024 + 100)}\n`,
    );
    grep = createGrepTool(() => dir, { forceJs: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a literal string in content mode", async () => {
    const { text, details } = await run(grep, { pattern: "foo bar", output_mode: "content" });
    expect(text).toContain("a.txt:2:foo bar");
    expect(details.engine).toBe("js");
  });

  it("supports real regular expressions", async () => {
    const { text } = await run(grep, { pattern: "hel+o w\\w+d", output_mode: "content" });
    expect(text).toContain("a.txt:1:hello world");
    expect(text).not.toContain("Hello Again");
  });

  it("honors -i case-insensitive search", async () => {
    const sensitive = await run(grep, { pattern: "HELLO", output_mode: "content" });
    expect(sensitive.text).toBe("No matches found");
    const insensitive = await run(grep, {
      pattern: "HELLO",
      "-i": true,
      output_mode: "content",
    });
    expect(insensitive.text).toContain("a.txt:1:hello world");
    expect(insensitive.text).toContain("a.txt:3:Hello Again");
    expect(insensitive.text).toContain("sub/b.js:2:function hello() {}");
  });

  it("applies a glob file filter", async () => {
    const { text } = await run(grep, { pattern: "foo", glob: "*.js" });
    expect(text).toContain("sub/b.js");
    expect(text).not.toContain("a.txt");
  });

  it("defaults to files_with_matches output mode", async () => {
    const { text, details } = await run(grep, { pattern: "foo" });
    expect(details.mode).toBe("files_with_matches");
    expect(text.split("\n").sort()).toEqual(["a.txt", "sub/b.js"]);
  });

  it("supports count output mode", async () => {
    const { text } = await run(grep, { pattern: "foo", output_mode: "count" });
    expect(text).toContain("a.txt:2");
    expect(text).toContain("sub/b.js:1");
  });

  it("respects head_limit", async () => {
    const { text, details } = await run(grep, {
      pattern: "o",
      output_mode: "content",
      head_limit: 2,
    });
    expect(details.returnedEntries).toBe(2);
    expect(text).toContain("[Results limited to first 2 of");
  });

  it("falls back to literal search for invalid regexes", async () => {
    const { text } = await run(grep, { pattern: "foo (", output_mode: "content" });
    expect(text).toContain("a.txt:4:foo (paren");
  });

  it("skips node_modules, binary files, and files over 2MB", async () => {
    const { text } = await run(grep, { pattern: "hello" });
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("bin.dat");
    expect(text).not.toContain("big.txt");
  });

  it("searches a subdirectory via the path param", async () => {
    const { text } = await run(grep, { pattern: "foo", path: "sub", output_mode: "content" });
    expect(text).toContain("b.js:1:const foo = 1;");
    expect(text).not.toContain("a.txt");
  });

  it("throws for a nonexistent path", async () => {
    await expect(run(grep, { pattern: "x", path: "does-not-exist" })).rejects.toThrow(
      /does not exist/,
    );
  });
});

// ---------------------------------------------------------------------------
// Glob
// ---------------------------------------------------------------------------

describe("Glob tool", () => {
  let dir: string;
  let glob: ToolDefinition;

  beforeAll(() => {
    dir = mkTmpDir("picc-glob-");
    fs.writeFileSync(path.join(dir, "old.txt"), "old");
    fs.writeFileSync(path.join(dir, "new.txt"), "new");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "c.js"), "// c");
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(dir, "old.txt"), now - 3600, now - 3600);
    fs.utimesSync(path.join(dir, "new.txt"), now, now);
    glob = createGlobTool(() => dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("matches patterns and sorts by mtime (newest first)", async () => {
    const { text, details } = await run(glob, { pattern: "*.txt" });
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("new.txt");
    expect(lines[1]).toContain("old.txt");
    expect(details.totalMatches).toBe(2);
  });

  it("matches nested files with **", async () => {
    const { text } = await run(glob, { pattern: "**/*.js" });
    expect(text).toContain(path.join(dir, "sub", "c.js"));
  });

  it("reports when nothing matches", async () => {
    const { text } = await run(glob, { pattern: "*.nope" });
    expect(text).toBe("No files found");
  });
});

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

describe("Task tools", () => {
  function toolByName(bundle: { tools: ToolDefinition[] }, name: string): ToolDefinition {
    const tool = bundle.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    return tool;
  }

  it("supports the create/update/list/get flow", async () => {
    const bundle = createTaskTools();
    const create = toolByName(bundle, "TaskCreate");
    const update = toolByName(bundle, "TaskUpdate");
    const list = toolByName(bundle, "TaskList");
    const get = toolByName(bundle, "TaskGet");

    const created = await run(create, { subject: "Write tests", description: "vitest suite" });
    expect(created.text).toContain("Created task #1");
    await run(create, { subject: "Ship it", activeForm: "Shipping it" });

    const updated = await run(update, { taskId: "1", status: "in_progress", owner: "agent-a" });
    expect(updated.text).toContain("#1 [in_progress] Write tests (owner: agent-a)");

    const listed = await run(list, {});
    expect(listed.text).toContain("#1 [in_progress] Write tests");
    expect(listed.text).toContain("#2 [pending] Ship it");

    const got = await run(get, { taskId: "1" });
    expect(got.text).toContain("Task #1");
    expect(got.text).toContain("Description: vitest suite");
    expect(got.text).toContain("Owner: agent-a");
  });

  it("tracks blockedBy and supports deletion", async () => {
    const bundle = createTaskTools();
    const create = toolByName(bundle, "TaskCreate");
    const update = toolByName(bundle, "TaskUpdate");
    const list = toolByName(bundle, "TaskList");

    await run(create, { subject: "Blocker" });
    await run(create, { subject: "Blocked work" });
    const updated = await run(update, { taskId: "2", addBlockedBy: ["1"] });
    expect(updated.text).toContain("(blocked by: #1)");
    expect(bundle.store.get("2")?.blockedBy).toEqual(["1"]);

    await run(update, { taskId: "1", status: "deleted" });
    const listed = await run(list, {});
    expect(listed.text).not.toContain("Blocker\n");
    expect(bundle.store.list().map((t) => t.id)).toEqual(["2"]);
  });

  it("rejects updates and gets for unknown task ids", async () => {
    const bundle = createTaskTools();
    await expect(
      run(toolByName(bundle, "TaskUpdate"), { taskId: "99", status: "completed" }),
    ).rejects.toThrow(/No task with id 99/);
    await expect(run(toolByName(bundle, "TaskGet"), { taskId: "99" })).rejects.toThrow(
      /No task with id 99/,
    );
  });

  it("TodoWrite replaces the store contents and points at Task* tools", async () => {
    const bundle = createTaskTools();
    await run(toolByName(bundle, "TaskCreate"), { subject: "Old task" });
    const res = await run(toolByName(bundle, "TodoWrite"), {
      todos: [
        { content: "New one", status: "pending" },
        { content: "New two", status: "in_progress", activeForm: "Doing two" },
      ],
    });
    expect(res.text).toContain("Replaced task list with 2 task(s)");
    expect(res.text).toContain("Task* tools");
    const subjects = bundle.store.list().map((t) => t.subject);
    expect(subjects).toEqual(["New one", "New two"]);
    expect(bundle.store.list().some((t) => t.subject === "Old task")).toBe(false);
  });

  it("returns a store snapshot in details on every result", async () => {
    const bundle = createTaskTools();
    const created = await run(toolByName(bundle, "TaskCreate"), { subject: "Snap" });
    const tasks = created.details.tasks as Array<{ id: string; subject: string }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks[0]).toMatchObject({ id: "1", subject: "Snap" });
    const listed = await run(toolByName(bundle, "TaskList"), {});
    expect((listed.details.tasks as unknown[]).length).toBe(1);
  });

  it("exports a usable standalone TaskStore", () => {
    const store = new TaskStore();
    const t = store.create({ subject: "s" });
    expect(t.id).toBe("1");
    expect(store.snapshot()).not.toBe(store.list());
  });
});

// ---------------------------------------------------------------------------
// Degrade stubs
// ---------------------------------------------------------------------------

describe("degrade stubs", () => {
  it("return non-error content and are callable with arbitrary params", async () => {
    const stub = createDegradeStub("NotebookEdit", "notebook editing is not implemented");
    const res = await run(stub, { anything: 123, nested: { deep: true }, cells: ["x"] });
    expect(res.text).toContain("The NotebookEdit tool is not available in PiCC");
    expect(res.text).toContain("Proceed without it.");
    expect(res.details.degraded).toBe(true);
  });

  it("cover the plan §7 degraded tool names", async () => {
    const names = DEGRADED_TOOLS.map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "NotebookEdit",
        "AskUserQuestion",
        "ExitPlanMode",
        "EnterPlanMode",
        "Artifact",
        "computer",
      ]),
    );
    // Every listed stub instantiates and executes without throwing.
    for (const { name, note } of DEGRADED_TOOLS) {
      const res = await run(createDegradeStub(name, note), {});
      expect(res.text).toContain(`The ${name} tool is not available`);
    }
  });
});

// ---------------------------------------------------------------------------
// WebFetch (local HTTP server, no real network)
// ---------------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html><head><title>T</title>
<style>.x{color:red}</style>
<script>var secret = "js-code";</script>
</head><body>
<h1>Big &amp; Bold</h1>
<p>Hello &lt;world&gt; &quot;quoted&quot; &#39;s&nbsp;end</p>
<ul><li>First item</li><li>Second item</li></ul>
<p>Visit <a href="https://example.com/docs">the docs</a> now.</p>
<noscript>NOSCRIPT-FALLBACK</noscript>
</body></html>`;

describe("WebFetch tool", () => {
  let server: http.Server;
  let baseUrl: string;
  let webFetch: ToolDefinition;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/page.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
      } else if (url === "/redirect") {
        res.writeHead(302, { location: "/page.html" });
        res.end();
      } else if (url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (url === "/data.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"a":1,"b":["x","y"]}');
      } else if (url === "/huge.html") {
        const body = Array.from({ length: 5000 }, (_, i) => `<p>line ${i + 1}</p>`).join("");
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>${body}</body></html>`);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nothing here");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    webFetch = createWebFetchTool(() => process.cwd());
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("converts HTML to readable text with entity decoding", async () => {
    const { text } = await run(webFetch, { url: `${baseUrl}/page.html` });
    expect(text).toContain("Big & Bold");
    expect(text).toContain(`Hello <world> "quoted" 's end`);
    expect(text).toContain("- First item");
    expect(text).toContain("- Second item");
    expect(text).toContain("the docs (https://example.com/docs)");
    expect(text).not.toContain("js-code");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("NOSCRIPT-FALLBACK");
  });

  it("prepends the prompt line when a prompt is given", async () => {
    const url = `${baseUrl}/page.html`;
    const { text } = await run(webFetch, { url, prompt: "summarize" });
    expect(text.startsWith(`Content of ${url} (analyze per prompt: summarize):\n\n`)).toBe(true);
  });

  it("follows redirects", async () => {
    const { text, details } = await run(webFetch, { url: `${baseUrl}/redirect` });
    expect(text).toContain("Big & Bold");
    expect(String(details.finalUrl)).toContain("/page.html");
  });

  it("throws on too many redirects", async () => {
    await expect(run(webFetch, { url: `${baseUrl}/loop` })).rejects.toThrow(/too many redirects/);
  });

  it("pretty-prints JSON responses", async () => {
    const { text } = await run(webFetch, { url: `${baseUrl}/data.json` });
    expect(text).toBe('{\n  "a": 1,\n  "b": [\n    "x",\n    "y"\n  ]\n}');
  });

  it("truncates huge bodies", async () => {
    const { text, details } = await run(webFetch, { url: `${baseUrl}/huge.html` });
    expect(details.truncated).toBe(true);
    expect(text).toContain("[Content truncated: showing first");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(80 * 1024);
  });

  it("throws a clear error for HTTP error statuses", async () => {
    await expect(run(webFetch, { url: `${baseUrl}/missing` })).rejects.toThrow(/HTTP 404/);
  });

  it("throws a clear error for network failures", async () => {
    await expect(run(webFetch, { url: "http://127.0.0.1:1/unreachable" })).rejects.toThrow(
      /WebFetch failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// WebSearch (fake fetch, no network)
// ---------------------------------------------------------------------------

function fakeFetchReturning(body: string, contentType: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
}

const BRAVE_BODY = JSON.stringify({
  web: {
    results: [
      { title: "Example A", url: "https://example.com/a", description: "About A" },
      { title: "Blocked B", url: "https://blocked.org/b", description: "About B" },
      { title: "Sub C", url: "https://sub.example.com/c", description: "About C" },
    ],
  },
});

const DDG_BODY = `
<div class="result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">Example Docs</a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Snippet one</a>
</div>
<div class="result">
  <a class="result__a" href="https://direct.example.org/page">Direct <b>Result</b></a>
  <a class="result__snippet">Snippet two</a>
</div>`;

describe("WebSearch tool", () => {
  const savedKey = process.env.BRAVE_API_KEY;

  afterAll(() => {
    if (savedKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = savedKey;
  });

  it("uses the Brave backend when BRAVE_API_KEY is set and formats results", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const tool = createWebSearchTool(() => process.cwd(), {
      fetchImpl: fakeFetchReturning(BRAVE_BODY, "application/json"),
    });
    const { text, details } = await run(tool, { query: "example things" });
    expect(details.backend).toBe("brave");
    expect(text).toContain('Search results for "example things":');
    expect(text).toContain("1. Example A\n   https://example.com/a\n   About A");
    expect(text).toContain("2. Blocked B");
    expect(text).toContain("3. Sub C");
  });

  it("applies allowed_domains and blocked_domains filters", async () => {
    process.env.BRAVE_API_KEY = "test-key";
    const tool = createWebSearchTool(() => process.cwd(), {
      fetchImpl: fakeFetchReturning(BRAVE_BODY, "application/json"),
    });

    const allowed = await run(tool, { query: "q", allowed_domains: ["example.com"] });
    expect(allowed.text).toContain("Example A");
    expect(allowed.text).toContain("Sub C"); // sub.example.com matches example.com
    expect(allowed.text).not.toContain("Blocked B");

    const blocked = await run(tool, { query: "q", blocked_domains: ["blocked.org"] });
    expect(blocked.text).toContain("Example A");
    expect(blocked.text).not.toContain("Blocked B");

    const none = await run(tool, { query: "q", allowed_domains: ["nowhere.test"] });
    expect(none.text).toContain('No results found for "q"');
  });

  it("falls back to DuckDuckGo parsing with uddg redirect decoding", async () => {
    delete process.env.BRAVE_API_KEY;
    const tool = createWebSearchTool(() => process.cwd(), {
      fetchImpl: fakeFetchReturning(DDG_BODY, "text/html"),
    });
    const { text, details } = await run(tool, { query: "docs" });
    expect(details.backend).toBe("duckduckgo");
    expect(text).toContain("1. Example Docs\n   https://example.com/docs\n   Snippet one");
    expect(text).toContain("2. Direct Result\n   https://direct.example.org/page\n   Snippet two");
  });

  it("throws an informative error when all backends fail", async () => {
    delete process.env.BRAVE_API_KEY;
    const failingFetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const tool = createWebSearchTool(() => process.cwd(), { fetchImpl: failingFetch });
    await expect(run(tool, { query: "anything" })).rejects.toThrow(/BRAVE_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// htmlToText unit checks
// ---------------------------------------------------------------------------

describe("htmlToText", () => {
  it("collapses whitespace and drops comments", () => {
    const out = htmlToText("<p>a   b</p><!-- hidden -->\n\n\n<p>c</p>");
    expect(out).toBe("a b\n\nc");
    expect(out).not.toContain("hidden");
  });

  it("keeps anchor targets", () => {
    expect(htmlToText('<a href="https://x.test/y">link</a>')).toBe("link (https://x.test/y)");
    expect(htmlToText('<a href="#frag">local</a>')).toBe("local");
  });
});
