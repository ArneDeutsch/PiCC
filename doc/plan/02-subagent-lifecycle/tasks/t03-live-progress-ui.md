# t03: Live progress in the UI

## Goal
While a subagent runs, the user sees which agent it is, what it was asked, and that it
is alive: agent type + description immediately, and a rolling tail of its recent
activity (latest output lines / current tool), including visibility of silent
auto-retry waits. No more bare grey "Agent".

## Context & seams
- Why it's bare today: the Agent tool defines `label: "Agent"` and no
  `renderCall`/`renderResult` (`src/runtime/subagents.ts:664-667`); Pi's interactive UI
  falls back to just the bold tool name
  (`pi-coding-agent/dist/modes/interactive/components/tool-execution.js:106-108`).
- Two channels, use both:
  1. `renderCall` — immediately shows dispatch parameters (agent type, description or
     prompt head). Cheap, model-independent. Also fix the Agent tool's `description`
     parameter doc, which currently says "(ignored)" (`subagents.ts:680`) — models
     reading that omit it, degrading the display.
  2. `onUpdate` (4th arg of `execute`, `pi-coding-agent/dist/core/extensions/types.d.ts:361`;
     `pi-agent-core/dist/types.d.ts:323`) — emits `tool_execution_update` events the UI
     renders as partial results; also works in print/RPC modes. Feed it from the child
     session's event stream: the real Pi `AgentSession` exposes `subscribe(listener)`
     (`core/agent-session.d.ts:255`) with `tool_execution_start/update/end`,
     `message_update`, `turn_start/end`, `auto_retry_start/end`
     (`pi-coding-agent/dist/core/agent-session.d.ts:40-82`). Pin `subscribe` + the
     retry events in `test/pi-contract.test.ts`.
- Seam into the runtime: `dispatch()` accepts a progress callback (new optional field
  on its options, `subagents.ts:244` area); the tool layer supplies one that condenses
  events into a rolling tail (user wish: latest ~10–20 lines) plus a current-activity
  line (e.g. "running Grep…", "waiting: API retry 2/3"). Extend the structural
  `PiSession` interface (`subagents.ts:94-101`) with optional `subscribe` — fakes in
  tests must be able to omit or implement it.
- Don't poll `session.messages` for progress — compaction inside `prompt()` rewrites
  the array (verified gotcha); use the event stream only.
- Background dispatches: same callback can update the task record's label/last-activity
  (`background-tasks.ts:25-38`) so TaskOutput shows liveness; keep it lightweight.
- **Sanitize the tail**: it replays subagent tool output (arbitrary repo file content)
  into the parent TUI — strip ANSI/control sequences in the condenser, or a hostile
  file becomes terminal injection.
- **`renderResult` is required, not nice-to-have** (plan review): without it, Pi's
  fallback renders only result text, so outcome, usage (t06), and transcript path
  (t02) would be invisible to the human. Render: outcome badge, the t02 trailer's
  agent ID, transcript path, and — once t06 lands — the usage line (coordinate shapes;
  render defensively when fields are absent).
- The verbatim-return contract is untouched: progress text is display-only, never part
  of `finalMessage`.

## Writable surface
`src/runtime/subagents.ts`, `src/runtime/background-tasks.ts` (record last-activity
only), a new `src/runtime/subagent-progress.ts` if the condenser deserves its own
module, `test/runtime-core.test.ts`, `test/agents.test.ts`, `test/pi-contract.test.ts`,
`test/helpers/` (fake-builder extension), new `test/subagent-progress.test.ts` if
cleaner, `doc/plan/02-subagent-lifecycle/log/t03.md`.

## Approach constraints
- Renderers must degrade gracefully where the UI is absent (print mode): everything
  flows through `onUpdate`/details, no `ctx.ui` dependency.
- Rolling tail bounded (memory + terminal height); truncate long tool outputs.

## Left open
- Exact rolling-tail length and formatting; what "current activity" line shows.
- renderResult layout (its content is mandated above — coordinate shapes with t01's
  outcome field and t06's usage field, rendering defensively when absent).
- Throttling of onUpdate emissions (events can be chatty).

## Testing
Unit (shared fake builder): condenser turns a scripted event sequence into the
expected tail/activity states (bounded length, retry visibility, ANSI/control
stripping); dispatch forwards events when the fake session supports `subscribe` and
works unchanged when it doesn't; captured onUpdate calls assert emission shape. Render
functions covered by calling them directly with sample data (incl. absent optional
fields). No real-UI assertions.

## Acceptance criteria
- [ ] Dispatch display shows agent type + description at call time.
- [ ] During a multi-turn subagent run, onUpdate carries a bounded, sanitized rolling tail incl. current tool and retry waits.
- [ ] `renderResult` shows outcome, agent ID, transcript path (usage once t06 lands).
- [ ] Print mode unaffected; fakes without `subscribe` still work.
- [ ] typecheck and full test suite green (flake policy per feature.md).

## Depends on
t01, t02 (serial execution order — see feature.md)
