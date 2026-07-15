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

## The lightweight path — one `evaluator`, not the full committee

proposal-gate is deliberately the **light** form of the engine's investigation wave. It does **not**
fan out the full roaster / pro-advocate / con-advocate / lens committee: a fork-under-fork committee
per candidate is expensive and, under the background-dispatch pool, risks a deadlock (the parity
finding). Instead:

- The coordinator dispatches a **single `evaluator`** sandbox agent, role-prompted with the rubric and
  the proposal text, and asks it to score the seven criteria and integrate a verdict.
- A **genuinely borderline** candidate — one whose integrated cost-vs-benefit sits close to the line
  between clear slop and clear keep — may earn a **second `evaluator` pass** (a lean roaster / pro-con
  framing supplied in the dispatch prompt) to break the tie. That second pass is **always another
  `evaluator`** — **never** a Bash-capable `generalist`. So the mode stays structurally shell-free end
  to end; a clear-cut proposal needs only the single sandbox score.

## Bounded structured return — the evaluator returns fields, the coordinator composes

The `evaluator` has unrestricted `Read` (it can see `~/.pi` / `.env`), and its return is embedded into
a body that may be filed publicly. So — exactly as issue-eval's keep-open and pr-eval's assessment do
— **constrain the evaluator's returned shape to bounded structured fields, not free-form prose**:

- **per-criterion scores** (the seven rubric rows) + a **short bounded justification** per row, and
- an **overall importance verdict** integrating cost-vs-benefit into the disposition
  (drop / surface for the gate use; annotate for Phase 1).

The **coordinator composes** the rendered assessment from those fields, **paraphrasing in its own
words**, applying leakage-stripping (no tokens / env / `~/.pi` / absolute local paths) and
**no-verbatim-reflection** (it never pastes the evaluator's returned text verbatim, and quotes no
verbatim excerpt of the proposal beyond neutral identifiers). A prompt injection buried in a proposal
can at most colour a score; it cannot smuggle an instruction or a secret into a filed body, because
the evaluator's output surface is bounded and the coordinator re-authors it.

## The rendered assessment — the canonical rating block

The assessment renders the engine's **canonical rating block** — the seven criteria rows
(User value / Reach / Legitimacy / Clarity / Blast radius / Conflict / Cost-vs-benefit) each with a
rating + short reasoning, and the **overall-importance** line carrying the integrated verdict and the
disposition it drives. This gives the human enough to judge importance without re-deriving it — more
than a one-line stamp. The **proportionate / brief-verdict** allowance — a short verdict instead of the
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
  the finding's own ask and its assessment visibly separate in the body.

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
