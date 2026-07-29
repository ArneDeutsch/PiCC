import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMcpJson,
  normalizeMcpServerBlock,
  type McpJsonResult,
} from "../src/claude/mcp-config.js";
import { resolveMcpConfig, type GitTrackedProbe } from "../src/discovery/mcp.js";
import { loadClaudeProject } from "../src/project.js";
import type {
  EnabledStdioMcpServer,
  McpSettingsEntry,
  ResolvedMcpConfig,
  ResolvedMcpServer,
  Scope,
} from "../src/types.js";

const tempDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup (Windows can hold handles briefly)
    }
  }
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

const FAKE_ROOT = path.join(os.tmpdir(), "pmc-fake-root");

/** Build a McpJsonResult from an inline block (no filesystem). */
function mcpJsonOf(block: Record<string, unknown>): McpJsonResult {
  return { servers: normalizeMcpServerBlock(block, ".mcp.json"), diagnostics: [], present: true };
}

const EMPTY_MCP_JSON: McpJsonResult = { servers: [], diagnostics: [], present: false };

function entry(scope: Scope, sourcePath: string, fields: Partial<McpSettingsEntry> = {}): McpSettingsEntry {
  return { scope, sourcePath, ...fields };
}

/** Resolution harness: injected env and probe so nothing leaks from the host. */
function resolve(opts: {
  mcpJson?: McpJsonResult;
  entries?: McpSettingsEntry[];
  env?: NodeJS.ProcessEnv;
  probe?: GitTrackedProbe;
}): ResolvedMcpConfig {
  return resolveMcpConfig({
    projectRoot: FAKE_ROOT,
    mcpJson: opts.mcpJson ?? EMPTY_MCP_JSON,
    mcpSettings: opts.entries ?? [],
    env: opts.env ?? ({} as NodeJS.ProcessEnv),
    isGitTracked: opts.probe ?? (() => false),
  });
}

function server(cfg: ResolvedMcpConfig, name: string): EnabledStdioMcpServer | undefined {
  return cfg.servers.find((s) => s.name === name) as EnabledStdioMcpServer | undefined;
}

const gitAvailable = (() => {
  try {
    return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
})();

// ---------------------------------------------------------------------------
// .mcp.json loading
// ---------------------------------------------------------------------------

describe("loadMcpJson — file handling", () => {
  it("returns an empty result when .mcp.json is absent", () => {
    const root = makeTmp();
    expect(loadMcpJson(root)).toEqual({ servers: [], diagnostics: [], present: false });
  });

  it("parses valid stdio entries (type absent and explicit)", () => {
    const root = makeTmp();
    writeJson(path.join(root, ".mcp.json"), {
      mcpServers: {
        github: { command: "gh-mcp", args: ["serve", "--fast"], env: { TOKEN: "${GH_TOKEN}" }, timeout: 5000 },
        files: { type: "stdio", command: "files-mcp" },
      },
    });

    const result = loadMcpJson(root);
    expect(result.present).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.servers).toHaveLength(2);
    const github = result.servers.find((s) => s.name === "github")!;
    expect(github.skipped).toBe(false);
    expect(github.command).toBe("gh-mcp");
    expect(github.args).toEqual(["serve", "--fast"]);
    expect(github.env.TOKEN).toBe("${GH_TOKEN}"); // raw here — expansion is resolution-time
    expect(github.timeoutMs).toBe(5000);
    expect(github.diagnostics).toEqual([]);
    expect(result.servers.find((s) => s.name === "files")!.skipped).toBe(false);
  });

  it("degrades malformed JSON to a diagnostic and never throws (strict JSON: JSONC rejected)", () => {
    const root = makeTmp();
    writeText(path.join(root, ".mcp.json"), "{ this is not json !!!");
    const broken = loadMcpJson(root);
    expect(broken.present).toBe(true);
    expect(broken.servers).toEqual([]);
    expect(broken.diagnostics.some((d) => d.includes("malformed JSON"))).toBe(true);

    // Strict JSON: a JSONC-style comment is malformed here (unlike settings files).
    writeText(path.join(root, ".mcp.json"), '{\n  // comment\n  "mcpServers": {}\n}');
    expect(loadMcpJson(root).diagnostics.some((d) => d.includes("malformed JSON"))).toBe(true);
  });

  it("loads a UTF-8 BOM .mcp.json instead of dropping its servers", () => {
    const root = makeTmp();
    writeText(
      path.join(root, ".mcp.json"),
      "\uFEFF" + JSON.stringify({ mcpServers: { srv: { command: "cmd" } } }),
    );
    const result = loadMcpJson(root);
    expect(result.diagnostics).toEqual([]);
    expect(result.servers.map((s) => s.name)).toEqual(["srv"]);
  });

  it("degrades non-object roots and wrong mcpServers shapes with diagnostics", () => {
    const root = makeTmp();
    writeText(path.join(root, ".mcp.json"), "[1, 2, 3]");
    expect(loadMcpJson(root).diagnostics.some((d) => d.includes("root is not an object"))).toBe(true);

    writeJson(path.join(root, ".mcp.json"), { otherKey: true });
    expect(loadMcpJson(root).diagnostics.some((d) => d.includes('no "mcpServers" key'))).toBe(true);

    writeJson(path.join(root, ".mcp.json"), { mcpServers: ["a"] });
    expect(loadMcpJson(root).diagnostics.some((d) => d.includes('"mcpServers" is not an object'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Entry validation
// ---------------------------------------------------------------------------

describe("normalizeMcpServerBlock — entry validation", () => {
  it("skips an entry missing a string command", () => {
    const servers = normalizeMcpServerBlock(
      { a: {}, b: { command: 42 }, c: { command: "   " } },
      ".mcp.json",
    );
    for (const s of servers) {
      expect(s.skipped).toBe(true);
      expect(s.diagnostics.some((d) => d.includes('missing required string "command"'))).toBe(true);
    }
  });

  it('skips a bare "url" entry (no type, no command) with the Claude-style message', () => {
    const servers = normalizeMcpServerBlock(
      { remote: { url: "https://example.com/mcp" } },
      ".mcp.json",
    );
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.diagnostics[0]).toContain('"remote"');
    expect(servers[0]?.diagnostics[0]).toContain('has a "url" but no explicit remote "type"');
    expect(servers[0]?.diagnostics[0]).toContain('use "http", "streamable-http", or "sse"');
  });

  it.each(["http", "streamable-http", "sse"] as const)(
    "accepts explicit remote transport type %s as raw, unexpanded configuration",
    (type) => {
      const servers = normalizeMcpServerBlock(
        { h: { type, url: "https://example.com/mcp" } },
        ".mcp.json",
      );
      expect(servers[0]?.skipped).toBe(false);
      expect(servers[0]?.remote).toMatchObject({
        configuredType: type,
        transportKind: type === "sse" ? "sse" : "http",
        rawUrl: "https://example.com/mcp",
      });
    },
  );

  it("skips explicit WebSocket transport with actionable guidance", () => {
    const server = normalizeMcpServerBlock(
      { h: { type: "ws", url: "https://example.com/mcp" } },
      ".mcp.json",
    )[0]!;
    expect(server.skipped).toBe(true);
    expect(server.diagnostics[0]).toContain('unsupported WebSocket transport "ws"');
  });

  it("skips unknown transport types", () => {
    const servers = normalizeMcpServerBlock({ h: { type: "carrier-pigeon", command: "x" } }, ".mcp.json");
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.diagnostics[0]).toContain('unsupported type "carrier-pigeon"');
    expect(servers[0]?.diagnostics[0]).toContain('"http", "streamable-http", and "sse" are supported');
  });

  it("keeps an untyped valid-command entry as stdio and diagnoses a stray URL", () => {
    const server = normalizeMcpServerBlock(
      { s: { command: "x", url: "https://example.com/mcp" } },
      ".mcp.json",
    )[0]!;
    expect(server.skipped).toBe(false);
    expect(server.command).toBe("x");
    expect(server.remote).toBeUndefined();
    expect(server.diagnostics).toEqual([
      'MCP server "s": field "url" is ignored on a stdio server',
    ]);
  });

  it("keeps a positive-integer timeout below 1000 ms ignored-with-fallthrough (server still runs)", () => {
    const servers = normalizeMcpServerBlock(
      { low: { command: "x", timeout: 999 }, ok: { command: "x", timeout: 1000 } },
      ".mcp.json",
    );
    const low = servers.find((s) => s.name === "low")!;
    expect(low.skipped).toBe(false);
    expect(low.timeoutMs).toBeUndefined();
    expect(low.diagnostics.some((d) => d.includes("below the 1000 ms minimum"))).toBe(true);
    expect(servers.find((s) => s.name === "ok")!.timeoutMs).toBe(1000);
  });

  it.each([
    ["a string", "5s"],
    ["zero", 0],
    ["negative", -5],
    ["non-integer", 1500.5],
  ])("skips the whole server when timeout is %s", (_label, timeout) => {
    const servers = normalizeMcpServerBlock({ s: { command: "x", timeout } }, ".mcp.json");
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.diagnostics.some((d) => d.includes('invalid "timeout"'))).toBe(true);
  });

  it.each([
    ["args is not an array", { command: "x", args: "not-a-list" }, 'invalid "args"'],
    ["args has a non-string element", { command: "x", args: ["ok", 7] }, 'invalid "args"'],
    ["env is not an object", { command: "x", env: ["A=1"] }, 'invalid "env"'],
    ["env value is an object", { command: "x", env: { BAD: {} } }, 'invalid "env"'],
    ["env value is a number", { command: "x", env: { NUM: 3 } }, 'invalid "env"'],
    ["env value is a boolean", { command: "x", env: { FLAG: true } }, 'invalid "env"'],
  ])("skips the whole server when %s (no salvage)", (_label, entryValue, needle) => {
    const servers = normalizeMcpServerBlock({ s: entryValue }, ".mcp.json");
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.diagnostics.some((d) => d.includes(needle))).toBe(true);
  });

  it("flags unknown fields with a diagnostic, keeping the server", () => {
    const servers = normalizeMcpServerBlock(
      { s: { command: "x", args: ["ok"], env: { GOOD: "v" }, cwd: "/tmp" } },
      ".mcp.json",
    );
    const s = servers[0]!;
    expect(s.skipped).toBe(false);
    expect(s.args).toEqual(["ok"]);
    expect(s.env).toEqual({ GOOD: "v" });
    expect(s.diagnostics.some((d) => d.includes('unknown field "cwd"'))).toBe(true);
  });

  it('recognizes deferred Claude fields without parsing their values or preventing startup', () => {
    const oauthCanary = "OAUTH_VALUE_CANARY";
    const servers = normalizeMcpServerBlock(
      { s: { command: "x", alwaysLoad: true, role: "reviewer", oauth: { token: oauthCanary } } },
      ".mcp.json",
    );
    const s = servers[0]!;
    expect(s.skipped).toBe(false);
    expect(s.diagnostics.some((d) => d.includes("unknown field"))).toBe(false);
    expect(s.diagnostics.filter((d) => d.includes("deferred feature"))).toHaveLength(3);
    expect(s.diagnostics).toContain(
      'MCP server "s": "oauth" is a deferred feature in PiCC; ignored (server still runs)',
    );
    expect(JSON.stringify(s)).not.toContain(oauthCanary);

    const resolved = resolve({
      entries: [entry("user", "/user-settings", {
        servers: { s: { command: "x", oauth: { token: oauthCanary } } },
      })],
    });
    expect(server(resolved, "s")).toMatchObject({ status: "enabled", transport: "stdio", command: "x" });
    expect(JSON.stringify(resolved)).not.toContain(oauthCanary);
  });

  it.each([
    ["a__b", "double underscore breaks the mcp__server__tool grammar"],
    ["has space", "whitespace"],
    ["srv(1)", "parenthesis"],
    ["*star", "glob char"],
    [".leading-dot", "must start alphanumeric"],
    ["-leading-dash", "must start alphanumeric"],
    ["__proto__", "double underscore AND prototype key"],
  ])("skips invalid server name %s (%s)", (name) => {
    const servers = normalizeMcpServerBlock(
      JSON.parse(`{ ${JSON.stringify(name)}: { "command": "x" } }`) as Record<string, unknown>,
      ".mcp.json",
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.diagnostics[0]).toContain("Invalid MCP server name");
    // Never a prototype-pollution vector.
    expect(({} as Record<string, unknown>)["command"]).toBeUndefined();
  });

  it("skips a server name over 128 chars with a bounded diagnostic (name never quoted in full)", () => {
    const longName = "a".repeat(200);
    const servers = normalizeMcpServerBlock(
      { [longName]: { command: "x" } },
      ".mcp.json",
    );
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s.skipped).toBe(true);
    // The stored name is truncated so every downstream line stays bounded.
    expect(s.name.length).toBeLessThan(64);
    expect(s.name).toContain("…");
    expect(s.diagnostics[0]).toContain("Invalid MCP server name");
    expect(s.diagnostics[0]).toContain("128-char limit");
    expect(s.diagnostics[0]).toContain("200 chars");
    expect(s.diagnostics[0]).not.toContain(longName);
    expect(s.diagnostics[0]!.length).toBeLessThan(300);
  });

  it("accepts a 128-char name at the limit (charset-valid)", () => {
    const edgeName = "b".repeat(128);
    const servers = normalizeMcpServerBlock({ [edgeName]: { command: "x" } }, ".mcp.json");
    expect(servers[0]?.skipped).toBe(false);
    expect(servers[0]?.name).toBe(edgeName);
  });

  it('accepts "constructor" and "toString" as real server names (valid charset)', () => {
    const servers = normalizeMcpServerBlock(
      { constructor: { command: "c-mcp" }, toString: { command: "t-mcp" } },
      ".mcp.json",
    );
    expect(servers.map((s) => [s.name, s.skipped, s.command])).toEqual([
      ["constructor", false, "c-mcp"],
      ["toString", false, "t-mcp"],
    ]);
  });

  it("neutralizes hostile control characters in names before they reach diagnostics", () => {
    const hostile = "evil\u001b[31mname";
    const servers = normalizeMcpServerBlock(
      JSON.parse(`{ ${JSON.stringify(hostile)}: { "command": "x" } }`) as Record<string, unknown>,
      ".mcp.json",
    );
    expect(servers[0]?.skipped).toBe(true);
    expect(servers[0]?.name).not.toContain("\u001b");
    for (const d of servers[0]!.diagnostics) expect(d).not.toContain("\u001b");
  });
});

// ---------------------------------------------------------------------------
// Enablement gate
// ---------------------------------------------------------------------------

describe("resolveMcpConfig — enablement gate", () => {
  const local = path.join(FAKE_ROOT, ".claude", "settings.local.json");
  const project = path.join(FAKE_ROOT, ".claude", "settings.json");
  const user = path.join(FAKE_ROOT, "home", ".claude", "settings.json");
  const managed = path.join(FAKE_ROOT, "managed-settings.json");

  it("leaves a .mcp.json server pending-approval by default, with no approvals anywhere", () => {
    const cfg = resolve({ mcpJson: mcpJsonOf({ srv: { command: "x" } }) });
    expect(server(cfg, "srv")?.status).toBe("pending-approval");
  });

  it("enables .mcp.json servers via enableAllProjectMcpServers from local scope", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("local", local, { enableAllProjectMcpServers: true })],
    });
    expect(server(cfg, "srv")?.status).toBe("enabled");
  });

  it("enables only the servers named in enabledMcpjsonServers (others stay pending)", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ a: { command: "x" }, b: { command: "y" } }),
      entries: [entry("user", user, { enabledMcpjsonServers: ["a"] })],
    });
    expect(server(cfg, "a")?.status).toBe("enabled");
    expect(server(cfg, "b")?.status).toBe("pending-approval");
  });

  it("ignores project-scope approvals and requires independently reviewed named approvals", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [
        entry("project", project, { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["srv"] }),
      ],
    });
    expect(server(cfg, "srv")?.status).toBe("pending-approval");
    const diag = cfg.diagnostics.find((d) => d.includes("ignored"));
    expect(diag).toContain("Independently review server definitions");
    expect(diag).toContain("only explicitly trusted server names");
    expect(diag).toContain("~/.claude/settings.json, or the configured user directory");
    expect(diag).toContain("clean untracked .claude/settings.local.json");
    expect(diag).toContain("never copy project-supplied mcpServers, approval keys, or blanket approval");
    expect(diag).not.toContain("move them");
  });

  it("honors disabledMcpjsonServers from EVERY scope, winning over all approvals", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [
        entry("project", project, { disabledMcpjsonServers: ["srv"] }),
        entry("local", local, { enableAllProjectMcpServers: true, enabledMcpjsonServers: ["srv"] }),
      ],
    });
    expect(server(cfg, "srv")?.status).toBe("disabled");
  });

  it("default-enables servers from user/managed settings and from an untracked local block", () => {
    const cfg = resolve({
      entries: [
        entry("user", user, { servers: { "u-srv": { command: "u" } } }),
        entry("local", local, { servers: { "l-srv": { command: "l" } } }),
        entry("managed", managed, { servers: { "m-srv": { command: "m" } } }),
      ],
    });
    expect(server(cfg, "u-srv")?.status).toBe("enabled");
    expect(server(cfg, "l-srv")?.status).toBe("enabled");
    expect(server(cfg, "m-srv")?.status).toBe("enabled");
    expect(server(cfg, "u-srv")?.source).toBe("settings:user");
  });

  it("matches disable-list entries through the name sanitizer (Claude parity)", () => {
    // Claude sanitizes BOTH sides ([^a-zA-Z0-9_-] → "_") before comparing, so
    // a "my_server" decline entry must catch a server named "my.server" —
    // an exact compare would miss the deny direction.
    const cfg = resolve({
      mcpJson: mcpJsonOf({ "my.server": { command: "x" } }),
      entries: [
        entry("local", local, {
          enableAllProjectMcpServers: true,
          disabledMcpjsonServers: ["my_server"],
        }),
      ],
    });
    expect(server(cfg, "my.server")?.status).toBe("disabled");
  });

  it("matches enable-list entries through the name sanitizer too", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ "my.server": { command: "x" } }),
      entries: [entry("local", local, { enabledMcpjsonServers: ["my_server"] })],
    });
    expect(server(cfg, "my.server")?.status).toBe("enabled");
  });

  it("sanitizes each UTF-16 code unit while preserving underscore and hyphen", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        "caf.": { command: "bmp" },
        "a..b": { command: "astral" },
        "keep_-x": { command: "preserved" },
        "keep..x": { command: "near" },
      }),
      entries: [entry("user", user, {
        enabledMcpjsonServers: ["café", "a💩b", "keep_-x"],
      })],
    });

    expect(server(cfg, "caf.")?.status).toBe("enabled");
    expect(server(cfg, "a..b")?.status).toBe("enabled");
    expect(server(cfg, "keep_-x")?.status).toBe("enabled");
    expect(server(cfg, "keep..x")?.status).toBe("pending-approval");
  });

  it("attaches no unset-variable warning to a disabled server (quiet decline path)", () => {
    // The declined command never runs; warning about its unset ${VAR}s would
    // break the promised quiet path of disabledMcpjsonServers.
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "${UNSET_MCP_VAR}" } }),
      entries: [entry("local", local, { disabledMcpjsonServers: ["srv"] })],
    });
    const declined = server(cfg, "srv");
    expect(declined?.status).toBe("disabled");
    expect(declined?.diagnostics).toEqual([]);
  });

  it("still applies disabledMcpjsonServers to user-authored servers", () => {
    const cfg = resolve({
      entries: [
        entry("user", user, {
          servers: { "u-srv": { command: "u" } },
          disabledMcpjsonServers: ["u-srv"],
        }),
      ],
    });
    expect(server(cfg, "u-srv")?.status).toBe("disabled");
  });

  it("keeps servers from a repo-committed .claude/settings.json pending by default", () => {
    const cfg = resolve({
      entries: [entry("project", project, { servers: { "p-srv": { command: "p" } } })],
    });
    expect(server(cfg, "p-srv")?.status).toBe("pending-approval");
    expect(server(cfg, "p-srv")?.source).toBe("settings:project");
  });

  it("enables a project-settings-origin server via local-scope enabledMcpjsonServers", () => {
    const cfg = resolve({
      entries: [
        entry("project", project, { servers: { "p-srv": { command: "p" } } }),
        entry("local", local, { enabledMcpjsonServers: ["p-srv"] }),
      ],
    });
    expect(server(cfg, "p-srv")?.status).toBe("enabled");
    expect(server(cfg, "p-srv")?.source).toBe("settings:project");
  });

  it("accumulates-and-dedupes the list keys across honored scopes", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ a: { command: "x" }, b: { command: "y" }, c: { command: "z" } }),
      entries: [
        entry("user", user, { enabledMcpjsonServers: ["a", "b"] }),
        entry("local", local, { enabledMcpjsonServers: ["b", "c"] }),
      ],
    });
    expect(server(cfg, "a")?.status).toBe("enabled");
    expect(server(cfg, "b")?.status).toBe("enabled");
    expect(server(cfg, "c")?.status).toBe("enabled");
  });

  it("resolves enableAllProjectMcpServers nearest-wins among honored scopes", () => {
    // Entries arrive in ascending precedence order; local overrides user…
    const offWins = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [
        entry("user", user, { enableAllProjectMcpServers: true }),
        entry("local", local, { enableAllProjectMcpServers: false }),
      ],
    });
    expect(server(offWins, "srv")?.status).toBe("pending-approval");

    // …and managed (highest, applied last) overrides local.
    const onWins = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [
        entry("local", local, { enableAllProjectMcpServers: false }),
        entry("managed", managed, { enableAllProjectMcpServers: true }),
      ],
    });
    expect(server(onWins, "srv")?.status).toBe("enabled");
  });

  it("never enables a skipped server, even under enableAllProjectMcpServers", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ remote: { url: "https://example.com" } }),
      entries: [entry("local", local, { enableAllProjectMcpServers: true })],
    });
    expect(server(cfg, "remote")?.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Git-tracked local demotion
// ---------------------------------------------------------------------------

describe("resolveMcpConfig — git-tracked settings.local.json demotion", () => {
  const local = path.join(FAKE_ROOT, ".claude", "settings.local.json");

  it("ignores approval keys from a TRACKED local file (demoted to project scope)", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("local", local, { enableAllProjectMcpServers: true })],
      probe: () => true,
    });
    expect(server(cfg, "srv")?.status).toBe("pending-approval");
    expect(cfg.diagnostics.some((d) => d.includes("tracked by git"))).toBe(true);
  });

  it("does not recommend untracking or reusing a tracked local file with approvals", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("local", local, { enabledMcpjsonServers: ["srv"] })],
      probe: () => true,
    });
    expect(server(cfg, "srv")?.status).toBe("pending-approval");
    const approvalDiag = cfg.diagnostics.find((d) => d.includes("MCP approvals"));
    expect(approvalDiag).toContain("cannot work while the file is tracked by git");
    expect(approvalDiag).toContain("only explicitly trusted server names");
    expect(approvalDiag).toContain("~/.claude/settings.json, or the configured user directory");
    expect(approvalDiag).toContain("from scratch only after a reviewed repository change");
    expect(approvalDiag).toContain("do not reuse project-supplied MCP content");
    expect(approvalDiag).not.toContain("git rm --cached");
  });

  it("suppresses the demotion diagnostic when the tracked local file only disables servers", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("local", local, { disabledMcpjsonServers: ["srv"] })],
      probe: () => true,
    });
    // disabledMcpjsonServers is honored from every scope — demotion changes
    // nothing for it, so the demotion story would be pure noise.
    expect(server(cfg, "srv")?.status).toBe("disabled");
    expect(cfg.diagnostics.some((d) => d.includes("tracked by git"))).toBe(false);
  });

  it("fails open (untracked) when the injected probe THROWS", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("local", local, { enableAllProjectMcpServers: true })],
      probe: () => {
        throw new Error("hostile probe");
      },
    });
    expect(server(cfg, "srv")?.status).toBe("enabled");
  });

  it("demotes a TRACKED local mcpServers block to pending instead of default-enabled", () => {
    const cfg = resolve({
      entries: [entry("local", local, { servers: { "l-srv": { command: "l" } } })],
      probe: () => true,
    });
    expect(server(cfg, "l-srv")?.status).toBe("pending-approval");
  });

  it("fails OPEN on probe failure (undefined): treated as untracked/user-authored", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [
        entry("local", local, {
          enableAllProjectMcpServers: true,
          servers: { "l-srv": { command: "l" } },
        }),
      ],
      probe: () => undefined,
    });
    expect(server(cfg, "srv")?.status).toBe("enabled");
    expect(server(cfg, "l-srv")?.status).toBe("enabled");
  });

  it.skipIf(!gitAvailable)("default probe: a git-ADDED settings.local.json is demoted for real", () => {
    const root = makeTmp();
    spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { srv: { command: "x" } } });
    writeJson(path.join(root, ".claude", "settings.local.json"), {
      enableAllProjectMcpServers: true,
      mcpServers: { "l-srv": { command: "l" } },
    });
    spawnSync("git", ["add", "-f", ".claude/settings.local.json"], { cwd: root, stdio: "ignore" });

    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "no-such-home", ".claude"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(server(project.mcp, "srv")?.status).toBe("pending-approval");
    expect(server(project.mcp, "l-srv")?.status).toBe("pending-approval");
    expect(project.mcp.diagnostics.some((d) => d.includes("tracked by git"))).toBe(true);
  });

  it.skipIf(!gitAvailable)("default probe: a tracked case-variant Settings.local.json is still demoted", () => {
    const root = makeTmp();
    // The bypass only exists where the filesystem case-folds (Windows/macOS):
    // the loader then reads "Settings.local.json" via the lowercase name while
    // a lexical git pathspec would miss it. On a case-SENSITIVE filesystem the
    // loader never sees the file at all — nothing to assert, so bail out.
    fs.writeFileSync(path.join(root, "case-probe"), "");
    if (!fs.existsSync(path.join(root, "CASE-PROBE"))) return;

    spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { srv: { command: "x" } } });
    writeJson(path.join(root, ".claude", "Settings.local.json"), {
      enableAllProjectMcpServers: true,
    });
    spawnSync("git", ["add", "-f", ".claude/Settings.local.json"], { cwd: root, stdio: "ignore" });

    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "no-such-home", ".claude"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(server(project.mcp, "srv")?.status).toBe("pending-approval");
    expect(project.mcp.diagnostics.some((d) => d.includes("tracked by git"))).toBe(true);
  });

  it.skipIf(!gitAvailable)("default probe: an UNTRACKED settings.local.json in a real repo self-approves", () => {
    const root = makeTmp();
    spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    writeJson(path.join(root, ".mcp.json"), { mcpServers: { srv: { command: "x" } } });
    writeJson(path.join(root, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["srv"],
    });

    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "no-such-home", ".claude"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(server(project.mcp, "srv")?.status).toBe("enabled");
    expect(project.mcp.diagnostics.some((d) => d.includes("tracked by git"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Precedence — whole-entry wins, no field merge
// ---------------------------------------------------------------------------

describe("resolveMcpConfig — source precedence", () => {
  const local = path.join(FAKE_ROOT, ".claude", "settings.local.json");
  const project = path.join(FAKE_ROOT, ".claude", "settings.json");
  const user = path.join(FAKE_ROOT, "home", ".claude", "settings.json");
  const managed = path.join(FAKE_ROOT, "managed-settings.json");

  function resolveWith(sources: string[]): ResolvedMcpConfig {
    // Entries in ascending-precedence file order, as loadSettings produces them.
    const entries: McpSettingsEntry[] = [];
    if (sources.includes("user")) entries.push(entry("user", user, { servers: { srv: { command: "user-cmd" } } }));
    if (sources.includes("project")) entries.push(entry("project", project, { servers: { srv: { command: "project-cmd" } } }));
    if (sources.includes("local")) entries.push(entry("local", local, { servers: { srv: { command: "local-cmd" } } }));
    if (sources.includes("managed")) entries.push(entry("managed", managed, { servers: { srv: { command: "managed-cmd" } } }));
    entries.push(entry("user", `${user}.approval`, { enabledMcpjsonServers: ["srv"] }));
    return resolve({
      mcpJson: sources.includes("mcpjson") ? mcpJsonOf({ srv: { command: "json-cmd" } }) : EMPTY_MCP_JSON,
      entries,
    });
  }

  it("orders managed > local > project-settings > .mcp.json > user, whole entry", () => {
    const all = ["user", "mcpjson", "project", "local", "managed"];
    const expected: Array<[string[], string, string]> = [
      [all, "managed-cmd", "settings:managed"],
      [["user", "mcpjson", "project", "local"], "local-cmd", "settings:local"],
      [["user", "mcpjson", "project"], "project-cmd", "settings:project"],
      [["user", "mcpjson"], "json-cmd", ".mcp.json"],
      [["user"], "user-cmd", "settings:user"],
    ];
    for (const [sources, command, source] of expected) {
      const winner = server(resolveWith(sources), "srv");
      expect(winner?.command).toBe(command);
      expect(winner?.source).toBe(source);
      expect(resolveWith(sources).servers).toHaveLength(1); // one server, no duplicates
    }
  });

  it("never merges fields across sources: the winner's entry is taken whole", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        srv: { command: "json-cmd", args: ["--json"], env: { FROM_JSON: "1" }, timeout: 2000 },
      }),
      entries: [
        // Higher precedence but sparser entry — its absence of args/env/timeout must win too.
        entry("project", project, { servers: { srv: { command: "project-cmd" } } }),
        entry("user", `${user}.approval`, { enabledMcpjsonServers: ["srv"] }),
      ],
    });
    const winner = server(cfg, "srv")!;
    expect(winner.command).toBe("project-cmd");
    expect(winner.args).toEqual([]);
    expect(winner.env).toEqual({});
    expect(winner.timeoutMs).toBeUndefined();
  });

  it("lets the nearer file win among equal-rank (nested project) sources", () => {
    const rootSettings = path.join(FAKE_ROOT, ".claude", "settings.json");
    const nestedSettings = path.join(FAKE_ROOT, "packages", "app", ".claude", "settings.json");
    const cfg = resolve({
      entries: [
        entry("project", rootSettings, { servers: { srv: { command: "root-cmd" } } }),
        entry("project", nestedSettings, { servers: { srv: { command: "nested-cmd" } } }),
        entry("user", `${user}.approval`, { enabledMcpjsonServers: ["srv"] }),
      ],
    });
    expect(server(cfg, "srv")?.command).toBe("nested-cmd");
  });

  it('handles "constructor"/"toString" server names across sources without corruption', () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ constructor: { command: "json-ctor" } }),
      entries: [
        entry("local", local, {
          servers: { constructor: { command: "local-ctor" }, toString: { command: "local-ts" } },
        }),
      ],
    });
    expect(server(cfg, "constructor")?.command).toBe("local-ctor");
    expect(server(cfg, "constructor")?.status).toBe("enabled");
    expect(server(cfg, "toString")?.command).toBe("local-ts");
    expect(cfg.servers).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Env expansion at resolution time
// ---------------------------------------------------------------------------

describe("resolveMcpConfig — ${VAR} expansion", () => {
  it("expands ${VAR} and ${VAR:-default} in command, args, and env values", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        srv: {
          command: "${MCP_BIN}",
          args: ["--mode", "${MCP_MODE:-fast}"],
          env: { TOKEN: "${MCP_TOKEN}" },
        },
      }),
      entries: [entry("user", "/approval", { enabledMcpjsonServers: ["srv"] })],
      env: { MCP_BIN: "/usr/bin/mcp", MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv,
    });
    const srv = server(cfg, "srv")!;
    expect(srv.command).toBe("/usr/bin/mcp");
    expect(srv.args).toEqual(["--mode", "fast"]);
    expect(srv.env.TOKEN).toBe("secret-token");
    // Pre-expansion command survives for display.
    expect(srv.rawCommand).toBe("${MCP_BIN}");
    expect(srv.diagnostics).toEqual([]);
  });

  it("keeps the literal for unset-without-default and warns ONCE per variable, names only", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        srv: { command: "${MCP_GONE}", args: ["${MCP_GONE}"], env: { K: "${MCP_GONE}" } },
      }),
      entries: [entry("user", "/approval", { enabledMcpjsonServers: ["srv"] })],
      env: {} as NodeJS.ProcessEnv,
    });
    const srv = server(cfg, "srv")!;
    expect(srv.command).toBe("${MCP_GONE}");
    expect(srv.args).toEqual(["${MCP_GONE}"]);
    expect(srv.env.K).toBe("${MCP_GONE}");
    const warnings = srv.diagnostics.filter((d) => d.includes("MCP_GONE"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("is not set");
  });

  it("never leaks expanded values into diagnostics", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        srv: { command: "${MCP_SECRET_BIN}", args: [], env: { K: "${MCP_ALSO_GONE}" } },
      }),
      entries: [entry("user", "/approval", { enabledMcpjsonServers: ["srv"] })],
      env: { MCP_SECRET_BIN: "hunter2-binary" } as NodeJS.ProcessEnv,
    });
    const srv = server(cfg, "srv")!;
    expect(srv.command).toBe("hunter2-binary");
    for (const d of [...srv.diagnostics, ...cfg.diagnostics]) {
      expect(d).not.toContain("hunter2-binary");
    }
  });
});

describe("resolveMcpConfig — remote arms and secret materialization", () => {
  it("expands approved HTTP URL/static headers from ambient env and retains alias identity", () => {
    const cfg = resolve({
      entries: [entry("user", "/user-settings", {
        servers: {
          remote: {
            type: "streamable-http",
            url: "https://${HOST}/mcp",
            headers: { Authorization: "Bearer ${TOKEN}", "X-Mode": "${MODE:-safe}" },
          },
        },
      })],
      env: { HOST: "example.test", TOKEN: "secret" },
    });
    expect(server(cfg, "remote")).toMatchObject({
      status: "enabled",
      transport: "http",
      configuredType: "streamable-http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer secret", "X-Mode": "safe" },
    });
  });

  it("never expands or materializes secret templates on pending, disabled, or not-configured arms", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        pending: { type: "http", url: "https://${PENDING_SECRET}/mcp", headers: { Authorization: "${TOKEN}" } },
        disabled: { type: "sse", url: "https://${DISABLED_SECRET}/sse", headers: { Authorization: "${TOKEN}" } },
        empty: { type: "http", url: "" },
      }),
      entries: [entry("user", "/approval", { disabledMcpjsonServers: ["disabled"] })],
      env: {},
    });
    expect(cfg.servers.map((item) => [item.name, item.status, item.transport])).toEqual([
      ["pending", "pending-approval", "http"],
      ["disabled", "disabled", "sse"],
      ["empty", "not-configured", "http"],
    ]);
    for (const item of cfg.servers) {
      expect(item).not.toHaveProperty("url");
      expect(item).not.toHaveProperty("headers");
      expect(JSON.stringify(item)).not.toMatch(/PENDING_SECRET|DISABLED_SECRET|TOKEN/u);
    }
  });

  it("skips enabled remote entries whose expanded endpoint is invalid without leaking values", () => {
    const cfg = resolve({
      entries: [entry("user", "/user-settings", {
        servers: { remote: { type: "http", url: "${BAD_URL}", headers: {} } },
      })],
      env: { BAD_URL: "SECRET_INVALID_ENDPOINT" },
    });
    const resolved = cfg.servers[0]!;
    expect(resolved.status).toBe("skipped");
    expect(resolved).not.toHaveProperty("url");
    expect(resolved.diagnostics.join("\n")).toContain("malformed expanded URL");
    expect(resolved.diagnostics.join("\n")).not.toContain("SECRET_INVALID_ENDPOINT");
  });

  it("keeps a project remote approved by name after its URL and headers change", () => {
    const approval = entry("user", "/approval", { enabledMcpjsonServers: ["remote"] });
    const first = resolve({
      mcpJson: mcpJsonOf({ remote: { type: "http", url: "https://first.example/mcp", headers: { Authorization: "one" } } }),
      entries: [approval],
    });
    const changed = resolve({
      mcpJson: mcpJsonOf({ remote: { type: "http", url: "https://changed.example/mcp", headers: { Authorization: "two" } } }),
      entries: [approval],
    });
    expect(server(first, "remote")).toMatchObject({ status: "enabled", url: "https://first.example/mcp" });
    expect(server(changed, "remote")).toMatchObject({ status: "enabled", url: "https://changed.example/mcp" });
  });

  it("never expands a losing lower-precedence remote definition", () => {
    const cfg = resolve({
      entries: [
        entry("user", "/user-settings", {
          servers: { remote: { type: "http", url: "https://${LOSING_SECRET}/mcp", headers: { Authorization: "${TOKEN}" } } },
        }),
        entry("managed", "/managed-settings", {
          servers: { remote: { type: "http", url: "https://winner.example/mcp" } },
        }),
      ],
      env: {},
    });
    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0]).toMatchObject({ status: "enabled", url: "https://winner.example/mcp" });
    expect(JSON.stringify(cfg)).not.toMatch(/LOSING_SECRET|TOKEN/u);
  });

  it("keeps inactive union arms free of every enabled-arm field", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({
        pendingRemote: { type: "http", url: "https://example.test/mcp" },
        pendingStdio: { command: "stdio-command" },
      }),
    });
    for (const resolved of cfg.servers) {
      expect(resolved.status).not.toBe("enabled");
      for (const key of ["command", "args", "env", "rawCommand", "url", "headers", "sseDeprecation"]) {
        expect(resolved).not.toHaveProperty(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Assembly (loadClaudeProject)
// ---------------------------------------------------------------------------

describe("loadClaudeProject — mcp assembly", () => {
  function loadFrom(root: string) {
    return loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "no-such-home", ".claude"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
  }

  it("yields servers: [] (and no diagnostics) when no MCP config exists anywhere", () => {
    const root = makeTmp();
    const project = loadFrom(root);
    expect(project.mcp).toEqual({ servers: [], diagnostics: [] });
  });

  it("uses ambient env rather than settings.env for remote interpolation end to end", () => {
    const root = makeTmp();
    const variable = "PICC_MCP_AMBIENT_SETTINGS_MATRIX";
    const previous = process.env[variable];
    process.env[variable] = "ambient.example";
    writeJson(path.join(root, ".mcp.json"), {
      mcpServers: { remote: { type: "http", url: `https://\${${variable}}/mcp` } },
    });
    writeJson(path.join(root, ".claude", "settings.json"), {
      env: { [variable]: "settings.example" },
    });
    writeJson(path.join(root, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["remote"],
    });
    try {
      const project = loadClaudeProject({
        cwd: root,
        userDir: path.join(root, "no-such-home", ".claude"),
        managedSettingsPaths: [],
        managedArtifactDirs: [],
      });
      expect(server(project.mcp, "remote")).toMatchObject({
        status: "enabled",
        transport: "http",
        url: "https://ambient.example/mcp",
      });
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });

  it("resolves .mcp.json + settings.local.json approval end to end", () => {
    const root = makeTmp();
    writeJson(path.join(root, ".mcp.json"), {
      mcpServers: { github: { command: "gh-mcp", args: ["serve"] } },
    });
    writeJson(path.join(root, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["github"],
    });

    // Temp dir: either not a repo (probe fails open) or the file is untracked —
    // both count as user-authored, so the approval holds.
    const project = loadFrom(root);
    const github = server(project.mcp, "github");
    expect(github?.status).toBe("enabled");
    expect(github?.source).toBe(".mcp.json");
    expect(github?.args).toEqual(["serve"]);
  });

  it("surfaces a malformed .mcp.json as a config-level diagnostic, never a crash", () => {
    const root = makeTmp();
    writeText(path.join(root, ".mcp.json"), "not json at all");
    const project = loadFrom(root);
    expect(project.mcp.servers).toEqual([]);
    expect(project.mcp.diagnostics.some((d) => d.includes("malformed JSON"))).toBe(true);
  });
});
