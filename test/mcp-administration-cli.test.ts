import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProductionMcpCliServices, parseMcpAdministrationArgv, readMcpJsonInput, runMcpAdministrationCli, type McpCliServiceHandle } from "../src/mcp-administration-cli.js";
import type { LoadedProject } from "../src/project.js";
import type { McpAdministrationInventory } from "../src/mcp-administration/model.js";
import { createMcpLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { projectIdentities } from "../src/util/project-identity.js";

const inventory: McpAdministrationInventory = {
  version: 1, policyPosture: "active-rules", observations: [], omittedDeclarationCount: 0,
  servers: [
    { name: "same", source: "native-local", authority: { kind: "mutable", scope: "local" }, precedence: "winner", summary: { transport: "stdio", commandBasename: "node", argumentCount: 1, environmentKeyCount: 1, headerKeyCount: 0, timeoutConfigured: false }, policy: "allowed", review: "not-required", status: "enabled", live: "connected", capabilityCounts: { tools: 1, prompts: 0, resources: 0 } },
    { name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" }, precedence: "shadowed", summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 1, timeoutConfigured: false }, policy: "allowed", review: "not-required", status: "shadowed", live: "not-running", capabilityCounts: { tools: 0, prompts: 0, resources: 0 } },
    { name: "pending", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "winner", summary: { transport: "stdio", commandBasename: "node", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false }, policy: "allowed", review: "pending", status: "disabled", live: "not-running", capabilityCounts: { tools: 0, prompts: 0, resources: 0 } },
    { name: "rejected", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "winner", summary: { transport: "stdio", commandBasename: "node", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false }, policy: "allowed", review: "rejected-exact", status: "disabled", live: "not-running", capabilityCounts: { tools: 0, prompts: 0, resources: 0 } },
  ],
};
const persistence = { state: "committed", retrySafe: false, effect: "changed", cleanup: "complete" } as const;
const transientProbeWarning = "PiCC MCP: eligible winners may be transiently started or contacted for bounded health/capability probing, then bounded shutdown is attempted.";
function harness(overrides: Partial<{ inventory: McpAdministrationInventory; preparation: unknown; preview: unknown; execute: unknown; health: Record<string, "connected" | "auth-needed" | "failed"> }> = {}) {
  const calls: unknown[] = []; const writes: unknown[] = [];
  const currentInventory = overrides.inventory ?? inventory;
  const preview = vi.fn(async (action: unknown) => { calls.push(["preview", action]); return overrides.preview ?? { inventory: currentInventory, eligibility: { eligible: true, reasonCode: "eligible" } }; });
  const execute = vi.fn(async (action: unknown) => { calls.push(["execute", action]); return overrides.execute ?? { inventory: currentInventory, eligibility: { eligible: true, reasonCode: "eligible" }, recovery: { state: "not-requested" }, durable: persistence, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } }; });
  const inventoryCall = vi.fn(async () => currentInventory);
  const prepareInventoryAfterRecovery = vi.fn(async () => overrides.preparation ?? ({ inventory: currentInventory, eligibility: { eligible: true as const, reasonCode: "eligible" as const }, recovery: { state: "not-requested" as const } }));
  const handle = { service: { inventory: inventoryCall, prepareInventoryAfterRecovery, preview, execute }, health: (name: string) => { const state = overrides.health?.[name]; return state === undefined ? undefined : { state, tools: 2, prompts: 1, resources: 0 }; } } as unknown as McpCliServiceHandle;
  const services = vi.fn(async (health: boolean) => { writes.push(health); return { ok: true as const, value: handle }; });
  const stdout: string[] = []; const stderr: string[] = [];
  const run = (argv: string[], extra: Record<string, unknown> = {}) => runMcpAdministrationCli(argv, { log: (line) => stdout.push(line), error: (line) => stderr.push(line) }, { services, ...extra });
  return { run, stdout, stderr, calls, writes, inventoryCall, prepareInventoryAfterRecovery, preview, execute };
}

describe("standalone MCP administration grammar", () => {
  it("pins stdio's mandatory first boundary, true variadic aliases, option positions, and remote forms", () => {
    const stdioCases = [
      ["add", "name", "-e", "A=secret", "B=other", "--env", "C=third", "--", "node", "arg", "--", "literal"],
      ["add", "-e", "A=secret", "B=other", "-s", "local", "name", "--env", "C=third", "--", "node", "arg", "--", "literal"],
    ];
    for (const argv of stdioCases) expect(parseMcpAdministrationArgv(argv)).toMatchObject({ kind: "mutation", action: { kind: "add", scope: "local", name: "name", definition: { command: "node", args: ["arg", "--", "literal"], env: { A: "secret", B: "other", C: "third" } } } });
    for (const argv of [["add", "-e", "A=secret", "name", "--", "node"], ["add", "--env", "name", "--", "node"], ["add", "name", "node"]]) expect(parseMcpAdministrationArgv(argv)).toEqual({ ok: false, code: 2 });
    const remoteCases = [
      ["add", "-s", "user", "-t", "http", "remote", "https://example.test", "-H", "Authorization: secret", "X-Test: other", "--header", "Third: value"],
      ["add", "--header", "Authorization: secret", "--transport", "http", "remote", "https://example.test", "-H", "X-Test: other", "Third: value", "--scope", "user"],
    ];
    for (const argv of remoteCases) expect(parseMcpAdministrationArgv(argv)).toMatchObject({ kind: "mutation", action: { scope: "user", name: "remote", definition: { type: "http", headers: { Authorization: "secret", "X-Test": "other", Third: "value" } } } });
    expect(parseMcpAdministrationArgv(["add", "-t", "sse", "remote", "https://example.test", "--", "extra"])).toEqual({ ok: false, code: 2 });
  });

  it("gives recognized commands Claude-compatible help precedence and accepts broad bounded names", () => {
    expect(parseMcpAdministrationArgv(["--help"])).toEqual({ kind: "help" });
    expect(parseMcpAdministrationArgv(["help"])).toEqual({ kind: "help" });
    for (const argv of [["help", "add", "ignored", "--bad"], ["list", "unexpected", "--help", "--scope"], ["add-json", "name", "--json-file", "-h", "extra"], ["add", "name", "--", "command", "--help"]]) {
      expect(parseMcpAdministrationArgv(argv)).toEqual({ kind: "help", command: argv[0] === "help" ? "add" : argv[0] });
    }
    for (const name of ["name with spaces", "name__with__separator"]) expect(parseMcpAdministrationArgv(["add", name, "--", "node"])).toMatchObject({ kind: "mutation", action: { name } });
    expect(parseMcpAdministrationArgv(["get", `bad\u0000name`])).toEqual({ ok: false, code: 2 });
    expect(parseMcpAdministrationArgv(["get", "x".repeat(129)])).toEqual({ ok: false, code: 2 });
    expect(parseMcpAdministrationArgv(["help", "unknown", "--help"])).toEqual({ ok: false, code: 2 });
    expect(parseMcpAdministrationArgv(["unknown", "--help"])).toEqual({ ok: false, code: 2 });
  });

  it("renders exact global and command-specific help for both accepted forms", async () => {
    const expectedGlobal = `Usage: picc mcp <command>\n\nCommands:\n  list [--scope|-s local|project|user]\n  get <name> [--scope|-s local|project|user]\n  add [--dry-run] [--scope|-s ...] [--transport|-t stdio] <name> [--env|-e KEY=VALUE ...] -- <command> [args...]\n  add [--dry-run] [--scope|-s ...] --transport|-t http|sse <name> <url> [--header|-H "Name: Value" ...]\n  add-json [--dry-run] [--scope|-s ...] <name> <json>\n  add-json [--dry-run] [--scope|-s ...] <name> --json-file <path|->\n  remove [--dry-run] [--scope|-s ...] <name>\n  reset-project-choices [--dry-run]\n  help [command]\n\nList/get report a bounded acquired inventory; omitted declarations are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.\nUse picc mcp <command> --help for command grammar.\nMutations run directly without confirmation. --dry-run evaluates the current safe snapshot without recovery or writes and may refuse where direct execution first recovers.\nInline JSON and --env/--header values may expose credentials in argv and shell history; for credential-bearing definitions prefer add-json --json-file <path|->.`;
    const expected: Record<string, string> = {
      list: "Usage: picc mcp list [--scope|-s local|project|user]\nReports a bounded acquired inventory and the effective winner; any omissions are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.",
      get: "Usage: picc mcp get <name> [--scope|-s local|project|user]\nReports the bounded acquired effective winner and same-name collisions; any omissions are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.",
      add: "Usage: picc mcp add [--dry-run] [--scope|-s local|project|user] [--transport|-t stdio] <name> [--env|-e KEY=VALUE ...] -- <command> [args...]\n       picc mcp add [--dry-run] [--scope|-s local|project|user] --transport|-t http|sse <name> <url> [--header|-H \"Name: Value\" ...]\nDefault scope: local. Static headers are supported; OAuth login is unavailable. --env/--header values may be exposed in argv and shell history; for credentials prefer add-json --json-file <path|->.",
      "add-json": "Usage: picc mcp add-json [--dry-run] [--scope|-s local|project|user] <name> <json>\n       picc mcp add-json [--dry-run] [--scope|-s local|project|user] <name> --json-file <path|->\nDefault scope: local. Inline JSON may expose credentials in argv and shell history; for credential-bearing definitions prefer add-json --json-file <path|->.",
      remove: "Usage: picc mcp remove [--dry-run] [--scope|-s local|project|user] <name>\nWithout --scope, removes the sole mutable same-name declaration only from a complete bounded inventory; pass --scope when declarations are omitted or ambiguous.",
      "reset-project-choices": "Usage: picc mcp reset-project-choices [--dry-run]\nResets PiCC-owned review choices across the active profile and checkout family; declarations and runtime-disable choices are preserved.",
    };
    const global = harness(); const globalVerb = harness(); expect(await global.run(["--help"])).toBe(0); expect(await globalVerb.run(["help"])).toBe(0); expect(global.stdout).toEqual([expectedGlobal]); expect(global.stderr).toEqual([]); expect(globalVerb.stdout).toEqual(global.stdout);
    for (const [command, help] of Object.entries(expected)) {
      const viaHelp = harness(); const viaFlag = harness();
      expect(await viaHelp.run(["help", command, "ignored", "--bad"])).toBe(0);
      expect(await viaFlag.run([command, "ordinary-invalid-token", "--help", "--bad"])).toBe(0);
      expect(viaHelp.stdout).toEqual([help]); expect(viaFlag.stdout).toEqual([help]); expect(viaHelp.stderr).toEqual([]); expect(viaFlag.stderr).toEqual([]);
    }
    expect(parseMcpAdministrationArgv(["add", "stdio-name", "--env", "KEY=value", "--", "node", "arg"])).toMatchObject({ kind: "mutation", action: { name: "stdio-name" } });
    expect(parseMcpAdministrationArgv(["add", "--transport", "http", "remote-name", "https://example.test", "--header", "X-Test: value"])).toMatchObject({ kind: "mutation", action: { name: "remote-name" } });
  });

  it("pins exclusive bounded add-json shapes and scope-less reset", async () => {
    expect(parseMcpAdministrationArgv(["add-json", "name", "{}", "--json-file", "x"])).toEqual({ ok: false, code: 2 });
    expect(parseMcpAdministrationArgv(["add-json", "name"])).toEqual({ ok: false, code: 2 });
    expect(parseMcpAdministrationArgv(["reset-project-choices", "--scope", "local"])).toEqual({ ok: false, code: 2 });
    const canaries = ["CANARY_COMMAND_VALUE", "CANARY_DEEP_OBJECT_KEY", "CANARY_DEEP_VALUE", "CANARY_ARRAY_VALUE", "CANARY_ARRAY_OBJECT_KEY", "CANARY_ARRAY_OBJECT_VALUE"];
    const nested = { command: canaries[0], CANARY_DEEP_OBJECT_KEY: { value: canaries[2], array: [canaries[3], { CANARY_ARRAY_OBJECT_KEY: canaries[5] }] } };
    const success = harness(); expect(await success.run(["add-json", "name", "--json-file", "-"], { readJsonInput: async () => ({ ok: true, value: nested }) })).toBe(0);
    expect(success.calls).toEqual([["execute", { kind: "add", scope: "local", name: "name", definition: nested }]]);
    expect(success.stdout).toEqual(["Declaration state: committed/not-visible; live activation=not-requested; health=not-probed"]); expect(success.stderr).toEqual([]);
    const failure = harness(); failure.execute.mockRejectedValue(new Error("CANARY_FAILURE_DETAIL")); expect(await failure.run(["add-json", "name", "--json-file", "-"], { readJsonInput: async () => ({ ok: true, value: nested }) })).toBe(1);
    expect(failure.stdout).toEqual([]); expect(failure.stderr).toEqual(["PiCC MCP: administration failed without exposing input details."]);
    const rendered = [...success.stdout, ...success.stderr, ...failure.stdout, ...failure.stderr].join("\n");
    for (const canary of [...canaries, "CANARY_FAILURE_DETAIL"]) expect(rendered).not.toContain(canary);
    const bad = harness(); expect(await bad.run(["add-json", "name", "--json-file", "-"] , { readJsonInput: async () => ({ ok: false, code: "input-too-large", message: "SECRET_NESTED" }) })).toBe(2); expect(bad.stdout).toEqual([]); expect(bad.stderr).toEqual(["PiCC MCP: JSON input is invalid, unreadable, or exceeds the 1 MiB UTF-8 limit."]); expect(bad.calls).toEqual([]);
  });
});

describe("standalone MCP administration semantics", () => {
  it("shows all unscoped collisions, effective winner, scoped reads, and stable health rows", async () => {
    const h = harness({ health: { same: "connected" } }); expect(await h.run(["get", "same"])).toBe(0); expect(h.stdout).toEqual(["MCP inventory: policy=active-rules; declarations=2; omitted=0\nsame: scope=local; precedence=winner; source=native-local; policy=allowed; review=not-required; status=enabled; health=connected; transport=stdio; capabilities=2/1/0\nsame: scope=user; precedence=shadowed; source=native-user; policy=allowed; review=not-required; status=shadowed; health=not-probed; transport=http; capabilities=0/0/0"]); expect(h.stderr).toEqual([transientProbeWarning]); const text = h.stdout[0]!;
    const auth = harness({ health: { same: "auth-needed" } }); expect(await auth.run(["get", "same", "-s", "local"])).toBe(0); expect(auth.stdout.join("\n")).toContain("health=auth-needed");
    const failed = harness({ health: { same: "failed" } }); expect(await failed.run(["get", "same", "-s", "local"])).toBe(0); expect(failed.stdout.join("\n")).toContain("health=failed");
    const scoped = harness(); expect(await scoped.run(["list", "-s", "project"])).toBe(0); expect(scoped.stdout.join("\n")).toContain("health=pending-review"); expect(scoped.stdout.join("\n")).toContain("health=rejected"); expect(scoped.stdout.join("\n")).not.toContain("scope=local");
    const missing = harness(); expect(await missing.run(["get", "missing"])).toBe(1); expect(missing.stdout).toEqual(["MCP inventory: policy=active-rules; declarations=0; omitted=0\nNo matching MCP servers."]); expect(missing.stderr).toEqual([transientProbeWarning]);
    const recoveryInventory: McpAdministrationInventory = { ...inventory, servers: [], remediation: "administration-recovery-pending", omittedDeclarationCount: 3 }; const blockedRead = harness({ inventory: recoveryInventory }); expect(await blockedRead.run(["list"])).toBe(0); expect(blockedRead.stdout).toEqual(["MCP inventory: policy=active-rules; declarations=0; omitted=3\nRecovery: reads cannot recover pending MCP administration state; open `/mcp manage` in an interactive TUI to attempt service-owned recovery, then retry this read.\nNo matching MCP servers."]); expect(blockedRead.stderr).toEqual([transientProbeWarning]);

    const ordered = harness();
    expect(await ordered.run(["list"], { services: async () => {
      expect(ordered.stderr).toEqual([transientProbeWarning]);
      return { ok: false as const, code: "fixture-unavailable", message: "fixture unavailable" };
    } })).toBe(1);
    expect(ordered.stderr).toEqual([transientProbeWarning, "PiCC MCP: administration unavailable (fixture-unavailable)."]);
  });

  it("executes noninteractive mutations directly and dry-run never executes", async () => {
    const direct = harness(); expect(await direct.run(["remove", "-s", "local", "name"])).toBe(0); expect(direct.calls).toEqual([["execute", { kind: "remove", scope: "local", name: "name" }]]); expect(direct.stdout).toEqual(["MCP result: action=remove; target=local name\nEligibility: eligible", "Durable: state=committed; effect=changed; cleanup=complete"]); expect(direct.stderr).toEqual([]);
    const dry = harness(); expect(await dry.run(["remove", "--dry-run", "-s", "user", "name"])).toBe(0); expect(dry.calls).toEqual([["preview", { kind: "remove", scope: "user", name: "name" }]]); expect(dry.stdout).toEqual(["MCP dry-run: action=remove; target=user name\nEligibility: eligible\nWrites: none (dry-run)"]); expect(dry.stderr).toEqual([]);
    const unscopedDry = harness(); expect(await unscopedDry.run(["remove", "--dry-run", "pending"])).toBe(0); expect(unscopedDry.inventoryCall).toHaveBeenCalledOnce(); expect(unscopedDry.prepareInventoryAfterRecovery).not.toHaveBeenCalled(); expect(unscopedDry.calls).toEqual([["preview", { kind: "remove", scope: "project", name: "pending" }]]);

    const blockedPreview = harness({ preview: { inventory, eligibility: { eligible: false, reasonCode: "recovery-pending" } } });
    expect(await blockedPreview.run(["remove", "--dry-run", "-s", "local", "name"])).toBe(1);
    expect(blockedPreview.stdout.at(-1)).toBe("Action: dry-run cannot recover pending MCP administration state; open `/mcp manage` in an interactive TUI to attempt service-owned recovery, then retry the original dry-run.");
    expect(blockedPreview.stdout.join("\n")).not.toContain("without --dry-run");
    const blockedDirect = harness({ execute: { inventory, eligibility: { eligible: false, reasonCode: "recovery-pending" }, recovery: { state: "pending-recovery", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } } });
    expect(await blockedDirect.run(["remove", "-s", "local", "name"])).toBe(1);
    expect(blockedDirect.stdout).toContain("Action: retry this administration command to continue safe rollback; no new writes are allowed until recovery completes.");
    expect(blockedDirect.stdout.join("\n")).not.toContain("dry-run cannot recover");
  });

  it("resolves unscoped removal through fresh service inventory and bounds ambiguity", async () => {
    const sole = harness(); expect(await sole.run(["remove", "pending"])).toBe(0); expect(sole.prepareInventoryAfterRecovery).toHaveBeenCalledOnce(); expect(sole.calls).toEqual([["execute", { kind: "remove", scope: "project", name: "pending" }]]);
    const ambiguous = harness(); expect(await ambiguous.run(["remove", "same"])).toBe(1); expect(ambiguous.calls).toEqual([]); expect(ambiguous.stderr.join("\n")).toContain("multiple mutable scopes");
    const missing = harness(); expect(await missing.run(["remove", "missing"])).toBe(1); expect(missing.calls).toEqual([]); expect(missing.stderr.join("\n")).toContain("no mutable server");
    const blocked = harness({ preparation: { inventory: { ...inventory, servers: [] }, eligibility: { eligible: false, reasonCode: "recovery-pending" }, recovery: { state: "pending-recovery", effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery" } } }); expect(await blocked.run(["remove", "missing"])).toBe(1); expect(blocked.stderr).toEqual([]); expect(blocked.stdout).toEqual(["Recovery: state=pending-recovery; effect=uncertain; cleanup=pending; reason=pending-recovery", "Action: retry this administration command to continue safe rollback; no new writes are allowed until recovery completes."]);
    const recovered = harness({ preparation: { inventory, eligibility: { eligible: true, reasonCode: "eligible" }, recovery: { state: "rolled-back", effect: "unchanged", cleanup: "complete", reasonCode: "no-op" } } }); expect(await recovered.run(["remove", "pending"])).toBe(0);
    expect(recovered.stdout).toEqual(["Recovery: state=rolled-back; effect=unchanged; cleanup=complete; reason=no-op", "MCP result: action=remove; target=project pending\nEligibility: eligible", "Durable: state=committed; effect=changed; cleanup=complete"]); expect(recovered.stderr).toEqual([]);
    expect(recovered.calls).toEqual([["execute", { kind: "remove", scope: "project", name: "pending" }]]);

    const omittedInventory = { ...inventory, omittedDeclarationCount: 2 };
    for (const args of [["remove", "pending"], ["remove", "--dry-run", "pending"]]) {
      const omitted = harness({ inventory: omittedInventory, preparation: { inventory: omittedInventory, eligibility: { eligible: true, reasonCode: "eligible" }, recovery: { state: "not-requested" } } });
      expect(await omitted.run(args)).toBe(1); expect(omitted.calls).toEqual([]);
      expect(omitted.stderr).toEqual(["PiCC MCP: unscoped remove requires a complete bounded inventory; declarations were omitted. Pass --scope local, project, or user."]);
    }
    const explicit = harness({ inventory: omittedInventory }); expect(await explicit.run(["remove", "--scope", "project", "pending"])).toBe(0);
    expect(explicit.calls).toEqual([["execute", { kind: "remove", scope: "project", name: "pending" }]]);
  });

  it("uses exit 2 for syntax, 1 for operational/recovery failure, and never reflects secrets", async () => {
    const syntax = harness(); expect(await syntax.run(["add", "name", "SECRET_COMMAND"])).toBe(2); expect(syntax.stderr.join("\n")).not.toContain("SECRET_COMMAND"); expect(syntax.writes).toEqual([]);
    const failed = harness({ execute: { inventory, eligibility: { eligible: false, reasonCode: "recovery-pending" }, recovery: { state: "pending-recovery", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: "SECRET_REASON" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } } });
    expect(await failed.run(["reset-project-choices"])).toBe(1); const text = failed.stdout.join("\n"); expect(text).toContain("reason=pending-recovery"); expect(text).not.toContain("SECRET_REASON");
  });

  it("recursively avoids definition, env, header, command, and URL values in plans and errors", async () => {
    const h = harness(); expect(await h.run(["add", "name", "-e", "TOKEN=ENV_SECRET", "--", "COMMAND_SECRET", "ARG_SECRET"])).toBe(0); const output = `${h.stdout.join("\n")}\n${h.stderr.join("\n")}`; for (const secret of ["ENV_SECRET", "COMMAND_SECRET", "ARG_SECRET"]) expect(output).not.toContain(secret);
    const remote = harness(); expect(await remote.run(["add", "-t", "http", "name", "https://URL_SECRET.example", "-H", "Authorization: HEADER_SECRET"])).toBe(0); expect(remote.stdout.join("\n")).not.toMatch(/HEADER_SECRET|URL_SECRET/u);
  });
});

describe("standalone MCP JSON input boundaries", () => {
  it("reads regular UTF-8 files through EOF and rejects malformed, non-object, non-file, oversized, and changed input", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-cli-json-"));
    try {
      const valid = path.join(root, "valid.json"); const padding = "x".repeat(1024 * 1024 - 8); fs.writeFileSync(valid, `{"x":"${padding}"}`); expect(fs.statSync(valid).size).toBe(1024 * 1024);
      await expect(readMcpJsonInput(valid)).resolves.toMatchObject({ ok: true, value: { x: padding } });
      for (const [name, bytes] of [["encoding", Buffer.from([0xff])], ["malformed", Buffer.from("{")], ["oversized", Buffer.alloc(1024 * 1024 + 1)] ] as const) { const file = path.join(root, name); fs.writeFileSync(file, bytes); await expect(readMcpJsonInput(file), name).resolves.toMatchObject({ ok: false }); }
      await expect(readMcpJsonInput(root)).resolves.toMatchObject({ ok: false });
      const changed = path.join(root, "changed.json"); fs.writeFileSync(changed, '{"before":true}');
      await expect(readMcpJsonInput(changed, undefined, () => fs.truncateSync(changed, 1))).resolves.toMatchObject({ ok: false, code: "input-read-failed" });
      fs.writeFileSync(changed, '{"before":true}'); await expect(readMcpJsonInput(changed, undefined, () => { const replacement = path.join(root, "replacement.json"); fs.writeFileSync(replacement, '{"after_":true}'); fs.renameSync(replacement, changed); })).resolves.toMatchObject({ ok: false, code: "input-read-failed" });
      const array = path.join(root, "array.json"); fs.writeFileSync(array, "[]"); const nonObject = harness(); expect(await nonObject.run(["add-json", "name", "--json-file", array], { readJsonInput: () => readMcpJsonInput(array) })).toBe(2); expect(nonObject.calls).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("bounds exact 1 MiB stdin and handles malformed, invalid UTF-8, oversize, and stream failures", async () => {
    const padding = "x".repeat(1024 * 1024 - 8); await expect(readMcpJsonInput("-", Readable.from([Buffer.from(`{"x":"${padding}"}`)]))).resolves.toMatchObject({ ok: true, value: { x: padding } });
    await expect(readMcpJsonInput("-", Readable.from([Buffer.from("{")]))).resolves.toMatchObject({ ok: false, code: "invalid-json-input" });
    await expect(readMcpJsonInput("-", Readable.from([Buffer.from([0xff])]))).resolves.toMatchObject({ ok: false, code: "invalid-json-input" });
    await expect(readMcpJsonInput("-", Readable.from([Buffer.from('{"command":'), Buffer.from('"run"}')]))).resolves.toEqual({ ok: true, value: { command: "run" } });
    await expect(readMcpJsonInput("-", Readable.from([Buffer.alloc(1024 * 1024), Buffer.from("x")]))).resolves.toMatchObject({ ok: false, code: "input-too-large" });
    const failed = new Readable({ read() { this.destroy(new Error("SECRET_STREAM_ERROR")); } });
    await expect(readMcpJsonInput("-", failed)).resolves.toEqual({ ok: false, code: "input-read-failed", message: "input read failed" });
  });
});

function productionProject(root: string, home: string): LoadedProject {
  return {
    root, userDir: path.join(home, ".claude"), settings: { env: { SETTINGS_ONLY: "settings-value", SHARED: "settings-value" } }, mcpStartupAuthority: { reviewInvalid: false, recoveryPending: false },
    mcp: { servers: [], diagnostics: [], policyPosture: "absent", administration: { version: 1, policyPosture: "absent", observations: [], omittedDeclarationCount: 0, declarations: [
      { name: "remote", source: "native-user", authority: { kind: "mutable", scope: "user" }, precedence: "winner", definitionVersion: 1, definitionDigest: `mcp-review-v1:${"a".repeat(64)}`, summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 1, timeoutConfigured: false }, policy: "allowed", review: "not-required", status: "enabled" },
    ] } },
  } as unknown as LoadedProject;
}

describe("standalone MCP production composition", () => {
  it("pins exact fresh-runtime lifecycle and deterministic operational failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-cli-production-")); const home = path.join(root, "home"); const project = path.join(root, "project"); fs.mkdirSync(home); fs.mkdirSync(project);
    const expectedEvents = {
      none: ["fresh-load", "start", "settle", "states", "shutdown", "inventory-complete"],
      settle: ["fresh-load", "start", "settle", "shutdown"],
      states: ["fresh-load", "start", "settle", "states", "shutdown"],
      shutdown: ["fresh-load", "start", "settle", "states", "shutdown"],
      start: ["fresh-load", "start"],
    } as const;
    try {
      for (const failure of ["none", "settle", "states", "shutdown", "start"] as const) {
        const events: string[] = []; const initial = productionProject(project, home); const fresh = productionProject(project, home); const runtimeEnv = {}; let loads = 0; let admittedConfig: LoadedProject["mcp"] | undefined;
        const loadProject = () => { loads += 1; if (loads === 1) return initial; events.push("fresh-load"); return fresh; };
        const shutdown = vi.fn(async () => { events.push("shutdown"); if (failure === "shutdown") throw new Error("CANARY_SHUTDOWN_FAILURE"); });
        const startRuntime = vi.fn((config: LoadedProject["mcp"], runtimeOptions: { env: NodeJS.ProcessEnv; settingsEnv: Record<string, string> }) => {
          admittedConfig = config; expect(runtimeOptions.env).toBe(runtimeEnv); expect(runtimeOptions.settingsEnv).toBe(fresh.settings.env); events.push("start"); if (failure === "start") throw new Error("CANARY_START_FAILURE");
          return { whenSettled: async () => { events.push("settle"); if (failure === "settle") throw new Error("CANARY_SETTLEMENT_FAILURE"); }, serverStates: () => { events.push("states"); if (failure === "states") throw new Error("CANARY_STATE_FAILURE"); return [{ name: "remote", transport: "http" as const, state: "failed" as const, statusSummary: "authentication", toolCount: 3, promptCount: 2, resourceCount: 1 }]; }, shutdown };
        });
        const handle = await createProductionMcpCliServices({ cwd: project, homeDir: home, env: runtimeEnv, health: true, loadProject, startRuntime });
        expect(handle.ok).toBe(true); if (!handle.ok) continue;
        const service = { ...handle.value.service, inventory: async () => { const result = await handle.value.service.inventory(); events.push("inventory-complete"); return result; } };
        const stdout: string[] = []; const stderr: string[] = [];
        const code = await runMcpAdministrationCli(["list"], { log: (line) => stdout.push(line), error: (line) => stderr.push(line) }, { services: async () => ({ ok: true, value: { service, health: handle.value.health } }) });
        expect(events).toEqual(expectedEvents[failure]); expect(admittedConfig).toBe(fresh.mcp); expect(admittedConfig).not.toBe(initial.mcp); expect(startRuntime).toHaveBeenCalledOnce();
        if (failure === "start") expect(shutdown).not.toHaveBeenCalled(); else expect(shutdown).toHaveBeenCalledOnce();
        if (failure === "none") {
          expect(code).toBe(0); expect(stdout).toEqual(["MCP inventory: policy=absent; declarations=1; omitted=0\nremote: scope=user; precedence=winner; source=native-user; policy=allowed; review=not-required; status=enabled; health=auth-needed; transport=http; capabilities=3/2/1\nAuthentication guidance: verify configured static headers; OAuth login is unavailable and deferred."]); expect(stderr).toEqual([transientProbeWarning]);
          expect(handle.value.health("remote")).toEqual({ state: "auth-needed", tools: 3, prompts: 2, resources: 1 });
        } else {
          expect(code).toBe(1); expect(stdout).toEqual([]); expect(stderr).toEqual([transientProbeWarning, "PiCC MCP: administration failed without exposing input details."]);
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps an authenticated create commit successful after a concurrent deletion and reports not-visible without live startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-cli-deleted-")); const home = path.join(root, "home"); const project = path.join(root, "project"); fs.mkdirSync(home); fs.mkdirSync(project);
    try {
      const startRuntime = vi.fn(); const absentProject = () => { const loaded = productionProject(project, home); return { ...loaded, mcp: { ...loaded.mcp, administration: { ...loaded.mcp.administration!, declarations: [] } } }; };
      const handle = await createProductionMcpCliServices({ cwd: project, homeDir: home, env: {}, health: false, startRuntime, loadProject: absentProject });
      expect(handle.ok).toBe(true); if (!handle.ok) return;
      const result = await handle.value.service.execute({ kind: "add", scope: "project", name: "added", definition: { command: "run" } });
      expect(result).toMatchObject({ inventory: { servers: [] }, eligibility: { eligible: true }, durable: { state: "committed", cleanup: "complete" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } });
      const identities = projectIdentities(project); const locations = createMcpLifecycleLocations({ homeDir: home, profilePath: path.join(home, ".claude"), platform: process.platform === "win32" ? "win32" : "posix", project: { checkoutFamilyPath: identities[0]!, activeCheckoutPath: identities.at(-1)! } });
      expect(locations.ok).toBe(true); if (!locations.ok || locations.value.checkoutFamilyKey === undefined) return;
      const expectedFingerprint = `sha256:${createHash("sha256").update(`${locations.value.profileKey}\0${locations.value.checkoutFamilyKey}`, "utf8").digest("hex")}`;
      const retainedText = fs.readdirSync(home, { recursive: true, encoding: "utf8" }).map((entry) => { const candidate = path.join(home, entry); try { return fs.statSync(candidate).isFile() ? fs.readFileSync(candidate, "utf8") : ""; } catch { return ""; } }).join("\n");
      expect(retainedText).toContain(expectedFingerprint);
      const stdout: string[] = []; const stderr: string[] = []; expect(await runMcpAdministrationCli(["add", "added", "--", "run"], { log: (line) => stdout.push(line), error: (line) => stderr.push(line) }, { services: async () => ({ ok: true, value: { service: { ...handle.value.service, execute: async () => result }, health: handle.value.health } }) })).toBe(0);
      expect(stdout).toEqual(["Declaration state: committed/not-visible; live activation=not-requested; health=not-probed"]); expect(stderr).toEqual([]); expect(startRuntime).not.toHaveBeenCalled();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("constructs no runtime for mutations and fails closed when freshly reloaded authority drifts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-cli-authority-")); const home = path.join(root, "home"); const project = path.join(root, "project"); const drift = path.join(root, "drift"); fs.mkdirSync(home); fs.mkdirSync(project); fs.mkdirSync(drift);
    try {
      const startRuntime = vi.fn(); const stable = await createProductionMcpCliServices({ cwd: project, homeDir: home, env: {}, health: false, loadProject: () => productionProject(project, home), startRuntime });
      expect(stable.ok).toBe(true); if (!stable.ok) return; await expect(stable.value.service.execute({ kind: "reset-project-choices" })).resolves.toMatchObject({ eligibility: { eligible: true }, durable: { state: "committed" } }); expect(startRuntime).not.toHaveBeenCalled();
      let loads = 0; const drifted = await createProductionMcpCliServices({ cwd: project, homeDir: home, env: {}, health: false, loadProject: () => productionProject(++loads >= 3 ? drift : project, home), startRuntime });
      expect(drifted.ok).toBe(true); if (!drifted.ok) return;
      await expect(drifted.value.service.execute({ kind: "add", scope: "project", name: "new", definition: { command: "run" } })).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "durable-mutation-failed" }, durable: { state: "rejected", reasonCode: "invalid-authority" } });
      expect(startRuntime).not.toHaveBeenCalled(); expect(fs.existsSync(path.join(project, ".mcp.json"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("standalone MCP rendering and recovery", () => {
  it("renders only the matching safe post-add declaration state for representative outcomes", async () => {
    const cases = [
      { precedence: "shadowed" as const, review: "not-required" as const, status: "shadowed" as const },
      { precedence: "winner" as const, review: "pending" as const, status: "pending-approval" as const },
      { precedence: "winner" as const, review: "not-required" as const, status: "disabled" as const },
    ];
    for (const row of cases) {
      const added = { ...inventory.servers[0]!, name: "added", authority: { kind: "mutable" as const, scope: "local" as const }, precedence: row.precedence, review: row.review, status: row.status };
      const resultInventory = { ...inventory, servers: [added] }; const h = harness({ inventory: resultInventory }); expect(await h.run(["add", "added", "--", "SECRET_COMMAND"])).toBe(0);
      expect(h.calls).toEqual([["execute", { kind: "add", scope: "local", name: "added", definition: { command: "SECRET_COMMAND", args: [] } }]]);
      const state = `Declaration state: name=added; scope=local; precedence=${row.precedence}; review=${row.review}; status=${row.status}; health=not-probed`; const expected = row.review === "pending" ? `${state}\nReview guidance: use interactive \`/mcp manage\`, or explicit trusted user/managed compatibility settings.` : state;
      expect(h.stdout).toEqual([expected]); expect(h.stderr).toEqual([]); expect(expected).not.toMatch(/SECRET_COMMAND|transport=|capabilities=|Durable:|MCP result:/u);
    }
  });

  it("reports completed recovery before successful add state", async () => {
    const result = { inventory, eligibility: { eligible: true, reasonCode: "eligible" }, recovery: { state: "rolled-back", effect: "unchanged", cleanup: "complete", reasonCode: "no-op" }, durable: persistence, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } };
    const h = harness({ execute: result }); expect(await h.run(["add", "added", "--", "SECRET_COMMAND"])).toBe(0);
    expect(h.stdout).toEqual(["Recovery: state=rolled-back; effect=unchanged; cleanup=complete; reason=no-op", "Declaration state: committed/not-visible; live activation=not-requested; health=not-probed"]);
    expect(h.stdout.join("\n")).not.toContain("SECRET_COMMAND");
  });

  it("renders exact fixed actionable remediation while retaining stable reason codes", async () => {
    const guidance: Record<string, string> = {
      "recovery-pending": "Action: retry this administration command to continue safe rollback; no new writes are allowed until recovery completes.",
      "invalid-authority": "Action: rerun from the intended project and selected Claude profile after any project/profile change.",
      "stale-state": "Action: reacquire current MCP state and retry the command.",
      busy: "Action: wait for the competing MCP administration operation to finish, then retry.",
      "cleanup-pending": "Action: retry the original direct administration command to continue cleanup before another MCP change.",
      "already-exists": "Action: choose a different server name or remove the exact-scope declaration before adding it again.",
      "server-not-found": "Action: list the bounded acquired inventory and retry with an exact visible server name.",
      "scope-mismatch": "Action: list the server's mutable scopes and retry with the matching --scope value.",
    };
    for (const [reasonCode, action] of Object.entries(guidance)) {
      const result = { inventory, eligibility: { eligible: false, reasonCode }, recovery: { state: "not-requested" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } }; const h = harness({ execute: result });
      expect(await h.run(["reset-project-choices"])).toBe(1); expect(h.stdout).toEqual([`MCP result: action=reset-project-choices; target=project-family review choices\nEligibility: refused:${reasonCode}`, action]); expect(h.stderr).toEqual([]);
    }

    const durableGuidance: Record<string, string> = {
      "already-exists": guidance["already-exists"]!,
      "invalid-authority": guidance["invalid-authority"]!,
      "invalid-input": "Action: correct the bounded server name or definition and retry.",
      "invalid-state": "Action: repair PiCC private MCP review state for the selected profile, then retry.",
      "ambiguous-project-state": "Action: consolidate canonical-equivalent project entries in the selected native `.claude.json`, then retry.",
      stale: "Action: reacquire current MCP state and retry the command.",
      busy: guidance.busy!,
      "storage-failure": "Action: verify writable storage and available space for both PiCC private transaction storage and PiCC private MCP review state for the selected profile, then retry.",
      "pending-recovery": guidance["recovery-pending"]!,
      "cleanup-pending": guidance["cleanup-pending"]!,
    };
    for (const [reasonCode, action] of Object.entries(durableGuidance)) {
      const result = { inventory, eligibility: { eligible: false, reasonCode: "durable-mutation-failed" }, recovery: { state: "not-requested" }, durable: { state: "rejected", retrySafe: true, effect: "unchanged", cleanup: reasonCode === "cleanup-pending" ? "pending" : "complete", reasonCode, reason: "SECRET_DURABLE_DETAIL" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } }; const h = harness({ execute: result });
      expect(await h.run(["reset-project-choices"])).toBe(1); expect(h.stdout[1]).toBe(action); expect(h.stdout[2]).toContain(`reason=${reasonCode}`); expect(h.stdout.join("\n")).not.toContain("SECRET_DURABLE_DETAIL");
    }

    const artifactCases = [
      { argv: ["add", "server", "--", "SECRET_COMMAND"], artifact: "the selected native `.claude.json`" },
      { argv: ["remove", "--scope", "user", "server"], artifact: "the selected native `.claude.json`" },
      { argv: ["remove", "--scope", "project", "server"], artifact: "the project `.mcp.json`" },
    ];
    for (const { argv, artifact } of artifactCases) {
      for (const [reasonCode, expected] of [
        ["invalid-state", `Action: repair ${artifact}, then retry.`],
        ["storage-failure", `Action: verify writable storage and available space for both PiCC private transaction storage and ${artifact}, then retry.`],
      ] as const) {
        const result = { inventory, eligibility: { eligible: false, reasonCode: "durable-mutation-failed" }, recovery: { state: "not-requested" }, durable: { state: "rejected", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode, reason: "SECRET_DURABLE_DETAIL" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } }; const h = harness({ execute: result });
        expect(await h.run(argv)).toBe(1); expect(h.stdout[1]).toBe(expected); expect(h.stdout[2]).toContain(`reason=${reasonCode}`);
        expect(h.stdout.join("\n")).not.toMatch(/SECRET_DURABLE_DETAIL|SECRET_COMMAND/u);
      }
    }
  });

  it("gives standalone action-aware remediation when durable rejection has no reason code", async () => {
    const result = { inventory, eligibility: { eligible: false, reasonCode: "durable-mutation-failed" }, recovery: { state: "not-requested" }, durable: { state: "rejected", retrySafe: false, effect: "unknown", cleanup: "pending", reason: "SECRET_REASON_WITHOUT_CODE" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } };
    const h = harness({ execute: result }); expect(await h.run(["add", "--scope", "project", "server", "--", "SECRET_COMMAND"])).toBe(1);
    expect(h.stdout).toEqual([
      "MCP result: action=add; target=project server\nEligibility: refused:durable-mutation-failed",
      "Action: inspect the project `.mcp.json` and PiCC private transaction storage, verify writable storage and available space for both, then retry the original direct administration command.",
      "Durable: state=rejected; effect=unknown; cleanup=pending",
    ]);
    expect(h.stdout.join("\n")).not.toMatch(/SECRET_REASON_WITHOUT_CODE|SECRET_COMMAND|safe durable reason below/u);
  });

  it("escapes broad names, keeps shadow counts unprobed, and gives deterministic review/auth guidance", async () => {
    const broad = "space name__safe"; const remoteInventory: McpAdministrationInventory = { ...inventory, servers: [
      { ...inventory.servers[0]!, name: broad, summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 1, timeoutConfigured: false } },
      { ...inventory.servers[1]!, name: broad, capabilityCounts: { tools: 9, prompts: 8, resources: 7 } },
      inventory.servers[2]!, inventory.servers[3]!,
    ] };
    const h = harness({ inventory: remoteInventory, health: { [broad]: "auth-needed" } }); expect(await h.run(["list"])).toBe(0); const text = h.stdout.join("\n");
    expect(text).toContain(`${JSON.stringify(broad)}:`); expect(text).toContain("health=not-probed"); expect(text).toContain("capabilities=9/8/7"); expect(text).toContain("use interactive `/mcp manage`"); expect(text).toContain("verify configured static headers"); expect(text).toContain("OAuth login is unavailable and deferred");
  });

  it("contains thrown service and composition details across inventory, preview, and execute recovery paths", async () => {
    for (const [argv, method] of [[['list'], 'inventoryCall'], [['add', 'name', '--', 'run'], 'execute'], [['remove', '-s', 'local', 'same'], 'execute']] as const) {
      const h = harness(); h[method].mockRejectedValue(new Error("SECRET_THROWN_DETAIL"));
      expect(await h.run([...argv])).toBe(1);
      expect(`${h.stdout.join("\n")}\n${h.stderr.join("\n")}`).not.toContain("SECRET_THROWN_DETAIL");
    }
    const unavailable = harness(); expect(await unavailable.run(["list"], { services: async () => { throw new Error("SECRET_COMPOSITION"); } })).toBe(1); expect(unavailable.stderr.join("\n")).not.toContain("SECRET_COMPOSITION");
  });
});
