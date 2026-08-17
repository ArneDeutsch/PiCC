import type {
  AgentMcpAdmissionContext,
  AgentMcpDeclaration,
  HookOutcome,
  HookPayload,
  ResolvedAgentMcpConfig,
  ToolCallDescriptor,
} from "../types.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import {
  createAgentMcpScope,
  type AgentMcpRuntimeSource,
  type AgentMcpScope,
  type CreateAgentMcpScopeOptions,
} from "./agent-mcp.js";
import type {
  McpCleanupOutcome,
  McpResourceServerInfo,
  McpRuntimeDeps,
  McpServerState,
  McpToolInfo,
} from "./mcp.js";

export const SELECTED_MAIN_HOOK_SLOT: unique symbol = Symbol("picc.selected-main-hook-slot");
export const SELECTED_MAIN_MCP_INVENTORY_SLOT: unique symbol = Symbol("picc.selected-main-mcp-inventory-slot");

const IDENTITY_MAX_CHARS = 128;
const DIAGNOSTIC_MAX_ITEMS = 128;
const CLEANUP_MAX_IDENTITIES = 128;
const EMPTY_INLINE_CONFIG: ResolvedAgentMcpConfig = Object.freeze({
  servers: Object.freeze([]),
  diagnostics: Object.freeze([]),
  diagnosticOwnership: Object.freeze([]),
});
const EMPTY_CLEANUP: McpCleanupOutcome = Object.freeze({
  confirmed: Object.freeze([]),
  unconfirmed: Object.freeze([]),
  diagnostics: Object.freeze([]),
});

export interface SelectedMainHookRunner {
  hasHooks(eventName: string): boolean;
  fire(
    eventName: string,
    payload: Partial<HookPayload>,
    toolCall?: ToolCallDescriptor,
  ): Promise<HookOutcome>;
}

/** Host operations are the t04 composition seam into the complete session HookMultiplexer. */
export interface SelectedMainSessionEndDelivery {
  readonly outcome: HookOutcome;
  /** Explicit host evidence that the selected delegate ran exactly once. */
  readonly selectedDelivered: true;
  /** Explicit host evidence that the base runner ran exactly once. */
  readonly baseDelivered: true;
  /** The full multiplexer delivery completed without a rejected/ambiguous tail. */
  readonly committed: true;
}

export interface SelectedMainHookSlotHost {
  replaceSelectedMainHook(
    slot: typeof SELECTED_MAIN_HOOK_SLOT,
    runner: SelectedMainHookRunner | undefined,
  ): void;
  fireSessionHook(
    eventName: "SessionEnd",
    payload: Partial<HookPayload>,
  ): Promise<SelectedMainSessionEndDelivery>;
}

export type SelectedMainHookTransitionReason =
  | "session-end-diagnostic"
  | "session-end-delivery-uncertain"
  | "slot-update-failed";

export interface SelectedMainHookTransitionOutcome {
  readonly installed: boolean;
  /** Local executable authority has been revoked. */
  readonly cleared: boolean;
  /** The complete lifecycle transition, including SessionEnd when applicable, is confirmed. */
  readonly committed: boolean;
  readonly sessionEndDelivery: "not-required" | "confirmed" | "uncertain";
  readonly reasons: readonly SelectedMainHookTransitionReason[];
}

export class SelectedMainHookSlotController {
  private current: SelectedMainHookRunner | undefined;
  private targetGeneration = 0;
  private hostUncertain = false;
  private lifecycleUncertain = false;
  private transitions: Promise<void> = Promise.resolve();
  private readonly delegate: SelectedMainHookRunner;

  constructor(private readonly host: SelectedMainHookSlotHost) {
    this.delegate = Object.freeze({
      hasHooks: (eventName: string) => this.current?.hasHooks(eventName) ?? false,
      fire: async (
        eventName: string,
        payload: Partial<HookPayload>,
        toolCall?: ToolCallDescriptor,
      ) => {
        const target = this.current;
        const generation = this.targetGeneration;
        if (target === undefined) return emptyHookOutcome();
        const outcome = await target.fire(eventName, payload, toolCall);
        return this.current === target && this.targetGeneration === generation
          ? outcome
          : emptyHookOutcome();
      },
    });
  }

  replace(
    next: SelectedMainHookRunner | undefined,
    sessionEndPayload: Partial<HookPayload>,
  ): Promise<SelectedMainHookTransitionOutcome> {
    return this.serialized(async () => {
      const reasons: SelectedMainHookTransitionReason[] = [];
      const outgoing = this.current;
      let sessionEndDelivery: SelectedMainHookTransitionOutcome["sessionEndDelivery"] = "not-required";
      if (outgoing !== undefined) {
        try {
          // The selected delegate remains live in its collision-proof slot while the host runs the
          // complete multiplexer, so selected and base SessionEnd each execute exactly once.
          const delivery = await this.host.fireSessionHook("SessionEnd", sessionEndPayload);
          if (delivery.selectedDelivered !== true
            || delivery.baseDelivered !== true
            || delivery.committed !== true) {
            throw new Error("missing explicit SessionEnd delivery evidence");
          }
          sessionEndDelivery = "confirmed";
          if (delivery.outcome.diagnostics.length > 0) reasons.push("session-end-diagnostic");
        } catch {
          // Delivery may have happened before the rejection. Never retry or publish a successor in
          // this controller: either action could duplicate SessionEnd or admit overlapping custody.
          sessionEndDelivery = "uncertain";
          this.lifecycleUncertain = true;
          reasons.push("session-end-delivery-uncertain");
        }
        this.revokeLocal();
      }

      if (outgoing !== undefined || this.hostUncertain || this.lifecycleUncertain) {
        try {
          // Revoke before host mutation: a mutate-then-throw can retain only an inert delegate.
          this.host.replaceSelectedMainHook(SELECTED_MAIN_HOOK_SLOT, undefined);
          this.hostUncertain = false;
        } catch {
          this.hostUncertain = true;
          reasons.push("slot-update-failed");
          return hookTransition(false, true, false, sessionEndDelivery, reasons);
        }
      }

      if (this.lifecycleUncertain) {
        if (!reasons.includes("session-end-delivery-uncertain")) {
          reasons.push("session-end-delivery-uncertain");
          sessionEndDelivery = "uncertain";
        }
        return hookTransition(false, true, false, sessionEndDelivery, reasons);
      }
      if (next === undefined) return hookTransition(false, true, true, sessionEndDelivery, reasons);

      this.current = next;
      this.targetGeneration += 1;
      try {
        // One stable local delegate is republished on retry; project-controlled names never key it.
        this.host.replaceSelectedMainHook(SELECTED_MAIN_HOOK_SLOT, this.delegate);
        return hookTransition(true, false, true, sessionEndDelivery, reasons);
      } catch {
        this.revokeLocal();
        this.hostUncertain = true;
        reasons.push("slot-update-failed");
        return hookTransition(false, true, false, sessionEndDelivery, reasons);
      }
    });
  }

  private revokeLocal(): void {
    this.current = undefined;
    this.targetGeneration += 1;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(operation, operation);
    this.transitions = result.then(() => undefined, () => undefined);
    return result;
  }
}

export type SelectedMainMcpDiagnosticReason =
  | "missing-reference"
  | "inline-startup-failed"
  | "setup-diagnostic"
  | "setup-failed"
  | "cleanup-unconfirmed"
  | "cleanup-failed"
  | "inventory-publication-failed"
  | "shutdown-started";

export interface SelectedMainMcpDiagnostic {
  readonly reason: SelectedMainMcpDiagnosticReason;
  readonly identity: string;
}

export interface SelectedMainMcpInventorySource {
  readonly ownership: "selected-main";
  tools(): readonly McpToolInfo[];
  resourceServers(): readonly McpResourceServerInfo[];
  serverStates(): readonly McpServerState[];
}

export interface SelectedMainMcpInventoryHost {
  replaceSelectedMainMcpInventory(
    slot: typeof SELECTED_MAIN_MCP_INVENTORY_SLOT,
    source: SelectedMainMcpInventorySource | undefined,
  ): void;
}

export interface SelectedMainMcpInstall {
  readonly agentIdentity: string;
  readonly sessionRuntime: AgentMcpRuntimeSource;
  readonly declaration?: AgentMcpDeclaration;
  /** Captured immutable project admission authority. Required for every present declaration. */
  readonly admissionContext?: AgentMcpAdmissionContext;
  readonly inlineDeps: McpRuntimeDeps;
  readonly signal?: AbortSignal;
}

export interface SelectedMainMcpTransitionOutcome {
  readonly installed: boolean;
  readonly cleanup: McpCleanupOutcome;
  readonly diagnostics: readonly SelectedMainMcpDiagnostic[];
}

export interface SelectedMainMcpAdapter extends AgentMcpRuntimeSource {
  readonly ownership: "selected-main";
}

type ScopeFactory = (options: CreateAgentMcpScopeOptions) => Promise<AgentMcpScope>;
type CurrentScope = {
  readonly scope: AgentMcpScope;
  readonly borrowedNames: ReadonlySet<string>;
};

export class SelectedMainMcpScopeController {
  private current: CurrentScope | undefined;
  private currentIdentity = "selected-main";
  private generation = 0;
  private transitions: Promise<void> = Promise.resolve();
  private uncertain: { scope: AgentMcpScope; outcome: McpCleanupOutcome; identity: string } | undefined;
  private inventoryPublished = false;
  private inventoryRevocationUncertain = false;
  private shutdownStarted = false;
  private readonly inventoryValue: SelectedMainMcpInventorySource;

  constructor(
    private readonly inventoryHost: SelectedMainMcpInventoryHost,
    private readonly createScope: ScopeFactory = createAgentMcpScope,
  ) {
    this.inventoryValue = Object.freeze({
      ownership: "selected-main" as const,
      tools: () => this.selectedTools(),
      resourceServers: () => this.selectedResourceServers(),
      serverStates: () => this.selectedServerStates(),
    });
  }

  /** Capture call authority for the installed generation; retained definitions fail after replacement. */
  adapter(): SelectedMainMcpAdapter {
    const current = this.current;
    const generation = this.generation;
    const isCurrent = () => current !== undefined
      && this.current === current
      && this.generation === generation;
    return Object.freeze({
      ownership: "selected-main" as const,
      whenSettled: async () => {},
      tools: () => current !== undefined && isCurrent() ? current.scope.tools() : [],
      resourceServers: () => current !== undefined && isCurrent() ? current.scope.resourceServers() : [],
      serverStates: () => current !== undefined && isCurrent() ? current.scope.serverStates() : [],
      callTool: (serverName: string, toolName: string, args: unknown) =>
        this.route(current, generation, (active) => active.callTool(serverName, toolName, args)),
      readResource: (serverName: string, uri: string) =>
        this.route(current, generation, (active) => active.readResource(serverName, uri)),
    });
  }

  replace(next: SelectedMainMcpInstall | undefined): Promise<SelectedMainMcpTransitionOutcome> {
    return this.serialized(async () => {
      const diagnostics: SelectedMainMcpDiagnostic[] = [];
      const cleanup = await this.revokeCurrent(diagnostics);
      if (this.shutdownStarted) {
        diagnostics.push(this.diagnostic("shutdown-started", "selected-main"));
        return this.outcome(false, cleanup, diagnostics);
      }
      if (this.inventoryRevocationUncertain) return this.outcome(false, cleanup, diagnostics);
      if (this.uncertain !== undefined) {
        diagnostics.push(...this.cleanupDiagnostics(this.uncertain.outcome));
        return this.outcome(false, cleanup, diagnostics);
      }
      if (next === undefined) return this.outcome(false, cleanup, diagnostics);

      this.currentIdentity = safeIdentity(next.agentIdentity);
      let inlineConfig = EMPTY_INLINE_CONFIG;
      if (next.declaration !== undefined) {
        try {
          if (next.admissionContext === undefined) throw new Error("missing admission authority");
          inlineConfig = next.admissionContext.resolve(next.declaration);
        } catch {
          diagnostics.push(this.diagnostic("setup-failed", this.currentIdentity));
          return this.outcome(false, cleanup, diagnostics);
        }
      }

      let scope: AgentMcpScope;
      try {
        scope = await this.createScope({
          sessionRuntime: next.sessionRuntime,
          declaration: next.declaration,
          inlineConfig,
          inlineDeps: next.inlineDeps,
          ...(next.signal === undefined ? {} : { signal: next.signal }),
        });
      } catch {
        diagnostics.push(this.diagnostic("setup-failed", this.currentIdentity));
        return this.outcome(false, cleanup, diagnostics);
      }

      // Ownership begins at factory return, before any untrusted scope inspection.
      let borrowedNames: ReadonlySet<string>;
      try {
        diagnostics.push(...scope.setupOutcomes().map((entry) =>
          this.diagnostic(entry.kind, entry.serverName)));
        if (scope.diagnostics().length > 0) {
          diagnostics.push(this.diagnostic("setup-diagnostic", this.currentIdentity));
        }
        if (typeof scope.borrowedServerNames !== "function") {
          throw new Error("missing borrowed-route provenance");
        }
        const borrowed = scope.borrowedServerNames();
        if (!Array.isArray(borrowed) || !borrowed.every((name) => typeof name === "string")) {
          throw new Error("invalid borrowed-route provenance");
        }
        borrowedNames = new Set(borrowed);
      } catch {
        diagnostics.push(this.diagnostic("setup-failed", this.currentIdentity));
        const failedCleanup = await this.cleanupScope(scope, this.currentIdentity, diagnostics);
        return this.outcome(false, failedCleanup, diagnostics);
      }

      if (next.signal?.aborted || this.shutdownStarted) {
        diagnostics.push(this.diagnostic(
          this.shutdownStarted ? "shutdown-started" : "setup-failed",
          this.currentIdentity,
        ));
        const abortedCleanup = await this.cleanupScope(scope, this.currentIdentity, diagnostics);
        return this.outcome(false, abortedCleanup, diagnostics);
      }

      const record = { scope, borrowedNames };
      this.current = record;
      this.generation += 1;
      try {
        this.inventoryHost.replaceSelectedMainMcpInventory(
          SELECTED_MAIN_MCP_INVENTORY_SLOT,
          this.inventoryValue,
        );
        this.inventoryPublished = true;
      } catch {
        // A mutate-then-throw may retain inventoryValue, but local revocation makes it empty and inert.
        this.current = undefined;
        this.generation += 1;
        this.inventoryPublished = false;
        this.inventoryRevocationUncertain = true;
        diagnostics.push(this.diagnostic("inventory-publication-failed", this.currentIdentity));
        const failedCleanup = await this.cleanupScope(scope, this.currentIdentity, diagnostics);
        return this.outcome(false, failedCleanup, diagnostics);
      }
      return this.outcome(true, cleanup, diagnostics);
    });
  }

  retryUnconfirmedCleanup(): Promise<SelectedMainMcpTransitionOutcome> {
    return this.serialized(async () => {
      if (this.uncertain === undefined) return this.outcome(false, EMPTY_CLEANUP, []);
      const pending = this.uncertain;
      let cleanup: McpCleanupOutcome;
      const diagnostics: SelectedMainMcpDiagnostic[] = [];
      try {
        cleanup = normalizeCleanupOutcome(
          await pending.scope.retryUnconfirmedShutdown(),
          pending.identity,
        );
      } catch {
        cleanup = uncertainCleanup(pending.identity);
        diagnostics.push(this.diagnostic("cleanup-failed", pending.identity));
      }
      this.uncertain = cleanup.unconfirmed.length === 0
        ? undefined
        : { scope: pending.scope, outcome: cleanup, identity: pending.identity };
      diagnostics.push(...this.cleanupDiagnostics(cleanup));
      return this.outcome(false, cleanup, diagnostics);
    });
  }

  shutdownBeforeGlobal<T>(globalShutdown: () => Promise<T>): Promise<{
    readonly selected: SelectedMainMcpTransitionOutcome;
    readonly global: T;
  }> {
    // Fence immediately, including replacements already queued behind an in-progress factory.
    this.shutdownStarted = true;
    return this.serialized(async () => {
      const diagnostics: SelectedMainMcpDiagnostic[] = [];
      const cleanup = await this.revokeCurrent(diagnostics);
      if (this.uncertain !== undefined) diagnostics.push(...this.cleanupDiagnostics(this.uncertain.outcome));
      const selected = this.outcome(false, cleanup, diagnostics);
      const global = await globalShutdown();
      return Object.freeze({ selected, global });
    });
  }

  private async revokeCurrent(
    diagnostics: SelectedMainMcpDiagnostic[],
  ): Promise<McpCleanupOutcome> {
    const outgoing = this.current;
    this.current = undefined;
    this.generation += 1;
    if (this.inventoryPublished || this.inventoryRevocationUncertain) {
      try {
        this.inventoryHost.replaceSelectedMainMcpInventory(
          SELECTED_MAIN_MCP_INVENTORY_SLOT,
          undefined,
        );
        this.inventoryPublished = false;
        this.inventoryRevocationUncertain = false;
      } catch {
        this.inventoryRevocationUncertain = true;
        diagnostics.push(this.diagnostic("inventory-publication-failed", this.currentIdentity));
      }
    }
    if (outgoing === undefined) return EMPTY_CLEANUP;
    return this.cleanupScope(outgoing.scope, this.currentIdentity, diagnostics);
  }

  private async cleanupScope(
    scope: AgentMcpScope,
    identity: string,
    diagnostics: SelectedMainMcpDiagnostic[],
  ): Promise<McpCleanupOutcome> {
    let cleanup: McpCleanupOutcome;
    try {
      cleanup = normalizeCleanupOutcome(await scope.shutdown(), identity);
    } catch {
      cleanup = uncertainCleanup(identity);
      diagnostics.push(this.diagnostic("cleanup-failed", identity));
    }
    if (cleanup.unconfirmed.length > 0) {
      this.uncertain = { scope, outcome: cleanup, identity };
    }
    diagnostics.push(...this.cleanupDiagnostics(cleanup));
    return cleanup;
  }

  private async route(
    current: CurrentScope | undefined,
    generation: number,
    operation: (scope: AgentMcpScope) => Promise<unknown>,
  ): Promise<unknown> {
    if (current === undefined || this.current !== current || this.generation !== generation) {
      throw new Error("Selected main MCP scope is not active");
    }
    const result = await operation(current.scope);
    if (this.current !== current || this.generation !== generation) {
      throw new Error("Selected main MCP scope was replaced during the operation");
    }
    return result;
  }

  private selectedTools(): readonly McpToolInfo[] {
    const current = this.current;
    return current?.scope.tools().filter((entry) => !current.borrowedNames.has(entry.serverName)) ?? [];
  }

  private selectedResourceServers(): readonly McpResourceServerInfo[] {
    const current = this.current;
    return current?.scope.resourceServers()
      .filter((entry) => !current.borrowedNames.has(entry.serverName)) ?? [];
  }

  private selectedServerStates(): readonly McpServerState[] {
    const current = this.current;
    return current?.scope.serverStates().filter((entry) => !current.borrowedNames.has(entry.name)) ?? [];
  }

  private cleanupDiagnostics(outcome: McpCleanupOutcome): SelectedMainMcpDiagnostic[] {
    return outcome.unconfirmed.map((identity) =>
      this.diagnostic("cleanup-unconfirmed", identity));
  }

  private diagnostic(
    reason: SelectedMainMcpDiagnosticReason,
    identity: string,
  ): SelectedMainMcpDiagnostic {
    return Object.freeze({ reason, identity: safeIdentity(identity) });
  }

  private outcome(
    installed: boolean,
    cleanup: McpCleanupOutcome,
    diagnostics: readonly SelectedMainMcpDiagnostic[],
  ): SelectedMainMcpTransitionOutcome {
    const normalizedCleanup = normalizeCleanupOutcome(cleanup, this.currentIdentity);
    return Object.freeze({
      installed,
      cleanup: normalizedCleanup,
      diagnostics: Object.freeze(dedupeDiagnostics(diagnostics).slice(0, DIAGNOSTIC_MAX_ITEMS)),
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(operation, operation);
    this.transitions = result.then(() => undefined, () => undefined);
    return result;
  }
}

function emptyHookOutcome(): HookOutcome {
  return { block: false, askDowngraded: false, diagnostics: [] };
}

function hookTransition(
  installed: boolean,
  cleared: boolean,
  committed: boolean,
  sessionEndDelivery: SelectedMainHookTransitionOutcome["sessionEndDelivery"],
  reasons: readonly SelectedMainHookTransitionReason[],
): SelectedMainHookTransitionOutcome {
  return Object.freeze({
    installed,
    cleared,
    committed,
    sessionEndDelivery,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

function uncertainCleanup(identity: string): McpCleanupOutcome {
  return Object.freeze({
    confirmed: Object.freeze([]),
    unconfirmed: Object.freeze([safeIdentity(identity)]),
    diagnostics: Object.freeze(["cleanup-outcome-redacted"]),
  });
}

function normalizeCleanupOutcome(value: unknown, fallbackIdentity: string): McpCleanupOutcome {
  try {
    if (typeof value !== "object" || value === null) throw new Error("malformed cleanup");
    const candidate = value as Partial<McpCleanupOutcome>;
    if (!Array.isArray(candidate.confirmed)
      || !Array.isArray(candidate.unconfirmed)
      || !Array.isArray(candidate.diagnostics)) {
      throw new Error("malformed cleanup");
    }
    const unconfirmed = normalizeIdentities(candidate.unconfirmed);
    const unconfirmedSet = new Set(unconfirmed);
    const confirmed = normalizeIdentities(candidate.confirmed)
      .filter((identity) => !unconfirmedSet.has(identity));
    const retainedDiagnostic = candidate.diagnostics.length === 1
      && (candidate.diagnostics[0] === "cleanup-outcome-redacted"
        || candidate.diagnostics[0] === "runtime-cleanup-diagnostics-redacted")
      ? candidate.diagnostics[0]
      : undefined;
    const diagnostics = candidate.diagnostics.length > 0
      ? Object.freeze([retainedDiagnostic ?? "runtime-cleanup-diagnostics-redacted"])
      : Object.freeze([] as string[]);
    return Object.freeze({
      confirmed: Object.freeze(confirmed),
      unconfirmed: Object.freeze(unconfirmed),
      diagnostics,
    });
  } catch {
    return uncertainCleanup(fallbackIdentity);
  }
}

function normalizeIdentities(values: readonly string[]): string[] {
  return [...new Set(values.slice(0, CLEANUP_MAX_IDENTITIES).map(safeIdentity))];
}

function safeIdentity(value: string): string {
  const safe = neutralizeControlChars(value).replace(/\s+/gu, " ").trim();
  if (safe === "") return "unavailable";
  return Array.from(safe).slice(0, IDENTITY_MAX_CHARS).join("");
}

function dedupeDiagnostics(
  diagnostics: readonly SelectedMainMcpDiagnostic[],
): SelectedMainMcpDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((entry) => {
    const key = `${entry.reason}:${entry.identity}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
