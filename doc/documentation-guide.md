# Documentation guide

The standard for documentation in this repository: who it is for, where each kind of content
belongs, and how it stays true. Docs-bearing changes are reviewed against this guide.

## 1. Purpose & audience

**PiCC is developed primarily by agents** running the workflows codified in `.claude/skills/`.
Human contributors are the minority. So our docs are **primarily agent-facing**, and that premise
decides every audience and altitude question: a reader is usually a literal-minded agent with a
finite context budget, reading one doc mid-task to make one decision.

Two consequences worth internalizing:

- **Bloat is a cost, not a courtesy.** Every paragraph is paid for out of a reading agent's context
  budget, on every run, forever.
- **Stale text is worse than missing text.** A human skims past an outdated line; an agent acts on
  it.

**The governing principle:** *docs state what is currently true, at the right altitude for their
audience, once.*

The audience premise does not license unreadable prose. Human-facing docs (README, user guide,
CONTRIBUTING) still read as prose for humans — the premise sets *what* we write and how much, not
whether it is well written.

## 2. The documentation map

Where each kind of content belongs. If content fits a lower-altitude surface, it goes there and the
higher-altitude doc **links** to it.

| Surface | Audience | Altitude | Belongs | Does not belong |
|---|---|---|---|---|
| `README.md` | Visitor deciding "what is this, do I want it?" | Highest — pitch + orientation | What PiCC is, the value proposition, quick start, one-line-per-capability feature list, repo layout, links onward | Per-flag/env-var detail, limits and caveats, mechanics, anything that reads like a reference manual |
| `doc/user-guide.md` | A person *running* PiCC on their project | Task-level, operational | Install, auth, running a project, control surface, configuration, security posture, Windows specifics, troubleshooting | How the harness is built internally; the full capability matrix; re-explaining Claude Code itself |
| `doc/architecture.md` | Agent or contributor about to change `src/` | Structural — the map, not the territory | Layering, module responsibilities, turn/data flow, the load-bearing mechanical-fidelity decisions and *why* they are load-bearing | Line-by-line narration of code; per-branch behavior detail that the code and its tests already state |
| `doc/testing.md` | Agent or contributor writing or fixing a test | Decision-guide | The layers, which layer a new test belongs in and why, how to run each lane, the synchronization contracts, how to add an e2e scenario | An inventory of every test file |
| `CONTRIBUTING.md` | A contributor making a change | Procedural, step-by-step | Setup, dev loop, test commands, the guiding principles a change must honor, PR and manual-verification expectations | Architecture explanation, user-facing operation, duplicated test strategy |
| `doc/tui-extension-guide.md` | Agent or contributor building a UI surface on Pi's TUI | Reference — capabilities and boundaries | What Pi's TUI can/cannot do, the rendering contract, the hard boundaries to design around | A changelog of PiCC's own UI; code that belongs in `src/` |
| `doc/pi-integration.md` | Agent or contributor touching a Pi seam | Contract record | The pinned Pi version and Node floor, the Pi APIs PiCC depends on, key seam decisions, churn watchpoints | PiCC-internal design that does not touch a Pi API |
| Code comments (`src/`, `scripts/`, `bin/`; `test/` more lightly — fixture scaffolding may explain itself) | Whoever next edits this code | Local — this decision, right here | The non-obvious *why*; a one-line file/module orientation header; navigational section banners | Anything the code already says; history; ephemeral cross-references |
| `doc/supported-features.md` | Anyone asking "is X supported?" | Exhaustive matrix | Nothing hand-written — generated from `src/registry/capability-registry.ts` | Hand edits of any kind |
| This guide | Anyone writing docs or reviewing a docs-bearing change | Standard, not tutorial | The rule, and the test that decides it | Worked examples beyond the one that makes a rule decidable |

**Out of scope — not swept, not measured against this guide:** `CLAUDE.md` (the project's own
instruction surface), `doc/plan/**` (live working artifacts — a plan folder referring to its own
task ids and section numbers refers to *itself*, which is not an ephemeral reference), `examples/**`
(test fixtures, not documentation — see *Genres*), and prompt docs (*Genres* again). The
*Conventions* below bind **durable** surfaces only.

**This guide describes the repository as it is.** It never describes work in flight: a sentence
about what a pending change *will* do is stale the day that change lands, and this doc is loaded
into a working agent's context by default.

**Placement test:** name the one reader and the one decision they are making. If a paragraph serves
a different reader or a different decision, it belongs in a different doc — as a link. And each
audience's entry doc (README for a visitor, CONTRIBUTING for a contributor) links onward to every doc
that audience needs: "link, don't copy" only works where the link exists.

### Proportional scope

First check only existing claims affected by the planned or realized behavior, and repair any that
became false, stale, or misleading. If none needs repair, **no durable documentation change** is a
valid result. If repairs are required, make them, but presume no optional additions beyond them.
For optional additions, start with the smallest sufficient set. For every proposed durable surface,
name its reader, the necessary decision it enables, why existing sources are insufficient, and why
this is the smallest sufficient placement.

Then apply the set-level removal test to every proposed durable surface and every separable proposed
content unit within a retained surface: remove it and ask whether a named reader can still make the
necessary decision. If so, leave it out. Any optional surface or content unit that remains despite
failing this test is aggregate excess and **MUST-FIX**, even when each statement is true and correctly
placed. Mechanically generated output and retained non-obvious rationale are not optional; the genre
rules below decide when they are required.

## 3. Quality standards

- **Truth over completeness.** A short, true doc beats a thorough, half-stale one. When you cannot
  keep a detail current, delete it rather than let it rot. Truth is judged in context: an omission
  that is locally true still misleads when an adjacent strong claim ("runs unchanged", "never a
  silent empty success") implies the missing case away. Qualify the claim or state the case.
- **Verify, don't transcribe — a preserved claim is your claim.** Carrying a claim over, restating
  it, or being *told* to preserve it makes you its author: check it against the code first. Docs here
  have shipped false the morning they merged; having the evidence is not the same as reconciling it.
- **A generalized rule states its exceptions.** "A new tool goes in `tools/`" is false for five of
  them; "the hook events carry the full contract" is false for the five that never fire. A rule
  silently false across part of its range misdirects worse than no rule: state the range, or do not
  state the rule.
- **Never enumerate a set the code owns.** A count, a member list, or an inventory of anything that
  changes without touching the doc rots on the next commit — every test file, a grep tally, "13 hook
  events", "5 never fired". State the shape of the answer and link to the source. Tier *groupings*
  are shape and are licensed; their counts and members are not.
- **Right altitude.** Match the map above. Detail that has sunk one level below its surface's
  altitude is bloat even when every word is true.
- **Single source of truth — link, don't copy.** Copied facts are the specific drift that rotted
  these docs: the copy is never updated with the original. What may never be duplicated is a
  *decision* — the same mechanism may be stated on two surfaces when each serves a different reader's
  decision (Git Bash as *what a user installs* and as *why a contributor must not delete the lookup*
  are two decisions, not a duplication). Run the placement test to tell the cases apart. **The rule
  binds itself:** a rule of this guide copied into an enforcer's prompt is a second source, and it
  drifts.
- **Concision.** Prefer the shortest form that stays true. Cut hedges, restatements, and history
  ("previously…", "note that…", "it is worth mentioning").
- **The discipline of omission.** Knowing what *not* to write is half the job. The canonical case
  from this repo: the user guide's **"What is and isn't supported"** section re-litigated every
  `partial` tier's exact limits, timing caveats, and upstream evidence — content that belongs in the
  capability registry's notes and the generated matrix. Nothing in it was false. The detail was
  simply written at the wrong altitude, and the right fix is deletion, not rewording.

## 4. Genres and their different rules

Documentation is not one thing. Each genre has its own rules; do not apply one genre's norms to
another.

### Human prose (`README.md`, `CONTRIBUTING.md`, `doc/*.md`)

The main subject of this guide. *The documentation map*, *Quality standards*, and *Conventions*
apply in full.

### Code comments

**Comment only the non-obvious — above all, the *why* behind an unusual choice.** Add a comment only
when that local rationale is necessary and not evident from the code. Proportional scope can reject a
new comment, but it cannot justify removing existing load-bearing rationale, comment-shaped
directives, or syntax. The reviewer's checklist, applied comment by comment:

1. **Does it restate the code?** Delete. `// increment i` and `/** Returns the name. */` on
   `getName()` are noise.
2. **Does it explain *why*, and is that why non-obvious?** Keep. This is the comment that earns its
   place: the constraint, the rejected alternative, the upstream bug being worked around, the reason
   the obvious thing does not work here.
3. **Does it carry an ephemeral cross-reference?** Strip the reference (see *Conventions*). If the
   comment is only a pointer, delete the comment.
4. **Does it document history or a migration?** Delete — git holds history. Comments help someone
   *working on* the code now, not someone reconstructing how it got here.
5. **Is it a stale claim?** A comment contradicting the code is a bug; fix or delete it.
6. **Is it a file/module orientation header?** Keep it — a one-line "what this file is" header is a
   legitimate genre, not a restatement. Strip any ephemeral ref *from* it rather than deleting the
   header with the ref: `// Hook execution engine (plan §4.5, research 02 §3.4–3.6)` →
   `// Hook execution engine`. The same holds for **divider/section banners**
   (`// ---- Fixture builders ----`): they are navigational, not explanatory, and they stay.
7. **Is it comment-shaped syntax rather than prose?** `eslint-disable` and directive pragmas
   (`@ts-expect-error`, coverage ignores) are code. So is anything comment-shaped **inside a string,
   regex, URL, or escape** — `//` in `https://`, a `*\/` escape that keeps a JSDoc block from
   terminating early, a `.mjs` shebang, an asserted substring in `expect(...)`. Never touch any of
   it as prose; removing one is a behavior change, and no lint or type gate in this repo catches it.

**In a removal-first pass the burden runs in both directions.** Over-removal is a defect, not a
bonus: a deleted non-obvious *why* is unrecoverable from the code by definition, and it costs the
next reader far more than a surplus line costs a reading agent. Default to removal **for low-value
comments** — the restatement, the decoration, the ceremonial JSDoc. That tie-breaker does *not*
apply to a comment whose value is contested: if a reviewer can articulate what would be lost, the
comment stays and the burden is on the remover.

### Prompt docs (`.claude/agents/**`, `.claude/skills/**`)

These are **program text for a model**, not prose. They are dense, imperative, deliberately
repetitive where repetition changes behavior, and tuned by observing what the model actually does.
**They are not held to prose norms** and are not swept for concision. Change them only with a
behavioral reason, and expect to verify the behavior.

### Generated docs (`doc/supported-features.md`)

A capability registry entry is support truth, not feature bookkeeping. Anti-drift investigation
determines factually whether behavior changed required tier or note truth; when it did, repair the
registry and **regenerate, never hand-edit** `doc/supported-features.md` with
`npm run gen:capabilities`. Discretionary explanatory detail in registry inputs must pass
*Proportional scope*; proportionality never permits required registry repair or regeneration to be
skipped. A hand edit is a defect — it is silently reverted by the next regeneration and, until then,
lies about behavior.

### Test fixtures (`examples/**`)

**Not documentation.** They are crafted to exercise parser and loader edge cases, and tests assert
on their exact content. Do not "improve" their wording, formatting, or apparent mistakes — the
mistakes are usually the point.

## 5. Agent-required reading

Some docs are **required reading** for specific agents, declared in the agent's own prompt. Two
flavors:

- **Unconditional** — the agent reads it on every task, because it cannot do its job without the
  frame (e.g. architecture for an agent that writes or reviews `src/`).
- **Task-triggered** — the agent reads it only when the task touches that surface (e.g. the TUI
  guide before UI work, the Pi integration record before touching a Pi seam).

A doc in this category carries a heavier obligation: it is loaded into a working agent's context by
default, so bloat in it is multiplied across every run, and a stale line in it is direction.

**Agents are kept deliberately heterogeneous.** Different required reading means different
viewpoints on a review panel — that diversity is a feature, not an inconsistency to be tidied up.
Adding a doc to an agent's required reading is therefore a deliberate act with a stated reason, not
a default: it costs context on every run and it erodes viewpoint diversity. Prefer task-triggered
over unconditional, and prefer *one* agent over *all* agents.

## 6. Conventions

### Reference by topic, never by bare number

**Point at things by name, because names survive edits and numbers tell the reader nothing.** A
pointer the reader must resolve before knowing what it even concerns is not carrying information —
it is a homework assignment. State the topic; the number is *corroboration*, never the payload.

One rule, three familiar cases:

| Instead of | Write |
|---|---|
| *see `tui-extension-guide.md` §3.2* | *see "Tool rendering (the workhorse)" in `doc/tui-extension-guide.md`* — quote the heading as it actually reads |
| `subagents.ts:412` | the file + symbol: `dispatch()` in `src/runtime/subagents.ts` |
| `// #26944:` or `// Feature 25 / #48:` | the claim, with the number behind it: `// Claude Code drops HTML comments in CLAUDE.md (anthropics/claude-code#26944)` |

**The test:** can you name the target — heading, symbol, or claim — in something that exists? Then
write that name and keep the number as evidence. If you cannot, the pointer goes.

**This binds intra-doc pointers too: a bare `§` aimed at a sibling section is banned.** The very
edits this guide encourages renumber headings, and an agent reading one *chunk* of a doc has no
numbering in context — name the section. The carve-out is narrow, and the distinction is the point:
it is for numbers that **are** the contract (a skill's own numbered report sections, `§A + §B`),
never for a pointer that merely happens to be intra-doc.

**Applied to issue refs, this decides the internal-vs-upstream question without knowing anyone's
issue range** — judge evidence by kind, not by syntax. A bare number fails whoever owns it: strip it.
But an upstream issue number, an upstream **version**, or a **dated observation** that *justifies a
parity choice* is the load-bearing part of the comment — keep it, in code as much as in prose, and
when it arrives as a bare number the fix is to **add the topic, not delete the citation**.
Version-shaped evidence (`Claude Code 2.1.205 flips the status synchronously`) is the common form in
`src/` and already carries its own topic: a worked example of the rule, not an exception to it. The
ban on restating a *tier claim* governs prose, not the evidence in the code that depends on it.

### No ephemeral cross-references

Pointers into things that move, vanish, or were never durable rot, and a literal-minded reader
follows them into a wall. Banned on every durable surface — prose, code comments, commit-adjacent
text (but not in the working artifacts the map puts out of scope): `plan §N` and research-note
numbers; `feature.md §N`, `F`-numbers, plan task ids; and **any project-internal work-item code** —
`Feature NN`, `FIX N`, `audit XN`, `plan-review`. If a token only means something to someone holding
this repo's working papers, it rots. Naming the topic does not rescue these: the target itself is
ephemeral.

**Rephrase, don't blanket-delete.** Usually the reference is decoration on a statement that stands
on its own: drop the pointer and keep the sentence. If the pointer is the only content, the text was
not carrying information.

### Terminology

Canonical spellings, used consistently: **PiCC** (this harness), **Pi** (the base harness we extend,
an npm dependency), **Claude Code** (the upstream product we are compatible with). Not "picc",
"PICC", or "Claude-Code". Say **subagent** (one word), **capability registry**, **completeness
floor**, **mechanical fidelity** — the terms the code and prompts already use.

Never describe PiCC as a **fork** of Pi — it is an extension, and the distinction is load-bearing.
That bans the one claim, not the word: `subagent_type: "fork"`, `tool.Agent.fork`, a skill's
`context: fork`, and "not a fork of Pi's renderer" are all correct usage.

## 7. Anti-drift

The guard that keeps the docs good after this sweep:

- **Repair invalidated claims in the same change.** When behavior makes existing documentation false,
  stale, or misleading, repair it now — not in a follow-up or ticket. A behavior change does not by
  itself require a durable addition; apply *Proportional scope* after the anti-drift check.
- **The capability registry is the single source for the feature matrix.** New or changed support
  claims go there (see *Generated docs*). Prose may carry the shape of the answer — the tier
  groupings — and a link; never a tier claim, a count, or a member list (see *Never enumerate a set
  the code owns*).
- **The docs agent enforces this guide in review.** It reads the guide, and it is on the review panel
  for any documentation-bearing change — including code comments. Severity mapping:

| Severity | Applies to |
|---|---|
| **MUST-FIX** | False or stale statements — including a claim generalized past its exceptions, and a true one an adjacent strong claim renders misleading; aggregate excess under *Proportional scope*; **a removed comment whose rationale is not recoverable from the code** (a lost non-obvious *why*); prose at the wrong altitude for its surface; a hand-edited generated file; a lost tool directive or comment-shaped syntax |
| **SHOULD** | Duplication of another doc's content instead of a link; an enumeration (count, member list, inventory) of a set the code owns; ephemeral cross-references; bare-number references that never name their topic, intra-doc `§`-refs included; terminology drift; a comment that restates the code; a history/migration comment |
| **NIT** | Wording, ordering, formatting polish |

**The altitude row is scoped to prose.** A code comment that merely restates the code is the SHOULD
row, not the MUST-FIX altitude row — otherwise the same comment gets tiered two ways by two
reviewers. Wrong *altitude* is a placement failure on a prose surface; a restatement is comment
noise. Style never blocks.
