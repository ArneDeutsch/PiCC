# Evaluate skill

Ticket: ArneDeutsch/PiCC#27

## What

A new `evaluate` skill — invocable directly by a human (`/evaluate <target>`) or by another agent —
that rates a GitHub issue, a proposed (not-yet-filed) issue, or a pull request, and drives a
disposition. One shared evaluation engine, three modes:

- **issue-eval** — given an open issue, understand it and act: **confidence-gated close** of clear
  slop (with a canned comment), **keep-open** of everything else with a rating/importance comment,
  biased to keep-open when uncertain. **Consent: it always previews the rating and the exact write it
  proposes, and confirms with the human before any public write (close or comment).** There is no
  unattended/autonomous mode and
  no opt-in token — the human is always in the loop (even when pointing the agent at a pile of issues,
  which is just re-prompting), and the agent asks back whenever something is off.
- **proposal-gate** — given a would-be issue (agent-invoked, structurally **no GitHub writes**),
  score it against the rubric. Used in two places with different force: on `implement-feature`'s
  Phase 8 agent-surfaced findings it **gates** — clear slop is dropped (with a one-line tally so
  nothing vanishes invisibly), the rest surfaced with the assessment embedded and per-item choice
  preserved; on the Phase 1 human-converged feature it **only annotates** — it rates whether the
  requested scope looks valuable and embeds that assessment, but never suppresses the user's own
  offer.
- **pr-eval** — given a pull request, assess the diff and its consequences, whether it fulfils its
  ticket *and* whether the ticket was worth doing, and the verification evidence; then post an
  assessment comment. **Never merges.** It first judges whether the change even *warrants* manual
  verification (a docs-only change, or one fully covered by automated tests, does not) — and only
  when it does and the author's manual-verification comment is missing does it post a comment
  requesting one.

**The evaluation, in every mode**, weighs the target against named criteria and reports its reasoning
in the posted comment: user value, reach (many users vs. esoteric), legitimacy (real bug vs. nitpick;
real improvement vs. cosmetic; plus a slop/malicious screen), clarity (specified well enough to
act on), blast radius (what code is affected, how large, how risky), conflict (does it fight existing
functionality, architecture, or the project's vision), and cost-vs-benefit (the actual keep/close
call — a nitpick with medium/high effort or risk is a close). PR-eval additionally weighs
fulfilment, code consequences, and verification evidence.

**Behaviour changes to `implement-feature`:** its Phase 8 issue-filing offer runs proposal-gate on
each machine-surfaced finding — clear slop is dropped (with a one-line tally), the rest surfaced with
the assessment embedded and per-item choice preserved. Its Phase 1 ticket-creation offer, which files
the human's own just-converged feature, is **not** gated — proposal-gate only annotates it with a
value assessment; the human's offer is never suppressed. And its PR hand-off produces **concrete,
applicability-aware verification guidance** (see below) rather than a generic "verify in the running
app" prompt.

**Contribution guidelines & the verification contract.** Manual verification is required **only where
it matters** — a docs-only change, or one fully and genuinely covered by automated tests, declares
that instead. Where it matters, two distinct artifacts are expected, and the difference is made sharp
so a first-time contributor isn't confused:
- **In the PR description — verification *guidance* (the plan a reviewer follows):** concrete steps —
  which branch to check out, how to launch picc (e.g. against an `examples/` project), exactly what to
  do inside the app to exercise the change or confirm the bug is fixed, and the observable outcome to
  expect. Not a vague "try it out".
- **The manual-verification comment — the author's evidence (a PR comment):** what they actually
  ran by hand and observed, on which OS/shell, and anything they could not verify.

`CONTRIBUTING.md` is tightened to demand this, with a worked example; a new
`.github/pull_request_template.md` surfaces it at PR-open time (including the "fully automated / not
manually verifiable — here's why" escape); and pr-eval enforces it — requesting only the missing
piece, and only when the change warrants it. The same concrete + applicability-aware standard governs
`implement-feature`'s own creation-side guidance. The applicability rule is stated on its own merits:
**a change with no runtime surface to drive (docs, comments) — or one already fully and genuinely
covered by automated tests — has nothing to manually verify**; note the distinction that a
skill/harness/prose change *does* have a runtime surface (picc executing the changed behaviour), so it
is not exempt. This threads with implement-feature's existing hand-off guidance in `handoff.md` for
changes "with no runnable UI".

### Safety (observable guarantees)

- **Fixed action envelope.** The skill's entire set of GitHub writes is: confidence-gated close +
  canned comment, keep-open rating comment, PR assessment comment, verification-request comment. It
  never merges, edits, labels, reopens, locks, or touches anything else. **Honest scope of that
  guarantee:** on the structural surfaces (the screen and proposal-gate) it is absolute — a tool-gated
  agent *cannot* perform those writes. On the coordinator's own path it is bounded by two real
  controls — a defence-in-depth `settings.json` deny floor and the text-is-data discipline — not by an
  absolute technical block, because in PiCC `allow`/`ask` permission rules are no-ops (only `deny` and
  per-agent tool-gating are hard). The deny floor denies the *common* write forms neither skill needs
  (including the common `gh api` write forms) — but a `*`-anywhere matcher can't express "flag in any
  position", so it is best-effort defence-in-depth, not the primary control; `gh issue close` cannot be
  on it (this skill needs it, the engine is shared with `implement-feature`), so its safety rests on the
  confidence gate + the close-invariant below.
- **Structural no-write surfaces.** **Every** agent that ingests attacker-controlled target content —
  the maliciousness **screen**, **proposal-gate**, and all the roaster / pro-con / lens **reviewers** —
  runs as a single dedicated read-only agent with no shell, no write, no fetch, and no dispatch tools,
  so they *cannot* post, close, run a reproducer, fetch a link, or fan out. This is enforced by the
  agent's tool set, not by prose. The Bash-capable coordinator does all `gh` work but **redirects raw
  content to a file it does not read** and points reviewers at that file — so no attacker text ever
  reaches a shell-capable subagent, and none reaches the coordinator either.
- **The coordinator never ingests raw target content.** The privileged coordinator (which holds Bash
  and the write tools) redirects the issue/PR body, comments, and diff to a temp file **without reading
  it**, and resolves only non-body metadata (issue-vs-PR, open/closed) via targeted queries. The
  shell-free `evaluator` reads that file itself and returns only constrained output — the classification
  enum, or a bounded rating in its own words. So the coordinator operates on the evaluator's bounded
  outputs, not on attacker-controlled bytes. Honest split: the evaluator's inability to write/fetch/run
  is **structural** (tool-gated); the coordinator's non-ingestion is a **disciplined redirect**
  (behavioral), resting on the premise that `gh … > file` returns empty stdout to the tool — pending one
  live smoke test before the "quarantine" framing is fully relied on.
- **Malicious input is contained.** The screen classifies the target into a **fixed set of categories
  and nothing else**, so a prompt injection can at most flip the category, never smuggle an
  instruction; parsing is strict and fails to keep-open. A malicious classification closes the issue
  with a **generic template selected by category** that contains **none of the target's text**. Every
  write is bounded by the envelope; the evaluator's returned text is treated as data never instructions;
  no reproducer/link/command from a target is ever run (the reading agent has no shell/fetch to run it
  with); no injected closing-keyword or foreign `#N` reaches a write; and no attacker-authored text is
  reflected into a public comment.
- **Invariant:** a **close always carries the canned comment**; only a **keep-open** ever carries a
  model-authored rating — so attacker text can never ride along with a destructive action.
- **Re-runs are idempotent** — a second evaluation of the same target does not double-post or
  double-close (already-closed / already-commented targets short-circuit).

## Why

Contribution volume is expected to be high and to include valueless slop. A single maintainer needs
to distinguish what should be done from what should not — the existence of a ticket (even one the
maintainer wrote) does not mean it should be implemented. This skill prunes what we don't need, gives
an initial read on what is valuable, keeps low-value issues from being created in the first place, and
raises PR-merge decisions to an evidence-backed assessment — so the maintainer can keep up.

## Acceptance

- A human runs `/evaluate <target>`; the skill auto-detects issue vs PR and routes accordingly — the
  human never picks a mode. It always previews its rating and proposed write and confirms before any
  public write (close or comment); only clear-cut slop/abuse is ever closed; borderline cases are never
  closed.
- An agent can run `evaluate` in proposal-gate mode and get a score with no GitHub write; on
  `implement-feature`, Phase 8 stops surfacing low-value findings (with a tally) while Phase 1
  annotates the human's own converged feature without ever suppressing the offer.
- A human runs `/evaluate` on a PR and gets an assessment comment (never a merge), with a
  verification-request comment only when the change warrants manual verification and the author's
  manual-verification comment is absent.
- A crafted malicious issue/PR cannot make the skill perform any write outside the fixed action
  envelope; the coordinator never ingests its raw content (only the shell-free evaluator does), and its
  text is never reflected into a public comment.
- `CONTRIBUTING.md` and a PR template require and explain the manual-verification expectation.
- typecheck and the full test suite are green.

## Non-goals

- No batch/triage mode and no cron loop — the skill is single-target; volume is handled by running it
  in a loop over many targets.
- Never auto-merge, auto-edit, or auto-label.
- Not a *formal* dual-LLM system, but close in spirit: the coordinator is kept off raw target content
  (redirect-to-file + metadata-only queries) and operates on the evaluator's constrained outputs. The
  residual is that those bounded outputs still reach the coordinator — a much smaller surface than raw
  content, not zero.
- No `src/` changes — confirmed prose-only. The build is: the `evaluate` skill bundle, **one** new
  read-only sandbox agent reused (role-prompted) for the screen, proposal-gate, and every roaster/
  pro-con/lens reviewer — so no new file per role, and no attacker content reaches a shell-capable
  agent; a defence-in-depth `.claude/settings.json` deny floor; the CONTRIBUTING + PR template edits;
  and the proposal-gate/verification wiring into `implement-feature`'s reference files.
- De-numbering the `implement-feature` convention is tracked separately (issue #26), not done here.

## Tasks
- t01 Skill foundation — router, engine, write-discipline, sandbox agent, deny floor, test (depends on: –)
- t02 issue-eval mode (depends on: t01)
- t03 pr-eval mode + canonical verification contract (depends on: t01)
- t04 proposal-gate mode + implement-feature wiring (depends on: t01)
- t05 CONTRIBUTING + PR template + implement-feature creation-side guidance + CHANGELOG (depends on: t01, t03)
