# proposal-gate — score a would-be (not-yet-filed) issue, with zero GitHub writes

This is the proposal-gate mode of `evaluate`. It rates a proposal that **does not yet exist on
GitHub** — a would-be issue — against the shared rubric and returns an assessment. It is
**agent-invoked** (not a human `/evaluate <target>` route): `implement-feature` calls it at two points
(Phase 8 findings, Phase 1 converged feature — see the wiring section). It consumes the two shared
references and does not restate them:

- the rubric and the canonical rating block live in [evaluation-engine.md](evaluation-engine.md);
- the L1 maliciousness screen and the closed-output discipline it models are in the same engine file.

**The one-line invariant of this whole mode: proposal-gate performs _no_ GitHub write of any kind —
no close, no comment, no create.** There is **no `<N>` and no target** to write to: the proposal is
not-yet-filed. This is not a promise made in prose — it is **structural**: proposal-gate runs as the
shell-free [`evaluator`](../../../agents/evaluator.md) sandbox agent (`tools: Read, Grep, Glob` — no
Bash, no Write, no Agent), which *physically cannot* write to GitHub, fetch a link, or fan out.
`gh issue close` is **never** part of this mode; neither is any comment or `gh issue create` (the
create, when it happens, is `implement-feature`'s own consented write, not proposal-gate's).

## The lightweight path — fewer reviewers, never less grounding

proposal-gate is deliberately the **light** form of the engine's investigation wave. **Light means
_fewer reviewers_, never _less grounding_.** It does **not** fan out the full roaster / pro-advocate /
con-advocate / lens committee: a fork-under-fork committee per candidate is expensive and, under the
background-dispatch pool, risks a deadlock (the parity finding). What it never trims is the engine's
grounding requirement — the F21 failure this fix targets (a value score returned in seconds with **zero
tool calls**, read purely from proposal prose) is exactly what the light path must now refuse. Instead:

- The coordinator dispatches a **single `evaluator`** sandbox agent, role-prompted with the rubric and
  the proposal text, and **requires it to investigate the project first** — architecture, source, tests,
  docs, and existing in-repo issue/plan tracking, via its `Read`/`Grep`/`Glob` tools — **before** it
  scores the seven criteria and integrates a verdict. Its input is therefore **the proposal plus project
  evidence**, never the proposal prose alone. A score from the supplied prose alone is permitted **only**
  with the engine's explicit one-line justification that no project evidence is relevant (per
  [evaluation-engine.md](evaluation-engine.md)'s grounding contract) — never as the default.
- A **genuinely borderline _or higher-stakes_** candidate — one whose integrated cost-vs-benefit sits
  close to the line between clear slop and clear keep, or whose blast radius / vision-conflict makes a
  wrong call costly — may earn a **second `evaluator` pass** (a lean roaster / pro-con framing supplied
  in the dispatch prompt) to pressure-test the verdict. There is **no time quota and no mandatory
  committee for trivial** proposals: a clear-cut candidate needs only the single grounded sandbox score,
  and the second pass is proportionate, not owed. That second pass is **always another `evaluator`** —
  **never** a Bash-capable `generalist` — and **inherits the same grounding requirement** (it
  investigates the project too; it never re-rates from prose). So the mode stays structurally shell-free
  **and grounded** end to end.

**Grounding is the evaluator's filesystem job.** The required investigation is performed **by the
`evaluator` via `Read`/`Grep`/`Glob`** over the trusted working tree — and **for grounding the
coordinator adds no new `gh` call, fetch, or dispatch**: the evaluator grounds its score entirely from
the filesystem, and "existing issue/plan tracking" means in-repo `doc/plan/`, `review.md`, not a live
GitHub query. Scope that "no new `gh` for grounding" guarantee precisely to the **evaluator/sandbox
grounding** — the coordinator's separate read-only advisory issue search (below) is **not part of the
evaluator's grounding**; it is a distinct, coordinator-supplied *non-grounding* input, and it is a
*read* that adds no write, so the fixed action envelope is unchanged. Two layers, kept truthful: the
`evaluator` **sandbox** is zero-network (structural, tool-enforced); the **coordinator** already
performs all `gh` I/O, so its search is a **new instance of an existing role, never a new capability
class** — never call the skill as a whole "zero-network". As `evaluation-engine.md` §"The
evidence-anchor contract" spells out, these grounding records are on-disk working-tree records for the
current run (`doc/plan/` is gitignored run scratch, not durable committed history); durable
cross-feature tracking requires either a newly filed user-approved GitHub issue or an existing issue
the user explicitly confirms as equivalent and the workflow reuses under Rule 9. This filesystem-only evaluator
does not query GitHub. A coordinator-supplied candidate near-match or search hit is only an advisory
`github_verified` provenance anchor, never durable tracking by itself; see "The advisory cross-feature
issue search" below.

## The advisory cross-feature issue search — coordinator-run, read-only

The evaluator is filesystem-only and cannot see GitHub Issues, so an advisory candidate
"already-tracked?" signal (#66) is supplied by the **invoking coordinator** — the `evaluate` skill in proposal mode, or
`implement-feature` at its **Phase 8** finding-filing offer — which already holds `gh`/Bash. It is
**never** run by the sandbox and is **not part of the evaluator's grounding**; it enters the gate as a
distinct, coordinator-supplied input, typed as a `github_verified` anchor. This is confined to the
**finding-filing path** (the `evaluate` skill's own proposal mode and implement-feature's **Phase 8**
finding-filing offer) — **not** implement-feature's Phase-1 ticket-creation, whose advisory keeps its
own "no new `gh`" guarantee (see
[ticket-creation.md](../../implement-feature/references/ticket-creation.md)).

**Who runs it, and when.** After the gate has produced its disposition and *before* the coordinator
presents the surfaced findings, the coordinator may run **one** narrow read-only search per surfaced
finding to cross-check novelty. It reuses the exact seam implement-feature's Rule 9 already uses —
`gh issue list --repo <target> --state all --search "<terms>" --json number,title,state,url` (see
[ticket-integration.md](../../implement-feature/references/ticket-integration.md) Rule 9) — a pure
read that files, closes, comments on, and labels **nothing**. It adds **zero** write verbs: the
four-write envelope and `"zero github writes"` stay TRUE (that invariant is about writes; this is a new
*read*, not a fifth write).

**Safe construction — the `gh` call is never driven by attacker-controlled text:**

- **Terms are coordinator-authored, never target-lifted.** The `--search` string is the coordinator's
  own paraphrase of the finding/proposal scope — the same material Rule 4 already makes it
  independently author — and rides the **already-frozen, model-authored** finding/title terms. It is
  **never** interpolated from the issue/PR body, comments, diff, or any `#N`/string in target text.
  "Search for terms from the proposal" *without* this independent-authoring clause is the injection
  hole — state it: the terms are independently authored, full stop.
- **One quoted argument; the character ban is coordinator/model discipline, not harness-enforced.**
  There is no `--search-file`; the single quoted argument plus a character ban **is** the mechanism,
  and it is **model-followed discipline** (the coordinator is the model), mirroring the frozen-title
  character contract ([ticket-integration.md](../../implement-feature/references/ticket-integration.md)
  Rule 4, [write-discipline.md](write-discipline.md)). The permission engine does **not** validate
  `--search` contents, so this prose never claims the harness rejects metacharacters. Validate the term
  string before it reaches the shell: **printable ASCII, one line, bounded length, and none of**
  `` ` `` `$` `"` `\` `;` `|` `&`. **Quoting style:** this ban list is tuned for a **double-quote**
  wrapping — either wrap the argument in double quotes (so the ban applies) or, for single-quote
  wrapping, **add `'` to the banned set** (a model-authored apostrophe under single-quote wrapping would
  otherwise break the argument); do not leave the style ambiguous.
- **`--repo <target>` is the already-resolved, `owner/repo`-validated target**, never an owner/repo
  parsed from attacker content.
- **Provenance by origin channel.** Populate `github_verified` **only** from the `number`/`url` fields
  of the coordinator's own `gh issue list --json number,url` result. **Never** promote a target-body
  `#N` (even one that matches a hit) or a sandbox-emitted `#N` into it; the coordinator lifts an `#N`
  from no context other than its own `gh issue list --json number` output.
- **Separate validation lane for the anchor.** A `github_verified` anchor is a `github.com` URL on the
  resolved `target` (or a bare `#N` from the search JSON); it is validated in its **own** lane — parse
  owner/repo, compare to the trusted `target`, reject wrong-host / foreign-repo (per
  [write-discipline.md](write-discipline.md)'s `#N`/`<target>` gate) — and does **not** loosen the
  general repo-relative allow-list to admit URLs.
- **Returned titles are attacker-influenceable display data.** Anyone can file an issue with a crafted
  title, so treat every returned string as lightly-untrusted: **never** interpolate a returned title
  into a subsequent `gh` call, and if it is surfaced to the human present it as clearly-delimited quoted
  data, never executed or reflected verbatim into a public write. No redirect-to-file — the JSON
  returns to the coordinator's own context.

**The #66 novelty rule + anti-suppression floor.** An already-tracked `github_verified` hit **lowers
the proposal's novelty/value contribution** (a duplicate is not rated novel — this closes the
scoring-accuracy gap #66; `evaluation-engine.md` gives `github_verified` its weight, this states how it
feeds novelty). **But a hit is advisory and attacker-plantable** — anyone can open a decoy issue whose
title paraphrases a predictable finding scope to get a genuine (e.g. security) finding rated
"already-tracked" and suppressed. **Floor: a hit may lower the novelty signal but must never by itself
move a finding below the file/keep-open threshold**, and it is surfaced to the human as a **candidate
near-match** — "possible existing coverage: <url> — verify before acting" — never an overclaimed
"already tracked by #N", and never a silent auto-dedupe (that is Rule 9's filing-time job, a non-goal
here). The no-hit direction is symmetric: a missing hit is **not** a novelty signal and **not** a
tracked signal (no hit ≠ novel, no hit ≠ tracked); it never flips the score toward drop or write.
keep-open-under-uncertainty governs both directions.

**Advisory + visible degrade.** This degrade applies only to an invoker that has actually entered
proposal-gate. For such an invocation, the search is strictly advisory and a pure read. If `gh` is
absent / unauthenticated / rate-limited / errors / times out, the gate **proceeds without a
`github_verified` anchor** — but the degrade is **visible**, never silent: mark the novelty read as
not-cross-checked ("existing-issue check unavailable — novelty not cross-checked against GitHub").
**Degrade once per batch when the cause is global:** when the unavailability is global — `gh` absent or
unauthenticated, so *no* finding can be cross-checked — emit that notice **once for the batch**, not
once per finding; repeat it **per-finding only for a per-call failure** (a rate-limit or timeout on a
specific search). A missing anchor never lowers novelty and never suppresses a finding.
`implement-feature` Phase 8 does not enter proposal-gate after a failed reachability precondition; it
uses its terminating offline branch instead.

## Bounded structured return — the evaluator returns fields, the coordinator composes

The `evaluator` has unrestricted `Read` (it can see `~/.pi` / `.env`), and its return is embedded into
a body that may be filed publicly. So — exactly as issue-eval's keep-open and pr-eval's assessment do
— the evaluator returns the engine's **locked bounded reviewer return** (defined once in
`evaluation-engine.md` §"The locked bounded reviewer return"), not free-form prose. Sized to the gate,
its **four fixed parts** — per-criterion scores, a short justification per row, the overall importance
verdict, and bounded evidence anchors — render as:

- **per-criterion scores** (the seven rubric rows) + a **short bounded justification** per row, each
  carrying the provenance marker the engine's locked schema binds to the justification field,
- an **overall importance verdict** integrating cost-vs-benefit into the disposition
  (drop / surface for the gate use; annotate for Phase 1), and
- **bounded evidence anchors** — the repo-relative, bounded locators the score rests on, in the engine's
  `**Evidence:**` shape (`<repo-relative locator> — <what it establishes> (<criterion>)`, 0–5 items,
  forward-slashed, **never** a target excerpt or file/line contents). Zero anchors is legal only with the
  engine's one-line "No project evidence — <reason>" note in place of the list.

The **coordinator composes** the rendered assessment from those fields, **paraphrasing in its own
words**, applying leakage-stripping (no tokens / env / `~/.pi` / absolute local paths) and
**no-verbatim-reflection** (it never pastes the evaluator's returned text verbatim, and quotes no
verbatim excerpt of the proposal beyond neutral identifiers). For the anchors specifically, the
coordinator additionally applies the **anchor re-validation of engine element 7** — the allow-list
re-check, rejecting any absolute / `..` / outside-repo / secret-file locator, stripping any content bytes
from the whole item (including the free-text "what it establishes" phrase), normalizing to
repo-root-relative, capping the list at ≤5 (truncating any over-count return), and treating each anchor
as a display-only string it **never re-opens or resolves** (engine element 7 remains the authoritative
list — this restatement is illustrative and must not drift from it). That re-validation is **strictly
stronger than** — not the same as — the existing per-criterion leakage-strip; the coordinator applies
**both** and never equates them. A prompt injection buried in a proposal can at most colour a score; it cannot smuggle
an instruction or a secret into a filed body, because the evaluator's output surface is bounded and the
coordinator re-authors it.

## The rendered assessment — the canonical rating block

The assessment renders the engine's **canonical rating block** — the seven criteria rows
(User value / Reach / Legitimacy / Clarity / Blast radius / Conflict / Cost-vs-benefit) each with a
rating and short reasoning, its **direction** folded into the criterion label in plain language
(`higher is better` / `lower is better`, so mixed-direction rows like Blast radius are never mis-read),
the **overall-importance** line carrying the integrated verdict and the
disposition it drives, and — as a sibling below that line, **not** an eighth rubric row — the
**`**Evidence:**`** block enumerating the bounded, repo-relative anchors the rating rests on, each in the
engine's `<repo-relative locator> — <what it establishes> (<criterion>)` shape (or the single
"No project evidence — <reason>" line when there are none). This gives the human enough to judge
importance without re-deriving it — more than a one-line stamp. The **proportionate / brief-verdict** allowance — a short verdict instead of the
full seven-row table — is for **trivial keep-opens only** (issue-eval's territory); every **surfaced**
(borderline-or-above) proposal-gate finding always carries the fuller rating, enough for the human to
judge its importance, and is **never** reduced to a one-line stamp.

Where the assessment lands depends on the use — and, critically, it is **never baked into the Phase 1
filed feature body**:

- **Phase 1 (annotate)** — the assessment is presented **in-session**, inside the create-offer exchange
  the human sees, as an advisory ("before I file, my read on the value is: <the rating block>; still
  want it filed as written?"). It is **not** embedded in the issue body that gets filed: that public
  body stays WHAT/WHY only, so `implement-feature`'s Phase 3 resume re-read of the synthesized cached
  `body` ([phase-3-ticket-file.md](../../implement-feature/references/phase-3-ticket-file.md), the FILE step)
  ingests only the feature scope, never a self-grade.
- **Phase 8 (gate) filed findings** — a **surfaced** finding is filed as its **own separate issue**, so
  the same block appears **both** in the in-session pick presentation the human chooses from **and**, if
  the user chooses to file that finding, **embedded in that finding's filed body under a
  clearly-delimited `## Evaluation` heading**. Embedding is intended here: a filed finding is a
  standalone issue, **never** re-read as the current feature's WHAT/WHY scope, and the delimiter keeps
  the finding's own ask and its assessment visibly separate in the body. The surfaced assessment
  supports a **lean pick-list** presentation — the disposition plus only the **decision-flipping**
  anchors — while the **full anchor set travels in the filed `## Evaluation` body**; the exact pick-list
  anchor budget is [phase-8-file-finding.md](../../implement-feature/references/phase-8-file-finding.md)'s
  to set, not restated here. A **material-disagreement line** (`**Reviewers split (<axis>):** …`, per
  `evaluation-engine.md`'s disagreement-disclosure rule) **rides the lean pick-list too**, not only the
  filed body — it is **decision-flipping by definition**, so whoever chooses from the in-session
  pick-list still sees that the reviewers disagreed. **Provenance rides this same split** (per
  `evaluation-engine.md`'s element-3 render): the lean pick-list has **no Reasoning column**, so its
  compact provenance cue attaches to the **decision-flipping anchor(s)** and/or the **disposition line**
  (the rating-derived surfaces actually present), while the full per-Reasoning-claim provenance lives in
  the filed `## Evaluation` body's rendered block — the `**Evidence:**` block itself always carries
  **verified classes only**.

**Fixed per-item line order in the pick-list — so N stacked findings stay uniform and scannable.** Each
surfaced finding renders in this fixed order, top to bottom: (1) **headline**, (2) **elaboration**,
(3) **disposition + 1–2 decision-flipping anchors**, then any of the conditional **riders** in this
order — (4a) **Reviewers-split** line, (4b) **Possible existing coverage** candidate line, (4c) the
**per-call existing-issue-check-unavailable** degrade line. A rider is present only when its condition
fires (per the engine skeleton's conditional siblings); when present it always occupies this slot, so
stacked findings line up column-for-column. **One explicit exception to that "always occupies its slot"
rule — the degrade has two cardinalities:** the (4c) slot carries **only the per-call failure** (a
rate-limit or timeout on *this* finding's own search) — a genuine per-item rider. The **global**
unavailability (`gh` absent / unauthenticated, so *no* finding could be cross-checked) is **not**
stamped into each finding's (4c) slot — that would repeat one batch-wide fact N times, contradicting the
"emit once for the batch" rule above. It instead renders **once as a batch-level banner** on a single
line **above the pick-list**, alongside the reachability preamble, **not** inside any finding's block
(the engine skeleton's decide-once placement).

## The disposition — drop / surface (gate) vs. annotate (Phase 1)

proposal-gate applies the same rubric as issue-eval, but its "disposition" is **never a close**. It is
one of:

- **drop** (gate use only) — a **clear-slop** proposal whose integrated cost-vs-benefit is decisively
  negative (low user value **and** low reach **and** high blast radius or direct conflict with the
  project's vision, with no redeeming clarity). This mirrors issue-eval's slop threshold and is
  **deliberately conservative**: when the integration is close to the line, treat it as **borderline**,
  not slop.
- **surface** (gate use) — everything at borderline or above: the assessment is presented with the
  disposition, and the human chooses per item.
- **annotate** (Phase 1) — the proposal is the human's own converged feature; proposal-gate **only
  annotates** it — presenting the assessment **in-session** in the create-offer exchange, **never**
  embedded in the filed body — and **never suppresses** the offer, whatever the score.

## Wiring into `implement-feature`

proposal-gate is called from two `implement-feature` reference files, with **different force**:

- **Phase 8 issue-filing offer** —
  [phase-8-file-finding.md](../../implement-feature/references/phase-8-file-finding.md). When every
  reachability precondition succeeds, it **gates** the machine-surfaced findings: **clear slop is
  dropped**, but with a **one-line tally that says dropped findings remain in `review.md` only as
  run-local staging lost with worktree cleanup and that no durable issue was filed** (e.g. "(N
  low-value findings not offered — they remain in review.md as run-local staging until worktree
  cleanup; no durable issue was filed.)"). The tally is an **in-flow lever, not just a pointer**: a
  maintainer who disagrees with the gate can **ask to see the gate-dropped findings**, and the
  coordinator **surfaces them into the pick-list on request** while the run remains active. Durable
  cross-feature tracking requires either a newly filed user-approved GitHub issue or an existing issue
  the user explicitly confirms as equivalent and the workflow reuses under Rule 9; a candidate near-match alone does
  not qualify. Borderline-and-above findings
  are **surfaced with the assessment embedded** and the existing **per-item user choice preserved** —
  the gate only ever **subtracts clear slop, never adds**, and never hard-drops a borderline finding
  the user might still want. If any reachability precondition fails, do not invoke proposal-gate;
  defer to implement-feature's branch that presents every eligible still-actionable finding
  **UNASSESSED** instead.
- **Phase 1 ticket-creation offer** —
  [ticket-creation.md](../../implement-feature/references/ticket-creation.md). proposal-gate **only
  annotates**: it rates whether the human's just-converged scope looks valuable and the assessment is
  presented **in-session**, inside the create-offer exchange the human sees ("before I file, my read on
  the value is …; still want it filed as written?"). It is **not** embedded in the filed issue body —
  that public body stays WHAT/WHY only. It **must not suppress** the offer — the human already converged
  on this scope; a "value: low" read on their own feature is never forced onto the public issue against
  their will, and if the score is low the assessment is still **surfaced** in-session (the human may
  still file) — never a silently-vanished offer.
