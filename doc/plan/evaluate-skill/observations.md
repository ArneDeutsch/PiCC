# Observations — evaluate skill

Running record of friction, bugs, and opportunities. Dated bullets, one line each; raw material for review.md.

## t01 — foundation (2026-07-15)

- **Deny floor is best-effort, not a boundary.** A `*`-anywhere Bash matcher can't express "flag in any
  position", so `gh api` write coverage is inherently incomplete (leading-flag + long-form forms were
  bypassable until broadened; residual forms remain). The real controls are the shell-free `evaluator`
  sandbox (structural) + the trusted-coordinator envelope discipline — the floor is defence-in-depth.
- **Redirect isolation rests on an unverified harness premise.** "Coordinator never reads raw content"
  assumes `gh … > file` returns empty stdout to the Bash tool. Sound by construction, but not
  runtime-confirmed offline — needs one live `gh` smoke test before the "dual-LLM quarantine" framing is
  fully relied on. (Deferred; candidate for a user-run smoke test, like the F14 pattern.)
- **Test gotcha (reusable):** per-skill frontmatter parse diagnostics live on `skill.diagnostics`, NOT
  in `loadSkills`'s top-level `diagnostics` array — a "loads clean" test must assert `skill.diagnostics`
  directly or it silently misses malformed frontmatter.
- **Spec friction:** an exact-file-count test pin (`toEqual([...two refs])`) would have forced a
  mandatory test edit in every later task; relaxed to a glob/superset check. Note for future task specs:
  prefer count-agnostic structural assertions when later tasks extend the same surface.
- **Carried-forward safety constraint:** the `evaluator` has unrestricted `Read` (can see `~/.pi`/`.env`),
  so its return must be a bounded *structured* rating the coordinator *composes* the comment from —
  never pasted verbatim — else a successful injection could exfiltrate a secret into a public comment.
  Folded into t02's keep-open-comment spec.

## t02 — issue-eval (2026-07-15)

- **"Scan comments" is a hidden isolation leak.** A spec that says "scan existing comments for our
  trailer" invites a naive implementer to read comment bodies into the coordinator — defeating the
  redirect isolation. Fixed by pinning it to a metadata-only `--jq` query returning just the matching
  comment URL. Lesson: every coordinator-side "look at the content" step must be spelled out as
  metadata-only, or it silently re-ingests attacker bytes.
- **Decision — already-closed issue = no write of any kind** (on-screen read/rating only). Resolved a
  disagreement between issue-eval.md and write-discipline.md.
- **Override safety:** a human-forced close of an issue the agent rated *keep-open* must NOT carry the
  slop "cost/risk outweighs value" canned template (it would contradict the shown rating) — it carries
  a neutral "closed by the maintainer after review" note, re-previewed. Canned slop/malicious templates
  are only for the agent's own clear-cut close dispositions.
- **Posture note (flag to user):** the build confirms before **every** public write (keep-open comments
  too), not only closes — safe, but when pointing the agent at many issues the maintainer confirms each
  keep-open comment as well. Tagline aligned to "confirms before any public write". Revisit if too heavy.
- **Accepted residual:** the evaluator's "short justification" fields are a free-text channel; a
  base64-encoded secret could survive an English paraphrase. Owned by feature.md's dual-LLM non-goal;
  optional future hardening is to restrict the composed comment to rubric vocabulary + scores.

## t03 — pr-eval (2026-07-15)

- **Metafile bundling trap (generalizes the t02 "scan comments" leak).** Redirecting attacker content
  AND coordinator-needed metadata into ONE `--json` file forces the coordinator to read the attacker
  body just to get `state`/`mergedAt`/file-list/CI — silently breaking redirect isolation. Rule that
  emerged: redirected content files are **evaluator-only**; everything the coordinator needs comes from
  **separate metadata-only `--jq` re-queries**. Never co-mingle the two in one file. (Note: `state ==
  closed` already covers every merged PR, so only the merged-vs-closed *reframe* needs an extra query.)
- **PR assessment comment needs two labelled sections:** §A "was this ticket worth doing?" (rubric on
  the ticket, no blast-radius row) and §B "assessment of this diff" (diff-specific rows incl. code
  consequences/blast-radius + a Tests/CI row) — otherwise a shared "Blast radius" row is ambiguous
  (ticket vs diff) and doubled.
- **Canonical-noun drift** ("manual-verification comment" vs "report") had scattered across engine +
  write-discipline + feature.md; swept. Lesson: when a task canonicalizes a term, sweep the siblings in
  the same pass or the "all name the same thing" claim ships false.
- **Cross-bundle link is unguarded:** pr-eval.md's `../../implement-feature/references/handoff.md`
  see-also is not covered by the link-integrity test (which only checks same-dir refs) — accepted as
  low-severity provenance coupling; would rot silently if handoff.md moves.
- **t05 coordination:** the verification contract is canonical in pr-eval.md; t05 must reuse its exact
  `node bin/picc.mjs` + `examples/` launch command rather than paraphrasing, to avoid drift.

## t04 — proposal-gate + implement-feature wiring (2026-07-15)

- **Don't publicly self-grade the human's own work.** Baking a "value: low/medium" assessment into the
  maintainer's OWN just-converged feature's public issue body (and on a fork, onto someone else's repo)
  is odd-to-embarrassing. Moved Phase 1 to an **in-session advisory**; this one change resolved five
  findings across three reviewers at once (public self-grading + passive `## Evaluation` delimiter +
  stale FILE-step cache + re-read-scope risk). Lesson: assessments on the human's own converged work
  belong in-session; the embed-in-body pattern is for **agent-surfaced findings** (separate issues,
  never re-read as current-feature scope), which is where the user's "assessment in the description"
  ask genuinely fits.
- **Editing a shipped, heavily-tuned skill needs invariant reconciliation, not just insertion.** The
  Phase 8 gate had to be framed as **subtractive-only** ("drops clear slop, never adds") to keep
  implement-feature's existing "never file anything not surfaced by this build" invariant true, and the
  word "surfaced" was overloaded (origin-invariant vs post-gate pick) — split to "surfaced" vs
  "presented".
- **A gate must leave an in-flow recovery lever.** "Dropped findings remain in review.md" is a durable
  record but not agency; added an explicit "ask to see the dropped findings and I'll surface them into
  the pick-list" affordance.
- **Deviation from decision C (flagged to user):** the user asked to "add an assessment about the
  feature proposal" at Phase 1; delivered as an in-session advisory rather than a public body embed.
  One line reverts it if the maintainer prefers the embed.

## t05 — CONTRIBUTING + PR template + creation-side guidance + CHANGELOG (2026-07-15)

- **A copy-paste-broken worked example is worse than none.** The first draft told a first-time
  contributor to type `/hello`, but the named `examples/hello-claude` fixture's skill is `/greet <name>`
  (the fixture/command-name collision made the wrong command look plausible). Fixed to `/greet Ada` with
  a real observable outcome (greeting reply + `greeted:` line in `greetings.log`). Lesson: verify every
  example command against the actual fixture, not the fixture's name.
- **A cross-surface literal must be byte-identical.** The escape phrase "no manual verification needed:
  <reason>" drifted to "No…" in the PR template; aligned. When four surfaces (pr-eval, CONTRIBUTING,
  template, handoff) restate one contract, casing/wording drift creeps in and undercuts the "one story"
  goal.
- **A template section with no gate ships blank.** Added a light checkbox gating the verification
  guidance so an author can't tick the boxes and submit with empty steps (pr-eval backstops it, but the
  template is the place to prevent it).
- **Two-artifact verification contract confirmed sound** by the contributor walkthrough: guidance
  (before, in the description, for the reviewer) vs. the manual-verification comment (after, as
  evidence) is additive, not busywork, with a genuine stated rationale.

## close — live smoke test (2026-07-15)

- **Ran the redirect-quarantine smoke test against real GitHub data.** Empty-stdout isolation premise
  CONFIRMED on Windows (both Git Bash and PowerShell keep `gh … > file` content out of the tool result);
  metadata-only `--jq` issue-vs-PR routing works (#27→issue/open, #25→PR/closed).
- **Real bug found & fixed:** a PowerShell `>` redirect writes UTF-16LE-with-BOM, which the Read tool
  returns as mojibake (`��{ " t i t l e"`); a Git Bash `>` writes clean UTF-8 the evaluator reads fine.
  The skill said only `gh … > file` — so on Windows/PowerShell the evaluator would get garbage. Fixed by
  mandating a UTF-8 (Bash-tool) redirect. Lesson: "redirect to a file" is encoding-sensitive on a
  dual-shell (PowerShell-primary) platform; the load-bearing detail is UTF-8, and only a live run caught
  it — offline reasoning had marked the premise "holds by construction."
