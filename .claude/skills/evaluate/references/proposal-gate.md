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
`evaluator` via `Read`/`Grep`/`Glob`** over the trusted working tree — the `implement-feature` /
`evaluate` coordinator adds **no** new `gh` call, fetch, or dispatch to satisfy grounding: the fixed
action envelope is unchanged, and "existing issue/plan tracking" means in-repo `doc/plan/`,
`review.md`, not a live GitHub query. As `evaluation-engine.md` §"The evidence-anchor contract" spells
out, these are on-disk working-tree records for the current run (`doc/plan/` is gitignored run scratch,
not durable committed history); durable cross-feature tracking lives in GitHub Issues, which this
filesystem-only evaluator does not query. That cross-feature tracking signal, when it is available, is
the **coordinator's** to supply from its own read-only GitHub issue search — entering the gate as a
`github_verified` provenance anchor (per `evaluation-engine.md`'s element-3 enum), never through the
evaluator; the search wiring itself is t05.

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
  `body` ([ticket-creation.md](../../implement-feature/references/ticket-creation.md), the FILE step)
  ingests only the feature scope, never a self-grade.
- **Phase 8 (gate) filed findings** — a **surfaced** finding is filed as its **own separate issue**, so
  the same block appears **both** in the in-session pick presentation the human chooses from **and**, if
  the user chooses to file that finding, **embedded in that finding's filed body under a
  clearly-delimited `## Evaluation` heading**. Embedding is intended here: a filed finding is a
  standalone issue, **never** re-read as the current feature's WHAT/WHY scope, and the delimiter keeps
  the finding's own ask and its assessment visibly separate in the body. The surfaced assessment
  supports a **lean pick-list** presentation — the disposition plus only the **decision-flipping**
  anchors — while the **full anchor set travels in the filed `## Evaluation` body**; the exact pick-list
  anchor budget is [ticket-integration.md](../../implement-feature/references/ticket-integration.md)'s
  to set, not restated here. A **material-disagreement line** (`**Reviewers split (<axis>):** …`, per
  `evaluation-engine.md`'s disagreement-disclosure rule) **rides the lean pick-list too**, not only the
  filed body — it is **decision-flipping by definition**, so whoever chooses from the in-session
  pick-list still sees that the reviewers disagreed. **Provenance rides this same split** (per
  `evaluation-engine.md`'s element-3 render): compact provenance cues on the load-bearing Reasoning
  claims in the lean pick-list, the full per-item provenance in the filed `## Evaluation` body — the
  `**Evidence:**` block itself always carries **verified classes only**.

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
  [ticket-integration.md](../../implement-feature/references/ticket-integration.md) (Per-phase ticket
  hooks → Phase 8). It **gates** the machine-surfaced findings: **clear slop is dropped**, but with a
  **one-line tally that also says the dropped findings remain in `review.md`** so nothing is lost (e.g.
  "(N low-value findings not offered — they remain in review.md)"). The tally is an **in-flow lever, not
  just a pointer**: a maintainer who disagrees with the gate can **ask to see the gate-dropped
  findings**, and the coordinator **surfaces them into the pick-list on request** (they stay in
  `review.md` as the durable record either way). Borderline-and-above findings are **surfaced with the
  assessment embedded** and the existing **per-item user choice preserved** — the gate only ever
  **subtracts clear slop, never adds**, and never hard-drops a borderline finding the user might still
  want.
- **Phase 1 ticket-creation offer** —
  [ticket-creation.md](../../implement-feature/references/ticket-creation.md). proposal-gate **only
  annotates**: it rates whether the human's just-converged scope looks valuable and the assessment is
  presented **in-session**, inside the create-offer exchange the human sees ("before I file, my read on
  the value is …; still want it filed as written?"). It is **not** embedded in the filed issue body —
  that public body stays WHAT/WHY only. It **must not suppress** the offer — the human already converged
  on this scope; a "value: low" read on their own feature is never forced onto the public issue against
  their will, and if the score is low the assessment is still **surfaced** in-session (the human may
  still file) — never a silently-vanished offer.
