# t02: Thread dispatcher ownership through subagent dispatch

## Goal
A subagent's injected `TaskOutput`/`TaskStop` are scoped to that subagent's own
dispatched tasks, and any task a subagent starts is tagged with that subagent's
owner id. The coordinator's tools stay on the full registry (unchanged). This
wires the t01 mechanism into the real dispatch path and proves it end-to-end with
one offline-integration test.

## Context & seams

Owner id contract (from t01): a task's `owner` is the **agent id of the dispatch
that started it**. The dispatcher's own `agentId` is `subagents.ts:559`
(`const agentId = opts.agentId ?? mintAgentId()` inside `SubagentRuntime.dispatch`),
in scope where the toolset is built. The coordinator has no such dispatch, so its
tools pass no owner and its started tasks have `owner: undefined`.

- **`customToolsFor` gains the owner.** `SubagentRuntimeDeps.customToolsFor`
  (signature ~`subagents.ts:70-75`, currently `(agent, granted, depth, subCwd?)`)
  gets an `ownerAgentId: string` argument. **`subCwd` is optional, so a required
  param cannot follow it** — insert `ownerAgentId` **before** `subCwd`, giving
  `(agent, granted, depth, ownerAgentId, subCwd?)`, and update the call site
  `subagents.ts:913` to `customToolsFor(agent, granted, opts.depth, agentId,
  subCwd)` and the `index.ts:611` closure signature to match. (Existing test
  stubs pass fewer params — `fake-sdk.ts:336`, `runtime-core.test.ts:555/706/721`,
  `sendmessage.test.ts:640` — and stay assignable, so they need no change.) The
  `agentId` passed is the dispatch's own id (line 559).
  **Anti-spoofing invariant (security, binding):** `ownerAgentId` MUST be the
  internally-minted dispatch `agentId` (line 559, `opts.agentId ?? mintAgentId()`),
  never a value read from or derived from any tool `params`. It lives in the
  `customToolsFor` closure, not in a tool argument. This is the load-bearing
  value: the same id must both scope the subagent's `TaskOutput`/`TaskStop` and
  tag the tasks the subagent starts — they must line up, or scoping is a no-op /
  wrong.

- **`createAgentToolDefinition` tags started tasks.** Its `opts`
  (`subagents.ts:1435-1438`, `{ depth, name?, backgroundTasks? }`) gains
  `ownerAgentId?: string`. Pass it through to the `registry.start(...)` call at
  `subagents.ts:1524` as the task's `owner` (per t01's `start` addition). When
  `ownerAgentId` is undefined (coordinator instance), the started task is
  coordinator-owned (`owner: undefined`) exactly as today. The resume-in-background
  `start(...)` at `subagents.ts:1790` (inside `createSendMessageToolDefinition`,
  coordinator-only) stays owner-`undefined` — do not add scoping there.
  **Mirror t01's chosen `start()` shape** (6th positional `owner?` vs options bag)
  at **both** `:1524` (pass `ownerAgentId`) and `:1790` (pass nothing / undefined):
  if t01 made `start` take an options bag, both call sites change shape, not just
  the added argument.

- **`index.ts` subagent wiring.** In the `customToolsFor` closure
  (`index.ts:611-648`), use the new `ownerAgentId`:
  - Subagent task tools (currently `index.ts:632-637`) build over the scoped view:
    `createTaskOutputTool(backgroundTasks.scopedTo(ownerAgentId))` and the
    `createTaskStopTool` equivalent.
  - The subagent's nested-dispatch Agent/Task tools (`index.ts:644-645`) pass
    `ownerAgentId` in their `createAgentToolDefinition` opts, so tasks the subagent
    starts are tagged with the subagent's id.
  - Replace the now-false divergence comment at `index.ts:626-631` with a short,
    accurate note (subagent tools are scoped to the dispatcher's own tasks;
    coordinator retains full reach). Keep the SendMessage doc-comment intent.
  - Coordinator tools are untouched: `index.ts:748-749` (coordinator Agent/Task,
    no `ownerAgentId`), `index.ts:753` (SendMessage), `index.ts:761-764`
    (coordinator `createTaskOutputTool(backgroundTasks)` / `createTaskStopTool`
    on the full registry).

- **Production helper for testability.** Extract a small production helper
  `scopedBackgroundTools(registry, ownerAgentId)` (place it where the tool
  factories live — `background-tasks.ts` — or a thin module; implementer's call)
  that returns the scoped `TaskOutput` + `TaskStop` tool pair, and use it from the
  `index.ts` subagent path. This is what lets the integration test assert the real
  wiring rather than re-deriving it. The coordinator path may keep its inline
  `createTaskOutputTool(backgroundTasks)` calls or use an unscoped sibling — do not
  change coordinator behavior.

## Writable surface
- `src/index.ts`
- `src/runtime/subagents.ts`
- `src/runtime/background-tasks.ts` (only if the `scopedBackgroundTools` helper
  lands here)
- `test/integration-extension.test.ts`
- (if needed to reach the subagent's injected tools without model calls)
  `test/helpers/fake-sdk.ts` — extend only additively; do not break existing
  helpers.

## Approach constraints
- The owner id used to scope a subagent's tools and the owner id stamped on the
  tasks it starts **must be the same value** (the dispatch's `agentId`, line 559).
- No change to coordinator reach, to foreground dispatch semantics, to
  `SendMessage`, or to the resume path's ownership.
- Nested dispatch: each dispatch level owns only its own children (owner = that
  level's `agentId`); a parent cannot reach a grandchild's task. Preserve this —
  it falls out of using line-559 `agentId` per level.
- Settlement-notice delivery is intentionally **not** scoped by owner:
  `drainSettlementNotices` (`background-tasks.ts:322`) delivers every settled
  task's notice to the **coordinator** only (never to subagents), which is
  correct and pre-existing. Do not change it; owner tagging must not start routing
  notices to subagents or filter the coordinator's notices.

## Left open
- Exact home/shape of `scopedBackgroundTools`.
- Whether the integration test reaches the injected tools via the extension path
  or a widened `onWired` seam / fake-SDK `customTools` — implementer picks the
  lowest-cost faithful route (must exercise real `index.ts` wiring, not a
  hand-built owner id).

## Testing
One **offline-integration** test in `test/integration-extension.test.ts` proving
the wiring end-to-end without live model calls. **The owner id must be derived by
the runtime, not supplied by the test** — otherwise the test fakes away the very
`:913 ↔ :559 ↔ :1524` threading it exists to prove:
- A subagent dispatched through the real `picc()` path (fake SDK injected so it
  stays offline) starts its **own** background task, and its **injected**
  `TaskOutput`/`TaskStop` — captured via `fakeSdk`'s `customTools`
  (`test/helpers/fake-sdk.ts:77`), i.e. the tools the runtime actually handed the
  subagent — can reach that task. Retrieve via `TaskOutput` with `wait: true`
  against a `gatedSdk`-style gate released in the test, so registration/settlement
  is awaited deterministically (do **not** use `setTimeout` to "let the dispatch
  create its session" — the `background-tasks.test.ts:1118/1221` smell).
- That same subagent's injected tools **refuse** a coordinator-owned (and, if
  feasible, a sibling-owned) task — cleanly, per the t01 non-leak contract.
- The coordinator still reaches every task.
- **Explicitly insufficient / disallowed:** a test that widens `onWired` to call
  `customToolsFor` with a **test-chosen** `ownerAgentId` and then manually
  `start`s a task with that same id proves only the given-an-owner half; the two
  ids match by test construction, not by the runtime. Do not rely on it as the
  own-reachable proof.
Reuse `fakeSdk`/`gatedSdk`/`makeSubagentRuntime`, the `wire()` + `onWired`
pattern (`integration-extension.test.ts:462-469`). In-memory; no OS-specific
paths.

## Acceptance criteria
- [ ] `customToolsFor` receives and uses `ownerAgentId` (line-913 call passes
      line-559 `agentId`); `createAgentToolDefinition` tags started tasks with it.
- [ ] Subagent `TaskOutput`/`TaskStop` are built over `scopedTo(ownerAgentId)`;
      coordinator tools unchanged on the full registry.
- [ ] Stale divergence comment at `index.ts:626-631` replaced with accurate text.
- [ ] Offline-integration test proves own-reachable + foreign-refused +
      coordinator-full-reach through real wiring.
- [ ] typecheck and full test suite green (existing tests that pass a raw
      registry to the factories still compile via the `BackgroundTaskView` widening).

## Depends on
t01
