# F02 Review: Subagent lifecycle — failures, observability, communication

## Outcome

Shipped in full across seven serial tasks (t01–t07) plus a feature-close fix pass.
The origin problem is closed: a subagent that dies on a terminal API error is now a
**loud failure** naming the cause on every surface (foreground tool result, background
task status, settlement notice) and can no longer masquerade as an empty success —
proven end-to-end against the real Pi CLI with a sticky 429. On top of that the feature
delivered persisted per-subagent transcripts + stable agent IDs (t02), live progress
rendering with ANSI-sanitized rolling tails (t03), a `SendMessage` resume/steer channel
that re-dispatches through the identical enforcement stack (t04), push-on-settlement
without polling (t05), per-subagent usage accounting + a `/usage` breakdown (t06), and a
capability registry/docs/CHANGELOG made truthful about all of it, gaps included (t07).
Suite grew 818 → 955 passing.

Deviations from the plan, all deliberate and recorded:
- **t02 parity correction:** the original spec (and a round-1 fix) wanted subagent hooks
  to carry the subagent's *own* `transcript_path`. Claude Code keeps `transcript_path` =
  the **main** session transcript inside a subagent; reverted to match, adding only
  `agent_id`/`agent_type`.
- **Foreground abort visual badge deferred** (t03) to a t01-seam follow-up — abort is
  distinct from failure at the text/model level but not yet as a foreground badge.
- **`/usage` is subagent-scoped**, not Claude's whole-session `/usage` — the Pi extension
  API exposes no parent-session cost. Documented as an additive PiCC surface.
- **Dispatch defaults foreground**, whereas Claude 2.1.198 is background-by-default —
  recorded as a named parity gap, not silently shipped.

## Planning errors & spec gaps

- **The plan carried a parity bug into a task spec.** t02's hook `transcript_path`
  design was wrong for Claude Code, and the round-1 review *accepted a fix that doubled
  down on it*. Only the claude-parity reviewer, checking against the live docs, caught
  the correct direction. Lesson baked in: any change to **hook payload semantics** is a
  parity surface and must go through claude-parity even when it reads as a local quality
  fix — "the code contradicts the log" is ambiguous until someone checks which is right
  against the source of truth.
- **The t07 spec text went stale** relative to that same correction (still said "the
  subagent's own transcript path"). Caught because the dispatch prompt told the
  implementer to cross-check the code, not the plan.
- **The default-foreground divergence wasn't anticipated in planning** — it surfaced
  during t05 review. It's arguably the single most consequential subagent parity gap and
  should have been a named non-goal/gap in feature.md from the start.
- **Exact user-facing strings weren't owned by a single spec** (t01) — the throw wording
  and the error-channel format briefly conflicted; specs should allocate exact strings to
  one owner.

## Friction

- **A fake-SDK circular mock hung the entire suite** (t02): `fake-sdk.ts`'s static import
  of the Pi module deadlocked against `builtin-agents`'s `vi.mock` factory that awaited
  it. It masqueraded as an implementer "stall" — the gate genuinely never completed.
  Fixed by injecting the real `SessionManager` instead of importing it. A second instance
  of the same class appeared at t04 (booting the full harness inside a statically-Pi-
  importing test file hit the live model). **Static Pi imports + mock-the-dynamic-import
  don't mix** — worth a lint/convention note.
- **Implementer subagents twice ended their turn "waiting" on a background gate** instead
  of running it synchronously, so their reports never arrived (the state-on-disk design
  saved the work). Every dispatch prompt now mandates synchronous gates, forbids no-op
  polling, and requires pasting the suite summary line as proof.
- **A generated artifact (`doc/supported-features.md`) shipped stale** in the first t07
  pass with a "no drift" claim that was false — caught only by a coordinator drift check.
  There was no test guarding matrix freshness (added at close).
- **`dispatch()` accreted a lot** across seven tasks (failure classification, persistence,
  progress, resume, background routing, usage). It held together, but it's now a large
  method whose early-guard / resume / background / finally paths need care to keep
  consistent about register/settle/capture/hook.

## Bugs discovered

- **Introduced-and-caught-at-close (the important one):** settlement notices were
  consumed *before* delivery, so a `pi.sendMessage` throw would silently and permanently
  drop them — a NEW instance of the exact silent-loss class this feature exists to kill.
  Only the holistic close review saw the ordering hazard between the drain and the
  delivery loop (each per-task review saw one side). Fixed to peek-then-commit.
- **Pre-existing, found along the way (fixed here):** the `src/index.ts` comment claiming
  a subagent could only poll/stop its own tasks was false (the shared registry exposes
  any session task) — corrected; `/usage` and TaskOutput rendered project-controlled
  agent names/labels unsanitized to the terminal — sanitized.
- **Pre-existing, found and deferred:** `context:fork` dispatches throw away partial
  output on failure (only the Agent tool got the 2.1.200 partial mapping) and aren't
  Esc-cancellable; subagent `TaskOutput`/`TaskStop` can reach *any* session task where
  Claude hides them from subagents; a security-relevant frame defang initially
  over-claimed completeness (hardened for zero-width/unicode-dash/keyword-less forgeries).

## Improvement opportunities

- **The multi-lens review fan-out repeatedly earned its cost.** Different reviewers with
  different mental models caught complementary defects neither would alone: security
  passed t04's SEC#1 while coder found the fork-resume hole in it; the settlement swallow
  needed the adversarial lens; the parity reviewer was the only one who knew which side of
  a code-vs-log contradiction was correct. Keep coder + security + tester on any code
  task, and always add claude-parity when a compat surface moves.
- **Promote the matrix-freshness test to CI** — the drift incident shows report-trust
  isn't enough for generated artifacts.
- **The settlement untrusted-output frame is a soft boundary.** A random-nonce delimiter
  (unknowable to the subagent) would be a strictly stronger fence than a labeled frame.
- **Consolidate the triplicated usage type** (now guarded against drift by a compile-time
  assertion, but still three copies).
- **No `examples/full-surface` fixture exercises `background:true` or `SendMessage`** — the
  two highest-divergence new surfaces have no conformance-fixture statement of support.

## Proposed follow-ups

1. **Background-by-default dispatch** — match Claude 2.1.198 so implicit-concurrency
   fan-outs parallelize; today they run serially under PiCC. Highest-value parity gap.
2. **t01-seam rework so foreground aborts/failures carry `outcome` through the throw
   path**, lighting up the `■ aborted` badge and making abort visually distinct from a
   crash.
3. **`context:fork` failure handling** — apply the t01 partial-output + loud-failure
   mapping to fork dispatches, and wire Esc cancellation.
4. **Scope subagent `TaskOutput`/`TaskStop`** to the dispatcher's own tasks (Claude hides
   TaskOutput from subagents entirely) — currently a documented divergence.
5. **Plugin `agent_type` scoping** — emit the plugin-scoped id in hook payloads if Claude
   does (verify first).
6. **Cross-restart `SendMessage` resume** — persist enough registry state to resume a
   subagent after a PiCC restart (Claude can; PiCC's registry is process-lifetime).
7. **Full-surface conformance fixture** for `background:true` and a `SendMessage` resume.
8. **Live-Pi verification of resume cumulative usage** — confirm `getSessionStats()` on a
   reopened session includes pre-resume history (else `/usage` under-reports resumes).
9. **Worktree-lifecycle on resume** — a resumed run reuses a worktree the original
   settlement already unlocked; confirm concurrency safety vs a merge flow.
10. **CI doc-freshness gate** — run `gen:capabilities` + `git diff --exit-code` in CI.
