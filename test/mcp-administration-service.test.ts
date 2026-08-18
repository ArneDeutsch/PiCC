import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedMcpConfig } from "../src/types.js";
import { createMcpLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import type { McpAdministrationDeclaration, McpAdministrationLiveState } from "../src/mcp-administration/model.js";
import { createMcpAdministrationService, openMcpAdministrationRuntimeAdmission, openMcpAdministrationRuntimeTransition, type McpAdministrationFreshState, type McpAdministrationLiveRequest, type McpAdministrationLiveResult } from "../src/mcp-administration/service.js";
import { bindMcpDeclarationDefinition, persistMcpMutation, type McpPersistenceResult } from "../src/mcp-administration/persistence.js";

const committed = (effect: "changed" | "unchanged" = "changed"): McpPersistenceResult => ({ state: "committed", effect, cleanup: "complete", retrySafe: effect === "unchanged" });
const rolledBack: McpPersistenceResult = { state: "rolled-back", operationId: "op", effect: "unchanged", cleanup: "complete", retrySafe: true };
const pending: McpPersistenceResult = { state: "pending-recovery", operationId: "op", effect: "uncertain", cleanup: "pending", retrySafe: false, reasonCode: "pending-recovery" };
const CONTROL_DIGEST_B_FOR_SERVICE = `mcp-review-v1:${"b".repeat(64)}`;

function declaration(overrides: Partial<McpAdministrationDeclaration> & Pick<McpAdministrationDeclaration, "name" | "source">): McpAdministrationDeclaration {
  const { name, source, ...rest } = overrides;
  return {
    name,
    source,
    authority: overrides.authority ?? { kind: "read-only", sourceClass: source },
    precedence: overrides.precedence ?? "winner",
    definitionVersion: 1,
    definitionDigest: `mcp-review-v1:${"a".repeat(64)}`,
    summary: overrides.summary ?? { transport: "stdio", commandBasename: "run", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false },
    policy: overrides.policy ?? "allowed",
    review: overrides.review ?? "not-required",
    status: overrides.status ?? "enabled",
    ...rest,
  };
}

function boundDeclaration(name: string, source: McpAdministrationDeclaration["source"], definition: Readonly<Record<string, unknown>>, overrides: Partial<McpAdministrationDeclaration> = {}): McpAdministrationDeclaration {
  const binding = bindMcpDeclarationDefinition(name, definition);
  if (!binding.ok) throw new Error(binding.message);
  return declaration({ name, source, definitionVersion: binding.value.definitionVersion, definitionDigest: binding.value.definitionDigest, ...overrides });
}

function admissionBinding(server: McpAdministrationDeclaration) {
  return {
    admittedName: server.name,
    admittedSource: server.source,
    ...(server.agentOwner === undefined ? {} : { admittedAgentOwner: server.agentOwner }),
    admittedDefinitionVersion: server.definitionVersion,
    admittedDefinitionDigest: server.definitionDigest,
    admittedPolicy: "allowed",
    admittedStatus: "enabled",
    admittedProfileKey: "profile-test",
    admittedCheckoutFamilyKey: "checkout-test",
  };
}

function fresh(declarations: readonly McpAdministrationDeclaration[], liveStates: readonly McpAdministrationLiveState[] = []): McpAdministrationFreshState {
  const servers: ResolvedMcpConfig["servers"] = [];
  for (const item of declarations) {
    if (item.precedence !== "winner" || item.status !== "enabled" || item.agentOwner !== undefined || item.source === "subagent-inline") continue;
    if (item.summary.transport === "http" || item.summary.transport === "sse") servers.push({
      name: item.name, source: item.source, status: "enabled", transport: item.summary.transport,
      configuredType: item.summary.transport, url: "https://example.test/mcp", headers: {}, diagnostics: [],
    });
    else servers.push({
      name: item.name, source: item.source, status: "enabled", transport: "stdio",
      command: "node", args: [], env: {}, rawCommand: "node", diagnostics: [],
    });
  }
  return {
    reviewIdentity: { profileKey: "profile-test", checkoutFamilyKey: "checkout-test" },
    mcp: {
      servers, diagnostics: [], policyPosture: "absent",
      administration: { version: 1, policyPosture: "absent", observations: [], declarations, omittedDeclarationCount: 0 },
    } as ResolvedMcpConfig,
    liveStates,
  };
}

function expectedInventory(declarations: readonly McpAdministrationDeclaration[]) {
  return {
    version: 1,
    policyPosture: "absent",
    observations: [],
    servers: declarations.map(({ definitionVersion: _definitionVersion, definitionDigest: _definitionDigest, ...server }) => ({
      ...server,
      live: "not-running",
      capabilityCounts: { tools: 0, prompts: 0, resources: 0 },
    })),
    omittedDeclarationCount: 0,
  } as const;
}

function harness(states: McpAdministrationFreshState[], options: { pending?: boolean; pendingSequence?: readonly boolean[]; recovery?: McpPersistenceResult; mutation?: McpPersistenceResult; live?: McpAdministrationLiveResult } = {}) {
  let index = 0; let pendingIndex = 0; let pendingNow = options.pending ?? false;
  const calls: string[] = [];
  const mutate = vi.fn(async () => { calls.push("mutate"); return options.mutation ?? committed(); });
  const recover = vi.fn(async () => { calls.push("recover"); const result = options.recovery ?? rolledBack; if (result.state === "rolled-back" && result.cleanup === "complete" || result.state === "committed" && result.effect === "unchanged" && result.cleanup === "complete") pendingNow = false; return result; });
  const assemble = vi.fn(() => { calls.push("assemble"); return states[Math.min(index++, states.length - 1)]!; });
  const apply = vi.fn(async (_request: McpAdministrationLiveRequest) => { calls.push("live"); return options.live ?? { runtime: { state: "succeeded" as const }, exposure: { state: "succeeded" as const } }; });
  const inspectPending = vi.fn(async () => {
    const sequenced = options.pendingSequence?.[Math.min(pendingIndex++, options.pendingSequence.length - 1)];
    const current = sequenced ?? pendingNow;
    return { pending: current, status: current ? "pending" as const : "clear" as const };
  });
  const service = createMcpAdministrationService({
    inspectPending,
    recover,
    mutate,
    assemble,
    live: { apply },
  });
  return { service, calls, mutate, recover, assemble, apply, inspectPending };
}

describe("MCP administration eligibility", () => {
  const cases = [
    { label: "approves pending project .mcp.json", server: declaration({ name: "s", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" }), action: { kind: "approve", name: "s" } as const, eligible: true, reasonCode: "eligible" },
    { label: "rejects native approval", server: declaration({ name: "s", source: "native-user", authority: { kind: "mutable", scope: "user" } }), action: { kind: "approve", name: "s" } as const, eligible: false, reasonCode: "review-not-applicable" },
    { label: "rejects managed approval", server: declaration({ name: "s", source: "managed-mcp" }), action: { kind: "reject", name: "s" } as const, eligible: false, reasonCode: "review-not-applicable" },
    { label: "blocks policy denial", server: declaration({ name: "s", source: "project-mcpjson", policy: "policy-denied", status: "blocked" }), action: { kind: "approve", name: "s" } as const, eligible: false, reasonCode: "policy-blocked" },
    { label: "disables effective native local", server: declaration({ name: "s", source: "native-local" }), action: { kind: "disable", name: "s" } as const, eligible: true, reasonCode: "eligible" },
    { label: "does not disable settings", server: declaration({ name: "s", source: "settings-user" }), action: { kind: "disable", name: "s" } as const, eligible: false, reasonCode: "unsupported-source" },
    { label: "enables only runtime-disabled", server: declaration({ name: "s", source: "native-user", status: "disabled", inactiveReason: "native-runtime-disabled" }), action: { kind: "enable", name: "s" } as const, eligible: true, reasonCode: "eligible" },
    { label: "does not enable an already enabled server", server: declaration({ name: "s", source: "native-user" }), action: { kind: "enable", name: "s" } as const, eligible: false, reasonCode: "not-disabled" },
    { label: "rejects a shadow-only target", server: declaration({ name: "s", source: "native-user", precedence: "shadowed", status: "shadowed" }), action: { kind: "disable", name: "s" } as const, eligible: false, reasonCode: "server-not-found" },
  ];
  for (const row of cases) it(row.label, async () => {
    const h = harness([fresh([row.server])]);
    await expect(h.service.preview(row.action)).resolves.toMatchObject({ eligibility: { eligible: row.eligible, reasonCode: row.reasonCode } });
  });

  it("requires an exact mutable scope for removal while add may create that exact scope", async () => {
    const shadow = declaration({ name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" }, precedence: "shadowed", status: "shadowed" });
    const h = harness([fresh([shadow])]);
    await expect(h.service.preview({ kind: "remove", scope: "project", name: "same" })).resolves.toMatchObject({ eligibility: { reasonCode: "scope-mismatch" } });
    await expect(h.service.preview({ kind: "remove", scope: "user", name: "same" })).resolves.toMatchObject({ eligibility: { eligible: true } });
    await expect(h.service.preview({ kind: "add", scope: "project", name: "same", definition: { command: "new" } })).resolves.toMatchObject({ eligibility: { eligible: true } });
    await expect(h.service.preview({ kind: "add", scope: "user", name: "same", definition: { command: "new" } })).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "already-exists" } });
    const executed = await h.service.execute({ kind: "add", scope: "user", name: "same", definition: { command: "new" } });
    expect(executed).toMatchObject({ eligibility: { eligible: false, reasonCode: "already-exists" }, durable: { state: "not-requested" } }); expect(h.mutate).not.toHaveBeenCalled();
  });

  it("rejects Claude built-in names only for add while retaining externally acquired administration", async () => {
    const names = ["workspace", "claude-in-chrome", "computer-use", "Claude Preview", "Claude Browser"];
    for (const name of names) {
      const external = declaration({ name, source: "native-user", authority: { kind: "mutable", scope: "user" } }); const h = harness([fresh([external])]);
      await expect(h.service.preview({ kind: "add", scope: "project", name, definition: { command: "run" } }), name).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "invalid-input" } });
      await expect(h.service.preview({ kind: "remove", scope: "user", name }), name).resolves.toMatchObject({ eligibility: { eligible: true } });
    }
  });

  it("table-drives every acquired source across review, toggle, reconnect, and authentication policy", async () => {
    const sources = ["native-local", "project-mcpjson", "native-user", "settings-managed", "settings-local", "settings-project", "settings-user", "managed-mcp", "subagent-inline"] as const;
    for (const source of sources) {
      const agentOwner = source === "subagent-inline" ? { name: "worker", scope: "project" as const } : undefined;
      const authority = source === "native-local" ? { kind: "mutable" as const, scope: "local" as const }
        : source === "project-mcpjson" ? { kind: "mutable" as const, scope: "project" as const }
          : source === "native-user" ? { kind: "mutable" as const, scope: "user" as const }
            : { kind: "read-only" as const, sourceClass: source };
      const server = declaration({ name: source, source, agentOwner, authority, review: source === "project-mcpjson" || source === "settings-project" || source === "subagent-inline" ? "approved-exact" : "not-required" });
      const failed = [{ name: source, ...(agentOwner === undefined ? {} : { agentOwner }), state: "failed" as const }];
      const h = harness([fresh([server], failed), fresh([server], failed), fresh([server], failed), fresh([server], failed), fresh([server], failed)]);
      const target = { name: source, ...(agentOwner === undefined ? {} : { agentOwner }) };
      const review = await h.service.preview({ kind: "approve", ...target });
      const reviewEligible = source === "project-mcpjson" || source === "settings-project" || source === "subagent-inline";
      expect(review.eligibility, `${source} review`).toEqual(reviewEligible ? { eligible: true, reasonCode: "eligible" } : { eligible: false, reasonCode: "review-not-applicable" });
      const toggle = await h.service.preview({ kind: "disable", ...target });
      const toggleEligible = source === "native-local" || source === "project-mcpjson" || source === "native-user";
      expect(toggle.eligibility, `${source} toggle`).toEqual(toggleEligible ? { eligible: true, reasonCode: "eligible" } : { eligible: false, reasonCode: "unsupported-source" });
      await expect(h.service.preview({ kind: "reconnect", ...target }), `${source} reconnect`).resolves.toMatchObject({ eligibility: source === "subagent-inline"
        ? { eligible: false, reasonCode: "unsupported-source" }
        : { eligible: true, reasonCode: "eligible" } });
      const remote = { ...server, summary: { transport: "http" as const, remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } };
      const auth = harness([fresh([remote])]);
      await expect(auth.service.preview({ kind: "authenticate", ...target }), `${source} authentication`).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "authentication-deferred" } });
    }
  });

  it("table-drives status and live-state gates with fixed reason codes", async () => {
    const rows = [
      { server: declaration({ name: "s", source: "project-mcpjson", status: "blocked", policy: "policy-denied" }), action: { kind: "approve", name: "s" } as const, reason: "policy-blocked" },
      { server: declaration({ name: "s", source: "project-mcpjson", status: "skipped", review: "pending" }), action: { kind: "approve", name: "s" } as const, reason: "not-effective" },
      { server: declaration({ name: "s", source: "native-local", status: "disabled", inactiveReason: "native-runtime-disabled" }), action: { kind: "disable", name: "s" } as const, reason: "not-enabled" },
      { server: declaration({ name: "s", source: "native-local", status: "enabled" }), action: { kind: "enable", name: "s" } as const, reason: "not-disabled" },
      { server: declaration({ name: "s", source: "native-user", status: "enabled" }), action: { kind: "reconnect", name: "s" } as const, reason: "not-failed", live: [{ name: "s", state: "connected" as const }] },
      { server: declaration({ name: "s", source: "native-user", status: "disabled" }), action: { kind: "reconnect", name: "s" } as const, reason: "not-effective", live: [{ name: "s", state: "failed" as const }] },
      { server: declaration({ name: "s", source: "native-user", status: "enabled", summary: { argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } }), action: { kind: "reconnect", name: "s" } as const, reason: "unsupported-transport", live: [{ name: "s", state: "failed" as const }] },
    ];
    for (const row of rows) {
      const h = harness([fresh([row.server], row.live)]);
      await expect(h.service.preview(row.action)).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: row.reason } });
    }
  });

  it("preserves broad compatibility labels unchanged", async () => {
    const h = harness([fresh([declaration({ name: "broad", source: "project-mcpjson", review: "approved-broad-name" })])]);
    await expect(h.service.preview({ kind: "disable", name: "broad" })).resolves.toMatchObject({ inventory: { servers: [{ review: "approved-broad-name" }] } });
  });

  it("returns fixed action reasons for missing targets and owners", async () => {
    const ordinary = declaration({ name: "ordinary", source: "native-user" });
    const h = harness([fresh([ordinary]), fresh([ordinary]), fresh([ordinary]), fresh([ordinary]), fresh([ordinary]), fresh([ordinary])]);
    for (const action of [
      { kind: "remove", scope: "user", name: "missing" },
      { kind: "approve", name: "missing" },
      { kind: "reject", name: "missing" },
      { kind: "enable", name: "missing" },
      { kind: "disable", name: "missing" },
      { kind: "reconnect", name: "ordinary", agentOwner: { name: "missing-owner", scope: "project" } },
    ] as const) await expect(h.service.preview(action)).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: action.kind === "reconnect" ? "unsupported-source" : "server-not-found" } });
  });

  it("returns fixed duplicate eligibility and preserves state when create loses a persistence race", async () => {
    const bytes = Buffer.from('{"mcpServers":{"neighbor":{"command":"keep"}}}\n'); const before = Buffer.from(bytes);
    const raced: McpPersistenceResult = { state: "stale", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "stale" };
    const h = harness([fresh([]), fresh([])], { mutation: raced });
    await expect(h.service.execute({ kind: "add", scope: "project", name: "raced", definition: { command: "run" } })).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "durable-mutation-failed" }, durable: { state: "stale", effect: "unchanged" } });
    expect(bytes).toEqual(before); expect(h.apply).not.toHaveBeenCalled();
  });

  it("validates add previews through the persistence-owned descriptor-safe validator", async () => {
    const getter = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(getter, "command", { enumerable: true, get() { throw new Error("must stay inert"); } });
    for (const action of [
      { kind: "add", scope: "user", name: "bad\u0000name", definition: { command: "run" } },
      { kind: "add", scope: "user", name: "safe", definition: getter },
      { kind: "add", scope: "project", name: "safe", definition: { unknown: true } },
    ] as const) {
      const h = harness([fresh([])]);
      await expect(h.service.preview(action)).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode: "invalid-input" } });
      expect(h.mutate).not.toHaveBeenCalled();
    }
  });

  it("table-drives every review posture and exact private identity requirement", async () => {
    const rows = [
      ["pending", true, "eligible"],
      ["approved-exact", true, "eligible"],
      ["rejected-exact", true, "eligible"],
      ["approved-broad-name", true, "eligible"],
      ["approved-broad-all", true, "eligible"],
      ["rejected-compatibility", false, "compatibility-rejected"],
      ["not-required", false, "review-not-applicable"],
    ] as const;
    for (const [review, allowed, reasonCode] of rows) {
      const server = declaration({ name: review, source: "project-mcpjson", review, status: review.startsWith("rejected") ? "disabled" : review === "pending" ? "pending-approval" : "enabled" });
      const h = harness([fresh([server])]);
      await expect(h.service.preview({ kind: "reject", name: review }), review).resolves.toMatchObject({ eligibility: { eligible: allowed, reasonCode } });
    }
    const missing = declaration({ name: "missing", source: "settings-project", definitionVersion: undefined, definitionDigest: undefined, review: "pending", status: "pending-approval" });
    const h = harness([fresh([missing])]);
    await expect(h.service.preview({ kind: "approve", name: "missing" })).resolves.toMatchObject({ eligibility: { reasonCode: "definition-unavailable" } });
    const userOwner = { name: "user-agent", scope: "user" as const };
    const userAgent = declaration({ name: "inline", source: "subagent-inline", agentOwner: userOwner, review: "not-required" });
    await expect(harness([fresh([userAgent])]).service.preview({ kind: "approve", name: "inline", agentOwner: userOwner })).resolves.toMatchObject({ eligibility: { reasonCode: "review-not-applicable" } });
  });
});

describe("MCP administration orchestration", () => {
  it("prepares fresh inventory through recovery only and recovers before mutation/live work", async () => {
    const preparedServer = declaration({ name: "prepared", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const preparation = harness([fresh([preparedServer])], { pending: true });
    await expect(preparation.service.prepareInventoryAfterRecovery()).resolves.toMatchObject({ eligibility: { eligible: true }, recovery: { state: "rolled-back" }, inventory: { servers: [expect.objectContaining({ name: "prepared" })] } });
    expect(preparation.calls).toEqual(["recover", "assemble"]); expect(preparation.mutate).not.toHaveBeenCalled();

    const stillPending = harness([fresh([])], { pending: true, recovery: pending });
    await expect(stillPending.service.prepareInventoryAfterRecovery()).resolves.toMatchObject({ eligibility: { reasonCode: "recovery-pending" }, inventory: { servers: [] } }); expect(stillPending.assemble).not.toHaveBeenCalled();

  });

  it("recovers before assembly, mutation, fresh assembly, and composite live work", async () => {
    const server = declaration({ name: "s", source: "native-local", authority: { kind: "mutable", scope: "local" } });
    const h = harness([fresh([server]), fresh([{ ...server, status: "disabled", inactiveReason: "native-runtime-disabled" }])], { pending: true });
    const result = await h.service.execute({ kind: "disable", name: "s" });
    expect(h.calls).toEqual(["recover", "assemble", "mutate", "assemble", "live"]);
    expect(result).toMatchObject({ recovery: { state: "rolled-back" }, durable: { state: "committed" }, runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
  });

  it("stops before assembly, mutation, and live work while recovery remains pending", async () => {
    const h = harness([fresh([])], { pending: true, recovery: pending });
    const result = await h.service.execute({ kind: "reset-project-choices" });
    expect(h.calls).toEqual(["recover"]);
    expect(result).toMatchObject({ eligibility: { reasonCode: "recovery-pending" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" } });
  });

  it("stops on terminal recovery with pending cleanup", async () => {
    const cleanupPending: McpPersistenceResult = { state: "rolled-back", operationId: "op", effect: "unchanged", cleanup: "pending", retrySafe: true, reasonCode: "cleanup-pending" };
    const h = harness([fresh([])], { pending: true, recovery: cleanupPending });
    await expect(h.service.execute({ kind: "reset-project-choices" })).resolves.toMatchObject({ eligibility: { reasonCode: "cleanup-pending" }, durable: { state: "not-requested" } });
    expect(h.assemble).not.toHaveBeenCalled();
  });

  it("does not inspect inventory for a passive preview while recovery is pending", async () => {
    const h = harness([fresh([])], { pending: true });
    const result = await h.service.preview({ kind: "reset-project-choices" });
    expect(h.assemble).not.toHaveBeenCalled();
    expect(result).toMatchObject({ eligibility: { reasonCode: "recovery-pending" }, inventory: { policyPosture: "fail-closed", servers: [] } });
  });

  it("maps add, remove, disable, and enable to exact persistence mutations", async () => {
    const native = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const disabled = { ...native, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
    const rows = [
      { action: { kind: "add", scope: "user", name: "added", definition: { command: "run" } } as const, before: fresh([]), after: fresh([boundDeclaration("added", "native-user", { command: "run" }, { authority: { kind: "mutable", scope: "user" } })]), mutation: { kind: "set-declaration", scope: "user", name: "added", definition: { command: "run" } } },
      { action: { kind: "remove", scope: "user", name: "native" } as const, before: fresh([native]), after: fresh([]), mutation: { kind: "remove-declaration", scope: "user", name: "native" } },
      { action: { kind: "disable", name: "native" } as const, before: fresh([native]), after: fresh([disabled]), mutation: { kind: "set-runtime-disabled", name: "native", disabled: true } },
      { action: { kind: "enable", name: "native" } as const, before: fresh([disabled]), after: fresh([native]), mutation: { kind: "set-runtime-disabled", name: "native", disabled: false } },
    ];
    for (const row of rows) {
      const h = harness([row.before, row.after]);
      await h.service.execute(row.action);
      expect(h.mutate).toHaveBeenCalledWith(row.mutation);
      expect(h.apply.mock.calls[0]![0].action).toEqual(row.action.kind === "add" ? { kind: "add", scope: row.action.scope, name: row.action.name } : row.action);
    }
  });

  it("proves symmetric review actions across project sources with exact mutations and live descriptors", async () => {
    const sources = ["project-mcpjson", "settings-project", "subagent-inline"] as const;
    for (const source of sources) {
      const owner = source === "subagent-inline" ? { name: "worker", scope: "project" as const } : undefined;
      const authority = source === "project-mcpjson" ? { kind: "mutable" as const, scope: "project" as const } : { kind: "read-only" as const, sourceClass: source };
      const beforeServer = declaration({ name: source, source, agentOwner: owner, authority, review: "pending", status: "pending-approval" });
      for (const kind of ["approve", "reject"] as const) {
        const afterServer = { ...beforeServer, review: kind === "approve" ? "approved-exact" as const : "rejected-exact" as const, status: kind === "approve" ? "enabled" as const : "disabled" as const };
        const h = harness([fresh([beforeServer]), fresh([afterServer])]);
        const action = { kind, name: source, ...(owner === undefined ? {} : { agentOwner: owner }) } as const;
        const result = await h.service.execute(action);
        expect(result.eligibility, `${source} ${kind}`).toEqual({ eligible: true, reasonCode: "eligible" });
        const ordinaryActivation = kind === "approve" && owner === undefined;
        const ownerScopeRebuild = owner !== undefined;
        const liveExpected = ordinaryActivation || ownerScopeRebuild;
        expect(result).toMatchObject({ recovery: { state: "not-requested" }, durable: { state: "committed", effect: "changed", cleanup: "complete" }, runtime: { state: liveExpected ? "succeeded" : "not-requested" }, exposure: { state: liveExpected ? "succeeded" : "not-requested" } });
        expect(h.mutate).toHaveBeenCalledWith({ kind: "set-review", record: { profileKey: "profile-test", checkoutFamilyKey: "checkout-test", source, serverName: source, ...(owner === undefined ? {} : { agentOwner: owner }), definitionVersion: 1, definitionDigest: beforeServer.definitionDigest, decision: kind === "approve" ? "approved" : "rejected" } });
        if (!liveExpected) {
          expect(h.apply).not.toHaveBeenCalled();
          continue;
        }
        const request = h.apply.mock.calls[0]![0];
        if (ownerScopeRebuild) {
          expect(request.action).toEqual({ kind, name: source, agentOwner: owner });
          expect(request.transitions).toEqual([]);
          expect(request.runtimeAdmission).toBeUndefined();
          continue;
        }
        expect(request.action).toEqual(action);
        expect(request.runtimeAdmission === undefined ? undefined : openMcpAdministrationRuntimeAdmission(request.runtimeAdmission)?.binding).toEqual(kind === "approve" ? admissionBinding(afterServer) : undefined);
      }
    }
  });

  it("proves symmetric runtime toggles across mutable sources with exact mutations and live descriptors", async () => {
    const sources = [
      ["native-local", "local"],
      ["project-mcpjson", "project"],
      ["native-user", "user"],
    ] as const;
    for (const [source, scope] of sources) {
      const enabled = declaration({ name: source, source, authority: { kind: "mutable", scope }, review: source === "project-mcpjson" ? "approved-exact" : "not-required" });
      const disabled = { ...enabled, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
      for (const kind of ["disable", "enable"] as const) {
        const beforeServer = kind === "disable" ? enabled : disabled;
        const afterServer = kind === "disable" ? disabled : enabled;
        const h = harness([fresh([beforeServer]), fresh([afterServer])]);
        const action = { kind, name: source } as const;
        const result = await h.service.execute(action);
        expect(result.eligibility, `${source} ${kind}`).toEqual({ eligible: true, reasonCode: "eligible" });
        expect(result).toMatchObject({ recovery: { state: "not-requested" }, durable: { state: "committed", effect: "changed", cleanup: "complete" }, runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
        expect(h.mutate).toHaveBeenCalledWith({ kind: "set-runtime-disabled", name: source, disabled: kind === "disable" });
        const request = h.apply.mock.calls[0]![0];
        expect(request.action).toEqual(action);
        expect(request.runtimeAdmission === undefined ? undefined : openMcpAdministrationRuntimeAdmission(request.runtimeAdmission)?.binding).toEqual(kind === "enable" ? admissionBinding(afterServer) : undefined);
      }
    }
  });

  it("maps exact-definition approval to private review persistence and assembles again", async () => {
    const server = declaration({ name: "project", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" });
    const h = harness([fresh([server]), fresh([{ ...server, review: "approved-exact", status: "enabled" }])]);
    const result = await h.service.execute({ kind: "approve", name: "project" });
    expect(h.mutate).toHaveBeenCalledWith({ kind: "set-review", record: expect.objectContaining({ profileKey: "profile-test", checkoutFamilyKey: "checkout-test", source: "project-mcpjson", serverName: "project", decision: "approved", definitionDigest: server.definitionDigest }) });
    expect(result.inventory.servers[0]).toMatchObject({ review: "approved-exact", status: "enabled" });
  });

  it("resets family review choices and asks live composition to retire newly pending servers", async () => {
    const approved = declaration({ name: "project", source: "project-mcpjson", review: "approved-exact", status: "enabled" });
    const awaiting = { ...approved, review: "pending" as const, status: "pending-approval" as const };
    const h = harness([fresh([approved]), fresh([awaiting])]);
    const result = await h.service.execute({ kind: "reset-project-choices" });
    expect(h.mutate).toHaveBeenCalledWith({ kind: "reset-review" });
    const request = h.apply.mock.calls[0]![0];
    expect(request.action).toEqual({ kind: "reset-project-choices" });
    expect(request.runtimeAdmission).toBeUndefined();
    expect(request.transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([{ kind: "retire", serverName: "project" }]);
    expect(result).toMatchObject({ durable: { state: "committed", effect: "changed" }, runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
  });

  it("treats a rejected choice that becomes freshly approved during reset as stale and retires only prior approved routes", async () => {
    const approved = declaration({ name: "approved", source: "project-mcpjson", review: "approved-exact", status: "enabled" });
    const rejected = declaration({ name: "rejected", source: "settings-project", review: "rejected-exact", status: "disabled" });
    const h = harness([fresh([approved, rejected]), fresh([
      { ...approved, review: "pending", status: "pending-approval" },
      { ...rejected, review: "approved-exact", status: "enabled" },
    ])]);

    await expect(h.service.execute({ kind: "reset-project-choices" })).resolves.toMatchObject({
      eligibility: { eligible: false, reasonCode: "stale-state" },
      durable: { state: "committed", effect: "changed" },
      runtime: { state: "succeeded" }, exposure: { state: "succeeded" },
    });
    const transitions = h.apply.mock.calls[0]![0].transitions.map(openMcpAdministrationRuntimeTransition);
    expect(transitions).toEqual([{ kind: "retire", serverName: "approved" }]);
    expect(transitions).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: expect.stringMatching(/activate|replace/u) })]));
  });

  it("derives only exact ownerless effective-winner transitions for shadow removal, reveal, reset, and agent review", async () => {
    const high = declaration({ name: "same", source: "native-local", authority: { kind: "mutable", scope: "local" }, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE });
    const lowShadow = declaration({ name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" }, precedence: "shadowed", status: "shadowed" });

    const shadowRemoval = harness([fresh([high, lowShadow]), fresh([high])]);
    await expect(shadowRemoval.service.execute({ kind: "remove", scope: "user", name: "same" })).resolves.toMatchObject({ runtime: { state: "not-requested" }, exposure: { state: "not-requested" } });
    expect(shadowRemoval.apply).not.toHaveBeenCalled();

    const lowWinner = { ...lowShadow, precedence: "winner" as const, status: "enabled" as const };
    const reveal = harness([fresh([high, lowShadow]), fresh([lowWinner])]);
    await reveal.service.execute({ kind: "remove", scope: "local", name: "same" });
    const revealed = reveal.apply.mock.calls[0]![0].transitions.map(openMcpAdministrationRuntimeTransition);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]).toMatchObject({ kind: "replace", serverName: "same" });
    if (revealed[0]?.kind !== "replace") throw new Error("replacement transition not minted");
    expect(openMcpAdministrationRuntimeAdmission(revealed[0].admission)).toEqual({
      server: expect.objectContaining({ name: "same", source: "native-user", status: "enabled" }),
      binding: admissionBinding(lowWinner),
    });

    const first = declaration({ name: "first", source: "project-mcpjson", review: "approved-exact" });
    const second = declaration({ name: "second", source: "settings-project", review: "approved-exact", definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE });
    const unrelatedResetBefore = declaration({ name: "unrelated-reset", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const unrelatedResetAfter = declaration({ name: "unrelated-reset", source: "native-local", authority: { kind: "mutable", scope: "local" }, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE });
    const reset = harness([fresh([first, second, unrelatedResetBefore]), fresh([
      { ...first, review: "pending", status: "pending-approval" },
      { ...second, review: "pending", status: "pending-approval" },
      unrelatedResetAfter,
    ])]);
    await reset.service.execute({ kind: "reset-project-choices" });
    expect(reset.apply.mock.calls[0]![0].transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([
      { kind: "retire", serverName: "first" },
      { kind: "retire", serverName: "second" },
    ]);

    const owner = { name: "worker", scope: "project" as const };
    const main = declaration({ name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const agent = declaration({ name: "same", source: "subagent-inline", agentOwner: owner, review: "approved-exact" });
    const agentReview = harness([fresh([main, agent]), fresh([main, { ...agent, review: "rejected-exact", status: "disabled" }])]);
    await expect(agentReview.service.execute({ kind: "reject", name: "same", agentOwner: owner })).resolves.toMatchObject({ runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
    expect(agentReview.apply).toHaveBeenCalledOnce();
    expect(agentReview.apply.mock.calls[0]![0]).toMatchObject({
      action: { kind: "reject", name: "same", agentOwner: owner },
      transitions: [],
    });

    const agentReset = harness([fresh([main, agent]), fresh([main, { ...agent, review: "pending", status: "pending-approval" }])]);
    await expect(agentReset.service.execute({ kind: "reset-project-choices" })).resolves.toMatchObject({ runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
    expect(agentReset.apply).toHaveBeenCalledOnce();
    expect(agentReset.apply.mock.calls[0]![0]).toMatchObject({ action: { kind: "reset-project-choices" }, transitions: [] });

    const target = declaration({ name: "target", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const unrelatedBefore = declaration({ name: "unrelated", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const unrelatedAfter = declaration({ name: "unrelated", source: "native-local", authority: { kind: "mutable", scope: "local" }, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE });
    const concurrent = harness([fresh([target, unrelatedBefore]), fresh([unrelatedAfter])]);
    await concurrent.service.execute({ kind: "remove", scope: "user", name: "target" });
    expect(concurrent.apply.mock.calls[0]![0].transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([
      { kind: "retire", serverName: "target" },
    ]);
  });

  it("persists an agent-inline review with its exact owner and current definition", async () => {
    const owner = { name: "worker", scope: "project" as const };
    const server = declaration({ name: "inline", source: "subagent-inline", agentOwner: owner, review: "pending", status: "pending-approval" });
    const changed = { ...server, definitionDigest: `mcp-review-v1:${"b".repeat(64)}` };
    const h = harness([fresh([changed]), fresh([{ ...changed, review: "rejected-exact", status: "disabled" }])]);
    await h.service.execute({ kind: "reject", name: "inline", agentOwner: owner });
    expect(h.mutate).toHaveBeenCalledWith({ kind: "set-review", record: expect.objectContaining({ agentOwner: owner, definitionDigest: changed.definitionDigest, decision: "rejected" }) });
  });

  it("keeps durable success distinct from runtime and exposure partial failure", async () => {
    const server = declaration({ name: "s", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const h = harness([fresh([server]), fresh([])], { live: { runtime: { state: "succeeded" }, exposure: { state: "failed", reasonCode: "exposure-failed" } } });
    const result = await h.service.execute({ kind: "remove", scope: "user", name: "s" });
    expect(result.recovery).toEqual({ state: "not-requested" });
    expect(result.durable).toEqual(committed());
    expect(result.runtime).toEqual({ state: "succeeded" });
    expect(result.exposure).toEqual({ state: "failed", reasonCode: "exposure-failed" });
  });

  it("never calls live work before durable commit and skips it for idempotent durable success", async () => {
    const server = declaration({ name: "s", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const failed = harness([fresh([server]), fresh([server])], { mutation: { state: "rejected", effect: "unchanged", cleanup: "complete", retrySafe: true } });
    await expect(failed.service.execute({ kind: "remove", scope: "user", name: "s" })).resolves.toMatchObject({ eligibility: { reasonCode: "durable-mutation-failed" } });
    expect(failed.apply).not.toHaveBeenCalled();
    const durablePending = harness([fresh([server]), fresh([server])], { mutation: pending });
    await expect(durablePending.service.execute({ kind: "remove", scope: "user", name: "s" })).resolves.toMatchObject({ eligibility: { reasonCode: "recovery-pending" }, durable: { state: "pending-recovery" } });
    expect(durablePending.apply).not.toHaveBeenCalled();
    const noOp = harness([fresh([server]), fresh([server])], { mutation: committed("unchanged") });
    await noOp.service.execute({ kind: "remove", scope: "user", name: "s" });
    expect(noOp.apply).not.toHaveBeenCalled();
  });

  it("reconnect reacquires current failed admission without durable mutation", async () => {
    const server = declaration({ name: "remote", source: "native-user", summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } });
    const live = [{ name: "remote", state: "failed" as const }];
    const h = harness([fresh([server], live), fresh([server], live)]);
    const result = await h.service.execute({ kind: "reconnect", name: "remote" });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.assemble).toHaveBeenCalledTimes(2);
    expect(h.apply.mock.calls[0]![0]).toMatchObject({ action: { kind: "reconnect", name: "remote" }, runtimeAdmission: expect.any(Object) });
    expect(openMcpAdministrationRuntimeAdmission(h.apply.mock.calls[0]![0].runtimeAdmission!)?.binding).toEqual(admissionBinding(server));
    expect(result).toMatchObject({ durable: { state: "not-requested" }, runtime: { state: "succeeded" } });
  });

  it("returns inert bounded authentication guidance for remote and stdio declarations", async () => {
    const remote = declaration({ name: "remote", source: "native-user", summary: { transport: "sse", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } });
    const stdio = declaration({ name: "stdio", source: "native-user" });
    const h = harness([fresh([remote, stdio]), fresh([remote, stdio])]);
    await expect(h.service.execute({ kind: "authenticate", name: "remote" })).resolves.toMatchObject({ eligibility: { reasonCode: "authentication-deferred" }, durable: { state: "not-requested" } });
    await expect(h.service.execute({ kind: "authenticate", name: "stdio" })).resolves.toMatchObject({ eligibility: { reasonCode: "authentication-unavailable" }, durable: { state: "not-requested" } });
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it("rechecks reconnect against the final exact ordinary main-session winner", async () => {
    const failed = declaration({ name: "target", source: "native-user" });
    const failedLive = [{ name: "target", state: "failed" as const }];
    const rows = [
      ["blocked", { ...failed, status: "blocked" as const, policy: "policy-denied" as const }, failedLive, "policy-blocked"],
      ["disabled", { ...failed, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const }, failedLive, "not-effective"],
      ["pending", { ...failed, source: "project-mcpjson" as const, status: "pending-approval" as const, review: "pending" as const }, failedLive, "stale-state"],
      ["not failed", failed, [{ name: "target", state: "connected" as const }], "not-failed"],
      ["source changed", { ...failed, source: "settings-user" as const }, failedLive, "stale-state"],
      ["digest changed", { ...failed, definitionDigest: `mcp-review-v1:${"b".repeat(64)}` }, failedLive, "stale-state"],
    ] as const;
    for (const [label, finalServer, finalLive, reasonCode] of rows) {
      const h = harness([fresh([failed], failedLive), fresh([finalServer], finalLive)]);
      await expect(h.service.execute({ kind: "reconnect", name: "target" }), label).resolves.toMatchObject({ eligibility: { eligible: false, reasonCode }, runtime: { state: "not-requested" } });
      expect(h.apply, label).not.toHaveBeenCalled();
    }
    const owner = { name: "worker", scope: "project" as const };
    const agent = declaration({ name: "target", source: "subagent-inline", agentOwner: owner, review: "approved-exact" });
    const deniedAgent = harness([fresh([agent], [{ name: "target", agentOwner: owner, state: "failed" }])]);
    await expect(deniedAgent.service.execute({ kind: "reconnect", name: "target", agentOwner: owner })).resolves.toMatchObject({ eligibility: { reasonCode: "unsupported-source" } });
  });

  it("mints only an authentic exact fresh-state runtime envelope", async () => {
    const base = declaration({ name: "target", source: "native-user" });
    const live = [{ name: "target", state: "failed" as const }];
    const exact = fresh([base], live);
    const exactHarness = harness([exact, exact]);
    await exactHarness.service.execute({ kind: "reconnect", name: "target" });
    const request = exactHarness.apply.mock.calls[0]![0];
    expect(request.runtimeAdmission).toEqual({});
    expect(JSON.stringify(request.runtimeAdmission)).toBe("{}");
    expect(openMcpAdministrationRuntimeAdmission(request.runtimeAdmission!)?.server).toBe(exact.mcp.servers[0]);
    expect(openMcpAdministrationRuntimeAdmission({} as never)).toBeUndefined();
    expect(openMcpAdministrationRuntimeAdmission({ ...request.runtimeAdmission } as never)).toBeUndefined();

    const rows: Array<[string, (state: McpAdministrationFreshState) => void]> = [
      ["resolved source", (state) => { state.mcp.servers[0] = { ...state.mcp.servers[0]!, source: "native-local" } as never; }],
      ["resolved status", (state) => { state.mcp.servers[0] = { name: "target", source: "native-user", status: "disabled", inactiveReason: "native-runtime-disabled", diagnostics: [] }; }],
      ["policy", (state) => { (state.mcp.administration!.declarations[0] as { policy: string }).policy = "policy-denied"; }],
      ["status", (state) => { (state.mcp.administration!.declarations[0] as { status: string }).status = "disabled"; }],
      ["review", (state) => { (state.mcp.administration!.declarations[0] as { review: string }).review = "pending"; }],
      ["owner", (state) => { (state.mcp.administration!.declarations[0] as { agentOwner?: unknown }).agentOwner = { name: "worker", scope: "project" }; }],
      ["version", (state) => { (state.mcp.administration!.declarations[0] as { definitionVersion?: number }).definitionVersion = 2; }],
      ["digest", (state) => { (state.mcp.administration!.declarations[0] as { definitionDigest?: string }).definitionDigest = CONTROL_DIGEST_B_FOR_SERVICE; }],
      ["profile", (state) => { (state.reviewIdentity as { profileKey: string }).profileKey = "other-profile"; }],
      ["family", (state) => { (state.reviewIdentity as { checkoutFamilyKey: string }).checkoutFamilyKey = "other-family"; }],
    ];
    for (const [label, mutateFinal] of rows) {
      const before = fresh([base], live);
      const after = structuredClone(before);
      mutateFinal(after);
      const candidate = harness([before, after]);
      await candidate.service.execute({ kind: "reconnect", name: "target" });
      expect(candidate.apply, label).not.toHaveBeenCalled();
    }

    for (const [label, resolvedServers] of [
      ["absent exact resolver entry", []],
      ["duplicate exact resolver entries", [exact.mcp.servers[0]!, exact.mcp.servers[0]!]],
    ] as const) {
      const before = fresh([base], live);
      const after = fresh([base], live);
      after.mcp.servers = [...resolvedServers];
      const candidate = harness([before, after]);
      await candidate.service.execute({ kind: "reconnect", name: "target" });
      expect(candidate.apply, label).not.toHaveBeenCalled();
    }
  });

  it("keeps one stdio and one remote reconnect success", async () => {
    for (const server of [
      declaration({ name: "stdio", source: "native-user" }),
      declaration({ name: "remote", source: "settings-user", summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } }),
    ]) {
      const live = [{ name: server.name, state: "failed" as const }];
      const h = harness([fresh([server], live), fresh([server], live)]);
      await expect(h.service.execute({ kind: "reconnect", name: server.name })).resolves.toMatchObject({ eligibility: { eligible: true }, runtime: { state: "succeeded" } });
    }
  });

  it("keeps an authenticated add commit successful but live-inert after a concurrent exact-name replacement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-service-evidence-"));
    try {
      const home = path.join(root, "home");
      const project = path.join(root, "project");
      const profile = path.join(home, ".claude.json");
      fs.mkdirSync(home); fs.mkdirSync(project); fs.writeFileSync(profile, "{}\n");
      const family = fs.realpathSync.native(project);
      const locations = createMcpLifecycleLocations({ homeDir: home, profilePath: profile,
        platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: family, checkoutFamilyPath: family } });
      if (!locations.ok || locations.value.checkoutFamilyKey === undefined) throw new Error("MCP locations unavailable");
      const established = await establishOwnedStateStore(locations.value, home);
      if (!established.ok) throw new Error(established.message);
      const authorityFingerprint = `sha256:${"e".repeat(64)}`;
      const context: Parameters<typeof persistMcpMutation>[0] = {
        store: established.value, profilePath: profile, projectRoot: project,
        checkoutFamilyKey: locations.value.checkoutFamilyKey, authorityFingerprint,
        identifyProject: () => [family],
        revalidateAuthority: () => ({ ok: true, value: { profileKey: established.value.profileKey,
          checkoutFamilyKey: locations.value.checkoutFamilyKey!, authorityFingerprint } }),
      };
      const replacement = boundDeclaration("raced", "project-mcpjson", { command: "replacement-b" }, {
        authority: { kind: "mutable", scope: "project" }, review: "approved-exact", status: "enabled",
      });
      const apply = vi.fn(async () => ({ runtime: { state: "succeeded" as const }, exposure: { state: "succeeded" as const } }));
      let assembly = 0;
      const service = createMcpAdministrationService({
        inspectPending: async () => ({ pending: false, status: "clear" }),
        recover: async () => rolledBack,
        mutate: async (mutation) => {
          const committedResult = await persistMcpMutation(context, mutation);
          fs.writeFileSync(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { raced: { command: "replacement-b" } } }));
          return committedResult;
        },
        assemble: () => assembly++ === 0 ? {
          ...fresh([]), reviewIdentity: { profileKey: established.value.profileKey, checkoutFamilyKey: locations.value.checkoutFamilyKey! },
        } : {
          ...fresh([replacement]), reviewIdentity: { profileKey: established.value.profileKey, checkoutFamilyKey: locations.value.checkoutFamilyKey! },
        },
        live: { apply },
      });
      await expect(service.execute({ kind: "add", scope: "project", name: "raced", definition: { command: "original-a" } })).resolves.toMatchObject({
        eligibility: { eligible: true }, durable: { state: "committed", effect: "changed" },
        runtime: { state: "not-requested" }, exposure: { state: "not-requested" },
      });
      expect(apply).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts exact durable pending add while suppressing live work for pending and stale postconditions", async () => {
    const additions = [
      boundDeclaration("added", "managed-mcp", { command: "secret-command", env: { TOKEN: "secret" } }),
      boundDeclaration("added", "project-mcpjson", { command: "secret-command", env: { TOKEN: "secret" } }, { authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" }),
      boundDeclaration("added", "project-mcpjson", { command: "changed-command" }, { authority: { kind: "mutable", scope: "project" }, review: "approved-exact", status: "enabled" }),
    ];
    for (const [index, finalServer] of additions.entries()) {
      const h = harness([fresh([]), fresh([finalServer!])]);
      await expect(h.service.execute({ kind: "add", scope: "project", name: "added", definition: { command: "secret-command", env: { TOKEN: "secret" } } })).resolves.toEqual({
        inventory: expectedInventory([finalServer!]),
        eligibility: index === 1 ? { eligible: true, reasonCode: "eligible" } : { eligible: false, reasonCode: "stale-state" },
        recovery: { state: "not-requested" },
        durable: committed(),
        runtime: { state: "not-requested" },
        exposure: { state: "not-requested" },
      });
      expect(h.apply).not.toHaveBeenCalled();
    }
    const pendingReview = declaration({ name: "review", source: "project-mcpjson", review: "pending", status: "pending-approval" });
    const changed = { ...pendingReview, definitionDigest: `mcp-review-v1:${"c".repeat(64)}`, review: "approved-exact" as const, status: "enabled" as const };
    const approval = harness([fresh([pendingReview]), fresh([changed])]);
    await expect(approval.service.execute({ kind: "approve", name: "review" })).resolves.toEqual({
      inventory: expectedInventory([changed]),
      eligibility: { eligible: false, reasonCode: "stale-state" },
      recovery: { state: "not-requested" },
      durable: committed(),
      runtime: { state: "not-requested" },
      exposure: { state: "not-requested" },
    });
    expect(approval.apply).not.toHaveBeenCalled();
    const ineffectiveApproval = harness([fresh([pendingReview]), fresh([pendingReview])]);
    await expect(ineffectiveApproval.service.execute({ kind: "approve", name: "review" })).resolves.toEqual({
      inventory: expectedInventory([pendingReview]),
      eligibility: { eligible: false, reasonCode: "not-effective" },
      recovery: { state: "not-requested" },
      durable: committed(),
      runtime: { state: "not-requested" },
      exposure: { state: "not-requested" },
    });
    expect(ineffectiveApproval.apply).not.toHaveBeenCalled();
  });

  it("treats exact durable add presence as success across shadowed, pending, rejected, disabled, auth-needed, and disconnected states", async () => {
    const definition = { command: "run" };
    const rows = [
      { label: "shadowed", scope: "project" as const, server: boundDeclaration("broad name__x", "project-mcpjson", definition, { authority: { kind: "mutable", scope: "project" }, precedence: "shadowed", status: "shadowed" }), live: [] },
      { label: "pending", scope: "project" as const, server: boundDeclaration("broad name__x", "project-mcpjson", definition, { authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" }), live: [] },
      { label: "rejected", scope: "project" as const, server: boundDeclaration("broad name__x", "project-mcpjson", definition, { authority: { kind: "mutable", scope: "project" }, review: "rejected-exact", status: "disabled" }), live: [] },
      { label: "disabled", scope: "user" as const, server: boundDeclaration("broad name__x", "native-user", definition, { authority: { kind: "mutable", scope: "user" }, status: "disabled", inactiveReason: "native-runtime-disabled" }), live: [] },
      { label: "auth-needed", scope: "user" as const, server: boundDeclaration("broad name__x", "native-user", definition, { authority: { kind: "mutable", scope: "user" } }), live: [{ name: "broad name__x", state: "failed" as const, diagnostic: "authentication" }] },
      { label: "disconnected", scope: "user" as const, server: boundDeclaration("broad name__x", "native-user", definition, { authority: { kind: "mutable", scope: "user" } }), live: [{ name: "broad name__x", state: "failed" as const }] },
    ];
    for (const row of rows) {
      const h = harness([fresh([]), fresh([row.server], row.live)]);
      await expect(h.service.execute({ kind: "add", scope: row.scope, name: "broad name__x", definition }), row.label).resolves.toMatchObject({ eligibility: { eligible: true }, durable: { state: "committed" } });
      if (row.server.precedence === "winner" && row.server.status === "enabled") expect(h.apply, row.label).toHaveBeenCalledOnce(); else expect(h.apply, row.label).not.toHaveBeenCalled();
    }
  });

  it("blocks stale and ineffective reject, disable, and enable final states with complete outcomes", async () => {
    const review = declaration({ name: "review", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" });
    const enabled = declaration({ name: "toggle", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const disabled = { ...enabled, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
    const changedDigest = `mcp-review-v1:${"d".repeat(64)}`;
    const rows = [
      { label: "reject stale", action: { kind: "reject", name: "review" } as const, before: review, after: { ...review, definitionDigest: changedDigest, review: "rejected-exact" as const, status: "disabled" as const }, reasonCode: "stale-state" },
      { label: "reject ineffective", action: { kind: "reject", name: "review" } as const, before: review, after: review, reasonCode: "not-effective" },
      { label: "disable stale", action: { kind: "disable", name: "toggle" } as const, before: enabled, after: { ...disabled, definitionDigest: changedDigest }, reasonCode: "stale-state" },
      { label: "disable ineffective", action: { kind: "disable", name: "toggle" } as const, before: enabled, after: enabled, reasonCode: "not-effective" },
      { label: "enable stale", action: { kind: "enable", name: "toggle" } as const, before: disabled, after: { ...enabled, definitionDigest: changedDigest }, reasonCode: "stale-state" },
      { label: "enable ineffective", action: { kind: "enable", name: "toggle" } as const, before: disabled, after: disabled, reasonCode: "not-effective" },
    ];
    for (const row of rows) {
      const h = harness([fresh([row.before]), fresh([row.after])]);
      const shouldRetire = row.label === "disable stale";
      await expect(h.service.execute(row.action), row.label).resolves.toEqual({
        inventory: expectedInventory([row.after]),
        eligibility: { eligible: false, reasonCode: row.reasonCode },
        recovery: { state: "not-requested" },
        durable: committed(),
        runtime: { state: shouldRetire ? "succeeded" : "not-requested" },
        exposure: { state: shouldRetire ? "succeeded" : "not-requested" },
      });
      if (shouldRetire) {
        const request = h.apply.mock.calls[0]![0];
        expect(request.runtimeAdmission).toBeUndefined();
        expect(request.transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([{ kind: "retire", serverName: "toggle" }]);
      } else expect(h.apply, row.label).not.toHaveBeenCalled();
    }
  });

  it("rejects a stale remove whose exact scoped declaration survives the durable result", async () => {
    const server = declaration({ name: "stale", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const h = harness([fresh([server]), fresh([server])]);
    await expect(h.service.execute({ kind: "remove", scope: "user", name: "stale" })).resolves.toEqual({
      inventory: expectedInventory([server]),
      eligibility: { eligible: false, reasonCode: "stale-state" },
      recovery: { state: "not-requested" },
      durable: committed(),
      runtime: { state: "succeeded" },
      exposure: { state: "succeeded" },
    });
    const request = h.apply.mock.calls[0]![0];
    expect(request.runtimeAdmission).toBeUndefined();
    expect(request.transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([{ kind: "retire", serverName: "stale" }]);
  });

  it("retires only causally targeted old routes when restrictive commits are followed by definition drift", async () => {
    const unrelatedBefore = declaration({ name: "unrelated", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const unrelatedAfter = { ...unrelatedBefore, source: "native-local" as const, authority: { kind: "mutable" as const, scope: "local" as const }, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE };
    const targets = [
      { action: { kind: "remove", scope: "user", name: "target" } as const, before: declaration({ name: "target", source: "native-user", authority: { kind: "mutable", scope: "user" } }) },
      { action: { kind: "disable", name: "target" } as const, before: declaration({ name: "target", source: "native-user", authority: { kind: "mutable", scope: "user" } }) },
      { action: { kind: "reject", name: "target" } as const, before: declaration({ name: "target", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "approved-exact" }) },
      { action: { kind: "reset-project-choices" } as const, before: declaration({ name: "target", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "approved-exact" }) },
    ];
    for (const { action, before } of targets) {
      const replacement = { ...before, source: "native-local" as const, authority: { kind: "mutable" as const, scope: "local" as const }, review: "not-required" as const, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE };
      const h = harness([fresh([before, unrelatedBefore]), fresh([replacement, unrelatedAfter])]);
      const result = await h.service.execute(action);
      expect(result).toMatchObject({ eligibility: { eligible: false, reasonCode: "stale-state" }, durable: { state: "committed", effect: "changed" }, runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
      const request = h.apply.mock.calls[0]![0];
      expect(request.runtimeAdmission).toBeUndefined();
      expect(request.transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([{ kind: "retire", serverName: "target" }]);
    }
  });

  it("passes only a secret-free action descriptor after exact durable postconditions", async () => {
    const added = boundDeclaration("added", "native-user", { command: "secret-command", env: { TOKEN: "secret-canary-value" } }, { authority: { kind: "mutable", scope: "user" } });
    const after = fresh([added]);
    after.mcp.servers[0] = { ...after.mcp.servers[0]!, command: "secret-command", rawCommand: "secret-command", env: { TOKEN: "secret-canary-value" } } as never;
    const h = harness([fresh([]), after]);
    await h.service.execute({ kind: "add", scope: "user", name: "added", definition: { command: "secret-command", env: { TOKEN: "secret-canary-value" } } });
    expect(h.apply).toHaveBeenCalledWith(expect.objectContaining({ action: { kind: "add", scope: "user", name: "added" }, runtimeAdmission: expect.any(Object) }));
    const opened = openMcpAdministrationRuntimeAdmission(h.apply.mock.calls[0]![0].runtimeAdmission!);
    expect(opened?.binding).toEqual(admissionBinding(added));
    expect(opened?.server).toBe(after.mcp.servers[0]);
    const serializedLiveRequest = JSON.stringify(h.apply.mock.calls);
    expect(serializedLiveRequest).not.toContain("secret-command");
    expect(serializedLiveRequest).not.toContain("TOKEN");
    expect(serializedLiveRequest).not.toContain("secret-canary-value");
  });

  it("reports committed cleanup pending, runtime/exposure outcomes, and live-port throws without undoing durability", async () => {
    const server = declaration({ name: "s", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const cleanup: McpPersistenceResult = { state: "committed", operationId: "op", effect: "changed", cleanup: "pending", retrySafe: false, reasonCode: "cleanup-pending" };
    const cleanupHarness = harness([fresh([server]), fresh([])], { mutation: cleanup });
    const cleanupResult = await cleanupHarness.service.execute({ kind: "remove", scope: "user", name: "s" });
    expect(cleanupResult.recovery).toEqual({ state: "not-requested" });
    expect(cleanupResult.durable).toEqual(cleanup);
    expect(cleanupResult.runtime).toEqual({ state: "not-requested" });
    expect(cleanupResult.exposure).toEqual({ state: "not-requested" });
    expect(cleanupResult.eligibility).toEqual({ eligible: false, reasonCode: "cleanup-pending" });
    expect(cleanupHarness.apply).not.toHaveBeenCalled();

    const runtimeFailure = harness([fresh([server]), fresh([])], { live: { runtime: { state: "failed", reasonCode: "runtime-failed" }, exposure: { state: "not-requested" } } });
    const runtimeResult = await runtimeFailure.service.execute({ kind: "remove", scope: "user", name: "s" });
    expect(runtimeResult.recovery).toEqual({ state: "not-requested" });
    expect(runtimeResult.durable).toEqual(committed());
    expect(runtimeResult.runtime).toEqual({ state: "failed", reasonCode: "runtime-failed" });
    expect(runtimeResult.exposure).toEqual({ state: "not-requested" });

    const thrown = harness([fresh([server]), fresh([])]);
    thrown.apply.mockRejectedValueOnce(new Error("live failed"));
    const thrownResult = await thrown.service.execute({ kind: "remove", scope: "user", name: "s" });
    expect(thrownResult.recovery).toEqual({ state: "not-requested" });
    expect(thrownResult.durable).toEqual(committed());
    expect(thrownResult.runtime).toEqual({ state: "failed", reasonCode: "live-port-failure" });
    expect(thrownResult.exposure).toEqual({ state: "not-requested" });
  });

  it("suppresses reset no-op and retains broad compatibility truth after a changed reset", async () => {
    const privateApproved = declaration({ name: "private", source: "project-mcpjson", review: "approved-exact" });
    const broad = declaration({ name: "broad", source: "project-mcpjson", review: "approved-broad-all" });
    const rejected = declaration({ name: "compat", source: "project-mcpjson", review: "rejected-compatibility", status: "disabled" });
    const after = [{ ...privateApproved, review: "pending" as const, status: "pending-approval" as const }, broad, rejected];
    const changed = harness([fresh([privateApproved, broad, rejected]), fresh(after)]);
    await expect(changed.service.execute({ kind: "reset-project-choices" })).resolves.toMatchObject({ inventory: { servers: expect.arrayContaining([expect.objectContaining({ name: "broad", review: "approved-broad-all" }), expect.objectContaining({ name: "compat", review: "rejected-compatibility" })]) }, runtime: { state: "succeeded" } });
    const noOp = harness([fresh([broad, rejected]), fresh([broad, rejected])], { mutation: committed("unchanged") });
    await noOp.service.execute({ kind: "reset-project-choices" });
    expect(noOp.apply).not.toHaveBeenCalled();
  });

  it("projects bounded recovery guidance without managed authority", async () => {
    const h = harness([fresh([])], { pending: true });
    await expect(h.service.inventory()).resolves.toEqual(expect.objectContaining({ policyPosture: "fail-closed", observations: ["administration-recovery-pending"], remediation: "administration-recovery-pending", servers: [] }));
  });
});

describe("MCP interactive confirmation authority", () => {
  const selector = (item: McpAdministrationDeclaration) => ({
    name: item.name, source: item.source, authority: item.authority, precedence: item.precedence,
    ...(item.agentOwner === undefined ? {} : { agentOwner: item.agentOwner }),
  });

  it.each(["approve", "reject"] as const)("prepares and confirms exact project %s", async (kind) => {
    const before = declaration({ name: "project", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" });
    const after = { ...before, review: kind === "approve" ? "approved-exact" as const : "rejected-exact" as const, status: kind === "approve" ? "enabled" as const : "disabled" as const };
    const h = harness([fresh([before]), fresh([before]), fresh([after])]);
    const prepared = await h.service.interactivePrepare(selector(before), kind);
    expect(prepared).toMatchObject({ eligibility: { eligible: true }, authority: {} });
    expect(JSON.stringify(prepared.authority)).toBe("{}");
    const result = await h.service.confirmedExecute(prepared.authority!);
    expect(result).toMatchObject({ eligibility: { eligible: true }, durable: { state: "committed", effect: "changed" } });
    expect(h.mutate).toHaveBeenCalledOnce();
  });

  it.each(["disable", "enable"] as const)("prepares and confirms exact native %s", async (kind) => {
    const enabled = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const disabled = { ...enabled, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
    const before = kind === "disable" ? enabled : disabled; const after = kind === "disable" ? disabled : enabled;
    const h = harness([fresh([before]), fresh([before]), fresh([after])]);
    const prepared = await h.service.interactivePrepare(selector(before), kind);
    await expect(h.service.confirmedExecute(prepared.authority!)).resolves.toMatchObject({ durable: { state: "committed" } });
    expect(h.mutate).toHaveBeenCalledWith({ kind: "set-runtime-disabled", name: "native", disabled: kind === "disable" });
  });

  it("prepares and confirms reconnect while authentication remains authority-free", async () => {
    const item = declaration({ name: "remote", source: "native-user", summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false } });
    const live = [{ name: "remote", state: "failed" as const }];
    const h = harness([fresh([item], live), fresh([item], live), fresh([item], live)]);
    const auth = await h.service.interactivePrepare(selector(item), "authenticate");
    expect(auth).toMatchObject({ eligibility: { reasonCode: "authentication-deferred" } }); expect(auth.authority).toBeUndefined();
    const prepared = await h.service.interactivePrepare(selector(item), "reconnect");
    await expect(h.service.confirmedExecute(prepared.authority!)).resolves.toMatchObject({ runtime: { state: "succeeded" } });
    expect(h.mutate).not.toHaveBeenCalled(); expect(h.apply).toHaveBeenCalledOnce();
  });

  it("denies missing, shadowed, and mismatched full selectors without authority", async () => {
    const winner = declaration({ name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const shadow = declaration({ name: "same", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "shadowed", status: "shadowed", review: "pending" });
    const h = harness([fresh([winner, shadow]), fresh([winner, shadow]), fresh([winner, shadow])]);
    for (const [candidate, action, reason] of [
      [selector(shadow), "approve", "stale-state"],
      [{ ...selector(winner), source: "native-local" }, "disable", "stale-state"],
      [{ ...selector(winner), name: "missing" }, "disable", "server-not-found"],
    ] as const) {
      const result = await h.service.interactivePrepare(candidate, action);
      expect(result.eligibility.reasonCode).toBe(reason); expect(result.authority).toBeUndefined();
    }
  });

  it("requires an exact authority and owner selector and refuses ambiguous duplicate winners", async () => {
    const base = declaration({ name: "same", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    for (const candidate of [
      { ...selector(base), authority: { kind: "mutable" as const, scope: "local" as const } },
      { ...selector(base), agentOwner: { name: "worker", scope: "project" as const } },
    ]) {
      const h = harness([fresh([base])]);
      const prepared = await h.service.interactivePrepare(candidate, "disable");
      expect(prepared).toMatchObject({ eligibility: { reasonCode: "stale-state" } }); expect(prepared.authority).toBeUndefined();
    }
    const duplicate = { ...base, source: "native-local" as const, authority: { kind: "mutable" as const, scope: "local" as const } };
    const h = harness([fresh([base, duplicate])]);
    const prepared = await h.service.interactivePrepare(selector(base), "disable");
    expect(prepared).toMatchObject({ eligibility: { reasonCode: "stale-state" } }); expect(prepared.authority).toBeUndefined();
    expect(h.mutate).not.toHaveBeenCalled(); expect(h.apply).not.toHaveBeenCalled();
  });

  it("keeps direct execution's existing first-winner behavior separate from interactive authority", async () => {
    const first = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const duplicate = { ...first, source: "native-local" as const, authority: { kind: "mutable" as const, scope: "local" as const } };
    const disabled = { ...first, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
    const h = harness([fresh([first, duplicate]), fresh([disabled, duplicate])]);
    await expect(h.service.execute({ kind: "disable", name: "native" })).resolves.toMatchObject({ eligibility: { eligible: true }, durable: { state: "committed" }, runtime: { state: "not-requested" } });
    expect(h.mutate).toHaveBeenCalledOnce(); expect(h.apply).not.toHaveBeenCalled();
  });

  it("fails closed when a duplicate winner emerges before mutation or after commit", async () => {
    const base = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const duplicate = { ...base, source: "native-local" as const, authority: { kind: "mutable" as const, scope: "local" as const } };
    const before = harness([fresh([base]), fresh([base, duplicate])]);
    const preparedBefore = await before.service.interactivePrepare(selector(base), "disable");
    await expect(before.service.confirmedExecute(preparedBefore.authority!)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" } });
    expect(before.mutate).not.toHaveBeenCalled(); expect(before.apply).not.toHaveBeenCalled();

    const disabled = { ...base, status: "disabled" as const, inactiveReason: "native-runtime-disabled" as const };
    const after = harness([fresh([base]), fresh([base]), fresh([disabled, duplicate])]);
    const preparedAfter = await after.service.interactivePrepare(selector(base), "disable");
    await expect(after.service.confirmedExecute(preparedAfter.authority!)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" }, durable: { state: "committed" }, runtime: { state: "succeeded" }, exposure: { state: "succeeded" } });
    expect(after.mutate).toHaveBeenCalledOnce();
    expect(after.apply.mock.calls[0]![0].transitions.map(openMcpAdministrationRuntimeTransition)).toEqual([{ kind: "retire", serverName: "native" }]);
  });

  it("never recovers during confirmation and blocks pending work at both pre-mutation boundaries", async () => {
    const base = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    for (const sequence of [[false, true], [false, false, true]] as const) {
      const h = harness([fresh([base]), fresh([base])], { pendingSequence: sequence });
      const prepared = await h.service.interactivePrepare(selector(base), "disable");
      const result = await h.service.confirmedExecute(prepared.authority!);
      expect(result).toEqual({ inventory: expect.objectContaining({ remediation: "administration-recovery-pending", servers: [] }), eligibility: { eligible: false, reasonCode: "recovery-pending" }, recovery: { state: "not-requested" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" } });
      expect(h.recover).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled(); expect(h.apply).not.toHaveBeenCalled();
    }
  });

  it("returns complete truthful current inventory for invalid and replayed authority", async () => {
    const base = declaration({ name: "truth", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const h = harness([fresh([base]), fresh([base]), fresh([base])]);
    const prepared = await h.service.interactivePrepare(selector(base), "disable");
    const expected = {
      inventory: expectedInventory([base]), eligibility: { eligible: false, reasonCode: "stale-state" },
      recovery: { state: "not-requested" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" },
    };
    await expect(h.service.confirmedExecute({} as never)).resolves.toEqual(expected);
    const first = await h.service.confirmedExecute(prepared.authority!);
    expect(first.durable.state).toBe("committed");
    await expect(h.service.confirmedExecute(prepared.authority!)).resolves.toEqual(expected);
  });

  it("fails closed for definition replacement, copied/serialized/forged/cross-service/replayed and concurrent confirmation", async () => {
    const a = declaration({ name: "project", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, review: "pending", status: "pending-approval" });
    const b = { ...a, definitionDigest: CONTROL_DIGEST_B_FOR_SERVICE };
    const stale = harness([fresh([a]), fresh([b])]);
    const stalePrepared = await stale.service.interactivePrepare(selector(a), "approve");
    await expect(stale.service.confirmedExecute(stalePrepared.authority!)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" }, durable: { state: "not-requested" } });
    expect(stale.mutate).not.toHaveBeenCalled(); expect(stale.apply).not.toHaveBeenCalled();

    const forgery = harness([fresh([a]), fresh([a]), fresh([a]), fresh([a])]);
    const forgedPreparation = await forgery.service.interactivePrepare(selector(a), "approve");
    const other = harness([fresh([a])]);
    for (const forged of [{}, { ...forgedPreparation.authority }, JSON.parse(JSON.stringify(forgedPreparation.authority))] as const) {
      await expect(forgery.service.confirmedExecute(forged as never)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" } });
    }
    await expect(other.service.confirmedExecute(forgedPreparation.authority!)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" } });
    const exact = harness([fresh([a]), fresh([a]), fresh([{ ...a, review: "approved-exact", status: "enabled" }])]);
    const prepared = await exact.service.interactivePrepare(selector(a), "approve");
    const [first, second] = await Promise.all([exact.service.confirmedExecute(prepared.authority!), exact.service.confirmedExecute(prepared.authority!)]);
    expect([first, second].filter((value) => value.durable.state === "committed")).toHaveLength(1);
    expect(exact.mutate).toHaveBeenCalledOnce();
    await expect(exact.service.confirmedExecute(prepared.authority!)).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" } });
  });

  it("invalidates every bound public/private state field before mutation", async () => {
    const base = declaration({ name: "native", source: "native-user", authority: { kind: "mutable", scope: "user" } });
    const changes: Array<[string, (state: McpAdministrationFreshState) => void]> = [
      ["source", (state) => { (state.mcp.administration!.declarations[0] as { source: string }).source = "native-local"; }],
      ["authority", (state) => { (state.mcp.administration!.declarations[0] as { authority: unknown }).authority = { kind: "mutable", scope: "local" }; }],
      ["precedence", (state) => { (state.mcp.administration!.declarations[0] as { precedence: string }).precedence = "shadowed"; }],
      ["owner", (state) => { (state.mcp.administration!.declarations[0] as { agentOwner?: unknown }).agentOwner = { name: "worker", scope: "project" }; }],
      ["profile", (state) => { (state.reviewIdentity as { profileKey: string }).profileKey = "changed"; }],
      ["family", (state) => { (state.reviewIdentity as { checkoutFamilyKey: string }).checkoutFamilyKey = "changed"; }],
      ["policy", (state) => { (state.mcp.administration!.declarations[0] as { policy: string }).policy = "policy-denied"; }],
      ["review", (state) => { (state.mcp.administration!.declarations[0] as { review: string }).review = "pending"; }],
      ["status", (state) => { (state.mcp.administration!.declarations[0] as { status: string }).status = "disabled"; }],
    ];
    for (const [label, change] of changes) {
      const before = fresh([base]); const after = structuredClone(before); change(after);
      const h = harness([before, after]); const prepared = await h.service.interactivePrepare(selector(base), "disable");
      await expect(h.service.confirmedExecute(prepared.authority!), label).resolves.toMatchObject({ eligibility: { reasonCode: "stale-state" } });
      expect(h.mutate, label).not.toHaveBeenCalled(); expect(h.apply, label).not.toHaveBeenCalled();
    }
  });
});
