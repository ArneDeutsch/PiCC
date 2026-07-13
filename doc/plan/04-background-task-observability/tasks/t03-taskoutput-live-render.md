# t03: TaskOutput live render + streaming

## Goal

`TaskOutput` looks and behaves like a foreground subagent. While it awaits a running background task
it renders a live view — a header naming the task and its agent, the rolling activity tail, and a
current-activity line — updating as the subagent works; on settle the same call resolves to the
outcome badge + transcript + usage footer. A `wait:false` poll renders the same identifying frame
(status + last activity), and an already-settled task renders the settled block. The dispatched
agent's type and `agent-<id>` are visible at every surface. The verbatim result the model reads is
unchanged.

## Context & seams

- **Streaming mechanism (verified):** Pi calls a tool's `execute(toolCallId, params, signal, onUpdate)`
  and re-renders its `renderResult(result, {isPartial:true}, theme)` on each `onUpdate`, then a final
  `renderResult(..., {isPartial:false})` on return — generic to any tool
  (`pi-agent-core/dist/agent-loop.js:453`; `pi-coding-agent` tool-execution). Print/RPC ignore
  partials; the returned result is authoritative everywhere (same as the foreground Agent path).
- **From t02 (consume, don't redefine):** `BackgroundTaskRecord.progress?: ProgressSnapshot`,
  `record.agentType`, `registry.subscribeProgress(id, listener): () => void`. `progressActivityLine`
  is exported from `subagent-progress.ts`.
- **From t01 (consume + extend):** `renderAgentCall`, `renderAgentResult` in
  `src/runtime/subagent-render.ts`. `TaskOutput` reuses `renderAgentResult` by constructing the same
  `{content, details}` shape — do not fork a parallel renderer.
- **Render additions (in `subagent-render.ts`), gated on `details.taskId` so the foreground Agent view
  is untouched. Every new line MUST be emitted inside the clamped `render(width)` closure (so the
  existing `clampLines(..., width)` return guard covers it — a line appended outside would bypass the
  width clamp):**
  - **Identity:** when `details.taskId` is present, the header shows the task chip + agent type
    (`Task(task-3) · Agent(coder) running…`) with an `agent-<id>` muted **identity subline** shown at
    EVERY surface — live, poll, AND settled — independent of `resumable`/`transcript` (so a
    non-resumable, transcript-less builtin still shows its id). The `resumable via SendMessage — agent
    <id>` footer line stays gated on `details.resumable` only (identity is shown; the SendMessage
    invite is not falsely offered).
  - **Badge chip on all outcomes:** `outcomeBadgeLine` gains the `Task(task-N)` chip for completed,
    failed, AND aborted (`● Task(task-3) · Agent(coder) completed`, `✗ Task(task-3) · … failed`,
    `■ Task(task-3) · … aborted`) — not just completed.
  - **Live/partial no-activity placeholder:** the partial (`isPartial:true`) branch, when its snapshot
    is absent or its tail+activity are empty (the just-started case), renders `… starting…` under the
    header — matching the poll placeholder, so a just-dispatched task never renders as a bare header
    with nothing beneath it. (feature.md promises "a current-activity line" in the live view.)
  - **Running/poll branch:** a final render with `details.status === "running"` (poll) renders the
    identity frame + one `… <lastActivity>` line (or `… starting…` when there is no activity yet), not
    a bare chip.
  - **Background start block:** the existing `details.background === true` block (`Agent → background`)
    becomes self-identifying: `Agent(<type>) → background as task-N` + a muted `agent-<id> · retrieve
    with TaskOutput(task_id "task-N")` subline.
- **TaskOutput `details` shapes (the contract with the renderer).** Each `onUpdate`/return value is
  `{ content, details }` — the partial MUST include `content: [{type:"text", text:
  renderProgressText(snap)}]` for print/RPC legibility (mirrors the foreground partial), not just
  `details`:
  - partial (while waiting): `details = { subagentProgress: snapshot, agent, taskId, agentId, live:true }`
  - poll (`wait:false`, running): `details = { status:"running", agent, taskId, agentId, lastActivity }`
  - final (settled): `details = { outcome, status, agent, taskId, agentId, cutOff, transcriptPath, usage, resumable }`
    — note TaskOutput today returns `status` but **not** `outcome`; this task adds `outcome` (via the
    `noticeOutcome` mapping) to the details it returns.
  - `agent = record.agentType ?? record.agentName ?? "subagent"` (t02 sets `agentType` eagerly at
    both start sites, so no `agent:`-prefix stripping is needed).
- **Usage / trailer double-render (MUST handle — not free from "reuse the renderer").** TaskOutput's
  completed `content[0].text` is `body + agentTrailerFrame(...) + "\nusage: …"`. `renderAgentResult`'s
  display strip `stripAgentTrailerForDisplay` anchors its regex at end-of-string, so the trailing
  `\nusage:` line defeats the strip → the raw `---\n[agent …]` trailer shows in the human body AND
  usage renders twice (once in the un-stripped body, once in the footer from `details.usage`). Fix in
  the shared renderer: make the display-body derivation tolerant of a trailing `usage:` line — strip
  the agent trailer even when a `usage:` line follows it, and drop that trailing `usage:` line from
  the display body (the footer renders usage from `details.usage`). The model-facing `content` stays
  byte-identical; only the human display body changes. Cover with a test (completed TaskOutput content
  with trailer + usage → human body shows neither the raw trailer nor a duplicated usage line).
- **`createTaskOutputTool(registry)`** (in `background-tasks.ts`): add `renderCall` (show
  `TaskOutput(task-N)` + agent) and `renderResult` (delegate to `renderAgentResult`). Widen `execute`
  to `(toolCallId, params, signal, onUpdate)`.
- **Streaming loop inside `execute`** (only when the task is running AND `wait !== false`):
  1. `const unsub = registry.subscribeProgress(id, snap => onUpdate(partial(snap)))` — subscribe
     first; if the task already settled, t02 guarantees this is a no-op returning a no-op unsub (no
     race, no leak);
  2. emit an initial paint from `record.progress` (or a `… starting…` partial when it is `undefined`)
     so a just-started task is never blank;
  3. `await registry.wait(id)` (resolves immediately if already settled; also returns cleanly on
     abort);
  4. `unsub()` in a `finally`; return the settled result.
  `wait:false` starts **no** subscription. Honor `signal` (abort → stop streaming, return cleanly —
  specify what `execute` returns on abort: the current status result, not a throw).
- **Status→outcome:** map background `status` (`completed`/`failed`/`stopped`) to the render outcome
  (`completed`/`failed`/`aborted`) — reuse the existing `noticeOutcome` mapping in
  `background-tasks.ts`.
- **Verbatim contract:** the **completed** task's returned `content[0].text` stays byte-identical to
  today (verbatim body + the existing agent-ID trailer + usage line — t02 does not touch this). The
  live tail rides only in `onUpdate` `details`/partial content — never in the settled `content`. The
  running/poll/failed/stopped `content` strings are PiCC metadata and may carry the `agent-<id>` for
  print-mode legibility — but the agent **type** interpolated into those strings MUST be
  single-line-sanitized with `sanitizeLine` (as `task.label` already is), since `agentType` derives
  from the raw model-/project-supplied `subagent_type` and this text is terminal-bound in print/RPC
  mode. Sanitizing only in the renderer (`sanitizeInline`) does not cover this content-string path.

## Writable surface

- `src/runtime/subagent-render.ts` (taskId-gated identity header, running/poll branch, background
  start-block identity; extend `outcomeBadgeLine`/footer as needed — all additive, foreground
  unchanged)
- `src/runtime/background-tasks.ts` (`createTaskOutputTool`: `renderCall`, `renderResult`, widened
  `execute` with the streaming loop; running/poll text identity enrichment)
- `test/runtime-core.test.ts` and/or `test/background-tasks.test.ts` (the test matrix below)

## Approach constraints

- **Reuse `renderAgentResult`; do not write a second renderer.** Every emitted line therefore inherits
  the pi-tui width clamp and the sanitize discipline. Additionally `sanitizeInline` the agent
  type/name and gate `agentId` through `isAgentId` at the point they enter the header (they are model-
  and project-file-supplied and were not previously rendered by TaskOutput).
- Live tail comes only from `record.progress` (the condenser's sanitized snapshot) — never re-derive
  from the transcript or session messages.
- Lifecycle: set up the subscription in `try/finally`; guaranteed unsubscribe on settle/abort/throw/
  return; no subscription on `wait:false`; no busy-loop; no dangling/rejected promise (`settled` never
  rejects — keep it so); concurrent TaskOutput calls on one task each own their subscription.
- No change to when tasks run in background, nor to the settlement-notice mechanism.

## Left open

- Exact header layout (single line vs. header + id subline) — optimize for readability under the
  width clamp; the id must never be the thing that gets truncated.
- Whether `renderCall` is worth adding or `renderResult` alone suffices.
- Placement of the new render tests (extend the runtime-core render `describe` vs. a new `describe` in
  background-tasks.test.ts).

## Testing

Deterministic, event-driven, no real timers. Cover:
- **Streaming unit (real registry + manually-resolvable promise + synthetic `ProgressSnapshot`):**
  awaiting `TaskOutput` on a running task emits ≥1 partial rendering the tail + activity, then
  resolves to the final; the partial is self-identifying (task id + type + `agent-<id>`); an
  already-settled task emits no partial; after settle the progress-listener set is empty (leak guard —
  use the deterministic hook t02 provides, not a sleep); `wait:false` starts no subscription.
- **Offline-integration (the real wiring the unit fakes):** dispatch with `run_in_background:true`
  through `fakeSdk({replies:[{text, gate, events:[{type:"tool_execution_start", toolName:"Grep", …}]}]})`;
  concurrently call `execute(id, {task_id}, undefined, onUpdate)` capturing partials; assert a partial
  carrying the Grep activity fires **before** `release()`, then the final verbatim result. Proves
  `onProgress → noteProgress → subscribeProgress → onUpdate` end-to-end. Reuse `gatedSdk`/`makeRuntime`.
- **Abort teardown:** abort the `signal` mid-wait → subscription torn down, `execute` returns cleanly
  (the current-status result, no throw, `settled` never rejects).
- **Verbatim + double-render:** the settled **completed** `content[0].text` equals the non-streaming
  TaskOutput text (byte-identical); no tail/activity leaks into it; the **human render** of that
  completed result shows neither the raw `---\n[agent …]` trailer nor a duplicated `usage:` line.
- **Final render (pure unit):** completed/failed/aborted(=stopped) badges each carry the `Task(task-N)`
  chip and the `agent-<id>` identity subline; transcript + usage footer; `resumable via SendMessage`
  shown only when `resumable` — and a **non-resumable** task (`resumable:false`, `agentId` present)
  still shows `agent-<id>` as identity and does NOT show the SendMessage invite.
- **Start-block identity render:** the `details.background === true` render shows `task-N` + agent
  type + `agent-<id>`.
- **Live no-activity placeholder:** a partial with absent/empty snapshot renders `… starting…` (not a
  bare header).
- **Poll (`wait:false`):** running → identity frame + last activity (not a bare chip); model-facing
  text includes type + `agent-<id>`; a poll on a settled task renders the settled block.
- **Concurrent same-type:** two `coder` tasks render distinct `Task(task-N)` + `agent-<id>` frames.
- **Width + sanitize (the gated lines MUST be exercised):** partial, poll, and final render **with
  `taskId` + `agentId` set** (else none of the new identity lines render), plus wide/CJK tail (`字`×N),
  tabbed activity, emoji, and a control-byte-laden agent type/label, across widths
  `[1,2,3,20,40,138]` → every line's pi-tui `visibleWidth ≤ width`; the `agent-<id>` is never the
  truncated element at narrow widths. Also assert the **poll `content` text** (not just rendered
  lines) carries no `ESC`/`BEL`/OSC bytes when the agent type contains control bytes. Reuse
  `noOverflow`/`tuiVisibleWidth` and the code-point ESC/BEL constants (keep source pure-ASCII).
- **Cross-platform:** transcript footer basename for both `\\` and `/` separators (string literals, no
  `path.join`). CRLF: the concern is the sanitized **tail** (via `sanitizeLine`, already `\r`-free) —
  do NOT assert the completed body is `\r`-free (`sanitizeProgressText` deliberately keeps `\r`, and
  t01 froze that behavior). Every gated streaming test `release()`s and awaits settlement.

## Acceptance criteria
- [ ] Awaiting `TaskOutput` on a running task streams a live tail + activity view and resolves to a
      badge + transcript + usage footer, reusing `renderAgentResult`.
- [ ] Task id + agent type + `agent-<id>` visible at the start block, the awaiting/live view, and the
      poll; `agent-<id>` shown as identity even for non-resumable builtins (no false SendMessage
      invite).
- [ ] `wait:false` poll renders the identity frame (not a bare chip); settled poll renders the settled
      block; the model's completed `content` text is byte-identical to today, and its human render
      shows neither the raw agent-ID trailer nor a duplicated `usage:` line.
- [ ] No terminal-overflow (pi-tui `visibleWidth ≤ width` for every emitted line) and no unsanitized
      model-/file-supplied text; subscription torn down on settle/abort/return; no stream on
      `wait:false`.
- [ ] typecheck and full test suite green (Windows + Linux).

## Depends on
t01, t02
