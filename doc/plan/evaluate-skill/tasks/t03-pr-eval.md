# t03: pr-eval mode + the canonical verification contract

## Goal
`references/pr-eval.md` exists and is linked: given a PR ref, the skill assesses the diff and its
consequences, whether it fulfils its ticket and whether the ticket was worth doing, and the
verification evidence — then posts an advisory assessment comment (never merges). It also defines the
**canonical verification contract** (applicability rule + the two artifacts + the concrete-guidance
standard) that t05 (CONTRIBUTING / PR template / implement-feature hand-off) restates for the
contributor/creation audience.

## Context & seams
- **Consumes** the engine + write-discipline from t01, adding the PR-specific criteria named there:
  fulfilment, code consequences/blast radius, verification evidence.
- **Target resolution:** resolve via `gh api repos/<target>/issues/<N>`; require the `pull_request`
  key (it IS a PR). Read the PR, its linked ticket (if any), the diff (`gh pr diff`), and comments.
  Same sanitization + foreign/URL-mismatch stop as t02. Reachability: read + comment auth on `target`,
  no push remote.
- **State short-circuit:** on an **already-closed or merged PR**, suppress or reframe the advisory
  assessment (a `ready | needs-work | hold` merge-readiness read on something already merged is
  surprising) and post no verification-request; offer the read only. Idempotency scan as in t02, with
  the same attacker-forgeable-marker caveat (conservative skip/ask only).
- **Depth:** go deep into the diff and consequences — but text-as-data, structurally. The
  diff/body/comments are attacker-controlled, so the coordinator **redirects them to files it does not
  read** (`gh pr diff > <difffile>`, `gh pr view --json ... > <file>`) and the roaster + pro/con + lens
  reviewers all run as the **shell-free `evaluator`** (t01), which Reads those files itself plus the
  trusted codebase via Read/Grep/Glob — but cannot run the author's reproducer, fetch a link, or write.
  The coordinator synthesises over their bounded returns and spot-checks load-bearing claims. The
  assessment renders the engine's canonical rating block (t01), filling the PR-specific rows.
- **What the assessment weighs and surfaces to the maintainer:** fulfilment (under/full/over-reach vs
  the ticket); was-the-ticket-worth-doing (so a faithful implementation of a bad ticket is still
  flagged); code consequences/risk; verification evidence (present/absent and whether *convincing*);
  tests/CI status (read via `gh`, no merge); and an advisory merge-readiness read
  (`ready | needs-work | hold`) with reasons. **Never merges, never says "merged".**

### The canonical verification contract (defined here, reused by t05)
- **Applicability first.** Judge whether the change even warrants manual verification, stated on its
  own merits (do **not** cite a `/verify` skill — that is a Claude Code *bundled* skill, not present in
  this repo). A change with **no runtime surface to drive** (docs, comments) — or one **fully and
  genuinely** covered by automated tests — has nothing to manually verify; record "no manual
  verification needed: <reason>" rather than inventing a step or nagging. **Crucial distinction (per
  handoff.md's existing doctrine):** a skill/harness/prose change *does* have a runtime surface — picc
  executing the changed behaviour — so it is **not** exempt; only genuinely no-runtime-surface (docs)
  or fully-auto-tested changes are. Thread this with `handoff.md`'s "no runnable UI" guidance rather
  than contradicting it.
- **Two distinct artifacts (when applicable) — canonical noun: "manual-verification comment":**
  - **PR description → verification *guidance*** (the plan a reviewer follows): concrete and specific —
    which branch to check out, how to launch picc (e.g. `node bin/picc.mjs` against a named
    `examples/` project), exactly what to do inside the app to exercise the change or confirm the bug
    is fixed, and the observable outcome to expect. A vague "try it out" does not satisfy it.
  - **The manual-verification comment → the author's evidence** (a PR comment): what they actually ran
    by hand and observed, on which OS/shell, and anything they could not verify.
- **pr-eval enforcement (adapted request):** only when the change warrants manual verification AND the
  manual-verification comment is missing does pr-eval post a **verification-request** comment —
  helpful, good-faith, one-time, pointing at CONTRIBUTING, never threatening a close. **If the evidence
  is present but misplaced** (the author wrote what-they-ran into the PR *description* instead of a
  comment), acknowledge it and point at the convention — do **not** post a rote "missing report" nag.
  If guidance in the description is missing/weak, name that too. If manual verification is not
  applicable, pr-eval says so and requests nothing. Guard the request for idempotency; never post it on
  a closed/merged PR.

## Writable surface
- `.claude/skills/evaluate/references/pr-eval.md`
- `.claude/skills/evaluate/SKILL.md` (add the link + any resident never-merge floor markers)
- `test/evaluate-skill.test.ts` (add never-merge / verification-applicability floor markers)
Read-only elsewhere.

## Approach constraints
- Never merge, never take a merge action, never say "merged".
- Assessment is advisory; the maintainer decides. End with evaluate's attribution trailer.
- Verification-request is applicability-gated and idempotent; never naggy, never a close threat.

## Left open
- The exact assessment-comment layout and the merge-readiness heuristic (within the criteria).
- Exact verification-request copy (t05 must stay consistent with it).
- How deep the diff investigation goes per PR (proportionate to size/risk).

## Testing
- Unit floor markers: pr-eval prose carries "never merge" and the applicability rule
  (docs-only / fully-auto-tested → no manual verification) (loose, case-insensitive).
- Reference-link integrity green.
- typecheck + full suite green.
- Do NOT test LLM judgment or `gh` writes.

## Acceptance criteria
- [ ] pr-eval requires a PR ref, reads diff + ticket + comments, and never merges.
- [ ] The assessment surfaces fulfilment, ticket-worth, consequences, verification evidence, CI, and an
      advisory readiness read.
- [ ] The verification contract (applicability rule + two artifacts + concrete-guidance standard) is
      defined here for t05 to reuse.
- [ ] A verification-request is posted only when warranted and missing, is idempotent, and never fires
      on a closed/merged PR or a not-manually-verifiable change.
- [ ] typecheck and full test suite green.

## Depends on
t01
