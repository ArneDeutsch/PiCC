import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  formatUsageCompact,
  sanitizeProgressText,
  type ProgressSnapshot,
} from "./subagent-progress.js";
import { clampLines, pushColored, pushWrapped, themedBold, themedFg } from "./render-util.js";
import { formatElapsed } from "./subagent-panel-render.js";
import { FORK_DEGRADE_PREFIX, isAgentId } from "../util/subagent-transcripts.js";
import type { Diagnostic } from "../types.js";

// --- live-progress + result rendering helpers ---
//
// The Agent tool's renderCall/renderResult return a STRUCTURAL pi-tui Component
// ({ render(width): string[] }) — the same untyped contract index.ts's control
// renderers use, so no pi-tui import is needed. The width/theme helpers
// (clampLines, pushWrapped, pushColored, themedFg, themedBold) live in
// render-util.ts, shared with the subagent status panel.

// Collapsed-completion-record markers, exported so the pure render tests and
// the print-mode e2e negative assertion share the exact strings (print mode
// never runs renderers, so these must never appear on stdout).
/**
 * The subtle expand affordance on the collapsed completion record, phrased
 * like Pi's own hints (`<key> to <verb>`). A STATIC string on purpose: Pi's
 * keybinding-aware `keyHint` helper reads Pi's module-global theme + keybinding
 * singletons (initialized only inside the real TUI), so it is not reachable
 * from this pure `(result, options, theme)` renderer seam without a throw risk —
 * and the e2e print-mode negative assertion needs a stable literal to pin.
 */
export const RECORD_EXPAND_HINT = "ctrl+o to expand";
/** The condensed fork-degrade warning — NEVER expand-only on a degraded fork. */
export const RECORD_FORK_MARKER = "⚠ fork degraded";
/** Suffix of the minimal reference line for an already-reported settlement. */
export const RECORD_REFERENCE_NOTE = "full record above";

/** Per-tool-call state shared by Pi across call/result renderer slots. */
export interface SubagentLifecycleRenderState {
  resultOwned?: boolean;
}

/** Structural subset of Pi's ToolRenderContext used by lifecycle renderers. */
export interface SubagentLifecycleRenderContext {
  state?: SubagentLifecycleRenderState;
}

/** Complete details-only contract consumed by subagent lifecycle renderers. */
export interface SubagentRenderDetails {
  record?: "subagent-completion";
  background?: boolean;
  taskId?: string;
  status?: "running" | "completed" | "failed" | "stopped";
  outcome?: "completed" | "failed" | "aborted";
  agent?: string;
  agentId?: string;
  description?: string;
  durationMs?: number;
  settledAt?: number;
  usage?: unknown;
  cutOff?: boolean;
  userStopped?: boolean;
  resumable?: boolean;
  transcriptPath?: string;
  diagnostics?: Diagnostic[];
  subagentProgress?: ProgressSnapshot;
  lastActivity?: string;
  alreadyReported?: boolean;
  error?: string;
  finalText?: string;
  nested?: boolean;
  live?: boolean;
  worktreePath?: string;
  note?: string;
  delivery?: "steer" | "resume";
  resumed?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeDiagnostics(value: unknown): Diagnostic[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const diagnostics: Diagnostic[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const { severity, message, source } = item;
    if (
      (severity !== "info" && severity !== "warning" && severity !== "error") ||
      typeof message !== "string" ||
      (source !== undefined && typeof source !== "string")
    ) {
      continue;
    }
    diagnostics.push({ severity, message, ...(source === undefined ? {} : { source }) });
  }
  return diagnostics.length > 0 ? diagnostics : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeProgressSnapshot(value: unknown): ProgressSnapshot | undefined {
  if (!isRecord(value) || typeof value.activity !== "string" || !isStringArray(value.tail)) {
    return undefined;
  }
  const usage: NonNullable<ProgressSnapshot["usage"]> = {};
  if (isRecord(value.usage)) {
    const inputTokens = finiteNumber(value.usage.inputTokens);
    const outputTokens = finiteNumber(value.usage.outputTokens);
    const cacheReadTokens = finiteNumber(value.usage.cacheReadTokens);
    const cacheWriteTokens = finiteNumber(value.usage.cacheWriteTokens);
    const costUsd = finiteNumber(value.usage.costUsd);
    if (inputTokens !== undefined) usage.inputTokens = inputTokens;
    if (outputTokens !== undefined) usage.outputTokens = outputTokens;
    if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens;
    if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens;
    if (costUsd !== undefined) usage.costUsd = costUsd;
  }
  return {
    activity: value.activity,
    tail: [...value.tail],
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

function normalizeUsage(value: unknown): string | Record<string, string | number> | undefined {
  if (typeof value === "string") return sanitizeInline(value);
  if (!isRecord(value)) return undefined;
  const usage: Record<string, string | number> = {};
  if (typeof value.text === "string") usage.text = sanitizeInline(value.text);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "tokens",
    "costUsd",
    "cost",
  ]) {
    const field = finiteNumber(value[key]);
    if (field !== undefined) usage[key] = field;
  }
  return usage;
}

/** Copy validated renderer fields from persisted or extension-message data. */
function normalizeSubagentRenderDetails(value: unknown): SubagentRenderDetails | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: SubagentRenderDetails = {};

  if (value.record === "subagent-completion") normalized.record = value.record;
  if (
    value.status === "running" ||
    value.status === "completed" ||
    value.status === "failed" ||
    value.status === "stopped"
  ) {
    normalized.status = value.status;
  }
  if (value.outcome === "completed" || value.outcome === "failed" || value.outcome === "aborted") {
    normalized.outcome = value.outcome;
  }
  if (value.delivery === "steer" || value.delivery === "resume") normalized.delivery = value.delivery;

  if (typeof value.taskId === "string") normalized.taskId = value.taskId;
  if (typeof value.agent === "string") normalized.agent = value.agent;
  if (typeof value.agentId === "string") normalized.agentId = value.agentId;
  if (typeof value.description === "string") normalized.description = value.description;
  if (typeof value.transcriptPath === "string") normalized.transcriptPath = value.transcriptPath;
  if (typeof value.lastActivity === "string") normalized.lastActivity = value.lastActivity;
  if (typeof value.error === "string") normalized.error = value.error;
  if (typeof value.finalText === "string") normalized.finalText = value.finalText;
  if (typeof value.worktreePath === "string") normalized.worktreePath = value.worktreePath;
  if (typeof value.note === "string") normalized.note = value.note;

  const durationMs = finiteNumber(value.durationMs);
  const settledAt = finiteNumber(value.settledAt);
  if (durationMs !== undefined) normalized.durationMs = durationMs;
  if (settledAt !== undefined) normalized.settledAt = settledAt;

  if (typeof value.background === "boolean") normalized.background = value.background;
  if (typeof value.cutOff === "boolean") normalized.cutOff = value.cutOff;
  if (typeof value.userStopped === "boolean") normalized.userStopped = value.userStopped;
  if (typeof value.resumable === "boolean") normalized.resumable = value.resumable;
  if (typeof value.alreadyReported === "boolean") {
    normalized.alreadyReported = value.alreadyReported;
  }
  if (typeof value.nested === "boolean") normalized.nested = value.nested;
  if (typeof value.live === "boolean") normalized.live = value.live;
  if (typeof value.resumed === "boolean") normalized.resumed = value.resumed;

  const usage = normalizeUsage(value.usage);
  if (usage !== undefined) normalized.usage = usage;
  const diagnostics = normalizeDiagnostics(value.diagnostics);
  if (diagnostics) normalized.diagnostics = diagnostics;
  const progress = normalizeProgressSnapshot(value.subagentProgress);
  if (progress) normalized.subagentProgress = progress;

  return normalized;
}

/**
 * SECURITY: body render paths split on this, not on `\n` alone — a
 * model-controlled `\r` surviving into an emitted line would overprint the line
 * start (same-line display spoofing), and `sanitizeProgressText` deliberately
 * preserves `\r`.
 */
const LINE_BREAK_RE = /\r\n?|\n/;

/** Push multi-line body text, breaking on \r\n / \r / \n before wrapping. */
function pushBodyText(text: string, width: number, into: string[]): void {
  for (const line of String(text ?? "").split(LINE_BREAK_RE)) pushWrapped(line, width, into);
}

/** Flatten model-/file-supplied label text to a single sanitized display line. */
function sanitizeInline(text: string): string {
  return sanitizeProgressText(String(text ?? "")).replace(/\s+/g, " ").trim();
}

/**
 * The `Task(task-N)` chip when `details.taskId` is present — the gate
 * for EVERY background-identity addition below, so the foreground Agent view is
 * untouched. `undefined` when absent. `taskId` is registry-minted (`task-N`) but
 * sanitized anyway so the discipline is uniform.
 */
function taskChip(details: SubagentRenderDetails): string | undefined {
  const taskId = typeof details.taskId === "string" ? sanitizeInline(details.taskId) : "";
  return taskId ? `Task(${taskId})` : undefined;
}

/**
 * The stable `agent-<id>` when present AND well-formed — gated through
 * `isAgentId` (it is model-/file-adjacent metadata), so a malformed value never
 * reaches the terminal. `undefined` otherwise.
 */
function agentIdOf(details: SubagentRenderDetails): string | undefined {
  return typeof details.agentId === "string" && isAgentId(details.agentId)
    ? details.agentId
    : undefined;
}

/**
 * The muted `agent-<id>` identity SUBLINE, emitted at EVERY task
 * surface (live / poll / settled) so a background task id is always traceable to
 * its agent and on-disk transcript — INDEPENDENT of `resumable`/`transcript` (a
 * non-resumable, transcript-less builtin still shows its id). Its own line so it
 * is never the element truncated out of a crowded header. No-op when absent.
 */
function pushIdentitySubline(
  theme: unknown,
  details: SubagentRenderDetails,
  width: number,
  into: string[],
): void {
  const id = agentIdOf(details);
  if (id) pushColored(theme, "muted", id, width, into);
}

/**
 * The developer-facing fork-degrade footer. A `subagent_type: "fork"`
 * dispatch that could not inherit the parent conversation runs fresh and records
 * a fork-SPECIFIC diagnostic (never the generic unknown-type warning) whose
 * message starts with this sentinel. We surface it as a muted footer line so the
 * degrade is VISIBLE — distinguishing a genuine inherited fork (no such line,
 * honest `Agent(fork)` badge) from a degraded one (this line + a fresh-agent
 * badge). Read from `details.diagnostics`, the channel BOTH the foreground Agent
 * result and the background TaskOutput result already carry — so no extra
 * plumbing is needed. `FORK_DEGRADE_PREFIX` is the shared sentinel (imported from
 * the transcript util) that the emitter in subagents.ts writes.
 */
function forkDegradeLine(
  details: SubagentRenderDetails,
): { text: string; tone: string } | undefined {
  const diags: unknown = details.diagnostics;
  if (!Array.isArray(diags)) return undefined;
  for (const diagnostic of diags) {
    if (!isRecord(diagnostic)) continue;
    const { message, severity } = diagnostic;
    if (
      typeof message === "string" &&
      (severity === "info" || severity === "warning" || severity === "error") &&
      message.startsWith(FORK_DEGRADE_PREFIX)
    ) {
      // Tone: `warning` for a genuine can't-do (no transcript, SDK can't fork,
      // forkFrom threw); muted/calm for a chosen/expected opt-out (env `=0`).
      return { text: message, tone: severity === "warning" ? "warning" : "muted" };
    }
  }
  return undefined;
}

/**
 * Usage formatter for the renderResult footer.
 * Renders a string as-is, an explicit `text` override, otherwise delegates to
 * the shared `formatUsageCompact` (the `{ inputTokens, … costUsd }` shape, and
 * the legacy `totalTokens`/`cost` shape). Returns NOTHING when absent or an
 * unrecognized shape, so the footer line drops entirely.
 */
function formatUsageLine(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return sanitizeInline(usage) || undefined;
  if (typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.text === "string") return sanitizeInline(u.text) || undefined;
    return formatUsageCompact(u);
  }
  return undefined;
}

/**
 * The outcome badge line: colored symbol + agent + fate word.
 * When `taskChipLabel` is present (the background surface), the badge leads
 * with the `Task(task-N)` chip — `● Task(task-3) · Agent(coder) completed` — so
 * completed / failed / aborted background outcomes are all self-identifying.
 * A USER-initiated stop (details.userStopped, panel action) overrides the fate
 * word — `■ … stopped by user` — so it is visually distinct from a model stop.
 */
function outcomeBadgeLine(
  theme: unknown,
  outcome: string | undefined,
  cutOff: boolean,
  agentName: unknown,
  taskChipLabel?: string,
  userStopped?: boolean,
): string {
  // SECURITY: agentName is model-supplied (subagent_type) OR project-file-supplied
  // (agent `name:` frontmatter) — sanitize before it reaches the parent terminal.
  const safeName = sanitizeInline(typeof agentName === "string" ? agentName : "");
  const agent = safeName ? `Agent(${safeName})` : "Agent";
  const subject = taskChipLabel ? `${taskChipLabel} · ${agent}` : agent;
  let symbol = "•";
  let color = "muted";
  let word = sanitizeInline(outcome ?? "") || "done";
  if (outcome === "completed") {
    symbol = "●";
    color = "success";
    word = cutOff ? "completed (truncated)" : "completed";
  } else if (outcome === "failed") {
    symbol = "✗";
    color = "error";
    word = cutOff ? "failed (partial output preserved)" : "failed";
  } else if (outcome === "aborted") {
    // Reached by the background TaskOutput/settlement surfaces (a stopped
    // task's outcome reads "aborted"); today's live foreground path throws
    // aborted/failed-no-output before this renders.
    symbol = "■";
    color = "warning";
    word = "aborted";
  }
  if (userStopped === true) {
    symbol = "■";
    color = "warning";
    word = "stopped by user";
  }
  return themedFg(theme, color, themedBold(theme, `${symbol} ${subject} ${word}`));
}

/** `details.durationMs` formatted for display, or undefined when absent/invalid. */
function durationOf(details: SubagentRenderDetails): string | undefined {
  const ms = details.durationMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? formatElapsed(ms)
    : undefined;
}

/** Local wall-clock completion time, after JavaScript Date TimeClip validation. */
function completionTimeOf(details: SubagentRenderDetails): string | undefined {
  if (typeof details.settledAt !== "number" || !Number.isFinite(details.settledAt)) return undefined;
  const date = new Date(details.settledAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Collapsed-line error summary cap — the full error stays behind expand. */
const COLLAPSED_ERROR_CAP = 80;

/**
 * Collapsed-line usage: in/out tokens (+cost) ONLY. The cache read/write
 * counts live EXCLUSIVELY in the expanded `usage:` footer so the normal row
 * stays concise. Same shape tolerance as {@link formatUsageLine} otherwise.
 */
function formatUsageBrief(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return sanitizeInline(usage) || undefined;
  if (typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u.text === "string") return sanitizeInline(u.text) || undefined;
  const brief: Record<string, unknown> = { ...u };
  delete brief.cacheReadTokens;
  delete brief.cacheWriteTokens;
  return formatUsageCompact(brief);
}

type LifecycleSegment = { separator: " · " | " - "; text: string; tone?: string };

/** Fit lifecycle rows by dropping optional detail, then fitting or removing the elastic agent. */
function lifecycleLine(
  theme: unknown,
  options: {
    agent: unknown;
    chip?: string;
    state: string;
    agentPlacement?: "before-task" | "after-task";
    prefix?: string;
    cue?: string;
    required?: LifecycleSegment[];
    optional?: LifecycleSegment[];
    tone: string;
  },
  width: number,
): string[] {
  const safeAgent = sanitizeInline(typeof options.agent === "string" ? options.agent : "") || "subagent";
  const required = options.required ?? [];
  const optional = [...(options.optional ?? [])];
  const placement = options.agentPlacement ?? "before-task";
  const prefix = options.prefix ?? "";
  const primaryText = (agent: string | undefined) => {
    if (!options.chip) return `${prefix}Agent(${agent ?? safeAgent})${options.state ? ` ${options.state}` : ""}`;
    if (placement === "after-task") {
      return `${prefix}${options.chip}${agent === undefined ? "" : ` · Agent(${agent})`}${options.state ? ` ${options.state}` : ""}`;
    }
    return `${prefix}${agent === undefined ? "" : `Agent(${agent}) → `}${options.chip}${options.state ? ` ${options.state}` : ""}`;
  };
  const plain = (agent: string | undefined) => {
    let line = primaryText(agent);
    for (const segment of required) line += `${segment.separator}${segment.text}`;
    for (const segment of optional) line += `${segment.separator}${segment.text}`;
    if (options.cue) line += ` · ${options.cue}`;
    return line;
  };

  while (optional.length > 0 && visibleWidth(plain(safeAgent)) > width) optional.pop();

  let fittedAgent: string | undefined = safeAgent;
  if (visibleWidth(plain(fittedAgent)) > width) {
    if (options.chip) {
      const withoutAgentWidth = visibleWidth(plain(undefined));
      const emptyAgentOverhead = visibleWidth(plain("")) - withoutAgentWidth;
      const agentBudget = width - withoutAgentWidth - emptyAgentOverhead;
      const truncated = agentBudget > 0 ? truncateToWidth(safeAgent, agentBudget, "…") : "";
      fittedAgent = truncated && visibleWidth(plain(truncated)) <= width ? truncated : undefined;
    } else {
      const agentBudget = Math.max(0, width - visibleWidth(plain("")));
      fittedAgent = truncateToWidth(safeAgent, agentBudget, agentBudget > 0 ? "…" : "");
    }
  }

  let line = themedFg(theme, options.tone, themedBold(theme, primaryText(fittedAgent)));
  for (const segment of required) {
    line += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
  }
  for (const segment of optional) {
    line += themedFg(theme, segment.tone ?? "muted", `${segment.separator}${segment.text}`);
  }
  if (options.cue) line += themedFg(theme, "muted", ` · ${options.cue}`);
  // Only widths narrower than the complete required row reach this final clamp.
  return clampLines([line], width);
}

/**
 * The COLLAPSED completion record: one badge line — outcome glyph, chip +
 * agent, fate word, then (muted) the capped error summary for failures, the
 * condensed fork-degrade marker (never expand-only), duration, brief usage,
 * successful completion time, and the expand affordance. Transcript access and
 * complete metadata remain reachable via the existing Ctrl+O expansion.
 */
function collapsedRecordLines(
  theme: unknown,
  details: SubagentRenderDetails,
  outcome: "completed" | "failed" | "aborted",
  chip: string | undefined,
  width: number,
): string[] {
  if (outcome === "completed") {
    const optional: LifecycleSegment[] = [];
    const fork = forkDegradeLine(details);
    const duration = durationOf(details);
    if (duration) optional.push({ separator: " · ", text: duration });
    const usage = formatUsageBrief(details.usage);
    if (usage) optional.push({ separator: " · ", text: usage });
    const completionTime = completionTimeOf(details);
    if (completionTime) optional.push({ separator: " · ", text: completionTime });
    return lifecycleLine(
      theme,
      {
        agent: details.agent,
        ...(chip ? { chip } : {}),
        state: details.cutOff === true ? "completed (truncated)" : "completed",
        cue: RECORD_EXPAND_HINT,
        required: fork ? [{ separator: " · ", text: RECORD_FORK_MARKER }] : [],
        optional,
        tone: "success",
      },
      width,
    );
  }

  const userStopped = details.userStopped === true;
  const state = userStopped
    ? "stopped by user"
    : outcome === "failed" && details.cutOff === true
      ? "failed (partial output preserved)"
      : outcome;
  const symbol = outcome === "failed" && !userStopped ? "✗" : "■";
  const tone = outcome === "failed" && !userStopped ? "error" : "warning";
  const required: LifecycleSegment[] = [];
  const fork = forkDegradeLine(details);
  if (fork) required.push({ separator: " · ", text: RECORD_FORK_MARKER, tone: fork.tone });
  const optional: LifecycleSegment[] = [];
  if (outcome === "failed") {
    const error = sanitizeInline(typeof details.error === "string" ? details.error : "");
    if (error) {
      optional.push({
        separator: " · ",
        text: truncateToWidth(error, COLLAPSED_ERROR_CAP, "…"),
        tone: "error",
      });
    }
  }
  const duration = durationOf(details);
  if (duration) optional.push({ separator: " · ", text: duration });
  const usage = formatUsageBrief(details.usage);
  if (usage) optional.push({ separator: " · ", text: usage });
  const completionTime = completionTimeOf(details);
  if (completionTime) optional.push({ separator: " · ", text: completionTime });

  return lifecycleLine(
    theme,
    {
      agent: details.agent,
      ...(chip ? { chip } : {}),
      state,
      agentPlacement: "after-task",
      prefix: `${symbol} `,
      cue: RECORD_EXPAND_HINT,
      required,
      optional,
      tone,
    },
    width,
  );
}

/**
 * The minimal non-expandable reference for a settlement whose completion
 * record was already emitted. A later TaskOutput collection never re-renders a
 * second full record or repeats transcript plumbing.
 */
function referenceRecordLines(
  theme: unknown,
  details: SubagentRenderDetails,
  outcome: "completed" | "failed" | "aborted",
  chip: string | undefined,
  width: number,
): string[] {
  const userStopped = details.userStopped === true;
  const state =
    outcome === "completed"
      ? details.cutOff === true
        ? "completed (truncated)"
        : "completed"
      : userStopped
        ? "stopped by user"
        : outcome === "failed" && details.cutOff === true
          ? "failed (partial output preserved)"
          : outcome;
  const exceptional = outcome !== "completed";
  const fork = forkDegradeLine(details);
  return lifecycleLine(
    theme,
    {
      agent: details.agent,
      ...(chip ? { chip } : {}),
      state,
      ...(exceptional
        ? {
            agentPlacement: "after-task" as const,
            prefix: outcome === "failed" && !userStopped ? "✗ " : "■ ",
          }
        : {}),
      cue: RECORD_REFERENCE_NOTE,
      required: fork
        ? [{ separator: " · ", text: RECORD_FORK_MARKER, tone: fork.tone }]
        : [],
      tone:
        outcome === "completed"
          ? "success"
          : outcome === "failed" && !userStopped
            ? "error"
            : "warning",
    },
    width,
  );
}

/**
 * The single running-status line shared by streaming partials and wait:false
 * polls: identity, state, and available metadata only. The panel/detail surface
 * owns live activity.
 */
function runningStatusLines(
  theme: unknown,
  chip: string | undefined,
  agent: string,
  details: SubagentRenderDetails,
  width: number,
): string[] {
  const optional: LifecycleSegment[] = [];
  const duration = durationOf(details);
  if (duration) optional.push({ separator: " · ", text: duration });
  const usage = formatUsageBrief(details.usage ?? details.subagentProgress?.usage);
  if (usage) optional.push({ separator: " · ", text: usage });
  return lifecycleLine(
    theme,
    { agent, ...(chip ? { chip } : {}), state: "running", optional, tone: "toolTitle" },
    width,
  );
}

/**
 * Strip the model-facing agent-ID trailer off the HUMAN-rendered
 * body. The model still reads `result.content` verbatim (trailer included); only
 * this local display copy drops it, so the footer can present the ID + a single
 * resumable hint without the raw `---`/`[agent …]` plumbing showing up too.
 * Case 1: a completed trailer opened its own `\n\n---\n` frame — drop the frame.
 * Case 2: a truncated/failed trailer rode inside an existing cut-off frame with a
 * single `\n` prefix — drop only the trailer line, keeping the cut-off frame.
 */
function stripAgentTrailerForDisplay(text: string): string {
  const framed = text.replace(/\n\n---\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
  if (framed !== text) return framed;
  return text.replace(/\n\[agent agent-[0-9a-f]{12}[^\]\n]*\]\s*$/, "");
}

/**
 * Strip the leading self-identification (`Background task task-N (type,
 * agent-<id>) failed: ` / `… was aborted — `) from the DISPLAY body of a failed
 * or aborted TaskOutput result — the badge + agent-<id> subline already state it,
 * so the body would otherwise triple it. The reason/tail is kept (`connection
 * reset`, the `it was stopped before completing…` clause). Display-only: the
 * model-facing content stays self-identifying for print/RPC.
 */
function stripTaskIdentityPrefix(text: string, taskId: string, outcome: string): string {
  const esc = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `\(.*?\)` is non-greedy but MUST be followed by the literal suffix, so nested
  // parens in a label (e.g. `foo(bar)`) don't cause a premature match. The subject
  // is a single sanitized line, so `.` never crosses the newline into the reason.
  if (outcome === "failed") {
    return text.replace(new RegExp(`^Background task ${esc} \\(.*?\\) failed: `), "");
  }
  if (outcome === "aborted") {
    return text.replace(new RegExp(`^Background task ${esc} \\(.*?\\) was aborted — `), "");
  }
  return text;
}

/** renderCall: one mode-neutral pending invocation until a result owns the row. */
export function renderAgentCall(
  args: Record<string, unknown>,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const a = (args ?? {}) as Record<string, unknown>;
  const agentType = sanitizeInline(String(a.subagent_type ?? "")) || "general-purpose";
  const description = sanitizeInline(String(a.description ?? ""));
  return {
    render(width: number): string[] {
      if (context?.state?.resultOwned === true) return [];
      return lifecycleLine(
        theme,
        {
          agent: agentType,
          state: "",
          optional: description ? [{ separator: " - ", text: description }] : [],
          tone: "toolTitle",
        },
        width,
      );
    },
  };
}

/**
 * renderResult (REQUIRED). Two modes:
 *  - PARTIAL (streaming): ONE identity/state/metadata line; the status panel
 *    and its drill-down own live activity.
 *  - FINAL: the collapsed completion record by default (identity + duration +
 *    usage + local completion time + expand affordance), expanding via Ctrl+O
 *    mechanism to the full body + metadata footer. Every field is optional and
 *    rendered only when present.
 */
export function renderAgentResult(
  result: { content?: Array<{ type: string; text: string }>; details?: SubagentRenderDetails },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  if (context?.state) context.state.resultOwned = true;
  const details: SubagentRenderDetails = result?.details ?? {};
  const contentText = (result?.content ?? [])
    .filter((c) => c && c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n");
  const isPartial = options?.isPartial === true;
  return {
    render(width: number): string[] {
      const lines: string[] = [];
      if (isPartial) {
        const candidate = details.subagentProgress;
        const snap =
          candidate &&
          typeof candidate.activity === "string" &&
          Array.isArray(candidate.tail) &&
          candidate.tail.every((line) => typeof line === "string")
            ? candidate
            : undefined;
        // SECURITY: details.agent originates from the model-supplied subagent_type — sanitize.
        const agent = sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        // A background live view leads with the Task chip + agent type;
        // the foreground view (no taskId) keeps the bare `Agent(<type>)` header.
        const chip = taskChip(details);
        return runningStatusLines(
          theme,
          chip,
          agent,
          snap ? { ...details, subagentProgress: snap } : details,
          width,
        );
      }
      // Final result.
      // A successful background dispatch is one task-targeted line. The normal
      // producer always supplies taskId; the fallback below remains defensive.
      if (details.background === true) {
        const bgChip = taskChip(details);
        if (bgChip) {
          const agent =
            sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
          const taskId = sanitizeInline(String(details.taskId ?? ""));
          const description = sanitizeInline(details.description ?? "");
          return lifecycleLine(
            theme,
            {
              agent,
              chip: `Task(${taskId})`,
              state: "background",
              optional: description ? [{ separator: " - ", text: description }] : [],
              tone: "accent",
            },
            width,
          );
        } else {
          lines.push(themedFg(theme, "accent", themedBold(theme, "Agent → background")));
          // SECURITY: the start message embeds the model-supplied agent label — sanitize.
          pushBodyText(sanitizeProgressText(contentText), width, lines);
        }
        return clampLines(lines, width);
      }
      // A wait:false poll on a RUNNING task renders one self-identifying
      // state/metadata line, never activity or a rolling tail. Gated on taskId (a foreground
      // final never carries status:"running").
      const chip = taskChip(details);
      if (chip && details.status === "running") {
        const agent =
          sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        return runningStatusLines(theme, chip, agent, details, width);
      }
      const outcome = typeof details.outcome === "string" ? details.outcome : undefined;
      // Exactly-once reconciliation: a settlement whose completion record was
      // already emitted (settlement notice, or an earlier collection) renders
      // only a minimal reference line — never a second full record.
      if (outcome && details.alreadyReported === true) {
        return referenceRecordLines(theme, details, outcome, chip, width);
      }
      // Collapsed by default in the interactive transcript: Pi always passes a
      // BOOLEAN `expanded` (false until the global Ctrl+O toggle), so the
      // collapse keys on the EXPLICIT false. A structural caller that omits the
      // option gets the full record — print/RPC never run renderers, so this
      // only widens compatibility for direct callers.
      if (outcome && options?.expanded === false) {
        return collapsedRecordLines(theme, details, outcome, chip, width);
      }
      if (outcome) {
        // `chip` leads the badge for background outcomes; the badge word flips
        // to "stopped by user" for a panel-stopped task (details.userStopped).
        lines.push(
          outcomeBadgeLine(
            theme,
            outcome,
            details.cutOff === true,
            details.agent,
            chip,
            details.userStopped === true,
          ),
        );
        // Identity subline at the SETTLED surface — SUPPRESSED when the resumable
        // footer will already print "— agent <id>" (avoid showing the id twice).
        // Kept for non-resumable settled (its only occurrence).
        const resumableFooterShowsId =
          details.resumable === true && agentIdOf(details) !== undefined;
        if (chip && !resumableFooterShowsId) pushIdentitySubline(theme, details, width, lines);
      }
      // SECURITY: the model reads result.content verbatim (with the agent-ID
      // trailer); the HUMAN view strips that trailer (the footer carries the ID
      // + a single resumable hint) and sanitizes control sequences. This builds
      // a local display string only — result.content is never mutated.
      // TaskOutput's completed content appends a
      // `\nusage: …` line AFTER the agent-ID trailer, which would defeat the
      // end-anchored trailer strip (raw trailer shown + usage rendered twice).
      // Drop that trailing usage line from the DISPLAY body first — the footer
      // re-renders usage from details.usage. GATED ON taskId (only TaskOutput
      // appends this line) so a FOREGROUND agent whose final message legitimately
      // ends in a `usage:` line is never mutilated; and on details.usage so a
      // background task with none keeps a genuine trailing `usage:` body line.
      let displaySource = contentText;
      if (details.taskId != null && details.usage != null) {
        displaySource = displaySource.replace(/\nusage:[^\n]*$/, "");
      }
      // For a taskId'd failed/aborted result the badge + subline already
      // state the identity — strip the leading self-identification from the body.
      if (chip && (outcome === "failed" || outcome === "aborted")) {
        displaySource = stripTaskIdentityPrefix(displaySource, String(details.taskId), outcome);
      }
      const body = sanitizeProgressText(stripAgentTrailerForDisplay(displaySource));
      if (body) pushBodyText(body, width, lines);
      const footer: string[] = [];
      if (typeof details.transcriptPath === "string" && details.transcriptPath) {
        // UX: a full session path is often far wider than the terminal and wraps
        // into unreadable, hard-sliced fragments. Show it whole only when it fits;
        // otherwise show the basename (the agent id + .jsonl — what a human uses to
        // find the file), marked with a leading ellipsis. The model still gets the
        // full path via result.content / the transcript details, so nothing is lost.
        const tp = sanitizeInline(details.transcriptPath);
        const full = `transcript: ${tp}`;
        if (visibleWidth(full) <= width) {
          footer.push(full);
        } else {
          const sep = tp.includes("\\") ? "\\" : "/";
          const base = tp.split(/[\\/]/).pop() || tp;
          footer.push(`transcript: …${sep}${base}`);
        }
      }
      const duration = durationOf(details);
      if (duration) footer.push(`duration: ${duration}`);
      const usage = formatUsageLine(details.usage);
      if (usage) footer.push(`usage: ${usage}`);
      if (details.resumable === true) {
        // The ID rides in the footer (not a duplicated raw trailer frame).
        const id =
          typeof details.agentId === "string" && isAgentId(details.agentId)
            ? details.agentId
            : undefined;
        footer.push(id ? `resumable via SendMessage — agent ${id}` : "resumable via SendMessage");
      }
      // Wrap each footer line to width (word-wrap, ANSI-aware) as a final guard.
      for (const f of footer) pushColored(theme, "muted", f, width, lines);
      // A degraded fork's fork-specific notice — its own footer line, toned
      // calm (muted) for an expected opt-out and `warning` for a genuine can't-do,
      // so the developer sees WHY a "fork" ran with fresh context (the badge above
      // already reads as the fresh agent, not `Agent(fork)`).
      const forkLine = forkDegradeLine(details);
      if (forkLine) pushColored(theme, forkLine.tone, sanitizeInline(forkLine.text), width, lines);
      return clampLines(lines.length ? lines : [""], width);
    },
  };
}

/**
 * renderCall for the TaskOutput tool: a self-identifying dispatch-time
 * line — `TaskOutput(task-N) · Agent(<type>)` — reusing this module's private
 * width-clamp/theme helpers so it inherits the same overflow + sanitize
 * discipline. `agentType` is looked up from the registry by the caller (it is
 * model-/file-supplied, so it is sanitized here before display).
 */
export function renderTaskOutputCall(
  args: Record<string, unknown>,
  theme: unknown,
  context?: SubagentLifecycleRenderContext,
) {
  const taskId = sanitizeInline(String((args ?? {}).task_id ?? ""));
  const action = (args ?? {}).wait === false ? "polling" : "awaiting";
  return {
    render(width: number): string[] {
      if (context?.state?.resultOwned === true) return [];
      const chip = taskId ? `TaskOutput(${taskId})` : "TaskOutput";
      return clampLines(
        [themedFg(theme, "toolTitle", themedBold(theme, `${chip} ${action}`))],
        width,
      );
    },
  };
}

/**
 * Renderer for the `picc-settlement` custom MESSAGE (registered via
 * `pi.registerMessageRenderer` in index.ts): a never-awaited background
 * settlement's notice renders as the SAME collapsed-expandable completion
 * record the tool renderers draw, keyed off the structured `details` the
 * settlement send attaches. Only the rendering changes — the model-facing
 * steer text is untouched. Returns undefined — falling back to Pi's default
 * custom-message box — for messages without the record details (older
 * sessions) and for NESTED (depth ≥ 2) tasks, which get no main-chat
 * completion record.
 */
export function renderSettlementRecord(
  details: unknown,
  options: { expanded?: boolean } | undefined,
  theme: unknown,
): { render(width: number): string[] } | undefined {
  const normalized = normalizeSubagentRenderDetails(details);
  if (normalized?.record !== "subagent-completion") return undefined;
  if (normalized.nested === true) return undefined;
  const finalText = normalized.finalText ?? "";
  const outcome = normalized.outcome ?? "completed";
  // Compose the expanded body the way the TaskOutput display reads: reason +
  // partial output for a failure, the discard note for an abort, the verbatim
  // final text otherwise. renderAgentResult sanitizes it before display.
  let text = finalText;
  if (outcome === "failed") {
    const err = normalized.error || "unknown error";
    text = finalText ? `${err}\n\nPartial output before the failure:\n${finalText}` : err;
  } else if (outcome === "aborted") {
    text = "The task was stopped before completing; its result was discarded.";
  }
  return renderAgentResult(
    { content: [{ type: "text", text }], details: normalized },
    // Normalize to an explicit boolean: expanded===false is the collapse key.
    { expanded: options?.expanded === true, isPartial: false },
    theme,
  );
}
