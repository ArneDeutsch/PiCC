# t05: CONTRIBUTING + PR template + implement-feature creation-side guidance + CHANGELOG

## Goal
The contribution guidelines and PR template demand the verification contract (applicability-aware,
concrete, two-artifact) in terms a first-time contributor can actually satisfy; `implement-feature`'s
own PR hand-off produces the same concrete, applicability-aware guidance; and the CHANGELOG records the
feature. All three verification surfaces tell **one** consistent story.

## Context & seams
- **Canonical contract source:** the verification contract defined in `references/pr-eval.md` (t03) —
  applicability rule (docs-only / fully-auto-tested → no manual verification), and the two artifacts
  (PR description = concrete *guidance*; PR comment = the author's manual-verification *report*). t05
  restates it for the contributor/creation audience; wording must match pr-eval's request/assessment
  copy so the three surfaces are identical in substance.
- **`CONTRIBUTING.md`** — add a "Manual verification" subsection in the existing "Pull requests"
  section (after the current line about noting registry/doc updates). It must state: *when* it applies
  (and the explicit escape for docs-only / fully-automated-test-covered changes, with "here's why" in
  the PR instead — but note a skill/harness/prose change is **not** exempt: picc executes it, so it has
  a runtime surface); *what* concrete guidance looks like (branch to check out, how to launch picc
  against an `examples/` project such as `hello-claude`/`full-surface`, the in-app steps, the expected
  observable outcome); *the two artifacts* (guidance in the description, the manual-verification comment
  as the evidence); and — **one sentence of rationale (UX)** — *why* they are separate: the guidance is
  written **before** you verify so a reviewer can follow it independently, the comment is written
  **after**, as evidence you actually ran it. Use a **worked example** using the repo's own fixtures so
  a stranger can copy it. Keep the exact phrase "manual-verification comment" consistent with pr-eval.
  Cross-platform: the example must work on Windows Git Bash and Linux.
- **`.github/pull_request_template.md`** (new; none exists today) — surface the contract at PR-open
  time. Sections: Summary; automated checks (`npm run typecheck`, `npm test` — matching CONTRIBUTING
  and the CI legs); **Manual verification guidance** (the concrete steps a reviewer runs) with the
  **"not manually verifiable / fully covered by automated tests — here's why" escape**; and an
  acknowledgement that the author will post their manual-verification **report as a comment** (the
  template body can't hold the comment itself). Align terminology with CONTRIBUTING and the two CI
  workflows.
- **`implement-feature` creation-side guidance** — the PR-body "Start your review here" verification
  section in `implement-feature/references/handoff.md`. Update it so the coordinator produces the same
  **concrete, applicability-aware** guidance: judge whether the change warrants manual verification
  (**docs-only or fully-auto-tested → state "no manual step needed: <reason>"** rather than inventing
  one) and, where it does, give concrete branch/launch/in-app steps + observable outcome. **Thread it
  with `handoff.md`'s existing doctrine, do not contradict it:** that file already says a change "with
  no runnable UI — skill/harness/prose-only" still has a runtime surface (picc executing the changed
  behaviour) and must give steps. So the applicability escape is for genuinely **no-runtime-surface**
  (docs, comments) or **fully-auto-tested** changes — NOT for prose/skill changes, which picc executes.
  Do not cite a `/verify` skill (it is a Claude Code bundled skill, absent here); state the rule on its
  own merits. This is the "improve agent judgement on creation" the user asked for. Keep the edit
  proportionate — refine the existing section, do not restructure the hand-off.
- **`CHANGELOG.md`** — add to `[Unreleased]`, following the house format
  `### <Category> — <short title> (YYYY-MM-DD)` with bold-lead bullets and honest limits:
  an `### Added — evaluate skill` entry (three modes, fixed action envelope, structural no-write
  surfaces, idempotency) and a `### Changed — implement-feature proposal-gating & verification
  guidance` entry (Phase 8 gating, Phase 1 annotation, concrete creation-side verification, the
  CONTRIBUTING/PR-template tightening). Use today's date. Note: CHANGELOG is a serial-merge-conflict
  hotspot — write this last, after t02–t04 are on the branch.
- **Do NOT** touch generated `doc/supported-features.md`, `src/registry/capability-registry.ts`, or run
  `npm run gen:capabilities` — no capability is added.

## Writable surface
- `CONTRIBUTING.md`
- `.github/pull_request_template.md` (new)
- `.claude/skills/implement-feature/references/handoff.md` (verification section only)
- `CHANGELOG.md`
- `test/evaluate-skill.test.ts` (or a small repo-artifacts test): assert the PR template exists and
  carries the verification requirement, and CONTRIBUTING carries both artifacts + the applicability
  escape
Read-only elsewhere.

## Approach constraints
- The three verification surfaces (CONTRIBUTING, PR template, pr-eval copy) must describe the same
  contract in the same terms — no drift.
- The applicability escape must be prominent everywhere manual verification is demanded, so docs-only /
  fully-auto-tested changes are never nagged.
- implement-feature hand-off edit stays within the existing verification section.

## Left open
- Exact CONTRIBUTING wording and which `examples/` fixture the worked example uses.
- Exact PR template section headings/checkboxes.
- CHANGELOG bullet wording.

## Testing
- Unit: `.github/pull_request_template.md` exists and contains the verification-guidance requirement +
  the applicability escape; `CONTRIBUTING.md` contains both artifacts (description guidance +
  manual-verification comment) and the applicability escape. **Explicitly normalize `\r\n`→`\n` before
  substring assertions** — `.gitattributes` does not force LF on `.md`, and these files are read raw
  (not via `loadSkillBody`), so on Windows they check out CRLF and un-normalized substring/line checks
  would flake.
- Reference-link integrity for implement-feature stays green after the handoff.md edit.
- typecheck + full suite green.

## Acceptance criteria
- [ ] CONTRIBUTING demands the two artifacts with a worked cross-platform example and the applicability
      escape.
- [ ] `.github/pull_request_template.md` exists, surfaces concrete verification guidance, the escape,
      and the post-a-comment acknowledgement.
- [ ] implement-feature's hand-off produces concrete, applicability-aware verification guidance.
- [ ] CHANGELOG has the Added + Changed entries in house format.
- [ ] `doc/supported-features.md` / registry untouched; `gen:capabilities` not run.
- [ ] typecheck and full test suite green.

## Depends on
t01, t03, t04
