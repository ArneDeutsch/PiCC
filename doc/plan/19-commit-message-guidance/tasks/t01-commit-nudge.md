# t01: Commit-message nudge in the always-on conventions block

## Goal

PiCC's every-turn system-prompt conventions block nudges the model, when the user
asks for a commit, to match the repository's commit-message style and favor a
why-over-what message — so a GPT/Codex model writes richer commits by default. The
existing `--no-verify` prohibition is preserved, and an anti-regression test guards
the nudge.

## Context & seams

- **The block:** `HARNESS_CONVENTIONS` in `src/runtime/context-assembly.ts` (lines
  ~99-107). It is a fixed list of second-person imperative bullets under the lead-in
  "You are running a project authored for Claude Code. Honor its conventions:". The
  last bullet is today's only git line:
  `- Never use git commit --no-verify; project hooks must run.`
  Several bullets use a noun-lead + colon (`- Subagents: …`, `- Worktrees: …`).
- **Change:** replace that single git bullet with **one** `Commits:` bullet (noun-lead
  to match the block's style) that folds in the new guidance AND keeps the `--no-verify`
  sentence **verbatim** as its own trailing sentence. Do not add a second git bullet.
- **The block is re-sent every turn to every dispatching context** (main session and
  subagents) via `buildSystemPromptSuffix` (`context-assembly.ts:124`); it is never
  compacted away. Adding ~1 sentence is a negligible context cost. Nothing parses the
  block's exact bytes — all assertions are substring/regex.

## Writable surface

- `src/runtime/context-assembly.ts` (the `HARNESS_CONVENTIONS` constant only)
- `test/runtime-core.test.ts` (add the anti-regression assertions)
- `doc/plan/19-commit-message-guidance/log/t01.md` (execution log)

## Approach constraints

The bullet MUST, in ~2 sentences:
1. Scope the guidance to **when the model is asked to commit — by the user, OR by a
   skill or project instruction** (a skill/CLAUDE.md directive to commit counts as "the
   ask"). This keeps the no-proactive-commit intent (mirroring Claude Code's strongest
   commit rule) WITHOUT contradicting projects/skills that legitimately instruct
   per-task commits — e.g. PiCC's own `implement-feature`. (Plan-review finding: a flat
   "only when the user asks" reopens a seam the sibling `MEMORY_WRITE_POLICY` already
   solved with an "Unless this project's own instructions…" deference lead-in; the
   parenthetical trigger-scope is the lighter-weight resolution.)
2. Tell the model to read the actual changes (git status/diff) and recent `git log` and
   **match this repository's commit-message style _where it is richer_** — NOT an
   unconditional "match the style." (Plan-review finding: the target repos are precisely
   those whose recent history is terse PiCC/GPT-authored one-liners; a bare "match the
   repo's style" would instruct the model to *reproduce* terse commits and perpetuate the
   gap this feature closes. An empty/fresh-repo log has nothing to match at all.)
3. Make the why-over-what body a **floor for non-trivial changes regardless of history**:
   "for a non-trivial change, still write a short body explaining why, not just what."
   Keep it **short** and gated to **non-trivial** changes (guards against over-verbose
   trivial commits and against being *more* verbose than Claude Code's concise baseline —
   a deliberate, parity-confirmed conservative divergence: Claude applies the why-focus to
   every commit; we gate it to non-trivial, the safe under-nudge direction).
4. Preserve `Never use git commit --no-verify; project hooks must run.` verbatim.
5. **Never** mention `Co-Authored-By`, any trailer, or attribution (PiCC has no
   commit-attribution machinery; a trailer instruction would contradict the
   `setting.includeCoAuthoredBy` / `setting.attribution` degraded-noop registry entries).

Recommended wording (adjust lightly if it reads better, honoring 1-5):

> `- Commits: when you're asked to commit — by the user, or by a skill or project instruction — first read the changes (git status/diff) and recent git log, and match this repository's commit-message style where it is richer; for a non-trivial change, still write a short body explaining why the change was made, not just what. Never use git commit --no-verify; project hooks must run.`

## Left open

- Minor wording polish, as long as constraints 1-5 hold and the two test phrases below
  remain present.

## Testing

- Add an anti-regression assertion pair in `test/runtime-core.test.ts`, inside the
  existing `it("builds a suffix containing instructions, rules, skills, agents and
  steering", …)` test, appended right after the F15 block (the
  `/background by default/i` + `/collect each result with TaskOutput/i` pair). Mirror
  the comment-plus-`toMatch` style. Anchor on the load-bearing phrases of the final
  wording, e.g.:
  ```ts
  // F19 anti-regression: the every-turn conventions block must nudge richer
  // commit messages (match the repo's git-log style; why-not-what body), so a
  // silent drop fails here rather than only in prose.
  expect(suffix).toMatch(/recent git log/i);
  expect(suffix).toMatch(/why the change was made/i);
  ```
  If you reword, keep two regexes that key on the primary "match git-log style" idea
  and the why-not-what clause. No new assertion needed in `test/builtin-agents.test.ts`
  (its existing header assertion already proves the block reaches subagents).
- Unit layer only; no cross-platform concern (pure string content).

## Acceptance criteria

- [ ] `HARNESS_CONVENTIONS` carries a single `Commits:` bullet honoring constraints 1-5.
- [ ] The `--no-verify` prohibition is preserved verbatim.
- [ ] `test/runtime-core.test.ts` asserts the commit nudge is present (two regexes).
- [ ] typecheck and full test suite green.

## Depends on

–
