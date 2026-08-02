import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_MCP_STATE_LIMITS,
  loadClaudeMcpState,
  type ClaudeMcpStateLoaded,
  type LoadClaudeMcpStateOptions,
} from "../src/claude/claude-mcp-state.js";

let root: string;
let project: string;
let state: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-claude-mcp-state-"));
  project = path.join(root, "project");
  state = path.join(root, "claude.json");
  fs.mkdirSync(project);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function write(value: unknown): void {
  fs.writeFileSync(state, JSON.stringify(value), "utf8");
}

function load(overrides: Partial<LoadClaudeMcpStateOptions> = {}) {
  return loadClaudeMcpState({ statePath: state, projectRoot: project, ...overrides });
}

function loaded(overrides: Partial<LoadClaudeMcpStateOptions> = {}): ClaudeMcpStateLoaded {
  const result = load(overrides);
  expect(result.kind).toBe("loaded");
  return result as ClaudeMcpStateLoaded;
}

function localKey(): string {
  return fs.realpathSync.native(project);
}

describe("loadClaudeMcpState snapshot handling", () => {
  it("returns quiet absence and reads a present file without mutation", () => {
    expect(load()).toEqual({ kind: "absent", diagnostics: [] });
    write({ mcpServers: { user: { command: "${SECRET_COMMAND}", args: ["${TOKEN}"] } } });
    const beforeBytes = fs.readFileSync(state);
    const beforeEntries = fs.readdirSync(root);

    const result = loaded();

    expect(result.user.servers[0]).toMatchObject({ name: "user", command: "${SECRET_COMMAND}", args: ["${TOKEN}"] });
    expect(result.local.servers).toEqual([]);
    expect(fs.readFileSync(state)).toEqual(beforeBytes);
    expect(fs.readdirSync(root)).toEqual(beforeEntries);
  });

  it("accepts a leading BOM but rejects malformed JSON and invalid UTF-8 without parser excerpts", () => {
    fs.writeFileSync(state, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"mcpServers":{}}')]));
    expect(load().kind).toBe("loaded");

    fs.writeFileSync(state, '{"secret":"credential-value",');
    expect(load()).toEqual({ kind: "unusable", diagnostics: ["Native Claude state is malformed JSON"] });

    fs.writeFileSync(state, Buffer.from([0xff, 0xfe]));
    expect(load()).toEqual({ kind: "unusable", diagnostics: ["Native Claude state is not valid UTF-8"] });
  });

  it("fails closed for unreadable, non-regular, oversized, and growing opened snapshots", () => {
    write({});
    expect(load({ fileSystem: { open: () => { throw Object.assign(new Error("secret path"), { code: "EACCES" }); } } }))
      .toEqual({ kind: "unusable", diagnostics: ["Native Claude state could not be read"] });
    expect(load({ fileSystem: { fstat: () => ({ isFile: () => false, size: 0 }) as fs.Stats } }).kind).toBe("unusable");
    expect(load({ fileSystem: { fstat: () => ({ isFile: () => true, size: CLAUDE_MCP_STATE_LIMITS.fileBytes + 1 }) as fs.Stats } }).kind)
      .toBe("unusable");

    const payload = Buffer.alloc(CLAUDE_MCP_STATE_LIMITS.fileBytes + 1, 0x20);
    expect(load({
      fileSystem: {
        open: () => 91,
        fstat: () => ({ isFile: () => true, size: 2 }) as fs.Stats,
        read: (_fd, buffer, offset, length, position) => {
          const count = Math.min(length, payload.length - position);
          if (count <= 0) return 0;
          payload.copy(buffer, offset, position, position + count);
          return count;
        },
        close: () => undefined,
      },
    }).kind).toBe("unusable");
  });

  it("accepts an exactly file-sized valid snapshot", () => {
    const prefix = Buffer.from('{"mcpServers":{}}');
    fs.writeFileSync(state, Buffer.concat([
      prefix,
      Buffer.alloc(CLAUDE_MCP_STATE_LIMITS.fileBytes - prefix.length, 0x20),
    ]));
    expect(load().kind).toBe("loaded");
  });

  it("treats a failed descriptor close as unusable", () => {
    write({});
    expect(load({ fileSystem: { close: (fd) => { fs.closeSync(fd); throw new Error("injected"); } } }))
      .toEqual({ kind: "unusable", diagnostics: ["Native Claude state could not be read"] });
  });
});

describe("loadClaudeMcpState scope selection", () => {
  it("keeps native user and selected local entries distinct with local gates", () => {
    write({
      mcpServers: { shared: { command: "user-command" } },
      projects: {
        [localKey()]: {
          mcpServers: { shared: { command: "local-command" }, local: { command: "local" } },
          disabledMcpServers: ["shared", "shared"],
          enabledMcpServers: ["builtin"],
        },
      },
    });
    const result = loaded();
    expect(result.user).toMatchObject({ source: "native-user", servers: [{ name: "shared", command: "user-command" }] });
    expect(result.local.servers.map(({ name, command }) => ({ name, command }))).toEqual([
      { name: "shared", command: "local-command" },
      { name: "local", command: "local" },
    ]);
    expect([...result.disabledMcpServers]).toEqual(["shared"]);
    expect(result.enabledMcpServers).toEqual(["builtin"]);
    expect(result.diagnostics).toEqual([
      "Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled",
    ]);
    expect(result.diagnostics.join(" ")).not.toMatch(/builtin|shared/);
  });

  it("uses only the ordered primary family identity, so a worktree record cannot override its main checkout", () => {
    const main = localKey();
    const worktree = path.join(root, "canonical-worktree");
    write({ projects: { [main]: { mcpServers: { family: { command: "main" } } }, [worktree]: { mcpServers: { wrong: { command: "worktree" } } } } });
    const result = loaded({
      identifyProject: () => [main, worktree],
      canonicalizeProject: (candidate) => ({ kind: "canonical", path: candidate }),
    });
    expect(result.local.servers.map((server) => server.name)).toEqual(["family"]);
  });

  it("matches representative directory-link spellings in both directions and not neighboring paths", () => {
    const link = path.join(root, "project-link");
    fs.symlinkSync(project, link, process.platform === "win32" ? "junction" : "dir");
    write({ projects: { [link]: { mcpServers: { linked: { command: "yes" } } } } });
    expect(loaded().local.servers.map((server) => server.name)).toEqual(["linked"]);

    write({ projects: { [localKey()]: { mcpServers: { real: { command: "yes" } } } } });
    expect(loaded({ projectRoot: link }).local.servers.map((server) => server.name)).toEqual(["real"]);

    const neighbor = path.join(root, "project-other");
    fs.mkdirSync(neighbor);
    write({ projects: { [neighbor]: { mcpServers: { no: { command: "no" } } } } });
    expect(loaded().local.servers).toEqual([]);
  });

  it("coalesces equivalent empty, populated, reordered, and metadata-different aliases", () => {
    const aliases = [localKey(), path.join(root, "alias-a"), path.join(root, "alias-b")];
    const first = JSON.parse('{"mcpServers":{"shared":{"command":"run","args":["a","b"],"future":{"__proto__":{"flag":true},"z":1}}},"disabledMcpServers":["off","off","other"],"enabledMcpServers":["on","extra"],"metadata":"first"}') as unknown;
    const reordered = JSON.parse('{"metadata":"second","enabledMcpServers":["extra","on","on"],"disabledMcpServers":["other","off"],"mcpServers":{"shared":{"future":{"z":1,"__proto__":{"flag":true}},"args":["a","b"],"command":"run"}}}') as unknown;
    write({ projects: { [aliases[0]!]: first, [aliases[1]!]: reordered, [aliases[2]!]: first } });

    const result = loaded({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) });

    expect(result.local.servers.map(({ name, command, args }) => ({ name, command, args }))).toEqual([
      { name: "shared", command: "run", args: ["a", "b"] },
    ]);
    expect([...result.disabledMcpServers]).toEqual(["off", "other"]);
    expect(result.enabledMcpServers).toEqual(["on", "extra"]);
    expect(result.diagnostics).toEqual([
      "Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled",
      "Native local MCP server \"shared\" has configuration PiCC ignored or adjusted; its definition was retained for later resolution",
    ]);
  });

  it("treats missing and empty disabled lists as equivalent but enabled-list presence as significant", () => {
    const alias = path.join(root, "alias");
    write({ projects: { [localKey()]: {}, [alias]: { mcpServers: {}, disabledMcpServers: [] } } });
    expect(load({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) }).kind).toBe("loaded");

    write({ projects: { [localKey()]: {}, [alias]: { enabledMcpServers: [] } } });
    expect(load({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) })).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude project MCP state has conflicting matching records"],
    });
  });

  it("fails closed with one redacted diagnostic for every MCP projection conflict class", () => {
    const alias = path.join(root, "alias");
    const conflicts: Array<[unknown, unknown]> = [
      [{ mcpServers: { s: { command: "one" } } }, { mcpServers: { s: { command: "two" } } }],
      [{ mcpServers: { s: { command: "x", args: ["a", "b"] } } }, { mcpServers: { s: { command: "x", args: ["b", "a"] } } }],
      [{ mcpServers: { s: { command: "x", future: { token: "secret-one" } } } }, { mcpServers: { s: { command: "x", future: { token: "secret-two" } } } }],
      [{ disabledMcpServers: ["one"] }, { disabledMcpServers: ["two"] }],
      [{ enabledMcpServers: ["one"] }, { enabledMcpServers: ["two"] }],
    ];
    for (const [first, second] of conflicts) {
      write({ projects: { [localKey()]: first, [alias]: second } });
      const result = load({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) });
      expect(result).toEqual({
        kind: "unusable",
        diagnostics: ["Native Claude project MCP state has conflicting matching records"],
      });
      expect(result.diagnostics.join(" ")).not.toMatch(/one|two|secret|token|command|future|\b s\b/i);
    }
  });

  it("rejects every malformed alias shape after valid state and when both aliases are identically malformed", () => {
    const alias = path.join(root, "alias");
    const malformedCases: Array<{ valid: unknown; malformed: unknown; diagnostic: string }> = [
      {
        valid: { mcpServers: {} },
        malformed: { mcpServers: [] },
        diagnostic: "Native Claude local MCP state has an invalid object shape",
      },
      {
        valid: { disabledMcpServers: [] },
        malformed: { disabledMcpServers: "all" },
        diagnostic: "Native Claude disabled MCP list has an invalid shape",
      },
      {
        valid: { enabledMcpServers: [] },
        malformed: { enabledMcpServers: "all" },
        diagnostic: "Native Claude enabled MCP list has an invalid shape",
      },
    ];
    for (const { valid, malformed, diagnostic } of malformedCases) {
      for (const records of [[valid, malformed], [malformed, malformed]]) {
        write({ projects: { [localKey()]: records[0], [alias]: records[1] } });
        expect(load({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) })).toEqual({
          kind: "unusable",
          diagnostics: [diagnostic],
        });
      }
    }
  });

  it("normalizes one equivalent bounded definition, including a skipped definition, only once", () => {
    const alias = path.join(root, "alias");
    const record = { mcpServers: { malformed: { command: 7, future: { value: true } } } };
    write({ projects: { [localKey()]: record, [alias]: record } });
    const result = loaded({ canonicalizeProject: () => ({ kind: "canonical", path: localKey() }) });
    expect(result.local.servers).toHaveLength(1);
    expect(result.local.servers[0]).toMatchObject({ name: "malformed", skipped: true });
    expect(result.diagnostics).toEqual([
      "Native local MCP server \"malformed\" has an invalid or unsupported definition and was skipped",
    ]);
  });

  it("continues canonicalizing after equivalent matches and preserves a later indeterminate failure", () => {
    const aliases = [localKey(), path.join(root, "alias"), path.join(root, "later")];
    write({ projects: Object.fromEntries(aliases.map((candidate) => [candidate, {}])) });
    const probes: string[] = [];
    expect(load({ canonicalizeProject: (candidate) => {
      probes.push(candidate);
      return candidate === aliases[2]
        ? { kind: "indeterminate" }
        : { kind: "canonical", path: localKey() };
    } })).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude project identity could not be determined safely"],
    });
    expect(probes).toEqual(aliases);
  });

  it.skipIf(process.platform !== "win32")("coalesces real Windows drive-letter case aliases", () => {
    const canonical = localKey();
    const swapped = `${canonical[0] === canonical[0]!.toUpperCase() ? canonical[0]!.toLowerCase() : canonical[0]!.toUpperCase()}${canonical.slice(1)}`;
    expect(swapped).not.toBe(canonical);

    write({ projects: { [canonical]: { mcpServers: { local: { command: "run" } } }, [swapped]: { mcpServers: { local: { command: "run" } } } } });
    expect(loaded().local.servers.map((server) => server.name)).toEqual(["local"]);

    write({ projects: { [canonical]: { mcpServers: { local: { command: "run" } } }, [swapped]: { mcpServers: { local: { command: "conflict" } } } } });
    expect(load()).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude project MCP state has conflicting matching records"],
    });
  });

  it("bounds canonicalization calls and never probes unsupported path classes", () => {
    const projects: Record<string, unknown> = Object.create(null);
    projects["relative/project"] = {};
    projects["//network/share"] = {};
    projects["\\\\server\\share"] = {};
    projects["\\\\?\\C:\\device"] = {};
    projects["\\\\.\\C:\\device"] = {};
    const eligible = Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.projects - 5 },
      (_, index) => process.platform === "win32" ? `C:\\local\\p${index}` : `/local/p${index}`,
    );
    for (const candidate of eligible) projects[candidate] = {};
    write({ projects });
    const probes: string[] = [];
    loaded({ canonicalizeProject: (candidate) => { probes.push(candidate); return { kind: "non-candidate", reason: "missing" }; } });
    expect(probes).toEqual(eligible);
    expect(probes).toHaveLength(CLAUDE_MCP_STATE_LIMITS.projects - 5);
  });

  it("distinguishes definite non-candidates from indeterminate canonicalization failures", () => {
    const candidate = process.platform === "win32" ? "C:\\eligible" : "/eligible";
    write({ projects: { [candidate]: { mcpServers: { hidden: { command: "x" } } } } });
    for (const reason of ["missing", "not-directory"] as const) {
      expect(loaded({ canonicalizeProject: () => ({ kind: "non-candidate", reason }) }).local.servers).toEqual([]);
    }
    expect(load({ canonicalizeProject: () => ({ kind: "indeterminate" }) })).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude project identity could not be determined safely"],
    });
  });

  it.each([
    "relative/project",
    "//network/share",
    "\\\\server\\share",
    "\\\\?\\C:\\device",
    "\\\\.\\C:\\device",
  ])("rejects unsupported primary family identity %j before candidate canonicalization", (identity) => {
    write({ projects: { [localKey()]: {} } });
    let calls = 0;
    expect(load({
      identifyProject: () => [identity],
      canonicalizeProject: () => { calls += 1; return { kind: "canonical", path: identity }; },
    })).toEqual({
      kind: "unusable",
      diagnostics: ["Active project identity uses an unsupported path class"],
    });
    expect(calls).toBe(0);
  });

  it("rejects over-depth, over-property, and over-material unrelated project records before probing", () => {
    const unrelated = process.platform === "win32" ? "C:\\unrelated" : "/unrelated";
    let tooDeep: unknown = "x";
    for (let index = 0; index < CLAUDE_MCP_STATE_LIMITS.containerDepth + 2; index += 1) tooDeep = [tooDeep];
    const tooManyProperties = Object.fromEntries(Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.properties + 1 },
      (_, index) => [`p${index}`, null],
    ));
    const materialPiece = "x".repeat(CLAUDE_MCP_STATE_LIMITS.stringChars);
    const tooMuchMaterial = Array.from(
      { length: Math.ceil(CLAUDE_MCP_STATE_LIMITS.materialChars / materialPiece.length) + 1 },
      () => materialPiece,
    );

    for (const record of [tooDeep, tooManyProperties, tooMuchMaterial]) {
      write({ projects: { [unrelated]: record } });
      let calls = 0;
      expect(load({ canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; } }).kind)
        .toBe("unusable");
      expect(calls).toBe(0);
    }
  });

  it("allows a small unrelated primitive record but rejects malformed matching and security shapes", () => {
    const unrelated = process.platform === "win32" ? "C:\\unrelated" : "/unrelated";
    write({ projects: { [unrelated]: "malformed", [localKey()]: { mcpServers: {} } } });
    expect(loaded().local.servers).toEqual([]);

    for (const record of [
      "matching primitive",
      { mcpServers: [] },
      { disabledMcpServers: "all" },
      { disabledMcpServers: [7] },
      { disabledMcpServers: ["bad__name"] },
      { disabledMcpServers: Array(CLAUDE_MCP_STATE_LIMITS.listItems + 1).fill("x") },
      { enabledMcpServers: "all" },
      { enabledMcpServers: [7] },
      { enabledMcpServers: ["bad__name"] },
      { enabledMcpServers: Array(CLAUDE_MCP_STATE_LIMITS.listItems + 1).fill("x") },
    ]) {
      write({ projects: { [localKey()]: record } });
      expect(load().kind).toBe("unusable");
    }
  });
});

describe("loadClaudeMcpState structural and diagnostic bounds", () => {
  it("accepts exact server and runtime-list boundaries", () => {
    const mcpServers = Object.fromEntries(Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.serversPerScope },
      (_, index) => [`s${index}`, { command: "x" }],
    ));
    write({
      mcpServers,
      projects: {
        [localKey()]: { enabledMcpServers: Array(CLAUDE_MCP_STATE_LIMITS.listItems).fill("s0") },
      },
    });
    const result = loaded();
    expect(result.user.servers).toHaveLength(CLAUDE_MCP_STATE_LIMITS.serversPerScope);
    expect(result.enabledMcpServers).toEqual(["s0"]);
  });

  it("proves exact and +1 project-count limits with the maximum eligible probe count", () => {
    const makeProjects = (count: number) => Object.fromEntries(Array.from(
      { length: count },
      (_, index) => [process.platform === "win32" ? `C:\\p${index}` : `/p${index}`, {}],
    ));
    write({ projects: makeProjects(CLAUDE_MCP_STATE_LIMITS.projects) });
    let calls = 0;
    expect(loaded({ canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; } }).kind)
      .toBe("loaded");
    expect(calls).toBe(CLAUDE_MCP_STATE_LIMITS.projects);

    write({ projects: makeProjects(CLAUDE_MCP_STATE_LIMITS.projects + 1) });
    calls = 0;
    expect(load({ canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; } }).kind)
      .toBe("unusable");
    expect(calls).toBe(0);
  });

  it("proves exact and +1 project-key limits before probing", () => {
    const prefix = process.platform === "win32" ? "C:\\" : "/";
    const key = (length: number) => prefix + "x".repeat(length - prefix.length);
    write({ projects: { [key(CLAUDE_MCP_STATE_LIMITS.projectKeyChars)]: {} } });
    let calls = 0;
    expect(load({ canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; } }).kind)
      .toBe("loaded");
    expect(calls).toBe(1);

    write({ projects: { [key(CLAUDE_MCP_STATE_LIMITS.projectKeyChars + 1)]: {} } });
    calls = 0;
    expect(load({ canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; } }).kind)
      .toBe("unusable");
    expect(calls).toBe(0);
  });

  it("applies cumulative exact and +1 property and material budgets across unrelated project records", () => {
    const candidates = process.platform === "win32"
      ? ["C:\\unrelated-a", "C:\\unrelated-b"]
      : ["/unrelated-a", "/unrelated-b"];
    const propertyRecords = (total: number) => {
      const first = Math.floor(total / 2);
      const record = (count: number) => Object.fromEntries(Array.from(
        { length: count },
        (_, index) => [`p${index}`, null],
      ));
      return { [candidates[0]!]: record(first), [candidates[1]!]: record(total - first) };
    };
    const materialRecords = (total: number) => {
      const strings = (chars: number) => {
        const values: string[] = [];
        for (let remaining = chars; remaining > 0; remaining -= CLAUDE_MCP_STATE_LIMITS.stringChars) {
          values.push("x".repeat(Math.min(remaining, CLAUDE_MCP_STATE_LIMITS.stringChars)));
        }
        return values;
      };
      const first = Math.floor(total / 2);
      return { [candidates[0]!]: strings(first), [candidates[1]!]: strings(total - first) };
    };
    const expectBoundary = (projects: Record<string, unknown>, expectedKind: "loaded" | "unusable", expectedCalls: number) => {
      write({ projects });
      let calls = 0;
      expect(load({
        canonicalizeProject: () => { calls += 1; return { kind: "non-candidate", reason: "missing" }; },
      }).kind).toBe(expectedKind);
      expect(calls).toBe(expectedCalls);
    };

    expectBoundary(propertyRecords(CLAUDE_MCP_STATE_LIMITS.properties), "loaded", 2);
    expectBoundary(propertyRecords(CLAUDE_MCP_STATE_LIMITS.properties + 1), "unusable", 0);
    expectBoundary(materialRecords(CLAUDE_MCP_STATE_LIMITS.materialChars), "loaded", 2);
    expectBoundary(materialRecords(CLAUDE_MCP_STATE_LIMITS.materialChars + 1), "unusable", 0);
  });

  it("proves exact and +1 disabled-list and runtime-name limits", () => {
    const exactName = `s${"x".repeat(CLAUDE_MCP_STATE_LIMITS.serverNameChars - 1)}`;
    write({ projects: { [localKey()]: {
      disabledMcpServers: Array(CLAUDE_MCP_STATE_LIMITS.listItems).fill(exactName),
    } } });
    expect([...loaded().disabledMcpServers]).toEqual([exactName]);

    write({ projects: { [localKey()]: {
      disabledMcpServers: Array(CLAUDE_MCP_STATE_LIMITS.listItems + 1).fill(exactName),
    } } });
    expect(load().kind).toBe("unusable");

    write({ projects: { [localKey()]: {
      disabledMcpServers: [`s${"x".repeat(CLAUDE_MCP_STATE_LIMITS.serverNameChars)}`],
    } } });
    expect(load().kind).toBe("unusable");
  });

  it("proves exact and +1 array-item, depth, and string limits", () => {
    write({ mcpServers: { exact: { command: "x", args: Array(CLAUDE_MCP_STATE_LIMITS.arrayItems).fill("x") } } });
    expect(loaded().user.servers[0]?.args).toHaveLength(CLAUDE_MCP_STATE_LIMITS.arrayItems);
    write({ mcpServers: { overflow: { command: "x", args: Array(CLAUDE_MCP_STATE_LIMITS.arrayItems + 1).fill("x") } } });
    expect(load().kind).toBe("unusable");

    const nested = (containers: number): unknown => {
      let value: unknown = "x";
      for (let index = 0; index < containers; index += 1) value = [value];
      return value;
    };
    write({ padding: nested(CLAUDE_MCP_STATE_LIMITS.containerDepth) });
    expect(load().kind).toBe("loaded");
    write({ padding: nested(CLAUDE_MCP_STATE_LIMITS.containerDepth + 1) });
    expect(load().kind).toBe("unusable");

    write({ padding: "x".repeat(CLAUDE_MCP_STATE_LIMITS.stringChars) });
    expect(load().kind).toBe("loaded");
    write({ padding: "x".repeat(CLAUDE_MCP_STATE_LIMITS.stringChars + 1) });
    expect(load().kind).toBe("unusable");
  });

  it("proves exact and +1 property-count, property-name, and aggregate-material limits", () => {
    const properties = (total: number) => ({ padding: Object.fromEntries(Array.from(
      { length: total - 1 },
      (_, index) => [`p${index}`, null],
    )) });
    write(properties(CLAUDE_MCP_STATE_LIMITS.properties));
    expect(load().kind).toBe("loaded");
    write(properties(CLAUDE_MCP_STATE_LIMITS.properties + 1));
    expect(load().kind).toBe("unusable");

    write({ ["k".repeat(CLAUDE_MCP_STATE_LIMITS.propertyNameChars)]: null });
    expect(load().kind).toBe("loaded");
    write({ ["k".repeat(CLAUDE_MCP_STATE_LIMITS.propertyNameChars + 1)]: null });
    expect(load().kind).toBe("unusable");

    const fixedKeyChars = "mcpServers".length + "exact".length + "args".length + "command".length + 1;
    const valueChars = CLAUDE_MCP_STATE_LIMITS.materialChars - fixedKeyChars;
    const fullStrings = Math.floor(valueChars / CLAUDE_MCP_STATE_LIMITS.stringChars);
    const remainder = valueChars % CLAUDE_MCP_STATE_LIMITS.stringChars;
    const args = [
      ...Array(fullStrings).fill("x".repeat(CLAUDE_MCP_STATE_LIMITS.stringChars)),
      ...(remainder === 0 ? [] : ["x".repeat(remainder)]),
    ];
    write({ mcpServers: { exact: { command: "x", args } } });
    expect(load().kind).toBe("loaded");
    const overflowArgs = [...args];
    overflowArgs[overflowArgs.length - 1] += "x";
    write({ mcpServers: { exact: { command: "x", args: overflowArgs } } });
    expect(load().kind).toBe("unusable");
  });

  it("separates invalid user/local object shapes from structural-limit diagnostics", () => {
    write({ mcpServers: [] });
    expect(load()).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude user MCP state has an invalid object shape"],
    });
    write({ mcpServers: Object.fromEntries(Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.serversPerScope + 1 },
      (_, index) => [`s${index}`, {}],
    )) });
    expect(load()).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude user MCP state exceeds structural limits"],
    });

    write({ projects: { [localKey()]: { mcpServers: [] } } });
    expect(load()).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude local MCP state has an invalid object shape"],
    });
    write({ projects: { [localKey()]: { mcpServers: Object.fromEntries(Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.serversPerScope + 1 },
      (_, index) => [`s${index}`, {}],
    )) } } });
    expect(load()).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude local MCP state exceeds structural limits"],
    });
  });

  it("distinguishes skipped definitions from retained entries with ignored or adjusted configuration", () => {
    write({ mcpServers: {
      active: { command: "run", timeout: 1, alwaysLoad: true, futureField: "credential-value" },
      malformed: { command: 7 },
    } });
    const result = loaded();
    expect(result.user.servers.map(({ name, skipped }) => ({ name, skipped }))).toEqual([
      { name: "active", skipped: false },
      { name: "malformed", skipped: true },
    ]);
    expect(result.user.servers.every((entry) => entry.diagnostics.length === 0)).toBe(true);
    expect(result.diagnostics).toEqual([
      "Native user MCP server \"active\" has configuration PiCC ignored or adjusted; its definition was retained for later resolution",
      "Native user MCP server \"malformed\" has an invalid or unsupported definition and was skipped",
    ]);
    expect(result.diagnostics.join(" ")).not.toContain("credential-value");
  });

  it("caps many malformed-entry diagnostics non-vacuously and clears all entry findings", () => {
    const mcpServers = Object.fromEntries(Array.from(
      { length: CLAUDE_MCP_STATE_LIMITS.diagnostics + 5 },
      (_, index) => [`server${index}`, {
        command: 7,
        token: `credential-value-${index}`,
        url: `https://secret.example/${index}`,
      }],
    ));
    write({ mcpServers });
    const result = loaded();
    expect(result.diagnostics).toHaveLength(CLAUDE_MCP_STATE_LIMITS.diagnostics);
    expect(result.diagnostics.every((message) => message.length <= CLAUDE_MCP_STATE_LIMITS.diagnosticChars)).toBe(true);
    expect(result.user.servers.every((entry) => entry.skipped && entry.diagnostics.length === 0)).toBe(true);
    const rendered = JSON.stringify(result.diagnostics) + JSON.stringify(result.user.servers.flatMap((server) => server.diagnostics));
    expect(rendered).not.toMatch(/credential|secret\.example|token|url|command|value-[0-9]/i);
  });

  it("retains hostile and prototype names only as skipped entries with redacted diagnostics", () => {
    fs.writeFileSync(state, `{"mcpServers":{"__proto__":{"command":"credential-command"},"safe":{"command":7,"url":"https://secret.example/token","headers":{"Authorization":"credential"}}}}`);
    const result = loaded();
    expect(result.user.servers).toHaveLength(2);
    expect(result.user.servers.every((server) => server.skipped)).toBe(true);
    expect(Object.getPrototypeOf(result.user.servers[0]!.env)).toBeNull();
    const rendered = JSON.stringify(result.diagnostics) + JSON.stringify(result.user.servers.flatMap((server) => server.diagnostics));
    expect(rendered).not.toMatch(/credential|secret\.example|Authorization|__proto__/);
  });

  it("fails closed with fixed redacted findings when identity seams throw", () => {
    write({ projects: { [localKey()]: {} } });
    expect(load({ identifyProject: () => { throw new Error("credential identity secret"); } })).toEqual({
      kind: "unusable",
      diagnostics: ["Active project identity could not be established"],
    });
    expect(load({ canonicalizeProject: () => { throw new Error("credential canonical secret"); } })).toEqual({
      kind: "unusable",
      diagnostics: ["Native Claude project identity could not be determined safely"],
    });
  });

  it("fails closed when the active project identity is unavailable", () => {
    write({ mcpServers: {} });
    expect(load({ identifyProject: () => [] })).toEqual({
      kind: "unusable",
      diagnostics: ["Active project identity could not be established"],
    });
  });
});
