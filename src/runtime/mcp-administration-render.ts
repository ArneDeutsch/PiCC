import { visibleWidth } from "@earendil-works/pi-tui";
import type { McpAdministrationInventory, McpAdministrationInventoryItem } from "../mcp-administration/model.js";
import type { McpAdministrationReasonCode } from "../mcp-administration/service.js";
import { clampLines, pushWrapped, sanitizeDisplayText, themedFg } from "./render-util.js";

export const MCP_ADMINISTRATION_ACTIONS = ["approve", "reject", "enable", "disable", "reconnect", "authenticate"] as const;
export type McpAdministrationUiAction = typeof MCP_ADMINISTRATION_ACTIONS[number];

export interface McpAdministrationUiIdentity {
  readonly name: string;
  readonly source: McpAdministrationInventoryItem["source"];
  readonly authority: McpAdministrationInventoryItem["authority"];
  readonly precedence: McpAdministrationInventoryItem["precedence"];
  readonly agentOwner?: { readonly name: string; readonly scope: "project" | "user" };
}

export interface McpAdministrationActionView {
  readonly action: McpAdministrationUiAction;
  readonly pending: boolean;
  readonly eligible?: boolean;
  readonly reasonCode?: McpAdministrationReasonCode;
  readonly checkFailed?: boolean;
}

export type McpAdministrationUiPhase =
  | { readonly kind: "list" }
  | { readonly kind: "detail"; readonly actions: readonly McpAdministrationActionView[]; readonly actionIndex: number; readonly scroll: number }
  | { readonly kind: "confirmation"; readonly action: Exclude<McpAdministrationUiAction, "authenticate">; readonly reasonCode: McpAdministrationReasonCode; readonly scroll: number }
  | { readonly kind: "executing"; readonly action: Exclude<McpAdministrationUiAction, "authenticate"> }
  | { readonly kind: "result"; readonly action: McpAdministrationUiAction; readonly message: string; readonly effect: "confirmed-changed" | "confirmed-unchanged" | "unconfirmed"; readonly recovery: string; readonly durable: string; readonly runtime: string; readonly exposure: string };

export interface McpAdministrationRenderView {
  readonly inventory: McpAdministrationInventory;
  readonly orderedServers: readonly McpAdministrationInventoryItem[];
  readonly selectedIndex: number;
  readonly selectedIdentity?: McpAdministrationUiIdentity;
  readonly phase: McpAdministrationUiPhase;
  readonly refreshing: boolean;
  readonly notice?: string;
}

export interface McpAdministrationRenderResult {
  readonly lines: readonly string[];
  readonly maxScroll: number;
}

const DETAIL_WINDOW = 11;
const TEXT_CAP = 160;

function safe(value: unknown, cap = TEXT_CAP): string {
  return sanitizeDisplayText(typeof value === "string" ? value : String(value ?? ""), cap, true);
}

function add(lines: string[], theme: unknown, role: string, text: string, width: number): void {
  pushWrapped(themedFg(theme, role, text), width, lines);
}

export function mcpAdministrationIdentity(server: Pick<McpAdministrationInventoryItem, "name" | "source" | "authority" | "precedence" | "agentOwner">): McpAdministrationUiIdentity {
  const authority = server.authority.kind === "mutable" ? Object.freeze({ kind: "mutable" as const, scope: server.authority.scope }) : Object.freeze({ kind: "read-only" as const, sourceClass: server.authority.sourceClass });
  return Object.freeze({ name: server.name, source: server.source, authority, precedence: server.precedence, ...(server.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ name: server.agentOwner.name, scope: server.agentOwner.scope }) }) });
}

export function sameMcpAdministrationIdentity(left: McpAdministrationUiIdentity | undefined, right: McpAdministrationUiIdentity | undefined): boolean {
  const authority = left?.authority.kind === right?.authority.kind && (left?.authority.kind === "mutable"
    ? right?.authority.kind === "mutable" && left.authority.scope === right.authority.scope
    : left?.authority.kind === "read-only" && right?.authority.kind === "read-only" && left.authority.sourceClass === right.authority.sourceClass);
  return left?.name === right?.name && left?.source === right?.source && left?.precedence === right?.precedence && authority && left?.agentOwner?.name === right?.agentOwner?.name && left?.agentOwner?.scope === right?.agentOwner?.scope;
}

export function mcpAdministrationPriority(server: McpAdministrationInventoryItem): number {
  if (server.review === "pending") return 0;
  if (server.live === "failed") return 1;
  if (["starting", "connecting", "reconnecting", "connected"].includes(server.live)) return 2;
  if (server.status === "disabled") return 3;
  return 4;
}

export function orderMcpAdministrationServers(inventory: McpAdministrationInventory): readonly McpAdministrationInventoryItem[] {
  return Object.freeze(inventory.servers.map((server, index) => ({ server, index }))
    .sort((left, right) => mcpAdministrationPriority(left.server) - mcpAdministrationPriority(right.server) || left.index - right.index)
    .map(({ server }) => server));
}

function groupName(priority: number): string {
  return ["Needs review", "Failed / actionable", "Connecting / connected", "Disabled", "Blocked / skipped"][priority] ?? "Blocked / skipped";
}

function identityText(server: McpAdministrationInventoryItem): string {
  return server.agentOwner === undefined ? safe(server.name, 256) : `${safe(server.name, 256)} · agent ${safe(server.agentOwner.name, 160)} (${server.agentOwner.scope})`;
}

function exactIdentityText(server: McpAdministrationInventoryItem): string {
  const authority = server.authority.kind === "mutable" ? `mutable scope ${server.authority.scope}` : `read-only class ${server.authority.sourceClass}`;
  const owner = server.agentOwner === undefined ? "owner ordinary session" : `owner ${safe(server.agentOwner.name, 160)} (${server.agentOwner.scope})`;
  return `source ${server.source} · ${authority} · precedence ${server.precedence} · ${owner}`;
}

function confirmationIdentityLines(server: McpAdministrationInventoryItem): readonly string[] {
  const authority = server.authority.kind === "mutable" ? `Mutable scope: ${server.authority.scope}` : `Read-only class: ${server.authority.sourceClass}`;
  const owner = server.agentOwner === undefined ? "ordinary session" : `${safe(server.agentOwner.name, 160)} (${server.agentOwner.scope})`;
  return Object.freeze([
    `Name: ${safe(server.name, 256)}`,
    `Source: ${server.source}`,
    authority,
    `Precedence: ${server.precedence}`,
    `Owner: ${owner}`,
  ]);
}

function stateRole(server: McpAdministrationInventoryItem): string {
  if (server.review === "pending" || server.live === "failed") return "warning";
  if (server.live === "connected") return "success";
  if (server.policy !== "allowed" || server.status === "blocked") return "error";
  return "muted";
}

function renderList(view: McpAdministrationRenderView, theme: unknown, width: number, lines: string[]): void {
  if (view.orderedServers.length === 0) {
    add(lines, theme, "muted", "No MCP server declarations are available in this safe snapshot.", width);
    return;
  }
  const selected = Math.max(0, Math.min(view.orderedServers.length - 1, view.selectedIndex));
  const narrow = width <= 24;
  const start = narrow ? selected : Math.max(0, Math.min(selected - 3, Math.max(0, view.orderedServers.length - 8)));
  const end = narrow ? selected + 1 : Math.min(view.orderedServers.length, start + 8);
  if (start > 0) add(lines, theme, "muted", `↑ ${start} retained servers above`, width);
  let prior = -1;
  for (let index = start; index < end; index += 1) {
    const server = view.orderedServers[index]!;
    const priority = mcpAdministrationPriority(server);
    if (priority !== prior) add(lines, theme, "accent", `${groupName(priority)}:`, width);
    prior = priority;
    const selectedRow = index === selected;
    add(lines, theme, selectedRow ? "accent" : "text", `${selectedRow ? "> [selected]" : "  [ ]"} ${identityText(server)}`, width);
    add(lines, theme, selectedRow ? "accent" : "muted", `    ${exactIdentityText(server)}`, width);
    add(lines, theme, stateRole(server), `    status ${server.status} · live ${server.live} · review ${server.review} · Enter details`, width);
  }
  if (end < view.orderedServers.length) add(lines, theme, "muted", `↓ ${view.orderedServers.length - end} retained servers below`, width);
}

function detailLines(server: McpAdministrationInventoryItem): readonly { readonly role: string; readonly text: string }[] {
  const owner = server.agentOwner === undefined ? "ordinary session" : `agent ${safe(server.agentOwner.name)} · ${server.agentOwner.scope}`;
  const authority = server.authority.kind === "mutable" ? `mutable ${server.authority.scope}` : `read-only ${server.authority.sourceClass}`;
  const transport = server.summary.transport ?? "not available";
  return Object.freeze([
    { role: "accent", text: `Server: ${identityText(server)}` },
    { role: "text", text: `Identity/source/authority: ${safe(server.name, 256)} · ${server.source} · ${authority} · ${server.precedence} · ${owner}` },
    { role: "text", text: `Transport: ${transport}${server.summary.configuredType === undefined ? "" : ` · configured ${server.summary.configuredType}`}` },
    { role: "text", text: `Declaration shape: arguments ${server.summary.argumentCount} · environment keys ${server.summary.environmentKeyCount} · header keys ${server.summary.headerKeyCount} · timeout ${server.summary.timeoutConfigured ? "configured" : "default"}` },
    { role: server.review === "pending" ? "warning" : "text", text: `Review: ${server.review} · policy ${server.policy}` },
    { role: server.live === "failed" ? "warning" : "text", text: `Live posture: declared ${server.status} · runtime ${server.live}${server.inactiveReason === undefined ? "" : ` · reason ${server.inactiveReason}`}` },
    { role: "text", text: `Capabilities: tools ${server.capabilityCounts.tools} · prompts ${server.capabilityCounts.prompts} · resources ${server.capabilityCounts.resources}` },
    { role: "muted", text: "Remediation: use only an eligible action below; blocked policy and review decisions cannot be bypassed here." },
  ]);
}

export function mcpAdministrationConfirmationLines(server: McpAdministrationInventoryItem, action: Exclude<McpAdministrationUiAction, "authenticate">): readonly string[] {
  const exact = `Exact identity ${identityText(server)} · ${exactIdentityText(server)} · in this checkout family`;
  if (action === "approve" || action === "reject") {
    const decision = action === "approve" ? "approve" : "reject";
    const broad = server.review === "approved-broad-name" ? "A trusted broad name grant currently applies to compatible definitions with this server name."
      : server.review === "approved-broad-all" ? "A trusted broad all-server grant currently applies to compatible project definitions."
        : "No trusted broad compatibility grant is represented by this snapshot.";
    return Object.freeze([
      `${decision === "approve" ? "Approval" : "Rejection"} changes the review decision; the server declaration remains unchanged.`,
      `${exact}; the decision binds the exact reviewed definition and checkout family.`,
      broad,
      action === "approve" ? "If admission remains allowed, the service may apply the resulting live start separately." : "The service may stop the live server separately after persisting rejection.",
    ]);
  }
  if (action === "enable" || action === "disable") return Object.freeze([
    `${action === "enable" ? "Enable" : "Disable"} changes the persistent native runtime choice; the declaration remains unchanged.`,
    `${exact}.`,
    action === "enable" ? "Live effect: the service may start the newly admitted server after the durable choice succeeds." : "Live effect: the service may stop and retire the server after the durable choice succeeds.",
    "Durable, runtime, and capability-exposure outcomes remain separate.",
  ]);
  return Object.freeze([
    "Reconnect changes no configuration or review decision.",
    `${exact}.`,
    "Reconnect cannot bypass managed policy, project review, disablement, or current admission.",
    "Only the service may replace the failed live generation and its exposure.",
  ]);
}

export function mcpAdministrationReasonGuidance(reason: McpAdministrationReasonCode): string {
  const guidance: Record<McpAdministrationReasonCode, string> = {
    eligible: "Eligible through the administration service.",
    "recovery-pending": "Administration recovery is pending; resolve recovery before retrying.",
    "cleanup-pending": "Durable cleanup remains pending; inspect recovery before retrying.",
    "already-exists": "An exact declaration already exists.",
    "server-not-found": "The exact server identity is no longer present; refresh.",
    "scope-mismatch": "The requested mutable scope does not own this declaration.",
    "unsupported-source": "This source or agent-owned server does not support that action.",
    "policy-blocked": "Managed policy blocks this action and cannot be bypassed here.",
    "review-not-applicable": "Project review does not apply to this server or current posture.",
    "compatibility-rejected": "Compatibility review rejects this definition; review trusted settings.",
    "definition-unavailable": "The exact reviewed definition binding is unavailable; refresh or repair discovery.",
    "invalid-input": "The administration action input is invalid.",
    "stale-state": "State changed while the action ran; inspect the refreshed snapshot.",
    "not-effective": "The declaration is not the effective admitted server.",
    "not-disabled": "The server is not persistently disabled.",
    "not-enabled": "The server is not currently enabled.",
    "not-failed": "Reconnect is available only for a failed live server.",
    "unsupported-transport": "This transport cannot be reconnected by the service.",
    "authentication-deferred": "OAuth is unavailable. No browser opens, no secret is accepted, and nothing is stored here; use a supported static declaration or settings authentication where applicable.",
    "authentication-unavailable": "OAuth is unavailable for this transport. No browser opens, no secret is accepted, and nothing is stored here; use supported declaration or settings authentication where applicable.",
    "durable-mutation-failed": "The durable mutation failed; no unconfirmed live action is claimed.",
  };
  return guidance[reason];
}

function renderDetail(view: McpAdministrationRenderView, server: McpAdministrationInventoryItem, phase: Extract<McpAdministrationUiPhase, { kind: "detail" }>, theme: unknown, width: number, lines: string[]): number {
  const body: string[] = [];
  for (const value of detailLines(server)) add(body, theme, value.role, value.text, width);
  const max = Math.max(0, body.length - DETAIL_WINDOW);
  const scroll = Math.min(max, phase.scroll);
  if (scroll > 0) add(lines, theme, "muted", `↑ ${scroll} detail lines above`, width);
  lines.push(...body.slice(scroll, scroll + DETAIL_WINDOW));
  if (scroll + DETAIL_WINDOW < body.length) add(lines, theme, "muted", `↓ ${body.length - scroll - DETAIL_WINDOW} detail lines below`, width);
  add(lines, theme, "accent", "Actions (service eligibility):", width);
  const actionStart = Math.max(0, Math.min(phase.actionIndex - 2, Math.max(0, phase.actions.length - 4)));
  const actionEnd = Math.min(phase.actions.length, actionStart + 4);
  if (actionStart > 0) add(lines, theme, "muted", `↑ ${actionStart} actions above`, width);
  phase.actions.slice(actionStart, actionEnd).forEach((value, offset) => {
    const index = actionStart + offset;
    const label = value.action === "authenticate" ? "Authentication (not yet supported)…" : value.action[0]!.toUpperCase() + value.action.slice(1);
    const state = value.pending ? "checking…" : value.checkFailed ? "eligibility could not be checked; press R" : value.reasonCode === "eligible" ? "eligible" : `inert · ${value.reasonCode ?? "unavailable"}`;
    add(lines, theme, index === phase.actionIndex ? "accent" : value.eligible ? "text" : "muted", `${index === phase.actionIndex ? "> [focused]" : "  [ ]"} ${label} · ${state}`, width);
  });
  if (actionEnd < phase.actions.length) add(lines, theme, "muted", `↓ ${phase.actions.length - actionEnd} actions below`, width);
  return max;
}

/** Pure bounded renderer over the safe administration inventory projection. */
export function renderMcpAdministration(view: McpAdministrationRenderView, options: { readonly width: number; readonly theme?: unknown }): McpAdministrationRenderResult {
  const width = Number.isFinite(options.width) ? Math.max(0, Math.floor(options.width)) : 0;
  if (width === 0) return { lines: [""], maxScroll: 0 };
  const lines: string[] = [];
  if (width < 16) {
    for (const text of ["MCP admin", "resize needed", "actions disabled", "Esc close"]) add(lines, options.theme, "warning", text, width);
    return { lines: clampLines(lines, width), maxScroll: 0 };
  }
  add(lines, options.theme, "accent", "PiCC MCP administration", width);
  add(lines, options.theme, "muted", `Loaded safe snapshot · ${view.refreshing ? "refreshing" : "ready"} · declarations ${view.inventory.servers.length}${view.inventory.omittedDeclarationCount > 0 ? ` · omitted ${view.inventory.omittedDeclarationCount}` : ""}`, width);
  if (view.notice !== undefined) add(lines, options.theme, "warning", safe(view.notice, 320), width);
  const server = view.selectedIdentity === undefined ? undefined : view.orderedServers.find((candidate) => sameMcpAdministrationIdentity(mcpAdministrationIdentity(candidate), view.selectedIdentity));
  let maxScroll = 0;
  if (view.phase.kind === "list") renderList(view, options.theme, width, lines);
  else if (server === undefined) add(lines, options.theme, "warning", "The exact selected identity is no longer present. Refresh or return to the list.", width);
  else if (view.phase.kind === "detail") maxScroll = renderDetail(view, server, view.phase, options.theme, width, lines);
  else if (view.phase.kind === "confirmation") {
    add(lines, options.theme, "warning", `Confirm ${view.phase.action}`, width);
    for (const identity of confirmationIdentityLines(server)) add(lines, options.theme, "warning", identity, width);
    const body: string[] = [];
    for (const text of mcpAdministrationConfirmationLines(server, view.phase.action)) add(body, options.theme, "text", text, width);
    maxScroll = Math.max(0, body.length - DETAIL_WINDOW);
    const scroll = Math.min(maxScroll, view.phase.scroll);
    if (scroll > 0) add(lines, options.theme, "muted", `↑ ${scroll} confirmation lines above`, width);
    lines.push(...body.slice(scroll, scroll + DETAIL_WINDOW));
    if (scroll + DETAIL_WINDOW < body.length) add(lines, options.theme, "muted", `↓ ${body.length - scroll - DETAIL_WINDOW} confirmation lines below`, width);
    add(lines, options.theme, "warning", "Enter submits once · Esc cancels with no action", width);
  } else if (view.phase.kind === "executing") add(lines, options.theme, "warning", `Submitting ${view.phase.action} once… · Esc closes this UI but does not cancel service work already started`, width);
  else {
    add(lines, options.theme, view.phase.effect === "confirmed-changed" ? "warning" : "muted", `${view.phase.action}: ${safe(view.phase.message, 400)}`, width);
    add(lines, options.theme, "text", `Aggregate effect: ${view.phase.effect}`, width);
    add(lines, options.theme, "text", `Recovery: ${safe(view.phase.recovery)}`, width);
    add(lines, options.theme, "text", `Durable: ${safe(view.phase.durable)}`, width);
    add(lines, options.theme, "text", `Runtime: ${safe(view.phase.runtime)}`, width);
    add(lines, options.theme, "text", `Exposure: ${safe(view.phase.exposure)}`, width);
  }
  const help = view.phase.kind === "list" ? "↑/↓ navigate · Enter details · R refresh · Esc close"
    : view.phase.kind === "detail" ? "↑/↓ focus action · ←/→ scroll details · Enter select · R refresh · Esc back"
      : view.phase.kind === "confirmation" ? "↑/↓ scroll · Enter confirm · Esc cancel"
        : view.phase.kind === "result" ? "Enter/← return · R refresh · Esc close" : "Esc close";
  const footer: string[] = [];
  add(footer, options.theme, "muted", help, width);
  const body = [...lines.slice(0, Math.max(0, 48 - footer.length)), ...footer];
  const bounded = clampLines(body, width).map((line) => {
    try { return visibleWidth(line) <= width ? line : ""; } catch { return ""; }
  });
  return { lines: bounded, maxScroll };
}
