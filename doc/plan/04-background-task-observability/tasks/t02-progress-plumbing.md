# t02: Background progress plumbing + identity-at-start

## Goal

A running background task exposes its **full live `ProgressSnapshot`** (rolling tail + activity), not
just the flattened `lastActivity` line, and a waiter can **subscribe** to snapshot updates. The task
record carries a **clean agent type** from the moment it starts, and the background **start message**
names the dispatched agent's type and `agent-<id>` for every task (including one-shot builtins). No
display/rendering in this task — this is the data + notification substrate t03 consumes.

## Context & seams

- **`progressActivityLine(snapshot)`** currently lives in `src/runtime/subagents.ts` (private, pure —
  reads only `snapshot.activity`/`tail`). **Move it into `src/runtime/subagent-progress.ts`** and
  export it (that module is the neutral pure module both `subagents.ts` and `background-tasks.ts`
  import; it must stay free of `pi-tui`). Update `subagents.ts` to import it from there.
- **`BackgroundTaskRecord`** (in `src/runtime/background-tasks.ts`) gains two fields:
  - `progress?: ProgressSnapshot` — the latest sanitized snapshot (bounded: the condenser already
    caps tail length/count). Display-only; never merged into `result`.
  - `agentType?: string` — the **clean** dispatched agent type (e.g. `coder`, `Explore`), set eagerly
    at `start()`. Today only `label` (`agent:<type>`) exists until settle sets `agentName`. Consumers
    must never have to strip the `agent:` prefix themselves.
- **`BackgroundTaskRegistry` API** (the contract t03 consumes — names/shapes are binding):
  - `noteProgress(id: string, snapshot: ProgressSnapshot): void` — sets `record.progress = snapshot`,
    sets `record.lastActivity = progressActivityLine(snapshot)` (keeps the existing string field for
    the model-facing text/poll), then notifies subscribers. Ignored after settle (mirror the existing
    `noteActivity` post-settle no-op guarantee).
  - `subscribeProgress(id: string, listener: (snapshot: ProgressSnapshot) => void): () => void` —
    registers a listener, returns an unsubscribe function. Multiple concurrent subscribers per task
    (fan-out via a set). Listener set is **cleared when the task settles, on EVERY settle path
    (fulfilled AND rejected)** — attach the clear to `record.settled` via `.finally(...)` (or clear at
    the top of both settle callbacks), never in just one branch. **Subscribing to an already-settled
    task is a no-op that returns a no-op unsubscribe** (mirrors the post-settle `noteProgress` no-op),
    so a subscribe that races settlement can neither fire nor leak.
  - `agentType` must be accepted by `start(...)` (extend its signature) or set immediately after, so
    it is present before any progress event fires.
- **Repoint the progress sinks:** the two `onProgress` callbacks that today call
  `registry.noteActivity(...)` — the background-dispatch branch AND the SendMessage-resume branch in
  `subagents.ts` — call `registry.noteProgress(taskId, snapshot)` instead (passing the whole
  snapshot, not the pre-flattened string). `noteProgress` derives `lastActivity` internally.
- **Clean agent type at BOTH `start()` sites:** the background Agent-tool branch and the
  SendMessage-resume branch (`subagents.ts` ~2065) both call `registry.start(...)`; pass a clean
  `agentType` at each — the resolved/normalized type for the fresh dispatch, `record.agentName` (or
  the resumed agent's type) for the resume. This makes the render fallback simply
  `agentType ?? agentName ?? "subagent"` — no `agent:`-prefix stripping anywhere.
- **Start message identity (model-facing text):** the only required change is to **stop suppressing
  the `agent-<id>` for one-shot builtins** (Explore/Plan) — the id must appear for every background
  task, since feature.md requires it visible at the start-message surface (print/RPC mode has no
  render, so the id must be in the content text). Keep the existing sentence format otherwise
  (`… (agent: <type>, agent id: agent-<id>)`) so the existing start-message assertions — including
  those in `test/subagent-transcripts.test.ts` — stay valid. Do NOT attempt a broader vocabulary
  rewrite here (the TUI chip form `Task(task-N) · Agent(type)` is t03's render concern; TaskStop and
  the settlement-notice wording are out of F04 scope).

## Writable surface

- `src/runtime/background-tasks.ts` (record fields, `start`, `noteProgress`, `subscribeProgress`,
  settle-time listener cleanup)
- `src/runtime/subagent-progress.ts` (receive + export `progressActivityLine`)
- `src/runtime/subagents.ts` (import `progressActivityLine` from its new home; repoint the two
  `onProgress` sinks to `noteProgress`; pass `agentType` into `start`; update the start-message text)
- `test/background-tasks.test.ts` (extend/adjust for `noteProgress`/`subscribeProgress`, keep the
  existing `lastActivity`/post-settle guarantees)

## Approach constraints

- `noteProgress` must preserve the existing `lastActivity` semantics exactly (same string
  `progressActivityLine` produces) so the poll text and any current test stay valid.
- Post-settle safety: `noteProgress` after settlement is a no-op; the listener set is emptied on
  settle **in both the fulfilled and rejected handlers** (shared teardown / `.finally`, not one
  branch) so no listener can fire or leak afterward, including on the throw/stopped paths.
- The snapshot stored is the one produced by `SubagentProgressCondenser` (already sanitized). Do
  **not** source progress from the transcript file or `session.messages`.
- No rendering, no `TaskOutput` changes here.

## Left open

- Whether `noteActivity` is kept as a thin wrapper or removed once its callers move to `noteProgress`
  (keep only if a test or code path still needs the string-only entry).
- Listener storage shape (Set vs array) and unsubscribe idempotency details.
- Whether `agentType` is a new `start()` parameter or a field set immediately after `start()` returns.

## Testing

- Unit (`test/background-tasks.test.ts`): `noteProgress` sets `progress` + `lastActivity`;
  `subscribeProgress` delivers each snapshot to all subscribers; unsubscribe stops delivery;
  `agentType` present on the record from start (both the fresh and the resume `start()` paths).
- **Leak guard on every settle path:** the listener set is empty after a **completed**, a
  **rejected/throwing**, AND a **stopped** dispatch; a post-settle `noteProgress` is a no-op; a
  `subscribeProgress` on an already-settled task registers nothing and its unsubscribe is a safe
  no-op. Provide a deterministic observation hook (e.g. a test-only `subscriberCount(id)` on the
  registry) rather than a sleep; behavioral assertion (late `noteProgress` never reaches a held
  listener) is acceptable if no accessor is added.
- **Start message:** a one-shot builtin (Explore/Plan) background start message now includes the
  `agent-<id>` (regression against the old suppression); a non-builtin still matches its existing
  format. Keep the existing `lastActivity`, post-settle, and `subagent-transcripts` start-message
  assertions green (format preserved).
- typecheck + full suite green; **no timers introduced**.

## Acceptance criteria
- [ ] `BackgroundTaskRecord` carries `progress?: ProgressSnapshot` and `agentType?: string` (set at
      both the fresh and the resume `start()` sites).
- [ ] `noteProgress`/`subscribeProgress` exist with the signatures above; snapshots fan out to
      subscribers; listeners cleared on **every** settle path (fulfilled/rejected/stopped);
      post-settle `noteProgress` and subscribe-after-settle both no-op.
- [ ] `progressActivityLine` exported from `subagent-progress.ts`; `subagents.ts` onProgress sinks use
      `noteProgress`; the background start message includes `agent-<id>` for one-shot builtins too
      (format otherwise unchanged).
- [ ] typecheck and full test suite green.

## Depends on
– (independent of t01; both edit `subagents.ts` but sequentially)
