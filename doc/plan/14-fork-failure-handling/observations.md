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
- **[note] `capErrorText` is duplicated on purpose** in `background-tasks.ts:416-423` to avoid
  a value-level import cycle. t01's "one source of truth" is scoped to the presentation path
  and must not touch that mirror. (generalist SHOULD2.)
