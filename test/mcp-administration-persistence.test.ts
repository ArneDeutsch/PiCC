import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMcpServerBlock } from "../src/claude/mcp-config.js";
import { createMcpLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import { mcpPersistenceDeclarationEvidence, persistMcpMutation, recoverMcpPendingOperation } from "../src/mcp-administration/persistence.js";
import { createMcpAdministrationService } from "../src/mcp-administration/service.js";
import type { ResolvedMcpConfig } from "../src/types.js";
import { createMcpReviewDefinitionDigest, matchesMcpReviewRecord } from "../src/mcp-administration/review-definition.js";
import { mcpReviewStatePath, readMcpReviewState } from "../src/mcp-administration/review-state.js";
import type { McpReviewRecord } from "../src/mcp-administration/model.js";
import { projectIdentities } from "../src/util/project-identity.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); });

async function fixture(projectOverride?: string): Promise<{ root: string; home: string; profile: string; project: string; store: OwnedStateStore; context: Parameters<typeof persistMcpMutation>[0] }> {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-persistence-"))); roots.push(root);
  const home = path.join(root, "home"); const profile = path.join(home, ".claude.json"); const project = projectOverride ?? path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(project, { recursive: true }); fs.writeFileSync(profile, "{\n  \"future\": {\"keep\": true}\n}\n");
  const family = fs.realpathSync.native(project); const locations = createMcpLifecycleLocations({ homeDir: home, profilePath: profile,
    platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: family, checkoutFamilyPath: family } });
  if (!locations.ok || locations.value.checkoutFamilyKey === undefined) throw new Error("locations");
  const established = await establishOwnedStateStore(locations.value, home); if (!established.ok) throw new Error(established.message);
  const authorityFingerprint = `sha256:${"a".repeat(64)}`;
  return { root, home, profile, project, store: established.value, context: { store: established.value, profilePath: profile, projectRoot: project,
    checkoutFamilyKey: locations.value.checkoutFamilyKey, authorityFingerprint, identifyProject: () => [family], revalidateAuthority: () => ({ ok: true, value: { profileKey: established.value.profileKey, checkoutFamilyKey: locations.value.checkoutFamilyKey!, authorityFingerprint } }) } };
}

describe("recoverable scoped MCP persistence", () => {
  it("round-trips project, user, local, runtime-disable, and review state while preserving unrelated fields", async () => {
    const f = await fixture();
    expect((await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "project", definition: { command: "run", env: { TOKEN: "secret" } } })).state).toBe("committed");
    expect((await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name: "user", definition: { command: "user-run" } })).state).toBe("committed");
    expect((await persistMcpMutation(f.context, { kind: "set-declaration", scope: "local", name: "local", definition: { command: "local-run" } })).state).toBe("committed");
    expect((await persistMcpMutation(f.context, { kind: "set-runtime-disabled", name: "local", disabled: true })).state).toBe("committed");
    const review = { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, source: "project-mcpjson" as const, serverName: "project",
      definitionVersion: 1 as const, definitionDigest: `mcp-review-v1:${"b".repeat(64)}`, decision: "approved" as const };
    expect((await persistMcpMutation(f.context, { kind: "set-review", record: review })).state).toBe("committed");

    expect(JSON.parse(fs.readFileSync(path.join(f.project, ".mcp.json"), "utf8"))).toMatchObject({ mcpServers: { project: { command: "run" } } });
    const native = JSON.parse(fs.readFileSync(f.profile, "utf8")) as { future: unknown; mcpServers: Record<string, { command: string }>; projects: Record<string, { mcpServers: Record<string, { command: string }>; disabledMcpServers: string[] }> };
    expect(native.future).toEqual({ keep: true }); expect(native.mcpServers.user!.command).toBe("user-run");
    expect(native.projects[fs.realpathSync.native(f.project)]!.mcpServers.local!.command).toBe("local-run");
    expect(native.projects[fs.realpathSync.native(f.project)]!.disabledMcpServers).toEqual(["local"]);
    const reviewState = await readMcpReviewState({ store: f.store, checkoutFamilyKey: f.context.checkoutFamilyKey });
    expect(reviewState).toMatchObject({ ok: true });
    if (!reviewState.ok) throw new Error(reviewState.message);
    expect(reviewState.value.records).toEqual([review]);
    const receipts = fs.readdirSync(f.store.receiptsRoot).map((name) => fs.readFileSync(path.join(f.store.receiptsRoot, name), "utf8")).join("\n");
    expect(receipts).not.toContain("secret");
  });

  it("performs create-only add and remove for project, user, and local names without touching neighbors", async () => {
    const f = await fixture(); const family = fs.realpathSync.native(f.project); const projectFile = path.join(f.project, ".mcp.json"); const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fs.writeFileSync(projectFile, '{\r\n\t"mcpServers": {\r\n\t\t"neighbor": {"command":"project-keep"}\r\n\t}\r\n}\r\n');
    fs.writeFileSync(f.profile, Buffer.concat([bom, Buffer.from(`{\r\n\t"mcpServers": {\r\n\t\t"neighbor": {"command":"user-keep"}\r\n\t},\r\n\t"projects": {\r\n\t\t${JSON.stringify(family)}: {\r\n\t\t\t"mcpServers": {\r\n\t\t\t\t"neighbor": {"command":"local-keep"}\r\n\t\t\t},\r\n\t\t\t"compatibility": {"keep":true}\r\n\t\t}\r\n\t},\r\n\t"userCanary": true\r\n}\r\n`)]));
    const readScopes = () => {
      const projectText = fs.readFileSync(projectFile, "utf8");
      expect(projectText).toContain("\r\n\t");
      expect(projectText.endsWith("\r\n")).toBe(true);
      const project = JSON.parse(projectText) as { mcpServers: Record<string, { command: string }> };
      const nativeBytes = fs.readFileSync(f.profile);
      expect(nativeBytes.subarray(0, 3)).toEqual(bom);
      const text = nativeBytes.subarray(3).toString("utf8");
      expect(text).toContain("\r\n\t");
      expect(text.endsWith("\r\n")).toBe(true);
      const native = JSON.parse(text) as { mcpServers: Record<string, { command: string }>; projects: Record<string, { mcpServers: Record<string, { command: string }>; compatibility: unknown }>; userCanary: boolean };
      return { project, native };
    };
    const assertCanaries = (same: Partial<Record<"project" | "user" | "local", string>>) => { const { project, native } = readScopes(); expect(project.mcpServers.neighbor).toEqual({ command: "project-keep" }); expect(native.mcpServers.neighbor).toEqual({ command: "user-keep" }); expect(native.projects[family]!.mcpServers.neighbor).toEqual({ command: "local-keep" }); expect(native.projects[family]!.compatibility).toEqual({ keep: true }); expect(native.userCanary).toBe(true); expect(project.mcpServers.same).toEqual(same.project === undefined ? undefined : { command: same.project }); expect(native.mcpServers.same).toEqual(same.user === undefined ? undefined : { command: same.user }); expect(native.projects[family]!.mcpServers.same).toEqual(same.local === undefined ? undefined : { command: same.local }); };
    const same: Partial<Record<"project" | "user" | "local", string>> = {};
    for (const scope of ["project", "user", "local"] as const) { expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope, name: "same", definition: { command: "one" } })).toMatchObject({ state: "committed", effect: "changed" }); same[scope] = "one"; assertCanaries(same); }
    for (const scope of ["project", "user", "local"] as const) { const before = scope === "project" ? fs.readFileSync(path.join(f.project, ".mcp.json")) : fs.readFileSync(f.profile); expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope, name: "same", definition: { command: "two" } })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "already-exists" }); expect(scope === "project" ? fs.readFileSync(path.join(f.project, ".mcp.json")) : fs.readFileSync(f.profile)).toEqual(before); assertCanaries(same); }
    for (const scope of ["project", "user", "local"] as const) { expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope, name: "same" })).toMatchObject({ state: "committed", effect: "changed" }); delete same[scope]; assertCanaries(same); }
  });

  it("round-trips bounded non-control names with spaces and double underscores across declaration and review state", async () => {
    const f = await fixture(); const name = "Claude compatible__server name";
    for (const scope of ["project", "user", "local"] as const) { const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope, name, definition: { command: "run" } }); expect(result).toMatchObject({ state: "committed", effect: "changed" }); expect(mcpPersistenceDeclarationEvidence(result)).toMatchObject({ scope, name, definitionVersion: 1 }); }
    const review: McpReviewRecord = { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, source: "project-mcpjson", serverName: name, definitionVersion: 1, definitionDigest: `mcp-review-v1:${"e".repeat(64)}`, decision: "approved" };
    expect(await persistMcpMutation(f.context, { kind: "set-review", record: review })).toMatchObject({ state: "committed" });
    expect((JSON.parse(fs.readFileSync(path.join(f.project, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers).toHaveProperty(name);
    const captured = await readMcpReviewState({ store: f.store, checkoutFamilyKey: f.context.checkoutFamilyKey }); expect(captured.ok && captured.value.records[0]?.serverName).toBe(name);
    for (const scope of ["project", "user", "local"] as const) expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope, name })).toMatchObject({ state: "committed", effect: "changed" });
    for (const scope of ["project", "user", "local"] as const) {
      expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope, name: "__proto__", definition: { command: "run" } }), `${scope} add`).toMatchObject({ state: "committed", effect: "changed" });
      const root = JSON.parse(fs.readFileSync(scope === "project" ? path.join(f.project, ".mcp.json") : f.profile, "utf8")) as Record<string, unknown>;
      const servers = scope === "project" ? (root.mcpServers as Record<string, unknown>) : scope === "user" ? (root.mcpServers as Record<string, unknown>) : ((root.projects as Record<string, Record<string, unknown>>)[fs.realpathSync.native(f.project)]!.mcpServers as Record<string, unknown>);
      expect(Object.hasOwn(servers, "__proto__")).toBe(true); expect(servers.__proto__).toEqual({ command: "run" });
      expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope, name: "__proto__" }), `${scope} remove`).toMatchObject({ state: "committed", effect: "changed" });
    }
    for (const invalid of ["bad\u0000name", "x".repeat(129), "workspace", "claude-in-chrome", "computer-use", "Claude Preview", "Claude Browser"]) expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: invalid, definition: { command: "run" } })).toMatchObject({ state: "rejected", reasonCode: "invalid-input" });
    fs.writeFileSync(path.join(f.project, ".mcp.json"), JSON.stringify({ mcpServers: { workspace: { command: "external" } } }));
    expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope: "project", name: "workspace" })).toMatchObject({ state: "committed", effect: "changed" });
  });

  it("authenticates a broad-name durable add even when the loader retains it as skipped without a review digest", async () => {
    const f = await fixture(); const name = "broad name__skipped"; const declaration = { name, source: "project-mcpjson" as const, authority: { kind: "mutable" as const, scope: "project" as const }, precedence: "winner" as const, summary: { transport: "stdio" as const, commandBasename: "run", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 0, timeoutConfigured: false }, policy: "allowed" as const, review: "pending" as const, status: "skipped" as const };
    let assembly = 0; const service = createMcpAdministrationService({ inspectPending: async () => ({ pending: false, status: "clear" }), recover: async () => ({ state: "committed", retrySafe: true, effect: "unchanged", cleanup: "complete" }), mutate: (mutation) => persistMcpMutation(f.context, mutation), assemble: () => ({ reviewIdentity: { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey }, mcp: { servers: [], diagnostics: [], administration: { version: 1, policyPosture: "absent", observations: [], declarations: assembly++ === 0 ? [] : [declaration], omittedDeclarationCount: 0 } } as ResolvedMcpConfig }) });
    await expect(service.execute({ kind: "add", scope: "project", name, definition: { command: "run" } })).resolves.toMatchObject({ eligibility: { eligible: true }, durable: { state: "committed" }, runtime: { state: "not-requested" } });
  });

  it("supports project and private review state without a native profile while native scopes fail unchanged", async () => {
    const f = await fixture(); fs.rmSync(f.profile);
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "project", definition: { command: "run" } })).toMatchObject({ state: "committed", effect: "changed" });
    const review = { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, source: "project-mcpjson" as const, serverName: "project", definitionVersion: 1 as const, definitionDigest: `mcp-review-v1:${"d".repeat(64)}`, decision: "approved" as const };
    expect(await persistMcpMutation(f.context, { kind: "set-review", record: review })).toMatchObject({ state: "committed", effect: "changed" });
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name: "user", definition: { command: "run" } })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "invalid-state" });
    expect(fs.existsSync(f.profile)).toBe(false);
  });

  it("rejects malformed native blocks, unsafe definitions, and exact no-ops without writes", async () => {
    for (const kind of ["servers", "projects", "disabled"] as const) {
      const f = await fixture(); const malformed = kind === "servers" ? { mcpServers: [] } : kind === "projects" ? { projects: [] } : { projects: { [fs.realpathSync.native(f.project)]: { disabledMcpServers: "bad" } } }; fs.writeFileSync(f.profile, JSON.stringify(malformed));
      const mutation = kind === "servers" ? { kind: "set-declaration" as const, scope: "user" as const, name: "safe", definition: { command: "run" } }
        : { kind: "set-runtime-disabled" as const, name: "safe", disabled: true };
      expect(await persistMcpMutation(f.context, mutation)).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "invalid-state" }); expect(JSON.parse(fs.readFileSync(f.profile, "utf8"))).toEqual(malformed);
    }
    const f = await fixture(); let getterCalls = 0; const accessor = Object.defineProperty({}, "command", { enumerable: true, get() { getterCalls += 1; return "secret"; } });
    const cyclic: Record<string, unknown> = { command: "run" }; cyclic.self = cyclic; const excessiveArrays = { command: "run", material: Array.from({ length: 100 }, () => Array(100).fill(0)) }; const sparse = new Array(2); sparse[0] = "run"; const customPrototype = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { command: "run" });
    for (const definition of [accessor, cyclic, excessiveArrays, { command: 42 }, { command: "x".repeat(1024 * 1024) }, Infinity as unknown as Record<string, unknown>, sparse as unknown as Record<string, unknown>, customPrototype]) { const beforeProfile = fs.readFileSync(f.profile); expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "bad", definition })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "invalid-input" }); expect(fs.readFileSync(f.profile)).toEqual(beforeProfile); expect(fs.existsSync(path.join(f.project, ".mcp.json"))).toBe(false); expect(fs.readdirSync(f.store.journalsRoot)).toEqual([]); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]); expect(fs.readdirSync(f.store.receiptsRoot)).toEqual([]); }
    expect(getterCalls).toBe(0);
    const protoDefinition = JSON.parse('{"command":"run","__proto__":{"inert":true}}') as Record<string, unknown>; expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "proto", definition: protoDefinition })).toMatchObject({ state: "committed", effect: "changed" }); expect((JSON.parse(fs.readFileSync(path.join(f.project, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers.proto).toEqual(protoDefinition);
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } })).toMatchObject({ state: "committed", effect: "changed" });
    const receipts = fs.readdirSync(f.store.receiptsRoot).length; const bytes = fs.readFileSync(path.join(f.project, ".mcp.json"));
    const noOp = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } }); expect(noOp).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "already-exists" }); expect(noOp).not.toHaveProperty("operationId");
    expect(fs.readdirSync(f.store.receiptsRoot)).toHaveLength(receipts); expect(fs.readFileSync(path.join(f.project, ".mcp.json"))).toEqual(bytes); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]);
    const nativeBefore = fs.readFileSync(f.profile); expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope: "local", name: "absent" })).toMatchObject({ state: "committed", effect: "unchanged", reasonCode: "no-op" }); expect(await persistMcpMutation(f.context, { kind: "set-runtime-disabled", name: "absent", disabled: false })).toMatchObject({ state: "committed", effect: "unchanged", reasonCode: "no-op" }); expect(fs.readFileSync(f.profile)).toEqual(nativeBefore);
  });

  it("preserves formatting and neighbors, enables by exact disabled-name removal, and resets the whole private family", async () => {
    const f = await fixture(); const projectFile = path.join(f.project, ".mcp.json"); fs.writeFileSync(projectFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n\t"future": true,\r\n\t"mcpServers": {\r\n\t\t"same": {"command":"old"},\r\n\t\t"neighbor": {"command":"keep"}\r\n\t}\r\n}\r\n')])); const initialProjectMode = fs.statSync(projectFile).mode & 0o777;
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "same", definition: { command: "new" } })).toMatchObject({ state: "rejected", reasonCode: "already-exists" }); const formatted = fs.readFileSync(projectFile); expect(formatted.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); expect(formatted.toString()).toContain("\r\n\t"); expect(formatted.toString()).toContain('"neighbor"'); expect(formatted.toString().endsWith("\r\n")).toBe(true);
    fs.writeFileSync(f.profile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{\r\n\t"future": {"keep":true}\r\n}\r\n')]));
    const readFormattedNative = () => { const bytes = fs.readFileSync(f.profile); expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); const text = bytes.subarray(3).toString("utf8"); expect(text).toContain("\r\n\t"); expect(text.endsWith("\r\n")).toBe(true); return JSON.parse(text) as { future: unknown; projects: Record<string, { disabledMcpServers: string[]; enabledMcpServers?: unknown }> }; };
    expect((await persistMcpMutation(f.context, { kind: "set-runtime-disabled", name: "same", disabled: true })).state).toBe("committed"); let local = readFormattedNative().projects[fs.realpathSync.native(f.project)]!; expect(local.disabledMcpServers).toEqual(["same"]); expect(local).not.toHaveProperty("enabledMcpServers");
    expect((await persistMcpMutation(f.context, { kind: "set-runtime-disabled", name: "neighbor", disabled: true })).state).toBe("committed"); local = readFormattedNative().projects[fs.realpathSync.native(f.project)]!; expect(local.disabledMcpServers).toEqual(["same", "neighbor"]); expect(local).not.toHaveProperty("enabledMcpServers");
    expect((await persistMcpMutation(f.context, { kind: "set-runtime-disabled", name: "same", disabled: false })).state).toBe("committed"); const native = readFormattedNative(); local = native.projects[fs.realpathSync.native(f.project)]!; expect(local.disabledMcpServers).toEqual(["neighbor"]); expect(local).not.toHaveProperty("enabledMcpServers"); expect(native.future).toEqual({ keep: true });
    const base = { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, definitionVersion: 1 as const, decision: "approved" as const };
    const otherFamily = `checkout-${"e".repeat(43)}`; const otherContext = { ...f.context, checkoutFamilyKey: otherFamily, revalidateAuthority: () => ({ ok: true as const, value: { profileKey: f.store.profileKey, checkoutFamilyKey: otherFamily, authorityFingerprint: f.context.authorityFingerprint } }) }; const otherRecord: McpReviewRecord = { ...base, checkoutFamilyKey: otherFamily, source: "project-mcpjson", serverName: "neighbor-family", definitionDigest: `mcp-review-v1:${"3".repeat(64)}` }; expect((await persistMcpMutation(otherContext, { kind: "set-review", record: otherRecord })).state).toBe("committed");
    await persistMcpMutation(f.context, { kind: "set-review", record: { ...base, source: "project-mcpjson", serverName: "ordinary", definitionDigest: `mcp-review-v1:${"1".repeat(64)}` } });
    await persistMcpMutation(f.context, { kind: "set-review", record: { ...base, source: "subagent-inline", serverName: "agent", agentOwner: { name: "worker", scope: "project" }, definitionDigest: `mcp-review-v1:${"2".repeat(64)}` } });
    expect((await persistMcpMutation(f.context, { kind: "reset-review" })).state).toBe("committed"); const reset = await readMcpReviewState({ store: f.store, checkoutFamilyKey: f.context.checkoutFamilyKey }); if (!reset.ok) throw new Error(reset.message); expect(reset.value.records).toEqual([]); const neighboring = await readMcpReviewState({ store: f.store, checkoutFamilyKey: otherFamily }); if (!neighboring.ok) throw new Error(neighboring.message); expect(neighboring.value.records).toEqual([otherRecord]); const projectAfterReset = fs.readFileSync(projectFile).toString(); const nativeBytesAfterReset = fs.readFileSync(f.profile); expect(nativeBytesAfterReset.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf])); expect(nativeBytesAfterReset.toString()).toContain("\r\n\t"); const nativeAfterReset = JSON.parse(nativeBytesAfterReset.subarray(3).toString("utf8")) as { future: unknown; projects: Record<string, { disabledMcpServers: string[] }> }; expect(projectAfterReset).toContain("neighbor"); expect(nativeAfterReset.projects[fs.realpathSync.native(f.project)]!.disabledMcpServers).toEqual(["neighbor"]); expect(nativeAfterReset.future).toEqual({ keep: true }); if (process.platform !== "win32") expect(fs.statSync(projectFile).mode & 0o777).toBe(initialProjectMode);
  });

  it("uses one flat authenticated review target and leaves no setup residue before journaling", async () => {
    const f = await fixture(); const selected = mcpReviewStatePath(f.store, f.context.checkoutFamilyKey); if (!selected.ok) throw new Error(selected.message);
    expect(path.dirname(selected.value)).toBe(f.store.recordsRoot); const before = fs.readdirSync(f.store.recordsRoot);
    expect(await persistMcpMutation(f.context, { kind: "reset-review" })).toMatchObject({ state: "committed", effect: "unchanged", cleanup: "complete", retrySafe: true, reasonCode: "no-op" });
    expect(fs.readdirSync(f.store.recordsRoot)).toEqual(before); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]); expect(fs.readdirSync(f.store.receiptsRoot)).toEqual([]);
  });

  it("mutates user scope without selecting malformed projects and preserves that unrelated value", async () => {
    const f = await fixture(); const malformedProjects = ["opaque", { nested: true }]; fs.writeFileSync(f.profile, JSON.stringify({ projects: malformedProjects, mcpServers: { neighbor: { command: "keep" } }, canary: true }) + "\n");
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name: "same", definition: { command: "one" } })).toMatchObject({ state: "committed", effect: "changed" });
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "user", name: "same", definition: { command: "two" } })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "already-exists" });
    expect(await persistMcpMutation(f.context, { kind: "remove-declaration", scope: "user", name: "same" })).toMatchObject({ state: "committed", effect: "changed" });
    const result = JSON.parse(fs.readFileSync(f.profile, "utf8")) as Record<string, unknown>; expect(result.projects).toEqual(malformedProjects); expect(result).toMatchObject({ mcpServers: { neighbor: { command: "keep" } }, canary: true });
  });

  it("mutates one authentic noncanonical native key and rejects canonical-equivalent aliases", async () => {
    const f = await fixture(); const canonical = fs.realpathSync.native(f.project); const alias = path.join(f.root, "alias-key"); const canonicalizeProject = () => ({ kind: "canonical" as const, path: canonical }); const context = { ...f.context, canonicalizeProject };
    fs.writeFileSync(f.profile, JSON.stringify({ projects: { [alias]: { future: "keep", mcpServers: { old: { command: "old" } } } } })); expect((await persistMcpMutation(context, { kind: "set-declaration", scope: "local", name: "new", definition: { command: "new" } })).state).toBe("committed"); const one = JSON.parse(fs.readFileSync(f.profile, "utf8")) as { projects: Record<string, unknown> }; expect(Object.keys(one.projects)).toEqual([alias]); expect(one.projects[alias]).toMatchObject({ future: "keep", mcpServers: { old: { command: "old" }, new: { command: "new" } } });
    fs.writeFileSync(f.profile, JSON.stringify({ projects: { [alias]: { mcpServers: {} }, [canonical]: { mcpServers: {} } } })); const before = fs.readFileSync(f.profile); const ambiguous = await persistMcpMutation(context, { kind: "set-declaration", scope: "local", name: "blocked", definition: { command: "run" } }); expect(ambiguous).toEqual({ state: "rejected", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "ambiguous-project-state", reason: "Consolidate or remove canonical-equivalent project entries in the selected .claude.json" }); expect(JSON.stringify(ambiguous)).not.toContain(alias); expect(JSON.stringify(ambiguous)).not.toContain(canonical); expect(fs.readFileSync(f.profile)).toEqual(before);
  });

  it("validates review records descriptor-safely and detects review CAS loss from the authenticated capture", async () => {
    const f = await fixture(); const valid: McpReviewRecord = { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, source: "project-mcpjson", serverName: "safe", definitionVersion: 1, definitionDigest: `mcp-review-v1:${"5".repeat(64)}`, decision: "approved" };
    const invalid = { ...valid, definitionDigest: "bad" } as unknown as McpReviewRecord; expect(await persistMcpMutation(f.context, { kind: "set-review", record: invalid })).toMatchObject({ state: "rejected", reasonCode: "invalid-input" });
    let getterCalls = 0; const getter = Object.defineProperty({ ...valid }, "serverName", { enumerable: true, get() { getterCalls += 1; return "unsafe"; } }) as McpReviewRecord;
    const cyclic = { ...valid } as unknown as McpReviewRecord & { self?: unknown }; cyclic.self = cyclic; const symbolic = { ...valid, [Symbol("unsafe")]: true } as McpReviewRecord;
    for (const record of [getter, cyclic, symbolic]) expect(await persistMcpMutation(f.context, { kind: "set-review", record })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "invalid-input" }); expect(getterCalls).toBe(0);
    const first = await persistMcpMutation(f.context, { kind: "set-review", record: valid }); expect(first.state).toBe("committed"); const selectedPath = mcpReviewStatePath(f.store, f.context.checkoutFamilyKey); if (!selectedPath.ok) throw new Error(selectedPath.message); const reviewPath = selectedPath.value;
    const changed = JSON.stringify({ version: 1, profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, records: [] }) + "\n";
    const result = await persistMcpMutation(f.context, { kind: "set-review", record: { ...valid, decision: "rejected" } }, { faults: { hit(phase) { if (phase === "after-journal") fs.writeFileSync(reviewPath, changed); } } });
    expect(result).toMatchObject({ state: "failed-before-commit", effect: "unchanged", reasonCode: "stale" }); expect(fs.readFileSync(reviewPath, "utf8")).toBe(changed);
  });

  it("preserves a competing exact-scope declaration introduced after the create read", async () => {
    const f = await fixture(); const target = path.join(f.project, ".mcp.json"); const competing = Buffer.from('{"mcpServers":{"raced":{"command":"competitor"}},"canary":true}\n');
    const result = await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "raced", definition: { command: "requested" } }, { faults: { hit(phase) { if (phase === "after-journal") fs.writeFileSync(target, competing); } } });
    expect(result).toMatchObject({ state: "failed-before-commit", effect: "unchanged", reasonCode: "stale" }); expect(fs.readFileSync(target)).toEqual(competing);
  });

  it("rejects valid output expansion beyond the reader limit without transaction residue", async () => {
    const f = await fixture(); const target = path.join(f.project, ".mcp.json"); const shell = JSON.stringify({ padding: "" }) + "\n"; const original = Buffer.from(JSON.stringify({ padding: "x".repeat(1024 * 1024 - Buffer.byteLength(shell) - 10) }) + "\n"); expect(original.byteLength).toBe(1024 * 1024 - 10); fs.writeFileSync(target, original);
    expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "valid", definition: { command: "run" } })).toEqual({ state: "rejected", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "invalid-state", reason: "The target MCP state is malformed or unsafe" });
    expect(fs.readFileSync(target)).toEqual(original); expect(fs.readdirSync(f.store.journalsRoot)).toEqual([]); expect(fs.readdirSync(f.store.stagingRoot)).toEqual([]); expect(fs.readdirSync(f.store.receiptsRoot)).toEqual([]);
  });

  it("rejects malformed UTF-8, oversized, and non-regular persisted targets unchanged", async () => {
    for (const bytes of [Buffer.from([0xff, 0xfe, 0xfd]), Buffer.alloc(1024 * 1024 + 1, 0x20)]) {
      const f = await fixture(); const target = path.join(f.project, ".mcp.json"); fs.writeFileSync(target, bytes); expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } })).toMatchObject({ state: "rejected", effect: "unchanged", cleanup: "complete", reasonCode: "invalid-state" }); expect(fs.readFileSync(target)).toEqual(bytes);
    }
    const f = await fixture(); const target = path.join(f.project, ".mcp.json"); fs.mkdirSync(target); expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } })).toMatchObject({ state: "rejected", effect: "unchanged", reasonCode: "invalid-state" }); expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("rejects alias and hardlink targets and stale authority without exposing canaries", async () => {
    const f = await fixture(); const outside = path.join(f.root, "outside"); fs.writeFileSync(outside, '{"mcpServers":{}}'); const target = path.join(f.project, ".mcp.json");
    try { fs.symlinkSync(outside, target, "file"); } catch (error) { const code = (error as NodeJS.ErrnoException).code; if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP"].includes(code ?? "")) throw error; }
    if (fs.existsSync(target)) { expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } })).toMatchObject({ state: "rejected", effect: "unchanged" }); expect(fs.readFileSync(outside, "utf8")).toBe('{"mcpServers":{}}'); fs.rmSync(target); }
    fs.linkSync(outside, target); expect(await persistMcpMutation(f.context, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "run" } })).toMatchObject({ state: "rejected", effect: "unchanged" }); expect(fs.readFileSync(outside, "utf8")).toBe('{"mcpServers":{}}'); fs.rmSync(target);
    const stale = { ...f.context, revalidateAuthority: () => ({ ok: true as const, value: { profileKey: f.store.profileKey, checkoutFamilyKey: f.context.checkoutFamilyKey, authorityFingerprint: `sha256:${"9".repeat(64)}` } }) };
    expect(await persistMcpMutation(stale, { kind: "set-declaration", scope: "project", name: "safe", definition: { command: "SECRET_CANARY" } })).toMatchObject({ state: "rejected", reasonCode: "invalid-authority" }); expect(JSON.stringify(await persistMcpMutation(stale, { kind: "remove-declaration", scope: "project", name: "safe" }))).not.toContain("SECRET_CANARY");
  });

  it("shares family review state across a real linked worktree and invalidates approval by digest", async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-mcp-linked-"))); roots.push(root); const main = path.join(root, "main"); const linked = path.join(root, "linked");
    fs.mkdirSync(main); execFileSync("git", ["init"], { cwd: main, stdio: "pipe" }); fs.writeFileSync(path.join(main, ".mcp.json"), '{"mcpServers":{"shared":{"command":"old"}}}\n'); execFileSync("git", ["add", ".mcp.json"], { cwd: main }); execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-m", "seed"], { cwd: main, stdio: "pipe" });
    execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: main, stdio: "pipe" });
    try {
      const mainIdentities = projectIdentities(main); const linkedIdentities = projectIdentities(linked); expect(mainIdentities[0]).toBe(linkedIdentities[0]);
      const f = await fixture(main);
      const composeContext = async (projectRoot: string, identities: readonly string[]) => {
        const locations = createMcpLifecycleLocations({ homeDir: f.home, profilePath: f.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: identities.at(-1)!, checkoutFamilyPath: identities[0]! } });
        if (!locations.ok || locations.value.checkoutFamilyKey === undefined) throw new Error("locations");
        const store = await establishOwnedStateStore(locations.value, f.home); if (!store.ok) throw new Error(store.message);
        const checkoutFamilyKey = locations.value.checkoutFamilyKey;
        const authorityFingerprint = f.context.authorityFingerprint;
        return { store: store.value, profilePath: f.profile, projectRoot, checkoutFamilyKey, authorityFingerprint,
          identifyProject: () => projectIdentities(projectRoot),
          revalidateAuthority: () => {
            const freshIdentities = projectIdentities(projectRoot); const freshLocations = createMcpLifecycleLocations({ homeDir: f.home, profilePath: f.profile, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: freshIdentities.at(-1)!, checkoutFamilyPath: freshIdentities[0]! } });
            if (!freshLocations.ok || freshLocations.value.profileKey !== store.value.profileKey || freshLocations.value.checkoutFamilyKey !== checkoutFamilyKey) return { ok: false as const, code: "changed-authority", message: "changed" };
            return { ok: true as const, value: { profileKey: store.value.profileKey, checkoutFamilyKey, authorityFingerprint } };
          } };
      };
      const mainContext = await composeContext(main, mainIdentities); const linkedContext = await composeContext(linked, linkedIdentities);
      expect(linkedContext.checkoutFamilyKey).toBe(mainContext.checkoutFamilyKey); expect(linkedContext.authorityFingerprint).toBe(mainContext.authorityFingerprint);
      const oldEntry = normalizeMcpServerBlock({ shared: { command: "old" } }, "linked fixture")[0]!; const oldDigest = createMcpReviewDefinitionDigest(oldEntry)!;
      const identity = { profileKey: mainContext.store.profileKey, checkoutFamilyKey: mainContext.checkoutFamilyKey, source: "project-mcpjson" as const, serverName: "shared" }; const approved = { ...identity, definitionVersion: 1 as const, definitionDigest: oldDigest, decision: "approved" as const };
      expect((await persistMcpMutation(mainContext, { kind: "set-review", record: approved })).state).toBe("committed"); const fromLinked = await readMcpReviewState({ store: linkedContext.store, checkoutFamilyKey: linkedContext.checkoutFamilyKey }); if (!fromLinked.ok) throw new Error(fromLinked.message); expect(matchesMcpReviewRecord(fromLinked.value.records[0]!, identity, oldDigest)).toBe(true);
      expect((await persistMcpMutation(mainContext, { kind: "remove-declaration", scope: "project", name: "shared" })).state).toBe("committed");
      expect(await persistMcpMutation(mainContext, { kind: "set-declaration", scope: "project", name: "shared", definition: { command: "pending-main" } }, { faults: { hit(phase) { if (phase === "after-replacement") throw new Error("pending"); } } })).toMatchObject({ state: "pending-recovery", effect: "uncertain", cleanup: "pending", retrySafe: false });
      const journalNames = fs.readdirSync(linkedContext.store.journalsRoot); expect(journalNames).toHaveLength(1);
      const uncertainContext = { ...linkedContext, revalidateAuthority: () => ({ ok: false as const, code: "changed-authority", message: "SECRET_PATH_CANARY" }) };
      expect(await recoverMcpPendingOperation(uncertainContext)).toEqual({ state: "pending-recovery", operationId: expect.any(String), retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: "MCP rollback remains pending and blocks new writes" });
      expect(fs.readdirSync(linkedContext.store.journalsRoot)).toEqual(journalNames);
      expect(JSON.stringify(await recoverMcpPendingOperation(uncertainContext))).not.toContain("SECRET_PATH_CANARY");
      expect(await recoverMcpPendingOperation(linkedContext)).toMatchObject({ state: "rolled-back", effect: "unchanged", cleanup: "complete" }); expect(fs.readFileSync(path.join(main, ".mcp.json"), "utf8")).not.toContain("pending-main"); expect(fs.existsSync(path.join(linked, ".mcp.json"))).toBe(true);
      expect((await persistMcpMutation(mainContext, { kind: "set-declaration", scope: "project", name: "shared", definition: { command: "changed-main" } })).state).toBe("committed"); expect((await persistMcpMutation(linkedContext, { kind: "remove-declaration", scope: "project", name: "shared" })).state).toBe("committed"); expect((await persistMcpMutation(linkedContext, { kind: "set-declaration", scope: "project", name: "shared", definition: { command: "changed-linked" } })).state).toBe("committed");
      const mainChanged = createMcpReviewDefinitionDigest(normalizeMcpServerBlock((JSON.parse(fs.readFileSync(path.join(main, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers, "main changed")[0]!)!; const linkedChanged = createMcpReviewDefinitionDigest(normalizeMcpServerBlock((JSON.parse(fs.readFileSync(path.join(linked, ".mcp.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers, "linked changed")[0]!)!;
      expect(matchesMcpReviewRecord(fromLinked.value.records[0]!, identity, mainChanged)).toBe(false); expect(matchesMcpReviewRecord(fromLinked.value.records[0]!, identity, linkedChanged)).toBe(false);
    } finally { try { execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: main, stdio: "pipe" }); } catch { fs.rmSync(linked, { recursive: true, force: true }); } }
  });
});
