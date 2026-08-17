import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { McpAdministrationInventory, McpAdministrationInventoryItem } from "../src/mcp-administration/model.js";
import type { McpAdministrationInteractivePreparation, McpAdministrationReasonCode, McpAdministrationResult } from "../src/mcp-administration/service.js";
import { McpAdministrationFocusController, openMcpAdministration, type McpAdministrationOpenResult } from "../src/runtime/mcp-administration-focus.js";
import { MCP_ADMINISTRATION_ACTIONS, mcpAdministrationConfirmationLines, mcpAdministrationReasonGuidance, orderMcpAdministrationServers, renderMcpAdministration, type McpAdministrationUiAction } from "../src/runtime/mcp-administration-render.js";
import { deferred, waitUntil } from "./helpers/async.js";

const CANARY = "TOP-SECRET-CANARY";
const ESC = "\u001b";
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const theme = { fg: (_role: string, text: string) => text };
const text = (lines: readonly string[]): string => lines.join("\n");
const normalized = (lines: readonly string[]): string => text(lines).replace(/\s+/gu, " ");

function server(name: string, patch: Partial<McpAdministrationInventoryItem> = {}): McpAdministrationInventoryItem {
  return {
    name, source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "winner",
    summary: { transport: "stdio", commandBasename: "safe-command", argumentCount: 2, environmentKeyCount: 1, headerKeyCount: 0, timeoutConfigured: false },
    policy: "allowed", review: "pending", status: "pending-approval", live: "not-running",
    capabilityCounts: { tools: 0, prompts: 0, resources: 0 }, ...patch,
  };
}

function inventory(servers: readonly McpAdministrationInventoryItem[]): McpAdministrationInventory {
  return { version: 1, policyPosture: "active-rules", observations: [], servers, omittedDeclarationCount: 0 };
}

function withCanaries<T>(value: T): T {
  if (Array.isArray(value)) {
    const result = value.map(withCanaries) as unknown as T;
    Object.defineProperty(result as object, "secretCanary", { value: CANARY, enumerable: true });
    return result;
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value as Record<string, unknown>)) output[key] = withCanaries(field);
    output.secretCanary = CANARY;
    return output as T;
  }
  return value;
}

function preparation(snapshot: McpAdministrationInventory, reasonCode: McpAdministrationReasonCode = "eligible"): McpAdministrationInteractivePreparation {
  const value = withCanaries({ inventory: snapshot, eligibility: { eligible: reasonCode === "eligible", reasonCode } });
  return reasonCode === "eligible" ? { ...value, authority: Object.freeze({}) as never } : value;
}

function actionResult(snapshot: McpAdministrationInventory, options: { changed?: boolean; reason?: McpAdministrationReasonCode } = {}): McpAdministrationResult {
  const reason = options.reason ?? "eligible";
  return withCanaries({
    inventory: snapshot, eligibility: { eligible: reason === "eligible", reasonCode: reason },
    recovery: { state: "not-requested" },
    durable: options.changed ? { state: "committed", retrySafe: false, effect: "changed", cleanup: "complete" } : { state: "not-requested" },
    runtime: options.changed ? { state: "succeeded" } : { state: "not-requested" }, exposure: { state: "not-requested" },
  });
}

function outcomeResult(snapshot: McpAdministrationInventory, patch: Partial<Pick<McpAdministrationResult, "recovery" | "durable" | "runtime" | "exposure">>): McpAdministrationResult {
  return withCanaries({
    inventory: snapshot, eligibility: { eligible: true, reasonCode: "eligible" },
    recovery: { state: "not-requested" }, durable: { state: "not-requested" }, runtime: { state: "not-requested" }, exposure: { state: "not-requested" },
    ...patch,
  } as McpAdministrationResult);
}

type Port = {
  inventory: ReturnType<typeof vi.fn<() => Promise<McpAdministrationInventory>>>;
  interactivePrepare: ReturnType<typeof vi.fn<(selector: never, action: McpAdministrationUiAction) => Promise<McpAdministrationInteractivePreparation>>>;
  confirmedExecute: ReturnType<typeof vi.fn<(authority: never) => Promise<McpAdministrationResult>>>;
};

function port(snapshot: McpAdministrationInventory, reasons: Partial<Record<McpAdministrationUiAction, McpAdministrationReasonCode>> = {}): Port {
  return {
    inventory: vi.fn(async () => withCanaries(snapshot)),
    interactivePrepare: vi.fn(async (_selector, action) => preparation(snapshot, reasons[action] ?? (action === "authenticate" ? "authentication-deferred" : "eligible"))),
    confirmedExecute: vi.fn(async () => actionResult(snapshot, { changed: true })),
  };
}

function controller(snapshot: McpAdministrationInventory, service = port(snapshot), options: { done?: (result: McpAdministrationOpenResult) => void; render?: typeof renderMcpAdministration; requestRender?: () => void; theme?: unknown } = {}) {
  return new McpAdministrationFocusController({ inventory: withCanaries(snapshot), port: service as never, tui: { requestRender: options.requestRender ?? (() => {}) }, theme: options.theme ?? theme, done: options.done ?? (() => {}), ...(options.render === undefined ? {} : { render: options.render }) });
}

async function enterReadyDetail(component: McpAdministrationFocusController): Promise<void> {
  component.handleInput("\r");
  await waitUntil({ description: "all administration action previews", predicate: () => {
    const phase = component.view().phase;
    return phase.kind === "detail" && phase.actions.every((action) => !action.pending);
  } });
}

function selectAction(component: McpAdministrationFocusController, action: McpAdministrationUiAction): void {
  const phase = component.view().phase;
  expect(phase.kind).toBe("detail");
  if (phase.kind !== "detail") return;
  const target = MCP_ADMINISTRATION_ACTIONS.indexOf(action);
  while (true) { const current = component.view().phase; if (current.kind !== "detail" || current.actionIndex >= target) break; component.handleInput("\u001b[B"); }
  while (true) { const current = component.view().phase; if (current.kind !== "detail" || current.actionIndex <= target) break; component.handleInput("\u001b[A"); }
}

function recursivelyExpectNoCanary(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(CANARY);
}

describe("MCP administration focused UI", () => {
  it("groups by safe priority, retains exact same-name owner identity, and renders bounded safe details", async () => {
    const values = [
      server("blocked", { policy: "policy-denied", status: "blocked", review: "not-required" }),
      server("same", { review: "not-required", status: "enabled", live: "connected", agentOwner: { name: "agent-a", scope: "project" }, summary: { transport: "http", configuredType: "streamable-http", remoteOrigin: "https://secret", argumentCount: 2, environmentKeyCount: 1, headerKeyCount: 0, timeoutConfigured: false }, capabilityCounts: { tools: 3, prompts: 2, resources: 1 } }),
      server("disabled", { review: "not-required", status: "disabled", inactiveReason: "native-runtime-disabled" }),
      server("failed", { review: "not-required", status: "enabled", live: "failed" }),
      server("same", { agentOwner: { name: "agent-b", scope: "user" } }),
      server("connecting", { review: "approved-exact", status: "enabled", live: "connecting" }),
    ];
    expect(orderMcpAdministrationServers(inventory(values)).map((value) => value.name)).toEqual(["same", "failed", "same", "connecting", "disabled", "blocked"]);
    const snap = inventory(values);
    const c = controller(snap);
    const list = normalized(c.render(72));
    for (const heading of ["Needs review:", "Failed / actionable:", "Connecting / connected:", "Disabled:", "Blocked / skipped:"]) expect(list).toContain(heading);
    expect(list).toContain("source project-mcpjson · mutable scope project · precedence winner · owner agent-b (user)");
    c.handleInput("\u001b[B"); c.handleInput("\u001b[B");
    await enterReadyDetail(c);
    expect(c.view().selectedIdentity).toEqual({ name: "same", source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "winner", agentOwner: { name: "agent-a", scope: "project" } });
    const detail = normalized(c.render(48));
    for (const expected of ["Identity/source/authority:", "Transport: http · configured streamable-http", "Declaration shape: arguments 2 · environment keys 1 · header keys 0 · timeout default", "Review:", "Live posture:", "Capabilities: tools 3 · prompts 2 · resources 1", "Actions (service eligibility):"]) expect(detail).toContain(expected);
    for (const forbidden of [CANARY, "raw arguments", "stderr", "exception", "https://secret", "JSON"]) expect(detail).not.toContain(forbidden);
    expect(c.view().orderedServers.findIndex((value) => value.agentOwner?.name === "agent-a")).toBe(2);
  });

  it("proves every service reason through the focused workflow with bounded fixed guidance", async () => {
    const reasons: McpAdministrationReasonCode[] = ["eligible", "recovery-pending", "cleanup-pending", "already-exists", "server-not-found", "scope-mismatch", "unsupported-source", "policy-blocked", "review-not-applicable", "compatibility-rejected", "definition-unavailable", "invalid-input", "stale-state", "not-effective", "not-disabled", "not-enabled", "not-failed", "unsupported-transport", "authentication-deferred", "authentication-unavailable", "durable-mutation-failed"];
    for (const reason of reasons) {
      const snap = inventory([server(`reason-${reason}`)]);
      const service = port(snap, { approve: reason });
      const c = controller(snap, service);
      await enterReadyDetail(c);
      c.handleInput("\r");
      if (reason === "eligible") {
        expect(c.view().phase.kind, reason).toBe("confirmation");
        expect(normalized(c.render(64)), reason).toContain("Confirm approve");
      } else {
        expect(c.view().phase.kind, reason).toBe("result");
        const rendered = normalized(c.render(64));
        expect(rendered, reason).toContain(mcpAdministrationReasonGuidance(reason));
        expect(rendered, reason).not.toContain(CANARY);
        expect(service.confirmedExecute, reason).not.toHaveBeenCalled();
      }
      expect(mcpAdministrationReasonGuidance(reason).length, reason).toBeLessThan(240);
    }
  });

  it("previews every action through only the injected service port and makes auth guidance inert", async () => {
    const snap = inventory([server("remote", { summary: { transport: "http", remoteOrigin: "https://example.test", argumentCount: 0, environmentKeyCount: 0, headerKeyCount: 2, timeoutConfigured: true } })]);
    const service = port(snap, { approve: "definition-unavailable", reject: "compatibility-rejected", enable: "not-disabled", disable: "not-enabled", reconnect: "not-failed", authenticate: "authentication-deferred" });
    const forbidden = vi.fn();
    const injected = new Proxy({ ...service, runtimeControl: forbidden, persistence: forbidden, files: forbidden, secrets: CANARY }, { get(target, key, receiver) { if (!["inventory", "interactivePrepare", "confirmedExecute"].includes(String(key))) forbidden(key); return Reflect.get(target, key, receiver); } });
    const c = controller(snap, injected as unknown as Port);
    await enterReadyDetail(c);
    expect(service.interactivePrepare.mock.calls.map(([, action]) => action)).toEqual(MCP_ADMINISTRATION_ACTIONS);
    for (const [index, action] of MCP_ADMINISTRATION_ACTIONS.entries()) {
      const phase = c.view().phase;
      expect(phase.kind === "detail" ? phase.actions[index]?.reasonCode : undefined).toBe(["definition-unavailable", "compatibility-rejected", "not-disabled", "not-enabled", "not-failed", "authentication-deferred"][index]);
      expect(phase.kind === "detail" ? phase.actions[index]?.eligible : undefined).toBe(false);
      expect(action).toBe(MCP_ADMINISTRATION_ACTIONS[index]);
    }
    selectAction(c, "authenticate");
    expect(normalized(c.render(80))).toContain("Authentication (not yet supported)…");
    c.handleInput("\r");
    const guidance = normalized(c.render(80));
    expect(guidance).toContain("authenticate:");
    expect(guidance).toContain("No browser opens, no secret is accepted, and nothing is stored");
    expect(service.confirmedExecute).not.toHaveBeenCalled();
    expect(forbidden).not.toHaveBeenCalled();
    expect(guidance).not.toContain(CANARY);
  });

  it("shows the complete distinguishing identity and help before width-16 confirmation submission", async () => {
    const owner = { name: "same-owner", scope: "project" as const };
    const first = server("same", { source: "native-user", authority: { kind: "mutable", scope: "user" }, precedence: "shadowed", agentOwner: owner });
    const second = server("same", { source: "project-mcpjson", authority: { kind: "mutable", scope: "project" }, precedence: "winner", agentOwner: owner });
    const snap = inventory([first, second]); const service = port(snap); const c = controller(snap, service);
    c.handleInput(DOWN); await enterReadyDetail(c); c.handleInput("\r");
    expect(c.view().phase.kind).toBe("confirmation");
    const lines = c.render(16); const compact = lines.join("").replace(/\s+/gu, ""); const readable = normalized(lines);
    for (const discriminator of ["Source: project-mcpjson", "Mutable scope: project", "Precedence: winner", "Owner: same-owner (project)"]) expect(compact).toContain(discriminator.replace(/\s+/gu, ""));
    expect(readable).toContain("Enter submits once"); expect(readable).toContain("Enter confirm");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
    expect(service.confirmedExecute).not.toHaveBeenCalled();
  });

  it("shows declaration/review/broad-grant, persistent/live, and reconnect non-bypass confirmations", () => {
    const exact = server("project", { review: "pending" });
    const approval = mcpAdministrationConfirmationLines(exact, "approve").join(" ");
    expect(approval).toMatch(/declaration remains unchanged.*exact reviewed definition and checkout family.*No trusted broad compatibility grant/su);
    expect(approval).toContain("source project-mcpjson · mutable scope project · precedence winner · owner ordinary session");
    expect(mcpAdministrationConfirmationLines({ ...exact, review: "approved-broad-name" }, "reject").join(" ")).toContain("trusted broad name grant");
    expect(mcpAdministrationConfirmationLines({ ...exact, review: "approved-broad-all" }, "approve").join(" ")).toContain("trusted broad all-server grant");
    for (const action of ["enable", "disable"] as const) {
      const copy = mcpAdministrationConfirmationLines(exact, action).join(" ");
      expect(copy).toContain("persistent native runtime choice"); expect(copy).toContain("Live effect:"); expect(copy).toContain("Durable, runtime, and capability-exposure outcomes remain separate");
    }
    const reconnect = mcpAdministrationConfirmationLines(exact, "reconnect").join(" ");
    expect(reconnect).toContain("changes no configuration or review decision");
    expect(reconnect).toContain("cannot bypass managed policy, project review, disablement, or current admission");
  });

  it.each(["approve", "reject", "enable", "disable", "reconnect"] as const)("confirms and executes %s exactly once", async (action) => {
    const snap = inventory([server("target")]);
    const service = port(snap);
    const c = controller(snap, service);
    await enterReadyDetail(c); selectAction(c, action); c.handleInput("\r");
    expect(c.view().phase.kind).toBe("confirmation");
    c.render(80);
    c.handleInput("\r"); c.handleInput("\r");
    await waitUntil({ description: `${action} result`, predicate: () => c.view().phase.kind === "result" });
    expect(service.confirmedExecute).toHaveBeenCalledOnce();
    expect(service.confirmedExecute.mock.calls[0]?.[0]).toEqual({});
    const settled = c.view().phase;
    recursivelyExpectNoCanary(settled.kind === "result" ? { action: settled.action, message: settled.message } : {});
  });

  it("cancels confirmations without execution and requires a visible confirmation repaint", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const c = controller(snap, service);
    await enterReadyDetail(c); c.handleInput("\r");
    c.handleInput("\r");
    expect(service.confirmedExecute).not.toHaveBeenCalled();
    c.render(80); c.handleInput(ESC);
    expect(c.view().phase.kind).toBe("detail"); expect(service.confirmedExecute).not.toHaveBeenCalled();
  });

  it("latches double submit, refreshes from fresh snapshots, and retains only exact identity", async () => {
    const initial = inventory([server("same", { agentOwner: { name: "a", scope: "project" } }), server("same", { agentOwner: { name: "b", scope: "project" } })]);
    const gate = deferred<McpAdministrationResult>(); const service = port(initial); service.confirmedExecute.mockImplementation(() => gate.promise);
    const c = controller(initial, service); c.handleInput(DOWN); await enterReadyDetail(c); selectAction(c, "approve"); c.handleInput("\r"); c.render(80); c.handleInput("\r"); c.handleInput("\r");
    expect(service.confirmedExecute).toHaveBeenCalledOnce();
    gate.resolve(actionResult(initial, { changed: true }));
    await waitUntil({ description: "settled double submit", predicate: () => c.view().phase.kind === "result" });
    expect(c.view().selectedIdentity).toMatchObject({ name: "same", source: "project-mcpjson", precedence: "winner", agentOwner: { name: "b", scope: "project" } });

    const fresh = inventory([server("other"), server("same", { agentOwner: { name: "b", scope: "project" }, review: "approved-exact" })]);
    service.inventory.mockResolvedValueOnce(withCanaries(fresh)); c.handleInput("r");
    await waitUntil({ description: "fresh snapshot", predicate: () => c.view().notice === "Fresh service snapshot loaded." });
    expect(service.inventory).toHaveBeenCalledOnce();
    expect(c.view().inventory.servers.map((value) => value.name)).toEqual(["other", "same"]); expect(c.view().selectedIdentity).toMatchObject({ name: "same", agentOwner: { name: "b", scope: "project" } });

    service.inventory.mockResolvedValueOnce(withCanaries(inventory([server("same", { agentOwner: { name: "a", scope: "project" } })]))); c.handleInput("r");
    await waitUntil({ description: "missing exact identity", predicate: () => c.view().notice === "The previously selected exact identity is no longer present." });
    expect(c.view().selectedIdentity).toBeUndefined();
  });

  it("cannot resurrect a closed or disposed UI from delayed preview, execute, or refresh results", async () => {
    const snap = inventory([server("target")]);
    const previewGate = deferred<McpAdministrationInteractivePreparation>(); const service = port(snap); service.interactivePrepare.mockImplementation(() => previewGate.promise);
    const done = vi.fn(); const c = controller(snap, service, { done }); c.handleInput("\r"); c.handleInput(ESC); c.handleInput(ESC);
    previewGate.resolve(preparation(snap)); await Promise.resolve(); await Promise.resolve();
    expect(done).toHaveBeenCalledOnce(); expect(c.view().phase.kind).toBe("list");

    const executeGate = deferred<McpAdministrationResult>(); const service2 = port(snap); service2.confirmedExecute.mockImplementation(() => executeGate.promise);
    const done2 = vi.fn(); const executing = controller(snap, service2, { done: done2 }); await enterReadyDetail(executing); executing.handleInput("\r"); executing.render(80); executing.handleInput("\r"); executing.handleInput(ESC);
    expect(done2).toHaveBeenCalledOnce(); executeGate.resolve(actionResult(snap, { changed: true })); await Promise.resolve(); await Promise.resolve();
    expect(executing.view().phase.kind).toBe("executing");

    const refreshGate = deferred<McpAdministrationInventory>(); const service3 = port(snap); service3.inventory.mockImplementation(() => refreshGate.promise);
    const disposed = controller(snap, service3); disposed.handleInput("r"); disposed.dispose(); refreshGate.resolve(inventory([server("replacement")])); await Promise.resolve(); await Promise.resolve();
    expect(disposed.view().inventory.servers.map((value) => value.name)).toEqual(["target"]);
  });

  it("uses semantic non-color selection/focus, drill-down scrolling, visible help, narrow bounds, and theme invalidation", async () => {
    const many = Array.from({ length: 14 }, (_, index) => server(`s${index}`, { review: index === 0 ? "pending" : "not-required", status: index % 2 ? "enabled" : "disabled", live: index % 2 ? "connected" : "not-running" }));
    const snap = inventory(many); const calls: string[] = [];
    const themed = { fg(role: string, value: string) { calls.push(`${role}:${value}`); return value; } };
    const c = controller(snap, port(snap), { theme: themed });
    let list = normalized(c.render(52));
    expect(list).toContain("> [selected]"); expect(list).toContain("↑/↓ navigate · Enter details · R refresh · Esc close"); expect(list).toContain("retained servers below");
    const priorCalls = calls.length; expect(c.render(52)).toBe(c.render(52)); expect(calls.length).toBe(priorCalls);
    c.invalidate(); c.render(52); expect(calls.length).toBeGreaterThan(priorCalls);
    await enterReadyDetail(c); list = normalized(c.render(30));
    expect(list).toContain("> [focused]"); expect(list).toContain("←/→ scroll details"); expect(c.view().phase.kind).toBe("detail");
    c.handleInput(RIGHT); const scrolled = c.view().phase; expect(scrolled.kind === "detail" ? scrolled.scroll : -1).toBeGreaterThanOrEqual(0);
    for (const width of [0, 1, 4, 7, 8, 12, 30, 80]) for (const line of c.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(normalized(c.render(12))).toContain("actions disabled");

    const long = inventory(Array.from({ length: 9 }, (_, index) => server(`${index}-${"x".repeat(120)}`)));
    const middle = controller(long);
    for (let index = 0; index < 4; index += 1) middle.handleInput(DOWN);
    const narrowSupported = normalized(middle.render(16));
    expect(narrowSupported).toContain("> [selected] 4-");
    expect(narrowSupported).toContain("4 retained servers above"); expect(narrowSupported).toContain("4 retained servers below");
    expect(narrowSupported).toContain("navigate · Enter details");
    expect(narrowSupported).not.toContain("> [selected] 3-");
  });

  it("returns bounded no-change outcomes for unavailable, snapshot, construction, render, repaint, close, and dispose failures", async () => {
    const snap = inventory([server("target")]); const service = port(snap);
    expect(await openMcpAdministration({ mode: "rpc", ui: {} }, service as never)).toMatchObject({ opened: false, changed: false, reason: "unavailable" });
    service.inventory.mockRejectedValueOnce(new Error(`${CANARY} snapshot`));
    recursivelyExpectNoCanary(await openMcpAdministration({ mode: "tui", ui: { custom: vi.fn() } }, service as never));
    service.inventory.mockResolvedValueOnce(withCanaries(snap));
    const forgedCustom = await openMcpAdministration({ mode: "tui", ui: { custom() { return { opened: true, changed: true, effect: "confirmed-changed", message: CANARY, secretCanary: CANARY } as never; } } }, service as never);
    expect(forgedCustom).toEqual({ opened: true, changed: false, effect: "confirmed-unchanged", message: "MCP administration closed; no action was started." });
    recursivelyExpectNoCanary(forgedCustom); expect(service.confirmedExecute).not.toHaveBeenCalled();
    service.inventory.mockResolvedValueOnce(withCanaries(snap));
    recursivelyExpectNoCanary(await openMcpAdministration({ mode: "tui", ui: { custom() { throw new Error(`${CANARY} construction`); } } }, service as never));
    service.inventory.mockResolvedValueOnce(withCanaries(snap));
    recursivelyExpectNoCanary(await openMcpAdministration({ mode: "tui", ui: { custom(factory) { const component = factory({}, theme, undefined, () => {}); component.dispose(); return Promise.reject(new Error(`${CANARY} disposal`)); } } }, service as never));

    let renderComponent: McpAdministrationFocusController | undefined;
    const rendered = openMcpAdministration({ mode: "tui", ui: { custom(factory) {
      return new Promise((resolve) => { renderComponent = factory({}, theme, undefined, resolve); renderComponent.render(40); });
    } } }, service as never, { render: () => { throw new Error(`${CANARY} render`); } });
    await waitUntil({ description: "render failure completion", predicate: () => renderComponent !== undefined });
    recursivelyExpectNoCanary(await rendered);
    expect(text(renderComponent!.render(40))).not.toContain(CANARY);
    expect(service.confirmedExecute).not.toHaveBeenCalled();

    const done = vi.fn().mockImplementationOnce(() => { throw new Error("close"); });
    const errors: unknown[] = []; const faulty = new McpAdministrationFocusController({ inventory: snap, port: service as never, tui: { requestRender() { throw new Error("repaint"); } }, theme, done, onError: (error) => errors.push(error) });
    faulty.handleInput(DOWN); faulty.handleInput(ESC); faulty.handleInput(ESC);
    expect(service.confirmedExecute).not.toHaveBeenCalled(); expect(errors.length).toBeGreaterThan(0); expect(done).toHaveBeenCalledOnce();
    expect(() => { faulty.dispose(); faulty.dispose(); }).not.toThrow();
  });

  it("honors configured up, down, confirm, and cancel bindings", async () => {
    const snap = inventory([server("first"), server("second")]); const service = port(snap); const done = vi.fn();
    const bindings = { matches: (data: string, id: string) => ({ n: "tui.select.down", p: "tui.select.up", y: "tui.select.confirm", x: "tui.select.cancel" }[data] === id) };
    const c = new McpAdministrationFocusController({ inventory: snap, port: service as never, tui: {}, theme, keybindings: bindings, done });
    c.handleInput("n"); expect(c.view().selectedIndex).toBe(1); c.handleInput("p"); expect(c.view().selectedIndex).toBe(0);
    c.handleInput("y"); await waitUntil({ description: "configured confirm detail", predicate: () => c.view().phase.kind === "detail" });
    c.handleInput("x"); expect(c.view().phase.kind).toBe("list");
    c.handleInput("y"); await waitUntil({ description: "configured confirm eligibility", predicate: () => { const phase = c.view().phase; return phase.kind === "detail" && phase.actions.every((action) => !action.pending); } });
    c.handleInput("y"); expect(c.view().phase.kind).toBe("confirmation"); c.render(60); c.handleInput("x");
    expect(c.view().phase.kind).toBe("detail"); expect(service.confirmedExecute).not.toHaveBeenCalled(); expect(done).not.toHaveBeenCalled();
  });

  it("uses a deterministic custom-UI harness and returns only fixed canary-free results", async () => {
    const snap = inventory([server("target")]); const service = port(snap); let component: McpAdministrationFocusController | undefined;
    const opened = openMcpAdministration({ mode: "tui", ui: { custom(factory, options) {
      expect(options).toBeUndefined();
      return new Promise((resolve) => { component = factory({ requestRender() {} }, theme, { matches: (data, id) => data === "q" && id === "tui.select.cancel" }, resolve); });
    } } }, service as never);
    await waitUntil({ description: "custom component construction", predicate: () => component !== undefined });
    component!.render(80); component!.handleInput("q");
    const result = await opened;
    expect(result).toEqual({ opened: true, changed: false, effect: "confirmed-unchanged", message: "MCP administration closed with no confirmed change." });
    recursivelyExpectNoCanary(result);
    expect(service.inventory).toHaveBeenCalledOnce(); expect(service.interactivePrepare).not.toHaveBeenCalled(); expect(service.confirmedExecute).not.toHaveBeenCalled();
  });
});

describe("MCP administration causal safety", () => {
  it("passes the full exact agent-owned selector to preparation and submits only its opaque authority", async () => {
    const owned = server("same", { source: "subagent-inline", authority: { kind: "read-only", sourceClass: "subagent-inline" }, agentOwner: { name: "worker", scope: "project" } });
    const snap = inventory([owned]); const service = port(snap); const c = controller(snap, service);
    await enterReadyDetail(c);
    expect(service.interactivePrepare.mock.calls[0]?.[0]).toEqual({ name: "same", source: "subagent-inline", authority: { kind: "read-only", sourceClass: "subagent-inline" }, precedence: "winner", agentOwner: { name: "worker", scope: "project" } });
    c.handleInput("\r"); c.render(60); c.handleInput("\r");
    await waitUntil({ description: "agent-owned confirmed result", predicate: () => c.view().phase.kind === "result" });
    expect(service.confirmedExecute).toHaveBeenCalledWith({});
    recursivelyExpectNoCanary(c.view());
  });

  it("keeps refresh and preview latches independent and permits a later refresh", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const gate = deferred<McpAdministrationInventory>();
    service.inventory.mockImplementationOnce(() => gate.promise);
    const c = controller(snap, service); c.handleInput("r"); expect(c.view().refreshing).toBe(true);
    c.handleInput("\r");
    await waitUntil({ description: "detail preview while refresh pending", predicate: () => { const phase = c.view().phase; return phase.kind === "detail" && phase.actions.every((value) => !value.pending); } });
    gate.resolve(inventory([server("stale-refresh")]));
    await waitUntil({ description: "refresh latch clears after stale result", predicate: () => !c.view().refreshing });
    expect(c.view().inventory.servers[0]?.name).toBe("target");
    c.handleInput(ESC); c.handleInput("r");
    await waitUntil({ description: "later refresh completes", predicate: () => c.view().notice === "Fresh service snapshot loaded." });
    expect(service.inventory).toHaveBeenCalledTimes(2);
  });

  it("retains the safe snapshot and clears the latch after a canary-bearing refresh rejection", async () => {
    const snap = inventory([server("target")]); const service = port(snap);
    service.inventory.mockRejectedValueOnce(new Error(`${CANARY} refresh`));
    const c = controller(snap, service); c.handleInput("r");
    await waitUntil({ description: "rejected refresh latch", predicate: () => !c.view().refreshing });
    expect(c.view().inventory.servers[0]?.name).toBe("target"); expect(c.view().notice).toContain("prior safe snapshot remains visible");
    recursivelyExpectNoCanary(c.view());
    service.inventory.mockResolvedValueOnce(inventory([server("retry")])); c.handleInput("r");
    await waitUntil({ description: "refresh retry", predicate: () => c.view().inventory.servers[0]?.name === "retry" });
    expect(service.inventory).toHaveBeenCalledTimes(2);
  });

  it("makes detail scrolling causal and disables hidden narrow-width actions", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const c = controller(snap, service);
    await enterReadyDetail(c);
    const before = normalized(c.render(20)); c.handleInput(RIGHT);
    const phase = c.view().phase; expect(phase.kind === "detail" ? phase.scroll : 0).toBeGreaterThan(0);
    expect(normalized(c.render(20))).not.toBe(before);
    const narrow = controller(snap, service); await enterReadyDetail(narrow); narrow.render(12); narrow.handleInput("\r"); narrow.handleInput("\r");
    expect(service.confirmedExecute).not.toHaveBeenCalled(); expect(normalized(narrow.render(12))).toContain("actions disabled");
  });

  it("renders post-submit failures as unconfirmed and closes with final confirmed change truth", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const done = vi.fn();
    const render = (view: Parameters<typeof renderMcpAdministration>[0], options: Parameters<typeof renderMcpAdministration>[1]) => {
      if (view.phase.kind === "result") throw new Error(`${CANARY} result render`);
      return renderMcpAdministration(view, options);
    };
    const c = controller(snap, service, { done, render }); await enterReadyDetail(c); c.handleInput("\r"); c.render(60); c.handleInput("\r");
    await waitUntil({ description: "result before render failure", predicate: () => c.view().phase.kind === "result" });
    const failed = normalized(c.render(40)); expect(failed).toContain("Known aggregate: confirmed change · confirmed-changed"); expect(failed).toContain("Detailed result rendering failed; refresh for details"); expect(failed).not.toContain("may still be running"); expect(failed).not.toContain(CANARY);
    c.handleInput(ESC); c.handleInput(ESC);
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ changed: true, effect: "confirmed-changed" }));
  });

  it("uses explicitly unconfirmed wording when rendering fails during execution", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const gate = deferred<McpAdministrationResult>();
    service.confirmedExecute.mockImplementation(() => gate.promise);
    const render = (view: Parameters<typeof renderMcpAdministration>[0], options: Parameters<typeof renderMcpAdministration>[1]) => {
      if (view.phase.kind === "executing") throw new Error(`${CANARY} executing render`);
      return renderMcpAdministration(view, options);
    };
    const c = controller(snap, service, { render }); await enterReadyDetail(c); c.handleInput("\r"); c.render(60); c.handleInput("\r");
    const failed = normalized(c.render(40)); expect(failed).toContain("unconfirmed and may still be running"); expect(failed).not.toContain(CANARY);
    gate.resolve(actionResult(snap));
    await waitUntil({ description: "execution settles after render failure", predicate: () => c.view().phase.kind === "result" });
  });

  it("keeps post-submit rejection unconfirmed, remains refreshable, and closes truthfully", async () => {
    const snap = inventory([server("target")]); const service = port(snap); const done = vi.fn();
    service.confirmedExecute.mockRejectedValueOnce(new Error(`${CANARY} execute`));
    const c = controller(snap, service, { done }); await enterReadyDetail(c); c.handleInput("\r"); c.render(60); c.handleInput("\r");
    await waitUntil({ description: "unconfirmed execution result", predicate: () => c.view().phase.kind === "result" });
    const rendered = normalized(c.render(60)); expect(rendered).toContain("unconfirmed and may still be running"); expect(rendered).toContain("refresh is required"); expect(rendered).not.toContain(CANARY);
    c.handleInput(ESC); c.handleInput("r"); await waitUntil({ description: "refresh after execute rejection", predicate: () => c.view().notice === "Fresh service snapshot loaded." });
    c.handleInput(ESC); expect(done).toHaveBeenCalledWith(expect.objectContaining({ changed: false, effect: "unconfirmed" }));
  });

  it("keeps confirmed-change and unconfirmed aggregates monotonic across multiple actions", async () => {
    const snap = inventory([server("target")]);
    const changed = actionResult(snap, { changed: true });
    const unchanged = actionResult(snap);
    const uncertain = outcomeResult(snap, { durable: { state: "pending-recovery", operationId: "op", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery" } });
    const rows = [
      { label: "changed then unchanged", results: [changed, unchanged], aggregateEffects: ["confirmed-changed", "confirmed-changed"], expected: { changed: true, effect: "confirmed-changed" } },
      { label: "changed then uncertain", results: [changed, uncertain], aggregateEffects: ["confirmed-changed", "unconfirmed"], expected: { changed: true, effect: "unconfirmed" } },
      { label: "uncertain then changed", results: [uncertain, changed], aggregateEffects: ["unconfirmed", "unconfirmed"], expected: { changed: true, effect: "unconfirmed" } },
    ] as const;
    for (const row of rows) {
      const service = port(snap); service.confirmedExecute.mockResolvedValueOnce(row.results[0]).mockResolvedValueOnce(row.results[1]);
      const done = vi.fn(); const c = controller(snap, service, { done });
      for (let index = 0; index < 2; index += 1) {
        await enterReadyDetail(c); c.handleInput("\r"); c.render(60); c.handleInput("\r");
        await waitUntil({ description: `${row.label} action ${index}`, predicate: () => c.view().phase.kind === "result" });
        expect(normalized(c.render(80)), `${row.label} action ${index}`).toContain(`Aggregate effect: ${row.aggregateEffects[index]}`);
        c.handleInput(ESC);
      }
      c.handleInput(ESC);
      expect(done, row.label).toHaveBeenCalledWith(expect.objectContaining(row.expected));
    }

    const inertService = port(snap); const inert = controller(snap, inertService);
    await enterReadyDetail(inert); inert.handleInput("\r"); inert.render(60); inert.handleInput("\r");
    await waitUntil({ description: "change before inert result", predicate: () => inert.view().phase.kind === "result" });
    inert.handleInput(ESC); await enterReadyDetail(inert); selectAction(inert, "authenticate"); inert.handleInput("\r");
    expect(normalized(inert.render(80))).toContain("Aggregate effect: confirmed-changed");
    expect(inertService.confirmedExecute).toHaveBeenCalledOnce();
  });

  it("preserves aggregate truth when custom UI resolves or rejects abnormally after a confirmed change", async () => {
    const snap = inventory([server("target")]);
    for (const ending of ["resolve", "reject"] as const) {
      const service = port(snap); const gate = deferred<McpAdministrationOpenResult>(); let component: McpAdministrationFocusController | undefined;
      const opened = openMcpAdministration({ mode: "tui", ui: { custom(factory) {
        component = factory({}, theme, undefined, () => {});
        return gate.promise;
      } } }, service as never);
      await waitUntil({ description: `abnormal ${ending} component`, predicate: () => component !== undefined });
      await enterReadyDetail(component!); component!.handleInput("\r"); component!.render(60); component!.handleInput("\r");
      await waitUntil({ description: `confirmed change before abnormal ${ending}`, predicate: () => component!.view().phase.kind === "result" });
      if (ending === "resolve") gate.resolve({ opened: true, changed: false, effect: "confirmed-unchanged", message: CANARY });
      else gate.reject(new Error(CANARY));
      await expect(opened).resolves.toMatchObject({ opened: false, reason: "open-failed", changed: true, effect: ending === "resolve" ? "confirmed-changed" : "unconfirmed" });
    }
  });

  it("preserves a confirmed change through the opener when a later effect is unconfirmed", async () => {
    const snap = inventory([server("target")]); const service = port(snap);
    service.confirmedExecute.mockResolvedValueOnce(actionResult(snap, { changed: true })).mockResolvedValueOnce(outcomeResult(snap, { runtime: { state: "failed", reasonCode: "live-port-failure" } }));
    let component: McpAdministrationFocusController | undefined;
    const opened = openMcpAdministration({ mode: "tui", ui: { custom(factory) { return new Promise((resolve) => { component = factory({}, theme, undefined, resolve); }); } } }, service as never);
    await waitUntil({ description: "aggregate opener component", predicate: () => component !== undefined });
    for (let index = 0; index < 2; index += 1) {
      await enterReadyDetail(component!); component!.handleInput("\r"); component!.render(60); component!.handleInput("\r");
      await waitUntil({ description: `aggregate opener action ${index}`, predicate: () => component!.view().phase.kind === "result" }); component!.handleInput(ESC);
    }
    component!.handleInput(ESC);
    await expect(opened).resolves.toEqual({ opened: true, changed: true, effect: "unconfirmed", message: "MCP administration closed with a confirmed change and an unconfirmed effect; refresh is required." });
  });

  it("classifies complete persistence and live outcome families truthfully", async () => {
    const snap = inventory([server("target")]);
    const cases = [
      { label: "recovery pending", result: outcomeResult(snap, { recovery: { state: "pending-recovery", operationId: "op", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery" } }), effect: "unconfirmed", text: "Recovery: pending-recovery · effect uncertain · cleanup pending" },
      { label: "durable uncertain", result: outcomeResult(snap, { durable: { state: "pending-recovery", operationId: "op", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery" } }), effect: "unconfirmed", text: "Durable: pending-recovery · effect uncertain · cleanup pending" },
      { label: "runtime partial", result: outcomeResult(snap, { durable: { state: "committed", retrySafe: false, effect: "changed", cleanup: "complete" }, runtime: { state: "failed", reasonCode: "runtime-failed" } }), effect: "unconfirmed", text: "Runtime: failed · runtime failed; inspect the fresh server posture before retrying" },
      { label: "exposure partial", result: outcomeResult(snap, { runtime: { state: "succeeded" }, exposure: { state: "failed", reasonCode: "exposure-failed" } }), effect: "unconfirmed", text: "Exposure: failed · capability exposure failed; refresh before relying" },
      { label: "confirmed unchanged", result: actionResult(snap), effect: "confirmed-unchanged", text: "Aggregate effect: confirmed-unchanged" },
    ] as const;
    for (const row of cases) {
      const service = port(snap); service.confirmedExecute.mockResolvedValueOnce(row.result); const done = vi.fn(); const c = controller(snap, service, { done });
      await enterReadyDetail(c); c.handleInput("\r"); c.render(60); c.handleInput("\r");
      await waitUntil({ description: row.label, predicate: () => c.view().phase.kind === "result" });
      const rendered = normalized(c.render(80)); expect(rendered, row.label).toContain(`Aggregate effect: ${row.effect}`); expect(rendered, row.label).toContain(row.text);
      c.handleInput(ESC); c.handleInput(ESC); expect(done, row.label).toHaveBeenCalledWith(expect.objectContaining({ effect: row.effect }));
      recursivelyExpectNoCanary(c.view());
    }
  });

  it("does not auto-open a missing deep-link identity and projects committed denial truth without canaries", async () => {
    const snap = inventory([server("actual")]); const service = port(snap);
    const missing = { name: "missing", source: "native-user" as const, authority: { kind: "mutable" as const, scope: "user" as const }, precedence: "winner" as const };
    const c = new McpAdministrationFocusController({ inventory: withCanaries(snap), port: service as never, tui: {}, theme, done: () => {}, initialIdentity: missing, initialAction: "approve" });
    expect(c.view().phase.kind).toBe("list"); expect(c.view().selectedIdentity).toBeUndefined(); recursivelyExpectNoCanary(c.view());

    service.confirmedExecute.mockResolvedValueOnce(actionResult(snap, { changed: true, reason: "not-effective" }));
    const active = controller(snap, service); await enterReadyDetail(active); active.handleInput("\r"); active.render(60); active.handleInput("\r");
    await waitUntil({ description: "committed but ineligible result", predicate: () => active.view().phase.kind === "result" });
    const rendered = normalized(active.render(60));
    expect(rendered).toContain("Aggregate effect: confirmed-changed"); expect(rendered).toContain("The declaration is not the effective admitted server"); expect(rendered).toContain("Durable: committed · effect changed · cleanup complete"); expect(rendered).toContain("Runtime: succeeded");
    recursivelyExpectNoCanary(active.view());
  });
});
