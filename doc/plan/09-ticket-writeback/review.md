# F09 Review: Refine implement-feature ticket write-back

## Outcome
Delivered all three intended changes to the `implement-feature` skill's GitHub-ticket behaviour, as a
lightweight single-pass edit (coordinator edited `SKILL.md` directly; no task specs / implementer
subagents), reviewed by four specialists (user-experience, docs, security, adversarial generalist):

1. **Kickoff comment removed** — nothing is posted to a linked ticket before hand-off; one automated
   ticket comment per run. Rewrote the intro, Rules 7–9, the Phase 1 write-contract, Phase 2 (deleted
   step 5), the Phase 9 degrade path, and the abort path to match.
2. **Ticket comment and PR body split by audience** — the issue comment is user-facing (what was built
   + how behaviour changes, against the ticket, naming differences/extensions); the PR body is
   reviewer-facing and centred on a "Start your review here" guide to verifying the change in the
   running app. Two distinct skeletons, matching Phase 8 preview.
3. **Opt-in issue-filing for out-of-scope findings** — new Phase 8 offer, both ticket and ticketless
   paths, reachability-gated, per-item explicit approval; Rule 5 carves the narrow `gh issue create`
   exception. Also updated the `[Unreleased]` CHANGELOG F06 entry in place (nothing released ever
   described a kickoff comment).

No `src/`/`test/` change; the suite and typecheck were green at baseline and remain unaffected.

## Planning errors & spec gaps
- **The "split the summary" intent hid a second-order rename that the first edit pass missed.** After
  renaming the single "summary comment" into an audience-specific "issue comment" in the phases, two
  discipline Rules (7 and 8) still said "summary comment" — a dangling reference caught independently
  by the docs and adversarial reviewers. Lesson: when a rename crosses the prose/rules boundary, sweep
  the *rules* explicitly, not just the phase where the concept is introduced.
- **Removing one artifact (the `PR: <url>` lead line) resolved three separate findings at once** (the
  redundancy contradiction, and both the docs and UX "Rule 9 opens-with is wrong" nits). The first
  pass over-built the comment with a link the maintainer had explicitly called redundant.

## Friction
- **Prose-only change vs. a workflow tuned for code.** The skill's Phase 7/8 machinery assumes
  src/test with typecheck/test gates; a single-Markdown-file change routes cleanly through the
  lightweight variant, but the pre-commit hook still runs the full ~2.5-min suite on a change that
  cannot affect it. Not worth special-casing, but noted.
- **The PR-body verification skeleton initially assumed a runnable UI** — most PiCC features (this one
  included) change agent/harness prose with no app to launch. Added a clause that "the running app" can
  be picc executing the changed behaviour. This is a recurring shape worth remembering for future
  ticket runs.

## Bugs discovered
- **Pre-existing under-specification in Rule 3's auto-close protection** (not introduced here, but
  surfaced and fixed under this change because the diff enlarges the distilled PR body): Rule 3 named
  only `Closes #123`, missing the rest of GitHub's closing-keyword family
  (`close/closes/closed`, `fix/fixes/fixed`, `resolve/resolves/resolved`). A stray `Fixes #50` carried
  through distilled text into a PR body would silently close an unrelated issue on merge. Fixed:
  enumerated the family in Rule 3 and cross-referenced it from the Phase 9 PR-body step.

## Improvement opportunities
- **Issue-filing idempotency is inherently best-effort.** The dedup guard uses fuzzy `gh issue list
  --search "<title>"`; it now searches all states and surfaces near-matches to the user, but a
  reworded title can still slip past. Acceptable given per-item human approval, but a stronger marker
  (e.g. a hidden machine token in the issue body, like the comment/PR guards) would be more robust.
- **Inline `--title`/`--search` are the one un-file-able sink.** Rule 4 now forbids shell
  metacharacters in the model-authored title; a future hardening could route even the title through a
  safer mechanism if `gh` ever gains `--title-file`.

## Proposed follow-ups
- **Dry-run a real ticket end-to-end.** F06's own review flagged that the `gh` write grammar has never
  been exercised against a live throwaway issue. F09 changes exactly those writes (one comment, PR
  body, and now `gh issue create`), so a single validation run against a scratch repo/issue would
  confirm the two-text hand-off and the issue-filing offer behave as written.
- **Consider a machine-token idempotency marker** shared across all three write types (comment, PR,
  issue) to replace the fuzzy title search — one convention, uniformly robust on resume.
