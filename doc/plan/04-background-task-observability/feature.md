# F04: Background Task Observability

## What

When a subagent dispatch runs in the **background** (started via the Agent tool with
`run_in_background`, or an agent whose frontmatter forces background), the person running picc can
observe its progress the same way a **foreground** dispatch is observed, and can always tell which
agent a background task belongs to.

Observable behavior:

- **`TaskOutput` streams live while it waits.** A `TaskOutput` call awaiting a still-running
  background task renders a live view like a running foreground subagent: a header naming the task
  and its agent, a rolling tail of the subagent's recent activity, and a current-activity line —
  updating as the background subagent works. When the task settles, the *same* call resolves to a
  finished view: an outcome badge (completed / failed / aborted), the agent's transcript path, and
  per-agent usage — matching what a completed foreground dispatch shows.
- **A poll is legible too.** `TaskOutput` with `wait: false` shows the task's current status and last
  observed activity inside the same identifying frame, not a bare unlabelled chip.
- **Every background surface is self-identifying.** The "background task started" message, the
  `TaskOutput` header/result, and the poll all name the **dispatched agent** — its type and its
  stable `agent-<id>` — so a task id like `task-3` is never an anonymous chip and can be traced to
  its agent and on-disk transcript.

Explicit non-goals:

- **No always-on background panel/dashboard.** A background task streams live only while a
  `TaskOutput` call is actively awaiting it; there is no persistent, unattended progress view. (This
  is a boundary of the surface, stated so nobody expects a task to paint itself with nothing
  rendering it.)
- **Not naming the originator/parent** agent that *issued* the dispatch — only the dispatched agent
  the task *runs*. Parent-lineage is deferred.
- **No change to scheduling** — when the coordinator chooses background vs. foreground stays the
  model's decision.
- **No change to the model-facing contract** — the verbatim result text `TaskOutput` returns to the
  model, and the settlement-notice mechanism, are untouched. This feature is display/observability
  only.

## Why

Background dispatch exists so the coordinator can parallelize subagents — but today a backgrounded
subagent is a black box. The Agent block freezes at "Agent → background", `TaskOutput` renders as a
bare unlabelled chip until it returns, and the subagent's progress (already tracked internally) is
invisible unless explicitly polled. A person watching picc can't tell whether a background agent is
working, stalled, or which of several `task-N` chips maps to which agent.

Foreground dispatches already earned a rich live view (feature 02); background dispatches should
reach parity so parallel work is legible and trustworthy. An observable, self-identifying background
task is the difference between "I can see my three review agents each making progress" and "three
anonymous chips that might be stuck." It also serves the same honesty goal as feature 02's loud
failures: a user should be able to *see* whether a background subagent is actually advancing, not
assume it.

## Acceptance

- Running picc, having the coordinator start a background subagent and then retrieve it with
  `TaskOutput`, shows a **live, updating activity view during the wait** and a **finished
  badge + transcript + usage footer at the end** — visibly comparable to a foreground dispatch.
- At each of the three surfaces (start message, awaiting/live `TaskOutput`, poll), the dispatched
  agent's **type and `agent-<id>` are visible**, so a task id is traceable to its agent and
  transcript.
- The model still receives the **unchanged verbatim result text** from `TaskOutput`.
- No terminal-overflow crashes and no unsanitized model-/file-supplied text reaches the terminal
  (the new rendering honors the same width-clamp and sanitize guarantees foreground rendering has).
- `npm run typecheck` and the full suite are green, on Windows and Linux.

## Tasks

- t01 Extract the shared subagent renderer into `subagent-render.ts` (depends on: –)
- t02 Background progress plumbing + identity-at-start (depends on: –)
- t03 TaskOutput live render + streaming (depends on: t01, t02)
- t04 Docs, capability-registry truthfulness, and fixture coverage (depends on: t03)
