# t05: Close-review gap closure — subagent scratchpad + wiring test + registry polish

## Goal

Close the two real gaps the Phase 8 close review found, plus the truthfulness/consistency
refinements: subagents receive the scratchpad guidance (faithful parity, closes the
subagent-writes-temp #48 hole); the index.ts computation/threading seam has a
revert-catching test; the registry id/gap wording is consistent and honest.

## Context & seams

- **Subagent scratchpad injection (the real gap).** `buildSubagentSystemPrompt`
  (src/index.ts ~:568, its `buildSystemPromptSuffix` call ~:623) passes neither `scratchDir`
  nor `windowsTempNote`. Thread BOTH in, using the same `scratchDir` variable (created eagerly
  at ~:946) and `windowsTempNote: shellNamespaceDiffersFromNative()` already computed for the
  main-session call (~:1042). The `scratchDir` `let` is reachable from that closure (it runs at
  dispatch time, after activation initialized the value) — confirmed by two reviewers. This
  mirrors Claude Code, which injects the scratchpad into agent contexts too. (This is NOT an
  exfiltration-sensitive value like the fork-inheritance case — the scratch path is harness
  data, safe to give every subagent.)

- **Wiring-seam test (revert-catcher).** No test exercises index.ts computing + injecting the
  scratch path, so dropping the call-site arg, breaking the `mkdtemp → realpath →
  toNativeSafeTempForm` ORDER, or reverting `CLAUDE_CODE_TMPDIR || os.tmpdir()` all ship green.
  Add a test following the existing booted-extension pattern in test/runtime-core.test.ts (the
  one that already boots the real harness via the `rc`/test seam for the parent-guard test):
  boot the extension and assert the assembled `before_agent_start` main-session suffix contains
  `## Scratchpad directory` and the literal scratch path, AND that the subagent system prompt
  does too (locks the SHOULD-1 fix). If booting proves impractical, the fallback is to extract
  the root-selection + `realpath→transform` computation into a small pure helper in
  src/util/env.ts (injectable env/tmpdir/realpath/platform) and unit-test: (a) `CLAUDE_CODE_TMPDIR`
  wins over `os.tmpdir()`, (b) win32 result is forward-slash drive-letter form, (c) the slash
  transform is applied AFTER realpath (feed a realpath stub that returns backslashes and assert
  the output is forward-slash). Prefer the booted-harness assertion if reachable — it covers the
  threading too; otherwise do the extracted-helper unit test.

- **Registry polish** (src/registry/capability-registry.ts, then regen):
  - Rename `feature.sessionScratchpad` → `feature.session-scratchpad` (every sibling id is
    kebab-case; the id surfaces in `/doctor` + generated docs).
  - In gap (a), name the Windows divergence explicitly: Claude's Windows scratchpad is a
    backslash `%LOCALAPPDATA%\…\claude\…\scratchpad` path while PiCC injects the forward-slash
    `C:/…` form — that separator difference is the deliberate fix mechanism, currently hidden
    behind the Unix-only example.
  - Run `npm run gen:capabilities`; keep `test/registry.test.ts` green.

- **Comment fix** (src/engine/shell-inject.ts ~:246): the `shellNamespaceDiffersFromNative`
  doc claims "both branches are unit-testable without faking the real OS" — only the false
  branch is (the fn calls `resolveGitBashPath()` which reads the real `process.platform`, so the
  true branch needs a real win32 host). Tighten the comment to say so.

## Writable surface

- src/index.ts (thread scratchDir/windowsTempNote into the subagent suffix call)
- src/engine/shell-inject.ts (comment only)
- src/util/env.ts (only if the extracted-helper fallback is used)
- src/registry/capability-registry.ts + doc/supported-features.md (regen, never hand-edit)
- test/runtime-core.test.ts (wiring test) and/or test/subprocess-env.test.ts (helper test)
- No other files.

## Approach constraints

- The subagent injection uses the SAME literal path + predicate as the main session; no new
  computation, no per-subagent scratch dir.
- Do not change `buildScratchpadSection`'s wording (that was settled in t02 review).
- Registry stays `partial`; only id + gap-(a) wording change.

## Left open

- Whether to also add Claude's "…can generally be used without permission prompts" line —
  **skip** (PiCC's permission posture is its own; don't imply an auto-approve guarantee).
  Note it as a review.md consideration instead.

## Testing

- The new wiring/helper test must be a genuine revert-catcher: it should go RED if the
  call-site arg is dropped, the realpath/transform order is swapped, or `CLAUDE_CODE_TMPDIR`
  honoring is removed. State in the test which regression each assertion catches.
- `test/registry.test.ts` green after regen; `npm run gen:capabilities` idempotent.

## Acceptance criteria
- [ ] Subagent system prompts include the scratchpad section (both the all-platform line and,
      when `windowsTempNote`, the Windows note), via threaded `scratchDir`/`windowsTempNote`.
- [ ] A revert-catching test covers the index.ts computation/threading (call-site arg, realpath
      order, `CLAUDE_CODE_TMPDIR`) — booted-harness assertion preferred, extracted-helper unit
      test as fallback.
- [ ] Registry id kebab-cased; gap (a) names the Windows forward-slash-vs-backslash divergence;
      matrix regenerated and in sync.
- [ ] Predicate comment tightened.
- [ ] typecheck and full suite green.

## Depends on
t01, t02, t04
