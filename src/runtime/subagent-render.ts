import { visibleWidth } from "@earendil-works/pi-tui";
import {
  formatUsageCompact,
  sanitizeProgressText,
  type ProgressSnapshot,
} from "./subagent-progress.js";
import { clampLines, pushColored, pushWrapped, themedBold, themedFg } from "./render-util.js";
import { formatElapsed } from "./subagent-panel-render.js";
import { FORK_DEGRADE_PREFIX, isAgentId } from "../util/subagent-transcripts.js";

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
function taskChip(details: Record<string, unknown>): string | undefined {
  const taskId = typeof details.taskId === "string" ? sanitizeInline(details.taskId) : "";
  return taskId ? `Task(${taskId})` : undefined;
}

/**
 * The stable `agent-<id>` when present AND well-formed — gated through
 * `isAgentId` (it is model-/file-adjacent metadata), so a malformed value never
 * reaches the terminal. `undefined` otherwise.
 */
function agentIdOf(details: Record<string, unknown>): string | undefined {
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
  details: Record<string, unknown>,
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
  details: Record<string, unknown>,
): { text: string; tone: string } | undefined {
  const diags = details.diagnostics;
  if (!Array.isArray(diags)) return undefined;
  for (const d of diags) {
    const msg = d && typeof d === "object" ? (d as { message?: unknown }).message : undefined;
    if (typeof msg === "string" && msg.startsWith(FORK_DEGRADE_PREFIX)) {
      const severity = (d as { severity?: unknown }).severity;
      // Tone: `warning` for a genuine can't-do (no transcript, SDK can't fork,
      // forkFrom threw); muted/calm for a chosen/expected opt-out (env `=0`).
      return { text: msg, tone: severity === "warning" ? "warning" : "muted" };
    }
  }
  return undefined;
}

/** First non-empty line of `text`, trimmed and capped for a one-line preview. */
function firstLine(text: string, max: number): string {
  for (const line of String(text ?? "").split(LINE_BREAK_RE)) {
    const t = line.trim();
    if (t) return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
  }
  return "";
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
  if (typeof usage === "string") return usage.trim() || undefined;
  if (typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    if (typeof u.text === "string" && u.text.trim()) return u.text.trim();
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
function durationOf(details: Record<string, unknown>): string | undefined {
  const ms = details.durationMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? formatElapsed(ms)
    : undefined;
}

/** The transcript-file basename (the human pointer to the on-disk transcript). */
function transcriptBasename(details: Record<string, unknown>): string | undefined {
  const tp =
    typeof details.transcriptPath === "string" && details.transcriptPath
      ? sanitizeInline(details.transcriptPath)
      : "";
  if (!tp) return undefined;
  return tp.split(/[\\/]/).pop() || tp;
}

/** Collapsed-line error summary cap — the full error stays behind expand. */
const COLLAPSED_ERROR_CAP = 80;

/**
 * Collapsed-line usage: in/out tokens (+cost) ONLY. The cache read/write
 * counts live EXCLUSIVELY in the expanded `usage:` footer — on the one-line
 * record they would push the transcript pointer and the expand hint past the
 * right edge at ordinary widths (~120 columns), and truncation eats from the
 * right. Same shape tolerance as {@link formatUsageLine} otherwise.
 */
function formatUsageBrief(usage: unknown): string | undefined {
  if (usage == null) return undefined;
  if (typeof usage === "string") return usage.trim() || undefined;
  if (typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  if (typeof u.text === "string" && u.text.trim()) return u.text.trim();
  const brief: Record<string, unknown> = { ...u };
  delete brief.cacheReadTokens;
  delete brief.cacheWriteTokens;
  return formatUsageCompact(brief);
}

/**
 * The COLLAPSED completion record: one badge line — outcome glyph, chip +
 * agent, fate word, then (muted) the capped error summary for failures, the
 * condensed fork-degrade marker (never expand-only), duration, tokens (in/out
 * + cost only — cache counts stay behind expand), the transcript-basename
 * pointer, and the expand affordance. Everything beyond this line is reachable
 * via the existing Ctrl+O expand.
 */
function collapsedRecordLines(
  theme: unknown,
  details: Record<string, unknown>,
  outcome: string,
  chip: string | undefined,
  width: number,
): string[] {
  const parts: string[] = [
    outcomeBadgeLine(
      theme,
      outcome,
      details.cutOff === true,
      details.agent,
      chip,
      details.userStopped === true,
    ),
  ];
  if (outcome === "failed") {
    // SECURITY: the error is model-/provider-adjacent text — single-line sanitize.
    const err = sanitizeInline(typeof details.error === "string" ? details.error : "");
    if (err) {
      parts.push(
        themedFg(
          theme,
          "error",
          err.length > COLLAPSED_ERROR_CAP ? `${err.slice(0, COLLAPSED_ERROR_CAP - 1)}…` : err,
        ),
      );
    }
  }
  const fork = forkDegradeLine(details);
  if (fork) parts.push(themedFg(theme, fork.tone, RECORD_FORK_MARKER));
  const duration = durationOf(details);
  if (duration) parts.push(themedFg(theme, "muted", duration));
  const usage = formatUsageBrief(details.usage);
  if (usage) parts.push(themedFg(theme, "muted", usage));
  const pointer = transcriptBasename(details);
  if (pointer) parts.push(themedFg(theme, "muted", pointer));
  parts.push(themedFg(theme, "muted", RECORD_EXPAND_HINT));
  return clampLines([parts.join(themedFg(theme, "muted", " · "))], width);
}

/**
 * The minimal reference line for a settlement whose completion record was
 * already emitted (exactly-once reconciliation): badge + a pointer to the
 * record above + the transcript-basename pointer (so even the reference
 * surface names the on-disk file), on both the collapsed AND expanded views —
 * a later TaskOutput collection never re-renders a second full record.
 */
function referenceRecordLines(
  theme: unknown,
  details: Record<string, unknown>,
  outcome: string,
  chip: string | undefined,
  width: number,
): string[] {
  const badge = outcomeBadgeLine(
    theme,
    outcome,
    details.cutOff === true,
    details.agent,
    chip,
    details.userStopped === true,
  );
  const pointer = transcriptBasename(details);
  const tail = pointer ? ` · ${RECORD_REFERENCE_NOTE} · ${pointer}` : ` · ${RECORD_REFERENCE_NOTE}`;
  return clampLines([badge + themedFg(theme, "muted", tail)], width);
}

/**
 * The single running-status line shared by the streaming partial and the
 * wait:false poll frame: identity header + `running…` + the current activity
 * (the panel/drill-down own the full live view; the transcript keeps one
 * legible current-activity line — the chosen "left open" reading).
 */
function runningStatusLines(
  theme: unknown,
  chip: string | undefined,
  agent: string,
  activity: string,
  width: number,
): string[] {
  const header = chip ? `${chip} · Agent(${agent})` : `Agent(${agent})`;
  const line =
    themedFg(theme, "toolTitle", themedBold(theme, header)) +
    themedFg(theme, "muted", " running…") +
    (activity
      ? themedFg(theme, "accent", ` · ${activity}`)
      : themedFg(theme, "muted", " · starting…"));
  return clampLines([line], width);
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

/** renderCall: agent type + description/prompt-head at dispatch time. */
export function renderAgentCall(args: Record<string, unknown>, theme: unknown) {
  const a = (args ?? {}) as Record<string, unknown>;
  // SECURITY: subagent_type/description/prompt are model-supplied and reach the
  // parent terminal — sanitize the DISPLAY strings (Pi does not sanitize
  // component render output). agentType is additionally flattened to one line.
  const agentType =
    sanitizeProgressText(String(a.subagent_type ?? "").trim()).replace(/\s+/g, " ").trim() ||
    "general-purpose";
  const detail = sanitizeProgressText(
    String(a.description ?? "").trim() || firstLine(String(a.prompt ?? ""), 100),
  );
  const background = a.run_in_background === true;
  return {
    render(width: number): string[] {
      const title =
        themedFg(theme, "toolTitle", themedBold(theme, `Agent(${agentType})`)) +
        (background ? themedFg(theme, "muted", " [background]") : "");
      const lines = [title];
      if (detail) {
        const wrapped: string[] = [];
        // Split on \r\n / \r / \n (not \n alone) so a CR in a model-supplied
        // description can never overprint the emitted line.
        for (const seg of detail.split(LINE_BREAK_RE)) pushWrapped(`  ${seg}`, width, wrapped);
        for (const l of wrapped) lines.push(themedFg(theme, "muted", l));
      }
      return clampLines(lines, width);
    },
  };
}

/**
 * renderResult (REQUIRED). Two modes:
 *  - PARTIAL (streaming): ONE running-status line (identity + current
 *    activity) — the status panel and its drill-down own the live rolling view.
 *  - FINAL: the collapsed completion record by default (badge + duration +
 *    tokens + pointer + expand affordance), expanding via the existing Ctrl+O
 *    mechanism to the full body + metadata footer. Every field is optional and
 *    rendered only when present.
 */
export function renderAgentResult(
  result: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: unknown,
) {
  const details = (result?.details ?? {}) as Record<string, unknown>;
  const contentText = (result?.content ?? [])
    .filter((c) => c && c.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n");
  const isPartial = options?.isPartial === true;
  return {
    render(width: number): string[] {
      const lines: string[] = [];
      if (isPartial) {
        const snap = details.subagentProgress as ProgressSnapshot | undefined;
        // SECURITY: details.agent originates from the model-supplied subagent_type — sanitize.
        const agent = sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        // A background live view leads with the Task chip + agent type;
        // the foreground view (no taskId) keeps the bare `Agent(<type>)` header.
        const chip = taskChip(details);
        // Current activity, else the newest tail line, else (defensively, for a
        // partial emitter without a snapshot) the content head — sanitized: the
        // snapshot is condenser-sanitized at capture, but the invariant stays
        // uniform so no partial path can leak control bytes to the terminal.
        const activity = sanitizeInline(
          snap
            ? snap.activity || snap.tail[snap.tail.length - 1] || ""
            : firstLine(sanitizeProgressText(contentText), 100),
        );
        return runningStatusLines(theme, chip, agent, activity, width);
      }
      // Final result.
      // The "started" block is self-identifying when a taskId is present
      // (`Agent(<type>) → background as task-N` + a muted retrieve-with-TaskOutput
      // subline); with no taskId it keeps the original foreground-neutral header.
      if (details.background === true) {
        const bgChip = taskChip(details);
        if (bgChip) {
          const agent =
            sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
          const taskId = sanitizeInline(String(details.taskId ?? ""));
          lines.push(
            themedFg(
              theme,
              "accent",
              themedBold(theme, `Agent(${agent}) → background as ${taskId}`),
            ),
          );
          const id = agentIdOf(details);
          const sub = [id, `retrieve with TaskOutput(task_id "${taskId}")`]
            .filter(Boolean)
            .join(" · ");
          pushColored(theme, "muted", sub, width, lines);
        } else {
          lines.push(themedFg(theme, "accent", themedBold(theme, "Agent → background")));
          // SECURITY: the start message embeds the model-supplied agent label — sanitize.
          pushBodyText(sanitizeProgressText(contentText), width, lines);
        }
        return clampLines(lines, width);
      }
      // A wait:false poll on a RUNNING task renders one self-identifying
      // status line (Task chip + agent type + last activity) — never a bare
      // unlabelled chip, never a rolling tail. Gated on taskId (a foreground
      // final never carries status:"running").
      const chip = taskChip(details);
      if (chip && details.status === "running") {
        const agent =
          sanitizeInline(typeof details.agent === "string" ? details.agent : "") || "subagent";
        const last = sanitizeInline(
          typeof details.lastActivity === "string" ? details.lastActivity : "",
        );
        return runningStatusLines(theme, chip, agent, last, width);
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
  agentType: string | undefined,
  theme: unknown,
) {
  const taskId = sanitizeInline(String((args ?? {}).task_id ?? ""));
  const type = sanitizeInline(agentType ?? "");
  return {
    render(width: number): string[] {
      const chip = taskId ? `TaskOutput(${taskId})` : "TaskOutput";
      const label = type ? `${chip} · Agent(${type})` : chip;
      return clampLines([themedFg(theme, "toolTitle", themedBold(theme, label))], width);
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
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  if (d.record !== "subagent-completion") return undefined;
  if (d.nested === true) return undefined;
  const finalText = typeof d.finalText === "string" ? d.finalText : "";
  const outcome = typeof d.outcome === "string" ? d.outcome : "completed";
  // Compose the expanded body the way the TaskOutput display reads: reason +
  // partial output for a failure, the discard note for an abort, the verbatim
  // final text otherwise. renderAgentResult sanitizes it before display.
  let text = finalText;
  if (outcome === "failed") {
    const err = typeof d.error === "string" && d.error ? d.error : "unknown error";
    text = finalText ? `${err}\n\nPartial output before the failure:\n${finalText}` : err;
  } else if (outcome === "aborted") {
    text = "The task was stopped before completing; its result was discarded.";
  }
  return renderAgentResult(
    { content: [{ type: "text", text }], details: d },
    // Normalize to an explicit boolean: expanded===false is the collapse key.
    { expanded: options?.expanded === true, isPartial: false },
    theme,
  );
}
