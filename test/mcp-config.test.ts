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
import { MCP_POLICY_LIMITS } from "../src/engine/mcp-policy.js";
import type { RemoteMcpWorkHooks } from "../src/claude/mcp-remote-config.js";
import { loadClaudeProject } from "../src/project.js";
import type { ClaudeMcpStateResult } from "../src/claude/claude-mcp-state.js";
import type { ManagedMcpIo, ManagedMcpResult } from "../src/claude/managed-mcp.js";
import type {
  EnabledStdioMcpServer,
  McpPolicySettingsEntry,
  McpPolicySourceFailure,
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

function nativeState(options: {
  user?: Record<string, unknown>;
  local?: Record<string, unknown>;
  disabled?: string[];
  enabled?: string[];
  diagnostics?: string[];
} = {}): ClaudeMcpStateResult {
  return {
    kind: "loaded",
    user: { source: "native-user", servers: normalizeMcpServerBlock(options.user ?? {}, "native user") },
    local: { source: "native-local", servers: normalizeMcpServerBlock(options.local ?? {}, "native local") },
    disabledMcpServers: new Set(options.disabled ?? []),
    ...(options.enabled === undefined ? {} : { enabledMcpServers: options.enabled }),
    diagnostics: options.diagnostics ?? [],
  };
}

/** Resolution harness: injected env and probe so nothing leaks from the host. */
function resolve(opts: {
  mcpJson?: McpJsonResult;
  entries?: McpSettingsEntry[];
  env?: NodeJS.ProcessEnv;
  probe?: GitTrackedProbe;
  nativeState?: ClaudeMcpStateResult;
  policy?: McpPolicySettingsEntry[];
  policyFailures?: McpPolicySourceFailure[];
  restrictiveMaterialOmitted?: boolean;
  managedMcp?: ManagedMcpResult;
  remoteWorkHooks?: RemoteMcpWorkHooks;
}): ResolvedMcpConfig {
  return resolveMcpConfig({
    projectRoot: FAKE_ROOT,
    mcpJson: opts.mcpJson ?? EMPTY_MCP_JSON,
    mcpSettings: opts.entries ?? [],
    ...(opts.nativeState === undefined ? {} : { nativeState: opts.nativeState }),
    mcpPolicySettings: opts.policy ?? [],
    mcpPolicySourceFailures: opts.policyFailures ?? [],
    mcpPolicyRestrictiveMaterialOmitted: opts.restrictiveMaterialOmitted ?? false,
    ...(opts.managedMcp === undefined ? {} : { managedMcp: opts.managedMcp }),
    env: opts.env ?? ({} as NodeJS.ProcessEnv),
    isGitTracked: opts.probe ?? (() => false),
    ...(opts.remoteWorkHooks === undefined ? {} : { remoteWorkHooksForTest: opts.remoteWorkHooks }),
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
    expect(server(cfg, "u-srv")?.source).toBe("settings-user");
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
    expect(server(cfg, "p-srv")?.source).toBe("settings-project");
  });

  it("enables a project-settings-origin server via local-scope enabledMcpjsonServers", () => {
    const cfg = resolve({
      entries: [
        entry("project", project, { servers: { "p-srv": { command: "p" } } }),
        entry("local", local, { enabledMcpjsonServers: ["p-srv"] }),
      ],
    });
    expect(server(cfg, "p-srv")?.status).toBe("enabled");
    expect(server(cfg, "p-srv")?.source).toBe("settings-project");
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
    expect(server(cfg, "l-srv")).toMatchObject({
      status: "pending-approval",
      source: "settings-local",
    });
    const demotion = cfg.diagnostics.find((diagnostic) => diagnostic.includes("treated as project scope"));
    expect(demotion).toContain("approvals ignored; any contributed servers are pending");
    expect(demotion).not.toContain("approvals ignored, servers pending");
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

  it.skipIf(!gitAvailable)("default probe: a tracked nested child beginning with dots is contained and demoted", () => {
    const root = makeTmp();
    const nested = path.join(root, "..app");
    const localFile = path.join(nested, ".claude", "settings.local.json");
    spawnSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
    writeJson(localFile, {
      enableAllProjectMcpServers: true,
      mcpServers: { nested: { command: "nested" } },
    });
    const relativeLocal = path.relative(root, localFile).split(path.sep).join("/");
    spawnSync("git", ["add", "-f", "--", relativeLocal], { cwd: root, stdio: "ignore" });

    const project = loadClaudeProject({
      cwd: nested,
      userDir: path.join(root, "no-such-home", ".claude"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(server(project.mcp, "nested")).toMatchObject({
      status: "pending-approval",
      source: "settings-local",
    });
    expect(project.mcp.servers.some((candidate) => candidate.status === "enabled")).toBe(false);
    expect(project.mcp.diagnostics.some((diagnostic) =>
      diagnostic.includes("tracked by git") && diagnostic.includes("treated as project scope"))).toBe(true);
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

  it("orders .mcp.json above every settings-extension scope, whole entry", () => {
    const all = ["user", "mcpjson", "project", "local", "managed"];
    const expected: Array<[string[], string, string]> = [
      [all, "json-cmd", "project-mcpjson"],
      [["user", "project", "local", "managed"], "managed-cmd", "settings-managed"],
      [["user", "project", "local"], "local-cmd", "settings-local"],
      [["user", "project"], "project-cmd", "settings-project"],
      [["user"], "user-cmd", "settings-user"],
    ];
    for (const [sources, command, source] of expected) {
      const winner = server(resolveWith(sources), "srv");
      expect(winner?.command).toBe(command);
      expect(winner?.source).toBe(source);
      expect(resolveWith(sources).servers).toHaveLength(1); // one server, no duplicates
    }
  });

  it("never merges fields across sources: a sparse .mcp.json winner replaces settings whole", () => {
    const cfg = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "json-cmd" } }),
      entries: [
        entry("managed", managed, {
          servers: { srv: { command: "managed-cmd", args: ["--managed"], env: { FROM_MANAGED: "1" }, timeout: 2000 } },
        }),
        entry("user", `${user}.approval`, { enabledMcpjsonServers: ["srv"] }),
      ],
    });
    const winner = server(cfg, "srv")!;
    expect(winner.command).toBe("json-cmd");
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
    expect(server(cfg, "constructor")?.status).toBe("pending-approval");
    expect(server(cfg, "constructor")?.source).toBe("project-mcpjson");
    expect(server(cfg, "toString")?.command).toBe("local-ts");
    expect(cfg.servers).toHaveLength(2);
  });
});

describe("resolveMcpConfig — native Claude hierarchy and gates", () => {
  const extensionEntries = [
    entry("user", "/user", { servers: { srv: { command: "settings-user" } } }),
    entry("project", "/project", { servers: { srv: { command: "settings-project" } } }),
    entry("local", "/local", { servers: { srv: { command: "settings-local" } } }),
    entry("managed", "/managed", { servers: { srv: { command: "settings-managed" } } }),
    entry("user", "/approval", { enabledMcpjsonServers: ["srv"] }),
  ];

  it.each([
    ["native local over .mcp.json", nativeState({ local: { srv: { command: "native-local" } } }), mcpJsonOf({ srv: { command: "json" } }), extensionEntries, "native-local", "native-local"],
    [".mcp.json over native user", nativeState({ user: { srv: { command: "native-user" } } }), mcpJsonOf({ srv: { command: "json" } }), extensionEntries, "json", "project-mcpjson"],
    ["native user over managed extension", nativeState({ user: { srv: { command: "native-user" } } }), EMPTY_MCP_JSON, extensionEntries, "native-user", "native-user"],
    ["managed over local extension", { kind: "absent", diagnostics: [] } as ClaudeMcpStateResult, EMPTY_MCP_JSON, extensionEntries, "settings-managed", "settings-managed"],
    ["local over project extension", { kind: "absent", diagnostics: [] } as ClaudeMcpStateResult, EMPTY_MCP_JSON, extensionEntries.slice(0, 3), "settings-local", "settings-local"],
    ["project over user extension", { kind: "absent", diagnostics: [] } as ClaudeMcpStateResult, EMPTY_MCP_JSON, extensionEntries.slice(0, 2).concat(extensionEntries.slice(4)), "settings-project", "settings-project"],
  ] as const)("selects %s", (_label, native, mcpJson, entries, command, source) => {
    expect(server(resolve({ nativeState: native, mcpJson, entries: [...entries] }), "srv"))
      .toMatchObject({ status: "enabled", command, source });
  });

  it("keeps sparse and invalid authentic winners whole while unrelated names survive", () => {
    const sparse = resolve({
      nativeState: nativeState({ local: { srv: { command: "local" }, other: { command: "other" } } }),
      mcpJson: mcpJsonOf({ srv: { command: "json", args: ["loser"], env: { SECRET: "loser" } } }),
      entries: extensionEntries,
    });
    expect(server(sparse, "srv")).toMatchObject({ command: "local", args: [], env: {} });
    expect(server(sparse, "other")).toMatchObject({ command: "other", status: "enabled" });

    const invalid = resolve({
      nativeState: nativeState({ local: { srv: {} } }),
      mcpJson: mcpJsonOf({ srv: { command: "must-not-run" } }),
      entries: extensionEntries,
    });
    expect(server(invalid, "srv")?.status).toBe("skipped");
    expect(JSON.stringify(server(invalid, "srv"))).not.toContain("must-not-run");
  });

  it("replaces the whole transport entry in both directions without inheriting secrets", () => {
    const stdioWinner = resolve({
      nativeState: nativeState({ local: { srv: { command: "native-command" } } }),
      mcpJson: mcpJsonOf({
        srv: { type: "http", url: "https://lower.example/${LOWER_URL}", headers: { Authorization: "${LOWER_HEADER}" } },
      }),
    });
    expect(server(stdioWinner, "srv")).toMatchObject({
      status: "enabled", source: "native-local", transport: "stdio", command: "native-command", args: [], env: {},
    });
    expect(JSON.stringify(server(stdioWinner, "srv"))).not.toMatch(/LOWER_|lower\.example|headers|url/u);

    const remoteWinner = resolve({
      nativeState: nativeState({
        local: { srv: { type: "http", url: "https://native.example/mcp", headers: { "X-Winner": "safe" } } },
        user: { srv: { command: "lower-command", args: ["LOWER_ARG"], env: { SECRET: "LOWER_SECRET" } } },
      }),
    });
    expect(server(remoteWinner, "srv")).toMatchObject({
      status: "enabled", source: "native-local", transport: "http", url: "https://native.example/mcp", headers: { "X-Winner": "safe" },
    });
    expect(JSON.stringify(server(remoteWinner, "srv"))).not.toMatch(/lower-command|LOWER_ARG|LOWER_SECRET|rawCommand/u);

    const invalidWinner = resolve({
      nativeState: nativeState({ local: { srv: { type: "http" } } }),
      mcpJson: mcpJsonOf({ srv: { command: "lower-command", env: { SECRET: "LOWER_SECRET" } } }),
    });
    expect(server(invalidWinner, "srv")?.status).toBe("skipped");
    expect(JSON.stringify(server(invalidWinner, "srv"))).not.toMatch(/lower-command|LOWER_SECRET|https?:|Authorization/u);
  });

  it("lets the nearer equal-rank project extension win", () => {
    const cfg = resolve({ entries: [
      entry("project", "/root", { servers: { srv: { command: "root" } } }),
      entry("project", "/near", { servers: { srv: { command: "near" } } }),
      entry("user", "/approval", { enabledMcpjsonServers: ["srv"] }),
    ] });
    expect(server(cfg, "srv")?.command).toBe("near");
  });

  it("composes native runtime disablement after policy admission without weakening deny", () => {
    const native = nativeState({ local: { exact: { command: "native", args: ["secret-arg"], env: { SECRET: "value" } } }, disabled: ["exact"] });
    const allowed = resolve({
      nativeState: native,
      policy: [{ scope: "managed", sourcePath: "/policy", order: 0, valid: true, allowedMcpServers: [{ serverName: "exact" }] }],
    });
    expect(server(allowed, "exact")).toEqual({
      name: "exact", source: "native-local", transport: "stdio", status: "disabled",
      inactiveReason: "native-runtime-disabled", diagnostics: [],
    });

    const denied = resolve({
      nativeState: native,
      policy: [
        { scope: "managed", sourcePath: "/policy", order: 0, valid: true, allowedMcpServers: [{ serverName: "exact" }] },
        { scope: "managed", sourcePath: "/policy", order: 1, valid: true, deniedMcpServers: [{ serverName: "exact" }] },
      ],
    });
    expect(server(denied, "exact")).toEqual({
      name: "exact", source: "native-local", transport: "stdio", status: "blocked",
      inactiveReason: "policy-denied", diagnostics: [],
    });
  });

  it("applies exact native runtime disablement to every authentic winner but not the settings extension", () => {
    for (const [label, native, mcpJson] of [
      ["local", nativeState({ local: { exact: { command: "local" } }, disabled: ["exact"] }), EMPTY_MCP_JSON],
      ["project", nativeState({ disabled: ["exact"] }), mcpJsonOf({ exact: { command: "json" } })],
      ["user", nativeState({ user: { exact: { command: "user" } }, disabled: ["exact"] }), EMPTY_MCP_JSON],
    ] as const) {
      const cfg = resolve({ nativeState: native, mcpJson, entries: [entry("user", "/approval", { enabledMcpjsonServers: ["exact"] })] });
      expect(server(cfg, "exact"), label).toMatchObject({ status: "disabled", inactiveReason: "native-runtime-disabled" });
    }
    const extension = resolve({
      nativeState: nativeState({ disabled: ["exact", "my_server"] }),
      entries: [entry("user", "/user", { servers: {
        exact: { command: "extension" },
        "my.server": { command: "not-exact" },
      } })],
    });
    expect(server(extension, "exact")?.status).toBe("enabled");
    expect(server(extension, "my.server")?.status).toBe("enabled");

    const nearName = resolve({
      nativeState: nativeState({
        local: { "my.server": { command: "local" } },
        disabled: ["my_server"],
      }),
      entries: [entry("user", "/settings", {
        enabledMcpjsonServers: ["other"],
        disabledMcpjsonServers: ["my_server"],
      })],
    });
    expect(server(nearName, "my.server")).toMatchObject({ status: "enabled", source: "native-local" });

    const extensionScopes = resolve({
      nativeState: nativeState({ disabled: ["managed", "local", "project", "user"] }),
      entries: [
        entry("user", "/user", { servers: { user: { command: "user" } } }),
        entry("project", "/project", { servers: { project: { command: "project" } } }),
        entry("local", "/local", { servers: { local: { command: "local" } } }),
        entry("managed", "/managed", { servers: { managed: { command: "managed" } } }),
        entry("user", "/approval", { enabledMcpjsonServers: ["project"] }),
      ],
    });
    expect(extensionScopes.servers.map((item) => [item.name, item.status])).toEqual([
      ["user", "enabled"], ["project", "enabled"], ["local", "enabled"], ["managed", "enabled"],
    ]);
  });

  it("makes native disabledMcpServers final for an unapproved authentic project winner", () => {
    const cfg = resolve({
      nativeState: nativeState({ disabled: ["blocked"] }),
      mcpJson: mcpJsonOf({ blocked: { command: "must-not-run" } }),
    });
    expect(server(cfg, "blocked")).toMatchObject({
      status: "disabled",
      source: "project-mcpjson",
      inactiveReason: "native-runtime-disabled",
    });
  });

  it("keeps native runtime lists distinct from settings approvals and reports unsupported enablement once", () => {
    const cfg = resolve({
      nativeState: nativeState({
        user: { user: { command: "user" } },
        enabled: ["pending"],
        diagnostics: ["Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled"],
      }),
      mcpJson: mcpJsonOf({ pending: { command: "pending" } }),
      entries: [entry("user", "/settings", { disabledMcpjsonServers: ["user"] })],
    });
    expect(server(cfg, "pending")?.status).toBe("pending-approval");
    expect(server(cfg, "user")?.status).toBe("enabled");
    expect(cfg.diagnostics.filter((item) => item.includes("enabledMcpServers is unsupported"))).toHaveLength(1);
  });

  it("fails closed on unusable native state while absence preserves existing activation", () => {
    const lower = [entry("user", "/user", { servers: { lower: { command: "lower" } } })];
    expect(resolve({ nativeState: { kind: "absent", diagnostics: [] }, entries: lower }).servers)
      .toHaveLength(1);
    const closed = resolve({
      nativeState: { kind: "unusable", diagnostics: ["Native Claude state is malformed JSON"] },
      mcpJson: mcpJsonOf({ project: { command: "project" } }),
      entries: lower,
    });
    expect(closed).toEqual({
      servers: [],
      diagnostics: ["Native Claude state is malformed JSON"],
      failClosed: "native-state-unusable",
      policyPosture: "fail-closed",
      policyAuthority: "user-controlled",
      policyObservations: [],
      policyFailures: [],
    });
  });

  it("never expands losing, pending, disabled, skipped, or fail-closed definitions", () => {
    const reads: PropertyKey[] = [];
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get(target, property, receiver) {
        reads.push(property);
        return Reflect.get(target, property, receiver);
      },
    });
    const cfg = resolve({
      nativeState: nativeState({
        local: {
          losing: { command: "winner" },
          disabled: { command: "${DISABLED_CANARY}" },
          skipped: {},
        },
        disabled: ["disabled"],
      }),
      mcpJson: mcpJsonOf({
        losing: { command: "${LOSER_CANARY}" },
        pending: { command: "${PENDING_CANARY}" },
      }),
      env,
    });
    expect(server(cfg, "losing")?.command).toBe("winner");
    expect(reads).toEqual([]);

    const failClosedReads: PropertyKey[] = [];
    resolve({
      nativeState: { kind: "unusable", diagnostics: ["bad state"] },
      entries: [entry("user", "/user", { servers: { lower: { command: "${FAIL_CLOSED_CANARY}" } } })],
      env: new Proxy({} as NodeJS.ProcessEnv, { get(_target, property) { failClosedReads.push(property); return undefined; } }),
    });
    expect(failClosedReads).toEqual([]);
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
        pending: { type: "http", url: "https://pending.example/mcp", headers: { Authorization: "${PENDING_SECRET}" } },
        disabled: { type: "sse", url: "https://disabled.example/sse", headers: { Authorization: "${DISABLED_SECRET}" } },
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
      expect(JSON.stringify(item)).not.toMatch(/PENDING_SECRET|DISABLED_SECRET/u);
    }
  });

  it("blocks an invalid expanded remote identity before materialization without leaking values", () => {
    const cfg = resolve({
      entries: [entry("user", "/user-settings", {
        servers: { remote: { type: "http", url: "${BAD_URL}", headers: {} } },
      })],
      env: { BAD_URL: "SECRET_INVALID_ENDPOINT" },
    });
    const resolved = cfg.servers[0]!;
    expect(resolved).toMatchObject({
      status: "blocked",
      inactiveReason: "policy-candidate-invalid",
    });
    expect(resolved).not.toHaveProperty("url");
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
// Managed policy admission
// ---------------------------------------------------------------------------

describe("resolveMcpConfig — managed policy admission", () => {
  const policyEntry = (
    scope: Scope,
    order: number,
    fields: Partial<McpPolicySettingsEntry>,
  ): McpPolicySettingsEntry => ({ scope, order, sourcePath: `/${scope}-${order}`, valid: true, ...fields });

  it("routes every ordinary source class through deny-first admission", () => {
    const names = ["native-local", "project-mcpjson", "native-user", "settings-managed", "settings-local", "settings-project", "settings-user"];
    const cfg = resolve({
      nativeState: nativeState({
        local: { "native-local": { command: "nl" } },
        user: { "native-user": { command: "nu" } },
      }),
      mcpJson: mcpJsonOf({ "project-mcpjson": { command: "pj" } }),
      entries: [
        entry("user", "/u", { servers: { "settings-user": { command: "u" } }, enabledMcpjsonServers: names }),
        entry("project", "/p", { servers: { "settings-project": { command: "p" } } }),
        entry("local", "/l", { servers: { "settings-local": { command: "l" } } }),
        entry("managed", "/m", { servers: { "settings-managed": { command: "m" } } }),
      ],
      policy: [policyEntry("managed", 0, {
        allowedMcpServers: names.map((serverName) => ({ serverName })),
        deniedMcpServers: names.map((serverName) => ({ serverName })),
      })],
    });
    expect(cfg.policyPosture).toBe("active-rules");
    expect(cfg.servers).toHaveLength(names.length);
    expect(cfg.servers.map((item) => item.source).sort()).toEqual([...names].sort());
    expect(cfg.servers.every((item) => item.status === "blocked" && item.inactiveReason === "policy-denied")).toBe(true);
  });

  it("applies the same admission stage to populated managed-exclusive entries", () => {
    const managedEntry = Object.freeze({
      ...normalizeMcpServerBlock({ managed: { command: "managed-command" } }, "managed")[0]!,
      source: "managed-mcp" as const,
    });
    const cfg = resolve({
      managedMcp: { status: "loaded", servers: [managedEntry] },
      policy: [policyEntry("managed", 0, { deniedMcpServers: [{ serverCommand: ["managed-command"] }] })],
    });
    expect(cfg.policyPosture).toBe("exclusive");
    expect(server(cfg, "managed")).toMatchObject({
      status: "blocked",
      source: "managed-mcp",
      inactiveReason: "policy-denied",
    });
  });

  it.each([
    {
      label: "over-limit stdio",
      block: { oversized: { command: "x".repeat(MCP_POLICY_LIMITS.candidateCommandChars + 1) } },
      observation: "candidate-over-limit-blocked",
      transport: "stdio",
    },
    {
      label: "ambiguous remote",
      block: { ambiguous: { type: "http", url: "https://example.test\\ambiguous", headers: { Authorization: "secret-canary" } } },
      observation: "identity-ambiguity-blocked",
      transport: "http",
    },
  ] as const)("blocks $label under absent policy through the central evaluator", ({ block, observation, transport }) => {
    const cfg = resolve({ entries: [entry("user", "/u", { servers: block })] });
    expect(cfg.policyPosture).toBe("absent");
    expect(cfg.servers[0]).toMatchObject({
      status: "blocked",
      transport,
      inactiveReason: "policy-candidate-invalid",
    });
    expect(cfg.policyObservations).toContain(observation);
    expect(JSON.stringify(cfg.servers[0])).not.toContain("secret-canary");
    for (const key of ["command", "args", "env", "rawCommand", "url", "headers"]) {
      expect(cfg.servers[0]).not.toHaveProperty(key);
    }
  });

  it.each(["http", "sse"] as const)("performs no remote header/helper/materializer work for policy-blocked %s", (type) => {
    const counts = { header: 0, headers: 0, helper: 0, materializer: 0 };
    const hooks: RemoteMcpWorkHooks = {
      onHeaderValidation: () => { counts.header += 1; },
      onHeadersConstruction: () => { counts.headers += 1; },
      onHelperInspection: () => { counts.helper += 1; },
      onMaterialization: () => { counts.materializer += 1; },
    };
    const blocked = resolve({
      entries: [entry("user", "/u", { servers: {
        remote: { type, url: "https://blocked.example/mcp", headersHelper: "helper-canary", headers: { Authorization: "header-canary" } },
      } })],
      policy: [policyEntry("managed", 0, { deniedMcpServers: [{ serverName: "remote" }] })],
      remoteWorkHooks: hooks,
    });
    expect(server(blocked, "remote")).toMatchObject({ status: "blocked", inactiveReason: "policy-denied" });
    expect(counts).toEqual({ header: 0, headers: 0, helper: 0, materializer: 0 });
    expect(JSON.stringify(blocked)).not.toMatch(/helper-canary|header-canary/u);

    const allowed = resolve({
      entries: [entry("user", "/u", { servers: {
        remote: { type, url: "https://allowed.example/mcp", headers: { "X-Test": "ok" } },
      } })],
      remoteWorkHooks: hooks,
    });
    expect(server(allowed, "remote")?.status).toBe("enabled");
    expect(counts.materializer).toBe(1);
    expect(counts.helper).toBe(1);
    expect(counts.header).toBe(2);
    expect(counts.headers).toBe(2);
  });

  it("composes soft allowlists, managed-only, approval, and identity-only blocked output", () => {
    const base = {
      mcpJson: mcpJsonOf({ project: { command: "${BIN}", args: ["${ARG}"], env: { SECRET: "${SECRET}" }, timeout: 3000 } }),
      entries: [entry("user", "/approval", { enabledMcpjsonServers: ["project"] })],
      env: { BIN: "expanded", ARG: "arg-secret", SECRET: "value-secret" },
    };
    const soft = resolve({ ...base, policy: [
      policyEntry("managed", 0, { allowedMcpServers: [{ serverName: "other" }] }),
      policyEntry("user", 1, { allowedMcpServers: [{ serverName: "project" }] }),
    ] });
    expect(server(soft, "project")).toMatchObject({ status: "enabled", command: "expanded" });

    const managedOnly = resolve({ ...base, policy: [
      policyEntry("managed", 0, {
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverName: "other" }],
      }),
      policyEntry("user", 1, { allowedMcpServers: [{ serverName: "project" }] }),
    ] });
    const blocked = server(managedOnly, "project")!;
    expect(blocked).toMatchObject({ status: "blocked", inactiveReason: "policy-managed-only" });
    for (const key of ["timeoutMs", "command", "args", "env", "rawCommand", "url", "headers"]) {
      expect(blocked).not.toHaveProperty(key);
    }
    expect(JSON.stringify(blocked)).not.toMatch(/expanded|arg-secret|value-secret|\$\{BIN\}/u);
  });

  it.each([
    ["non-regular", "unreadable"],
    ["unreadable", "unreadable"],
    ["oversized", "omitted"],
    ["invalid-encoding", "malformed"],
    ["malformed", "malformed"],
    ["wrong-root", "malformed"],
    ["unstable", "unreadable"],
  ] as const)("maps unusable standalone reason %s to administrator fail-closed %s evidence", (reason, kind) => {
    const cfg = resolve({ managedMcp: { status: "unusable", reason } });
    expect(cfg.policyPosture).toBe("fail-closed");
    expect(cfg.policyOrdinarySourcesSuppressed).toBe(true);
    expect(cfg.servers).toEqual([]);
    expect(cfg.policyFailures).toContainEqual({
      kind,
      sourceClass: "standalone-mcp",
      authority: "administrator-controlled",
      remediation: "repair-administrator-policy",
    });
  });

  it("globally fails closed on typed source failure or restrictive-material omission, including exclusive state", () => {
    const failure: McpPolicySourceFailure = {
      kind: "unreadable",
      sourceClass: "system-file",
      authority: "administrator-controlled",
      remediation: "repair-administrator-policy",
    };
    for (const cfg of [
      resolve({ entries: [entry("user", "/u", { servers: { srv: { command: "x" } } })], policyFailures: [failure] }),
      resolve({ restrictiveMaterialOmitted: true, managedMcp: { status: "loaded", servers: [] } }),
      resolve({ policyFailures: [failure], managedMcp: { status: "loaded", servers: [] } }),
    ]) {
      expect(cfg.servers).toEqual([]);
      expect(cfg.policyPosture).toBe("fail-closed");
    }
  });

  it("keeps policy final while preserving allowed disablement and approval gates", () => {
    const allowedDisabled = resolve({
      mcpJson: mcpJsonOf({ srv: { command: "x" } }),
      entries: [entry("user", "/u", { enabledMcpjsonServers: ["srv"], disabledMcpjsonServers: ["srv"] })],
      policy: [policyEntry("managed", 0, { allowedMcpServers: [{ serverName: "srv" }] })],
    });
    expect(server(allowedDisabled, "srv")).toMatchObject({ status: "disabled", inactiveReason: "mcpjson-rejected" });

    for (const fields of [
      { enabledMcpjsonServers: ["srv"] },
      { disabledMcpjsonServers: ["srv"] },
    ]) {
      const denied = resolve({
        mcpJson: mcpJsonOf({ srv: { command: "x" } }),
        entries: [entry("user", "/u", fields)],
        policy: [policyEntry("managed", 0, { deniedMcpServers: [{ serverName: "srv" }] })],
      });
      expect(server(denied, "srv")).toMatchObject({ status: "blocked", inactiveReason: "policy-denied" });
    }
  });

  it("lets policy failures dominate unusable native state and populated exclusive input", () => {
    const failure: McpPolicySourceFailure = {
      kind: "unreadable", sourceClass: "system-file", authority: "administrator-controlled",
      remediation: "repair-administrator-policy",
    };
    const unusableNative = resolve({
      nativeState: { kind: "unusable", diagnostics: ["native-canary"] },
      policyFailures: [failure],
    });
    expect(unusableNative).toMatchObject({ policyPosture: "fail-closed", servers: [] });
    expect(unusableNative.failClosed).toBeUndefined();
    expect(unusableNative.diagnostics).not.toContain("native-canary");

    const managedEntry = Object.freeze({
      ...normalizeMcpServerBlock({ managed: { command: "managed" } }, "managed")[0]!,
      source: "managed-mcp" as const,
    });
    const exclusive = resolve({ managedMcp: { status: "loaded", servers: [managedEntry] }, policyFailures: [failure] });
    expect(exclusive).toMatchObject({ policyPosture: "fail-closed", servers: [] });
  });

  it("does not classify local definitions or approvals once policy blocks every candidate", () => {
    let probes = 0;
    const cfg = resolve({
      mcpJson: mcpJsonOf({ project: { command: "deny-project" } }),
      entries: [entry("local", "/local", {
        servers: { blocked: { command: "deny-local" } },
        enabledMcpjsonServers: ["project"],
      })],
      policy: [policyEntry("managed", 0, { deniedMcpServers: [
        { serverCommand: ["deny-local"] },
        { serverCommand: ["deny-project"] },
      ] })],
      probe: () => { probes += 1; return true; },
    });
    expect(cfg.servers.every((item) => item.status === "blocked")).toBe(true);
    expect(probes).toBe(0);
  });

  it.each(["settings-managed", "native-user", "project-mcpjson", "native-local"] as const)(
    "does not probe a local same-name loser behind higher fixed winner %s",
    (source) => {
      let probes = 0;
      const entries: McpSettingsEntry[] = [entry("local", "/local", { servers: { same: { command: "local" } } })];
      let native: ClaudeMcpStateResult | undefined;
      let mcpJson: McpJsonResult | undefined;
      if (source === "settings-managed") entries.push(entry("managed", "/managed", { servers: { same: { command: "fixed" } } }));
      if (source === "native-user") native = nativeState({ user: { same: { command: "fixed" } } });
      if (source === "native-local") native = nativeState({ local: { same: { command: "fixed" } } });
      if (source === "project-mcpjson") mcpJson = mcpJsonOf({ same: { command: "fixed" } });
      const cfg = resolve({
        entries,
        ...(native === undefined ? {} : { nativeState: native }),
        ...(mcpJson === undefined ? {} : { mcpJson }),
        policy: [policyEntry("managed", 0, { deniedMcpServers: [{ serverCommand: ["fixed"] }] })],
        probe: () => { probes += 1; throw new Error("higher fixed winner must suppress classification"); },
      });
      expect(probes).toBe(0);
      expect(server(cfg, "same")).toMatchObject({ status: "blocked", inactiveReason: "policy-denied" });
    },
  );

  it.each([
    { blocked: false, probes: 1, status: "pending-approval" },
    { blocked: true, probes: 0, status: "blocked" },
  ] as const)("probes approval-only local input exactly $probes time(s) when policyBlocked=$blocked", ({ blocked, probes, status }) => {
    let calls = 0;
    const cfg = resolve({
      mcpJson: mcpJsonOf({ target: { command: "target" }, unrelated: { command: "unrelated" } }),
      entries: [entry("local", "/local", { enabledMcpjsonServers: ["target"] })],
      policy: [policyEntry("managed", 0, blocked
        ? { deniedMcpServers: [{ serverName: "target" }], allowedMcpServers: [{ serverName: "unrelated" }] }
        : { allowedMcpServers: [{ serverName: "target" }, { serverName: "unrelated" }] })],
      probe: () => { calls += 1; return true; },
    });
    expect(calls).toBe(probes);
    expect(server(cfg, "target")?.status).toBe(status);
  });

  it.each([
    { tracked: false, denied: "local", winner: "local", status: "blocked" },
    { tracked: true, denied: "local", winner: "project", status: "enabled" },
    { tracked: false, denied: "project", winner: "local", status: "enabled" },
    { tracked: true, denied: "project", winner: "project", status: "blocked" },
  ] as const)("selects the $winner winner before policy when tracked=$tracked and never falls back", ({ tracked, denied, winner, status }) => {
    let probes = 0;
    const cfg = resolve({
      entries: [
        entry("local", "/outer/.claude/settings.local.json", { servers: { same: { command: "local" } } }),
        entry("project", "/near/.claude/settings.json", { servers: { same: { command: "project" } } }),
        entry("user", "/approval", { enabledMcpjsonServers: ["same"] }),
      ],
      policy: [policyEntry("managed", 0, { deniedMcpServers: [{ serverCommand: [denied] }] })],
      probe: () => { probes += 1; return tracked; },
    });
    expect(probes).toBe(1);
    expect(cfg.servers).toHaveLength(1);
    expect(server(cfg, "same")?.status).toBe(status);
    if (status === "enabled") expect(server(cfg, "same")).toMatchObject({ command: winner });
    else expect(server(cfg, "same")).not.toHaveProperty("command");
  });

  it("uses one immutable environment snapshot for admission and enabled materialization", () => {
    const env = { BIN: "before" } as NodeJS.ProcessEnv;
    const cfg = resolve({
      entries: [entry("user", "/u", { servers: { srv: { command: "${BIN}" } } })],
      policy: [policyEntry("managed", 0, { allowedMcpServers: [{ serverCommand: ["before"] }] })],
      env,
    });
    env.BIN = "after";
    expect(server(cfg, "srv")).toMatchObject({ status: "enabled", command: "before" });
  });

  it("reads getter-backed environment values once and shares that snapshot", () => {
    let reads = 0;
    const env = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperty(env, "BIN", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "snapshot-value" : "changed-value";
      },
    });
    const cfg = resolve({
      entries: [entry("user", "/u", { servers: { srv: { command: "${BIN}" } } })],
      policy: [policyEntry("managed", 0, { allowedMcpServers: [{ serverCommand: ["snapshot-value"] }] })],
      env,
    });
    expect(reads).toBe(1);
    expect(server(cfg, "srv")).toMatchObject({ status: "enabled", command: "snapshot-value" });
  });

  it("does not acquire ordinary inputs when a getter makes the prepared environment uncertain", () => {
    const env = Object.create(null) as NodeJS.ProcessEnv;
    Object.defineProperty(env, "BROKEN", {
      enumerable: true,
      get: () => { throw new Error("environment getter uncertainty"); },
    });
    let calls = 0;
    const cfg = resolveMcpConfig({
      projectRoot: "/project",
      mcpSettings: [],
      env,
      loadOrdinaryMcp: () => {
        calls += 1;
        throw new Error("ordinary inputs must not be acquired");
      },
    });
    expect(calls).toBe(0);
    expect(cfg).toMatchObject({
      policyPosture: "fail-closed",
      policyAuthority: "user-controlled",
      policyObservations: ["compiler-uncertainty-fail-closed"],
      servers: [],
    });
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

  function managedIo(text: string): ManagedMcpIo {
    const bytes = Buffer.from(text, "utf8");
    const metadata = { regular: true, size: bytes.length, identity: "managed", modified: "fixed" };
    return {
      open: () => ({
        status: "opened",
        handle: {
          metadata: () => metadata,
          read: () => bytes,
          currentPathMetadata: () => metadata,
          close: () => true,
        },
      }),
    };
  }

  it.each([
    { label: "populated", io: managedIo(JSON.stringify({ mcpServers: { managed: { command: "managed-command" } } })), posture: "exclusive", names: ["managed"] },
    { label: "empty", io: managedIo(JSON.stringify({ mcpServers: {} })), posture: "exclusive-empty", names: [] },
    { label: "unusable", io: { open: () => ({ status: "unreadable" as const }) }, posture: "fail-closed", names: [] },
  ] as const)("skips throwing ordinary loaders for $label standalone state", ({ io, posture, names }) => {
    const root = makeTmp();
    writeText(path.join(root, ".mcp.json"), "expensive malformed ordinary input");
    let nativeCalls = 0;
    let projectCalls = 0;
    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "user"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { nativeCalls += 1; throw new Error("native loader must be skipped"); },
        loadProjectMcpJson: () => { projectCalls += 1; throw new Error("project loader must be skipped"); },
      },
    });
    expect([nativeCalls, projectCalls]).toEqual([0, 0]);
    expect(project.mcp.policyPosture).toBe(posture);
    expect(project.mcp.policyOrdinarySourcesSuppressed).toBe(true);
    expect(project.mcp.servers.map((item) => item.name)).toEqual(names);
    expect(project.mcp.diagnostics).toEqual([]);
    if (names.length > 0) expect(project.mcp.servers[0]).toMatchObject({ status: "enabled", source: "managed-mcp" });
  });

  it.each([
    { label: "typed managed-source failure", standalone: "absent" as const },
    { label: "typed failure plus populated exclusive", standalone: "populated" as const },
  ])("skips ordinary loaders for $label before native state can fail", ({ standalone }) => {
    const root = makeTmp();
    const malformedPolicy = path.join(root, "managed-settings.json");
    writeText(malformedPolicy, "{");
    let nativeCalls = 0;
    let projectCalls = 0;
    const io = standalone === "populated"
      ? managedIo(JSON.stringify({ mcpServers: { managed: { command: "managed" } } }))
      : { open: () => ({ status: "absent" as const }) };
    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "user"),
      managedSettingsPaths: [malformedPolicy],
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { nativeCalls += 1; throw new Error("unusable native state must remain unobserved"); },
        loadProjectMcpJson: () => { projectCalls += 1; throw new Error("project loader must remain unobserved"); },
      },
    });
    expect([nativeCalls, projectCalls]).toEqual([0, 0]);
    expect(project.mcp.policyPosture).toBe("fail-closed");
    expect(project.mcp.servers).toEqual([]);
    expect(project.mcp.policyObservations).toContain("source-failure-fail-closed");
  });

  it("rejects an invalid ordinary policy file without projecting policy or suppressing ordinary loaders", () => {
    const root = makeTmp();
    const userDir = path.join(root, "user");
    writeJson(path.join(userDir, "settings.json"), {
      allowedMcpServers: [{ serverName: "ordinary" }],
      deniedMcpServers: "invalid",
    });
    let calls = 0;
    const project = loadClaudeProject({
      cwd: root,
      userDir,
      env: {},
      managedSettingsPaths: [],
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io: { open: () => ({ status: "absent" }) } } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { calls += 1; return { kind: "absent", diagnostics: [] }; },
        loadProjectMcpJson: () => { calls += 1; return mcpJsonOf({ ordinary: { command: "ordinary" } }); },
      },
    });
    expect(calls).toBe(2);
    expect(project.mcp.policyPosture).toBe("absent");
    expect(server(project.mcp, "ordinary")?.status).toBe("pending-approval");
    expect(project.mcp.policyObservations).not.toContain("invalid-non-managed-projection");
  });

  it("uses over-limit environment compiler uncertainty to skip ordinary loaders", () => {
    const root = makeTmp();
    let calls = 0;
    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "user"),
      env: Object.fromEntries(Array.from({ length: MCP_POLICY_LIMITS.environmentEntries + 1 }, (_, index) => [`ENV_${index}`, "x"])),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io: { open: () => ({ status: "absent" }) } } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { calls += 1; throw new Error("native loader must be skipped"); },
        loadProjectMcpJson: () => { calls += 1; throw new Error("project loader must be skipped"); },
      },
    });
    expect(calls).toBe(0);
    expect(project.mcp).toMatchObject({ policyPosture: "fail-closed", servers: [] });
    expect(project.mcp.policyObservations).toContain("compiler-uncertainty-fail-closed");
  });

  it("skips ordinary loaders when bounded policy collection signals restrictive omission", () => {
    const root = makeTmp();
    const managedPaths = Array.from({ length: 257 }, (_, index) => {
      const file = path.join(root, "managed", `${index}.json`);
      writeJson(file, { deniedMcpServers: [{ serverName: `denied-${index}` }] });
      return file;
    });
    let calls = 0;
    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "user"),
      managedSettingsPaths: managedPaths,
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io: { open: () => ({ status: "absent" }) } } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { calls += 1; throw new Error("native loader must be skipped"); },
        loadProjectMcpJson: () => { calls += 1; throw new Error("project loader must be skipped"); },
      },
    });
    expect(calls).toBe(0);
    expect(project.mcp).toMatchObject({ policyPosture: "fail-closed", servers: [] });
    expect(project.mcp.policyObservations).toContain("restrictive-material-omitted");
  });

  it("invokes each ordinary loader exactly once only when standalone state is absent", () => {
    const root = makeTmp();
    let nativeCalls = 0;
    let projectCalls = 0;
    const project = loadClaudeProject({
      cwd: root,
      userDir: path.join(root, "user"),
      managedSettingsPaths: [],
      managedArtifactDirs: [],
      managedMcpDiscovery: { testAuthority: { path: "/managed", io: { open: () => ({ status: "absent" }) } } },
      mcpOrdinaryLoadersForTest: {
        loadNativeState: () => { nativeCalls += 1; return { kind: "absent", diagnostics: [] }; },
        loadProjectMcpJson: () => {
          projectCalls += 1;
          return mcpJsonOf({ ordinary: { command: "ordinary" } });
        },
      },
    });
    expect([nativeCalls, projectCalls]).toEqual([1, 1]);
    expect(server(project.mcp, "ordinary")?.status).toBe("pending-approval");
    expect(project.mcp.policyOrdinarySourcesSuppressed).toBeUndefined();
  });

  it.each([
    { route: "explicit userDir", select: "explicit", env: { PICC_CLAUDE_USER_DIR: "picc", CLAUDE_CONFIG_DIR: "claude" } },
    { route: "PICC_CLAUDE_USER_DIR", select: "picc", env: { PICC_CLAUDE_USER_DIR: "picc", CLAUDE_CONFIG_DIR: "claude" } },
    { route: "CLAUDE_CONFIG_DIR", select: "claude", env: { CLAUDE_CONFIG_DIR: "claude" } },
    { route: "default injected home", select: "default", env: {} },
  ] as const)("loads native user MCP state from the $route profile only", ({ select, env }) => {
    const root = makeTmp();
    const home = path.join(root, "home");
    const profiles = {
      explicit: path.join(root, "explicit-profile"),
      picc: path.join(root, "picc-profile"),
      claude: path.join(root, "claude-profile"),
      default: path.join(home, ".claude"),
    } as const;
    const injectedEnv: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(env).map(([key, profile]) => [key, profiles[profile as keyof typeof profiles]]),
    );
    const statePath = (profile: keyof typeof profiles): string => profile === "default"
      ? path.join(home, ".claude.json")
      : path.join(profiles[profile], ".claude.json");

    for (const profile of Object.keys(profiles) as Array<keyof typeof profiles>) {
      if (profile === select) continue;
      writeJson(statePath(profile), { mcpServers: { [`canary-${profile}`]: { command: "CANARY" } } });
    }
    // The default profile uses the home sibling, never a contained state file.
    writeJson(path.join(profiles.default, ".claude.json"), {
      mcpServers: { "canary-default-contained": { command: "CANARY" } },
    });
    writeJson(statePath(select), { mcpServers: { selected: { command: "selected-command" } } });

    const project = loadClaudeProject({
      cwd: root,
      ...(select === "explicit" ? { userDir: profiles.explicit } : {}),
      env: injectedEnv,
      homeDir: home,
      managedSettingsPaths: [],
      managedArtifactDirs: [],
    });
    expect(server(project.mcp, "selected")).toMatchObject({
      status: "enabled",
      source: "native-user",
      command: "selected-command",
    });
    expect(project.mcp.servers.map((item) => item.name)).toEqual(["selected"]);
  });

  it("yields servers: [] (and no diagnostics) when no MCP config exists anywhere", () => {
    const root = makeTmp();
    const project = loadFrom(root);
    expect(project.mcp).toEqual({
      servers: [],
      diagnostics: [],
      policyPosture: "absent",
      policyAuthority: "user-controlled",
      policyObservations: [],
      policyFailures: [],
    });
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
    expect(github?.source).toBe("project-mcpjson");
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
