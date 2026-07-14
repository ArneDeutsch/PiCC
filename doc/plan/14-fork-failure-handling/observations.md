# F14 observations

Running record of friction, bugs, and opportunities. Dated bullets; raw material for review.md.

## 2026-07-14 — from Phase 6 plan review (deferred / out of scope)

- **[deferred] Typed `/forked-skill` Esc non-cancellability has no point-of-use signal.**
  The gap is disclosed only in the capability registry / `/compat` surface, not where the
  user presses Esc. Accepted as a documented residual for F14 (the runtime fix would need a
  Pi-base change to expose an abort signal to input hooks, or to move fork expansion into the
  turn). Candidate follow-up: surface a subtle non-cancellable hint, or push Pi to expose the
  signal. (generalist SHOULD3, docs SHOULD.)
- **[deferred] Nested-fork / from-subagent Esc *delivery* is unverified.** F14 threads the
  abort signal correctly at each hop, but whether a genuine top-level Esc is delivered to a
  *nested* Skill `execute` inside a subagent is Pi's cross-session abort-propagation
  behaviour, not tested here. Same class as any nested tool. Worth a dedicated
  propagation test / Pi-behaviour confirmation later. (generalist SHOULD1, tester residual.)
- **[deferred] `examples/full-surface` has no executable fork failure/Esc conformance
  statement.** `fork-research` exists and is used by the offline tests, but the supported
  surface isn't exercised as a conformance fixture for failure/abort. Same family as F02
  follow-up 7 (background:true / SendMessage fixture). (claude-parity SHOULD.)
- **[pre-existing, not F14] Agent-tool aborted path discards partial output.** F14 matches
  this for parity, but whether discarding partial-on-abort itself matches Claude Code (which
  tends to leave interrupted partial content visible) is an open Agent-path question F14
  deliberately does not reopen. (claude-parity, generalist.)
- **[pre-existing, not F14] `skill.name` interpolated into input-hook transform text**
  (`index.ts:1046`, kept in the F14 rewording). If the skill loader does not strip
  newlines/control chars from a frontmatter `name`, a malicious project skill could inject
  lines into the user turn. Loader-side check, out of F14 scope. (security NIT.)
## 2026-07-14 — t01 (dispatch-presentation helper)

- Refactor was byte-identical; both reviewers (coder, tester) confirmed behaviour-preservation
  via the unchanged Agent-tool regression suites. +21 unit tests.
- Coupling NIT taken: the Agent-tool consumer re-derives the cut-off case via
  `result.outcome === "failed"`, an invariant the helper owns. Added an explicit comment tying
  the two together so a future change to the helper's branch guard won't silently misroute.

## 2026-07-14 — t02 (wire fork path)

- All four reviewers (coder, security, claude-parity, tester) PASS, no MUST/SHOULD fixes.
  Security confirmed the sdk-seam has no env/settings/file fallback and the abort threading
  adds no listener surface; tester confirmed the abort test genuinely proves signal threading
  (never-resolving gate would hang, not pass, if threading were dropped).
- sdk-seam shape: `PiccTestSeam.sdk?: PiSdk`, conditional-spread into `new SubagentRuntime`
  deps at construction (NOT onWired). Guarded by test/fork-sdk-seam.test.ts (single-arg
  picc(pi) ⇒ loadRealSdk, via a partial vi.mock of the real module).
- Took two tester NITs: assert `details.agent` presence on success + partial paths; clarifying
  comment on why fork cutOff is always false (non-resumable). Skipped: adding
  `details.outcome`/`details.error` to Skill-fork failed-partial details (logs-only, never
  model-visible, no consumer needs it — model-visible content is byte-identical to Agent tool).
- **[for t03]** parity reviewer confirmed the registry note must say F14 *threads* the Esc
  signal to the Skill-tool fork (verified), NOT that "Esc cancels a nested fork" (cross-session
  delivery is Pi's, unverified); typed /forked-skill stays non-cancellable (harness limit).

## 2026-07-14 — t03 (registry/docs truthfulness)

- Both reviewers (docs, claude-parity) confirmed the registry note claims exactly what shipped:
  "threads the Esc signal" (not "cancels a nested fork"), typed /forked-skill non-cancel framed
  as a PiCC/Pi harness limitation (not Claude scoping Esc), 2.1.199 attribution, no unqualified
  "Esc → aborted". Generated matrix is a clean regeneration (freshness guard green).
- Fixed a cross-surface inconsistency: architecture.md called the second consumer the
  "Skill-tool-from-subagent caller", but the Skill tool is model-invoked at top level too (depth
  0) — the shipped registry/user-guide/CHANGELOG correctly say "model-invoked Skill-tool caller".
  Aligned architecture.md to match.
- **DECISION (coordinator): kept `skill.frontmatter.context` tagged `full`, not `partial`.**
  F14 fixed the actual broken failure/abort semantics; the residual Esc-on-typed-route gap is a
  narrow harness-interruption limitation on one invocation route, orthogonal to whether the
  frontmatter key is parsed/honoured with Claude dispatch semantics (it is). The note documents
  the gap transparently. Downgrading as we close the main gap would misrepresent the surface.
- **[follow-up]** No documented convention for whether a *documented harness-limitation
  divergence* should nudge a registry entry from `full` to `partial` (tool.Agent is `partial`
  for its foreground-default divergence; this entry stays `full` with a divergence note). Worth
  a one-line tagging-policy note somewhere authoritative so future entries are consistent.
- **[note]** "not Claude Code scoping Esc" asserts a mild negative about Claude's behaviour that
  is *inferred* (F14 verified only PiCC's side). Acceptable as written (self-deprecating /
  truthful-safe framing); keep labelled inferred if ever promoted to a stronger claim.

## 2026-07-14 — t04 (typed /forked-skill Esc, post-close, user-requested)

- User asked to implement former follow-up 1 (the remaining scope of #11) directly rather than
  file it. Done via `ctx.ui.onTerminalInput` — the input hook watches raw terminal input and
  aborts the fork on a lone Esc in interactive mode. Wiring proven offline (case 8). Also
  broadens the earlier "harness limitation" framing in registry/architecture/user-guide/CHANGELOG.
- **RESIDUAL (honest, flagged to user):** live end-to-end Esc *delivery* to the listener during
  the awaited input hook is the documented purpose of the API but NOT verified against a live
  terminal (can't script a live Esc; couldn't confirm from Pi's minified bundle). Needs a manual
  smoke test before fully trusting the live path / closing #11 on this basis.
- Now BOTH #11 acceptance criteria are met at the mechanism/wiring level → close-vs-keep-open
  for #11 shifts toward closeable, pending the smoke test. Re-decide with the user.
- Review (coder + security): PASS after two hardening fixes both flagged — (1) wrap the
  `onTerminalInput` subscribe + the `finally` teardown in try/catch so a Pi listener-plumbing
  throw degrades to "uncancellable fork" instead of hitting the outer catch and leaking the raw
  `/skill` (protects the never-throw invariant); (2) the test now asserts an ESC-prefixed arrow
  sequence does NOT abort (previously the arrow line was a no-op assertion). Security confirmed
  the intercept is Esc-only, raw input never logged/forwarded, listener can't leak.

## 2026-07-14 — hand-off merge with origin/main (F11 SlashCommand)

- origin/main advanced by 5 commits (F11 "Real SlashCommand tool") while F14 was in flight.
  F11 had refactored the Skill-tool body into a shared `runSkillActivation` helper used by both
  the Skill tool AND the new SlashCommand tool, and independently added the same
  `PiccTestSeam.sdk` injection field F14 added. Conflicts in CHANGELOG.md + src/index.ts.
- Resolved by moving F14's fork mapping INTO `runSkillActivation` and threading the Esc signal
  through it → **the SlashCommand tool is now also a model-invoked fork route** carrying
  failure-preservation + Esc-abort. Broadened the registry/architecture/user-guide wording from
  "the Skill-tool path" to "the Skill or SlashCommand tool", regenerated the matrix, kept both
  CHANGELOG entries. Added 2 SlashCommand fork tests (partial-preservation + abort).
- Coder review of the integration: PASS (no F11 behaviour dropped, no unthreaded signal, input
  hook still never-throws). Full suite green after merge (1057 + 2 new).
- **[write-preview impact]** the approved PR/comment texts predate this merge and say only
  "Skill-tool caller" — must be re-confirmed with the SlashCommand broadening before posting.

## Phase-6 deferred (continued)

- **[note] `capErrorText` is duplicated on purpose** in `background-tasks.ts:416-423` to avoid
  a value-level import cycle. t01's "one source of truth" is scoped to the presentation path
  and must not touch that mirror. (generalist SHOULD2.)
