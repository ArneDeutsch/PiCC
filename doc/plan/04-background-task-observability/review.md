# F04 Review: Background Task Observability

## Outcome

Shipped as planned. `TaskOutput` now reuses the shared subagent renderer: while awaiting a running
background task it streams the live rolling tail + current-activity line like a foreground dispatch,
then resolves — in the same call — to an outcome badge (completed/failed/aborted) + transcript + usage
footer. A `wait:false` poll shows status + last activity in the same identifying frame. Every
background surface (start block, live/awaiting, poll, settled) names the task and its agent —
`Task(task-N) · Agent(<type>) · agent-<id>` on the live/poll/settled views, `Agent(<type>) →
background as task-N` on the start block — with the `agent-<id>` shown even for non-resumable one-shot
builtins and the "resumable via SendMessage" hint gated on actual resumability. The model-facing
completed content stays byte-identical (display/observability only). Delivered as 4 tasks
(extract shared renderer → event-driven progress plumbing → TaskOutput render+streaming →
docs/registry/fixture) + a close-fix commit; adversarial feature-close verdict was "mergeable, no
blockers."

Deviations from the plan (all minor, all for the better): the double-render fix landed in the display-
body derivation (gated on `taskId`) rather than by widening the shared trailer-strip regex; the
event-driven seam (chosen in planning over polling) kept every test deterministic; `noteActivity` was
removed at close once `noteProgress` subsumed it.

## Planning errors & spec gaps

- **t03's double-render fix hint named the wrong gate.** The spec suggested gating the usage-line strip
  on `details.usage`; that field is also set on the *foreground* path (shared renderer), so the strip
  would have deleted a legitimate trailing `usage:` line from a foreground agent's message. The plan
  review rated "gate on usage not taskId" a NIT; the adversarial feature-close made it a concrete
  foreground regression. Correct gate: `details.taskId != null && details.usage != null`. Lesson: when
  a task extends a **shared** component, the spec must require an explicit "other-caller unchanged" gate
  and a regression test for the other caller — not leave it to the implementer to infer.
- **t02 spec self-tension.** "Keep the subagent-transcripts start-message assertions green" collided
  with the required removal of the one-shot-builtin id-suppression — one existing test *encoded* the old
  suppression and had to be flipped (a file outside the listed writable surface). The spec should have
  named that test as intentionally-changed and included it in the surface.
- **t04 under-scoped the docs.** The writable surface omitted `doc/user-guide.md`, yet the feature is
  user-observable and the guide's "Observing subagents" section only covered foreground. A docs task
  for a user-facing behavior must include the user guide, not just the capability registry + CHANGELOG.
- **Registry parity detail.** The plan's first GAP wording invented a Claude Code `/tasks` slash
  command; the real surface is the `claude agents` Agent View (v2.1.139+). Caught in plan review — a
  reminder to verify external product names before writing them into the truthfulness-bearing registry.

## Friction

- Most findings were spec-precision issues surfaced cheaply at Phase 6 (plan review). The recurring
  pattern: the **adversarial lens caught what per-aspect reviewers rated NITs** (both the foreground
  regression and, earlier in the crash-fix work, the CJK/width overflow). An adversarial reviewer on
  any shared-component change earns its keep.
- Windows CRLF warnings on every commit are cosmetic noise (`.gitattributes` normalizes on checkout);
  not worth acting on but repeatedly present.

## Bugs discovered

- **Foreground usage-line double-strip** — introduced in t03, caught by adversarial feature-close
  *before* commit, fixed (the `taskId` gate). Never reached a commit.
- **Pre-existing, still open:** in `background-tasks.ts` the dispatch *resolve* path stores
  `record.error = result.error ?? …` WITHOUT `capErrorText`, unlike the *reject* path which caps it;
  `task.error` is then interpolated into failed-content. Not introduced by F04. See follow-up 1.

## Improvement opportunities

- The streaming integration glue relies on Pi's own `onUpdate → renderResult(isPartial)` re-render
  loop (the same mechanism foreground feature 02 uses). PiCC's tests prove its *own* wiring
  (`onProgress → noteProgress → subscribeProgress → onUpdate`) at the offline-integration layer, but
  nothing PiCC-owned drives Pi's actual re-render loop. Reasonable boundary; noted.
- Cosmetic: the tool-call chip renders `TaskOutput(task-N)` while the streaming result immediately
  below renders `Task(task-N)` — two adjacent chips for one id. Standard (call line mirrors the tool
  name) but could be unified.
- Identity vocabulary is unified across the F04 surfaces but NOT across the remaining background
  surfaces: `TaskStop` text and the settlement-notice header still use the `agent:coder`-style label
  with no `Task(...)` chip. Deliberately out of F04 scope. See follow-up 2.

## Proposed follow-ups

1. **Cap/sanitize `result.error` on the resolve path** (`background-tasks.ts`) for parity with the
   reject path — small correctness/safety fix; keeps failed-content bounded.
2. **Unify identity vocabulary across the remaining background surfaces** — apply the
   `Task(task-N) · Agent(<type>) · agent-<id>` form (and clean type, not the `agent:`-prefixed label) to
   `TaskStop` and the settlement notice, so every background surface reads consistently.
3. **Always-on background view (`claude agents` parity).** The one real observability gap vs Claude
   Code: a backgrounded task is visible only while a `TaskOutput` awaits it. A persistent view of all
   running background tasks would be a sizable follow-up feature — worth scoping if PiCC pursues
   dashboard parity.
4. **Adversarial-review-by-default on shared-component changes.** Process improvement: whenever a task
   extends a shared renderer/util used by another caller, add an adversarial reviewer + an
   other-caller regression test to that task's plan by default. Two features running, two saves.
