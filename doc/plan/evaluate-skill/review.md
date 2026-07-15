# Evaluate skill — Review

## Outcome

Shipped the `evaluate` skill — a maintainer triage tool with three modes over one shared engine:
**issue-eval** (confidence-gated close of clear slop / keep-open rating, always confirm-before-write),
**pr-eval** (deep diff assessment + the verification contract, never merges), and **proposal-gate**
(structurally write-free scoring, wired into implement-feature's Phase 8 findings offer as a gate and
its Phase 1 create-offer as an in-session advisory). Safety rests on two real controls — a **shell-free
`evaluator` sandbox agent** (tool-gated: it and every content-ingesting reviewer cannot write/fetch/run)
and a **coordinator redirect-to-file + metadata-only** discipline so the privileged context never
ingests raw attacker bytes — plus honestly-labelled behavioral controls (a defence-in-depth
`settings.json` deny floor, the close-invariant, confirm-before-write). Also tightened `CONTRIBUTING.md`
+ a new `.github/pull_request_template.md` + implement-feature's hand-off with a concrete,
applicability-aware verification contract.

**Prose/config only — no `src/` changes.** 1117 tests pass (unit adds an evaluate-skill test that pins
frontmatter, link integrity, router cap, the evaluator tool restriction, and the deny floor via the
real `PermissionEngine`). Five tasks (t01 foundation → t02 issue-eval → t03 pr-eval → t04 proposal-gate
→ t05 docs), each committed green after a specialist review round.

**Deviations from the plan (all deliberate, all with the user or clearly right):**
- De-numbered workspace naming (branch/folder/commits by description, not `F<NN>`), at the user's
  request; the de-numbering of implement-feature itself was split out to issue #26.
- The autonomy/`--yes` token was designed then **removed** at the user's direction — there is no
  unattended mode; the skill always confirms before a close and the human is always reachable.
- The strong isolation model (shell-free reviewers + coordinator never reads content) replaced the
  initial weaker "coordinator reads, prose-constrained Bash reviewers" design, at the user's direction.
- Phase 1 proposal-gate delivers its value assessment as an **in-session advisory**, not embedded in
  the maintainer's own public issue body (a decision-C refinement that dissolved five review findings at
  once). One line reverts it if the maintainer prefers the embed.

## Planning errors & spec gaps

- **The isolation model was under-specified until review surfaced it.** The plan initially had the
  coordinator read target content with prose-only containment on Bash-capable reviewers; the security
  review (M3/M4) and the user pushed to the structural model. A safety-critical WHAT-adjacent property
  emerged late rather than being set at Phase 1.
- **"Coordinator looks at content" steps are recurring isolation leaks.** The idempotency comment-scan
  (t02) and the bundled PR metafile (t03) each would have re-ingested attacker bytes if implemented
  naively. The global rule — *every coordinator-side content touch must be a metadata-only `--jq`
  re-query* — should have been stated once, up front, not rediscovered per task.
- **Canonical-noun drift shipped across siblings** ("manual-verification report" vs "comment"): when a
  task canonicalizes a term, the sibling files must be swept in the same pass.
- **Editing the shipped implement-feature skill leaves stale traces** (the "pr-eval not available yet"
  line; the `## Evaluation` embed promised in proposal-gate.md but missing from the file that authors
  the body). Cross-file/cross-task edits need an explicit staleness sweep.

## Friction

- Exact-file-count test assertions forced a mandatory edit in every later task — count-agnostic
  structural assertions (glob + superset) avoid the churn.
- `.md` files aren't LF-forced by `.gitattributes`, so content-check tests need explicit
  `\r\n`→`\n` normalization to be cross-platform.
- Cross-bundle relative links (evaluate → implement-feature references) resolve on disk but are
  unguarded by the link-integrity test (which only scans same-dir refs).

## Bugs discovered

- **Would-have-shipped (caught in plan review):** a `Bash(gh repo *)` deny-floor wildcard would have
  silently broken implement-feature's fork detection (which needs `gh repo view`) — four reviewers
  flagged it; fixed to enumerated destructive subcommands before any code landed.
- **Caught in t05 review:** the CONTRIBUTING worked example told a first-timer to type `/hello`, a
  command the named `examples/hello-claude` fixture doesn't have (its skill is `/greet`).
- **Caught by the live smoke test at close:** the coordinator's content redirect wrote **UTF-16LE**
  under a PowerShell `>`, which the evaluator's Read tool renders as mojibake — issue/PR evaluation
  would silently break on Windows whenever the coordinator used PowerShell. Fixed by mandating a UTF-8
  (Bash-tool) redirect across the skill. (The empty-stdout isolation premise itself was *confirmed* by
  the same test on both shells.)
- No pre-existing repo bugs surfaced.

## Improvement opportunities

- Extend the skill link-integrity test to cover cross-bundle relative links so they can't rot silently.
- Constrain the evaluator's free-text "justification" fields to rubric vocabulary + scores to close the
  low-bandwidth exfil residual that survives paraphrase (feature.md owns this as a non-goal today).
- The deny floor can't express "flag in any position"; it's honestly framed as best-effort — the real
  control is the sandbox + trusted coordinator, so exhaustive matcher-chasing isn't worthwhile.

## Proposed follow-ups

- **Live smoke test of the redirect quarantine — DONE at close.** Run against real GitHub data (#27
  issue, #25 PR) with `gh` authenticated: the empty-stdout isolation premise was **confirmed** on both
  Windows Git Bash and PowerShell, and metadata-only issue-vs-PR routing worked; it surfaced the
  UTF-16LE redirect gap (now fixed — see Bugs discovered). A fuller end-to-end exercise of the *rating*
  logic (model behaviour) is still worthwhile once the skill is loaded as an invocable command in a
  session.
- **De-numbering the implement-feature convention** — already filed as issue #26; a good candidate to
  dogfood the new evaluate skill against.
- **Considered and declined by the maintainer this cycle:** cross-bundle link-integrity test coverage
  (low value); hardening the evaluator justification channel to structured-only (low-probability,
  disclosed residual with a usefulness tradeoff). Left as documented residuals rather than tracked work.
