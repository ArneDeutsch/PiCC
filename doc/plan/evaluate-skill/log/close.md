# close.md — applying accepted feature-close-review findings

Applied the six accepted findings from the evaluate-skill close review. Prose/config/test only; no
`src/` touched. Summary of each fix, key decisions, and verification below.

## Fix 1 (SHOULD) — Phase-8 `## Evaluation` embed missing from the body-authoring step

- File: `.claude/skills/implement-feature/references/ticket-integration.md`, Phase-8 issue-filing hook.
- The body-authoring instruction ("author an ASCII title and a body written to a temp file … ending
  with the attribution trailer") now also says to **embed that finding's proposal-gate assessment
  under a clearly-delimited `## Evaluation` heading, kept visibly separate from the finding's own
  ask**. Minimal insertion inside the existing sentence; Rule 5 and the rest of the hook untouched.
- Matches proposal-gate.md:75-77 (a surfaced finding is filed as its own separate issue with the block
  embedded under `## Evaluation`). No resume-scope concern — a filed finding is a standalone issue,
  never re-read as the current feature's WHAT/WHY.

## Fix 2 (SHOULD) — router `<target>` resolution for a bare-number ref

- File: `.claude/skills/evaluate/SKILL.md`, Target-detection + reachability gate.
- Added a "Resolving `<target>` for a bare ref" paragraph: BEFORE the first `gh` touch the coordinator
  resolves `<target>` from the current checkout (the **target-only** half — `origin`'s repo on a
  maintainer checkout, upstream `parent` on a fork), for a bare `#N`/`N` ref; a URL ref carries its own
  validated owner/repo. Reconciled the remoteless case: evaluate needs a *resolvable* (not *pushable*)
  target, so a **remoteless checkout with a bare ref stops with the usage/reachability message**; a URL
  ref is unaffected.
- **Decision (link-integrity trap):** the router bidirectional test regex `references\/[…]\.md` would
  match `references/fork.md` inside a full `../../implement-feature/references/fork.md` link and then
  assert `evaluate/references/fork.md` exists (it does not) → red. So SKILL.md refers to `fork.md` by
  bare name and points the reader to write-discipline.md's Target-repo resolution for the resolvable
  link (which fix 6 makes clickable). This keeps the router link-integrity test green while still
  giving the reader a resolvable path one hop away.

## Fix 3 (SHOULD, security) — pr-eval treat-as-data for attacker-influenced identifiers

- File: `.claude/skills/evaluate/references/pr-eval.md`.
- (a) Step 1's "carries no attacker prose" note reclassified: the changed-file paths
  (`gh pr diff --name-only`) and CI check/context names (`gh pr checks`) are **attacker-influenced
  bounded data** (a fork PR author controls their own paths and can name a check), not attacker-free.
  What makes them safe to read is that they are **bounded** (enum/bool/path-list/names+conclusions),
  not that they are attacker-authored-free; treat-as-data discipline still applies (never interpolate,
  never paste verbatim).
- (b) Step 6 verbatim-allowed identifiers: removed "file paths"; the only verbatim-safe identifier is
  now the **PR ref number**. File paths are attacker-influenced, so the composed comment describes
  affected areas in the coordinator's own words.

## Fix 4 (SHOULD, security) — deny floor `=`-glued long-flag `gh api` write forms

- File: `.claude/settings.json` — ADDED exactly the three SAFE `=`-glued forms:
  - `Bash(gh api *--method=*)`
  - `Bash(gh api *--field=*)`
  - `Bash(gh api *--raw-field=*)`
- Did NOT add single-dash shorthand-glued forms (`-f*`/`-X*`) — they would false-positive on
  repo/branch/path names containing `-f`/`-x` and wrongly deny reads.
- Test (`test/evaluate-skill.test.ts`):
  - Added the three matchers to the enumerated deny list.
  - **Positive controls** (denied): `gh api repos/o/r --method=PATCH`,
    `gh api repos/o/r/labels --field=name=bug`, `gh api repos/o/r/issues/5 --raw-field=body=x`.
  - **Negative control** (NOT denied): `gh api repos/o/some-foo-repo/issues/5 --jq '.state'` — a GET on
    a repo path containing a dash-letter sequence must survive.
- write-discipline.md floor caveat updated: names the space-separated + `=`-glued long-flag forms as
  covered, and documents the single-dash **shorthand-glued** forms as an accepted **residual** gap
  (consistent with the existing best-effort framing).

## Fix 5 (NIT) — garbled foreign-repo phrase in SKILL.md

- File: `.claude/skills/evaluate/SKILL.md`, reachability paragraph.
- `"owner/repo matches neither the resolved `target`"` → `"owner/repo does not match the resolved
  `target`"` (evaluate intentionally narrows to target-only).

## Fix 6 (NIT) — resolvable fork.md link in write-discipline.md

- File: `.claude/skills/evaluate/references/write-discipline.md`, Target-repo resolution.
- Bare `` `fork.md` `` → `[`fork.md`](../../implement-feature/references/fork.md)` so a reader
  following it in isolation lands on the file.

## Verification

- `npm run typecheck`: clean (tsc --noEmit, no output).
- `npm test` (full suite): **47 passed | 1 skipped** test files; **1117 passed | 16 skipped** tests;
  0 failures. Baseline had no failures; still green.
- Both SKILL.md files under 20_000 chars (evaluate 12,984 bytes; implement-feature 19,988 bytes,
  untouched). Router bidirectional link-integrity green.

## Friction / notes

- The router link-integrity regex is greedy for any `references/NAME.md` substring, including inside a
  cross-skill relative path. Any future SKILL.md edit that wants to link an implement-feature reference
  by full path would trip it; the safe pattern is bare-name in SKILL.md + resolvable link in a
  reference file. Recorded here so the next editor doesn't rediscover it the hard way.
- implement-feature/SKILL.md sits at 19,988 bytes (12 under the 20k cap). I did not touch it, but it is
  worth flagging as nearly full for anyone editing it next.

## Fix 7 (post-smoke-test) — redirect-isolation UTF-8 encoding gap + verified framing

Live smoke test of the redirect isolation found a real cross-platform correctness gap and confirmed the
long-hedged empty-stdout premise. Both addressed. Prose only; no `src/` touched.

- **The finding (verified on Windows).** (1) The empty-stdout premise HOLDS: `gh … > <file>` returns
  empty stdout to the tool on both Git Bash and PowerShell — the coordinator's context never sees the
  content. (2) BUT the Read tool (the shell-free evaluator's only way to consume the file) does **not**
  decode UTF-16LE. A **Git Bash** `>` writes UTF-8 (reads back cleanly); a **PowerShell** `>` writes
  UTF-16LE-with-BOM, which the Read tool returns as garbled space-separated mojibake → breaks
  evaluation. The skill previously said only `gh … > <file>` with no shell/encoding, so a coordinator
  using PowerShell on Windows would hand the evaluator garbage.

- **Canonical rule (write-discipline.md).** Added a new `## Content-redirect encoding — the redirect
  MUST produce a UTF-8 file` section near the mechanics: the content redirect MUST produce UTF-8 because
  the evaluator consumes the file via the Read tool, which cannot decode UTF-16LE; do the redirect via
  the **Bash tool** (Git Bash `>` writes UTF-8), **never** a PowerShell `>` redirect (UTF-16LE-with-BOM
  → mojibake); if PowerShell is unavoidable, pipe explicitly: `gh … | Out-File -Encoding utf8 <file>`.
  States the WHY (evaluator Read + UTF-16LE decode failure) so it can't be dropped as arbitrary. Same
  section records the empty-stdout premise as verified-on-Windows-but-still-behavioral.

- **Referenced the rule at each redirect site** (terse pointer, so an implementer at any entry point
  sees it): SKILL.md resident kernel (the `Redirect it … without reading it` lead + the two-bullet
  redirect commands), evaluation-engine.md redirect-isolation note, issue-eval.md Step 1
  (`> <tempfile>`), pr-eval.md Step 1 (`> <difffile>` / `> <contentfile>`). proposal-gate.md has **no**
  redirect site (structurally shell-free — no `gh` redirect), so it was left untouched by design.

- **Framing upgrade (SKILL.md + evaluation-engine.md).** Replaced the "currently **unverified** premise
  … pending one live smoke test" hedge in both files with: the redirect keeps content out of the
  coordinator's context is **verified on Windows** (Git Bash + PowerShell), and correctness
  **additionally** requires the UTF-8 redirect. Deliberately **kept** the honest distinction that this
  is a **behavioral discipline** (the coordinator must actually perform the redirect), not a tool-enforced
  / structural guarantee — did not overclaim. write-discipline.md carried no prior hedge; the verified
  framing lands in its new UTF-8 section instead.

- **Decision — link form.** The new write-discipline pointer in SKILL.md reuses the already-present
  `[references/write-discipline.md](references/write-discipline.md)` link form (a real evaluate
  reference), so the greedy router link-integrity regex (Fix 2 note) stays green. Reference-to-reference
  pointers use the bare-name `[write-discipline.md](write-discipline.md)` sibling link.

- **Verification.** `npm run typecheck`: clean (no output). `npm test` (full suite): **47 passed |
  1 skipped** files; **1117 passed | 16 skipped** tests; 0 failures — identical to the Fix 1–6 baseline.
  SKILL.md now 13,561 bytes (under the 20k cap). Router bidirectional link-integrity green.
