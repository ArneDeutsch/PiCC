# t04: Ticket-creation offer on the ticketless path

## Goal
When the skill is invoked with **no** ticket ref and GitHub is reachable, after the Phase 1 scope
mirror converges the coordinator makes an opt-in offer to capture the agreed WHAT/WHY as a GitHub
issue. On acceptance the run **continues as if that ticket had been given from the start**: the issue
is filed once (model-authored ASCII title, body via file), its URL echoed, a durable `Ticket:
<target>#N` anchor persisted, and every downstream ticket-path branch reads a synthesized issue cache.
Declining leaves the ticket dimension as today. Works on both maintainer and fork paths. Adds
`references/ticket-creation.md`.

## Context & seams
Builds on t01 (discipline rules, resident checklist), t02 (resolved identities — the issue is filed
on `target`; on a fork that is the upstream the user doesn't own), and t03 (the fork hand-off, which
this task's fork-cell accept message must promise instead of an auto-PR). New file
`references/ticket-creation.md`; router gets a Phase 1 routing line: *"With no ticket ref and GitHub
reachable, after the scope mirror read [references/ticket-creation.md](references/ticket-creation.md)
and make the offer."*

**Reachability precondition for the offer (make explicit).** The ticketless path has no Phase 0 gate
today. The offer runs the **same preconditions the Phase 8 filing offer uses** — `gh` installed, `gh
auth status` authenticated, a resolvable `target` repo — and if any fails it **silently skips** the
offer (never errors, never nudges the user to install `gh`; they didn't ask for a ticket).

**The offer = a preview, its own exchange, before the build "go" (two distinct yes/nos so "go" is
never read as "yes, file"):**
- Show the exact title (`F<NN>: <short description>`, model-authored ASCII, no shell metacharacters —
  Rule 4) and the exact body (WHAT/WHY from the converged scope + attribution trailer) that **would
  be** filed. Keep the wording **conditional/future** ("here's what I'd file") so the preview never
  reads as a done write. Note `<NN>` is assigned at Phase 2, so the preview may show a placeholder.
- State plainly **where** it writes and that a public artifact appears when it's filed: on a fork name
  the **upstream** `target` and that it's a repo the user doesn't own.
- Genuine choice: no nudge / no default-yes / no re-offer if declined. Declining ≠ losing all tracking
  (the Phase 8 findings offer still stands).

**Timing — consent at Phase 1, FILE at Phase 3 (closes the resume double-file window).** The user
accepts at Phase 1, but the actual `gh issue create` and the anchor write happen together at **Phase 3**
(feature-spec creation), by which point `<NN>`, the worktree, the branch, and `feature.md` all exist.
This keeps the Phase 1 write-contract's "nothing is posted yet" honest, gives a real `F<NN>` title, and
means the anchor is written in the same step as the create — so a resume before Phase 3 has filed
nothing (re-offer is correct), and a resume after Phase 3 finds the anchor (below).

**On the Phase 3 FILE step:**
1. **Rule 9 dedup (mandatory, unconditional on every accept):** before creating, `gh issue list
   --repo <target> --state all --search "<model title>"`. `--search` is keyword-based (not typo-fuzzy),
   so surface only **plausible** near-matches, framed as a reuse choice ("found a possibly-related
   issue — file new, or reuse #M?"), and reuse rather than double-file. This is the sole guard in the
   Phase 1→Phase 3 window (before the anchor exists); the resident anchor reader (below) guards after.
2. Body written with the Write tool to an **OS-temp path outside the worktree**. `gh issue create
   --repo <target> --title "<title>" --body-file <path>`. Echo the new issue URL (Rule 7); body ends
   with the attribution trailer (Rule 8); no leakage (Rule 6).
3. **Synthesize the cached-issue JSON** the reachability gate would have produced —
   `number=N, title=<model title>, body=<the WHAT/WHY just written>, labels=[], state="open", url,
   comments=[]` (include `labels: []` — the gate caches `labels` and Phase 1 reads them; omitting it
   breaks a downstream `labels` read). Set the working ticket ref to `<target>#N`. From here every
   "with a ticket present" branch reads this synthesized cache — no re-fetch.
4. **Persist `Ticket: <target>#N`** into `feature.md` (and add the `Ticket:` field to the `feature.md`
   template in `references/templates.md`, applicable to given tickets too — value `–` when ticketless).

**Resident anchor READER (the missing consumer).** Add to the **always-loaded router** a resume/entry
rule: when reconstructing a resumed/compacted run that re-enters with empty `$ARGUMENTS`, before making
the Phase 1 offer, read the in-progress feature's `feature.md` and inspect its `Ticket:` line:
- **Ticketless test by ref SHAPE, not by a sentinel glyph.** Treat the run as ticketless (→ make the
  offer as normal) unless the value is a **valid ref** — `<owner/repo>#<int>`, `#<int>`, or a GitHub
  issue URL. Any placeholder or blank (`–`, `-`, `—`, empty, missing) is *not* a ref and falls through
  to the offer. Do **not** key on "not exactly `–`": a hand-typed hyphen/em-dash would otherwise be
  misread as a real ref and hijack every ticketless resume.
- **On a valid ref, adopt the ticket path AND re-hydrate the cache.** Adopt that ticket path + target
  repo, and **re-run the gate's read** — `gh issue view <N> --repo <target> --json
  number,title,body,labels,state,url,comments` — to rebuild the issue cache in this session. The
  synthesized `comments: []` from the filing session is stale on resume; Phase 9's comment-idempotency
  scan and Phase 8's close-vs-keep-open both read this cache, so without the re-read a resumed run could
  double-post the hand-off comment. (This applies to given-ticket resumes too, but t04 owns the reader.)
Without this reader the persisted anchor has no effect and the resume-idempotency acceptance is not
delivered.

**Write-contract, routed BY CHECKOUT KIND at the accept step (not a downstream note).** On accept, the
user (who started ticketless) must see the contract that actually applies — decide it at the accept
step:
- **maintainer accept:** "I'll file the issue as I set up the branch/plan (Phase 3), then at hand-off
  open a ready-for-review PR that closes #N and post one comment on #N." (This replaces the stock
  ticket-path line "nothing is posted to #N yet" — that line is written for a *given* ticket; on the
  created path say the issue is filed at setup.)
- **fork accept:** "I'll file the issue on `<target>` as I set up the branch/plan, then at hand-off
  push to your fork and hand you a compare URL + paste-ready PR (and optional comment) — I will post
  nothing *further* to `<target>` automatically." Reconcile the apparent contradiction explicitly: the
  feature issue is the one consented public write on `<target>`; nothing *else* is auto-posted there,
  and the PR is opened by the user (t03 hand-off, **not** an auto-PR).

**Invariant reconciliation — enumerate all three "nothing posted before hand-off" sites.** The claim
appears at Phase 1, Phase 2, and Aborting in the router. With file-at-Phase-3 it stays true through
Phase 2, but once the issue is filed at Phase 3 it is false. Update all three: Phase 1/Phase 2 note the
created-ticket exception ("except the feature issue you approved, filed at Phase 3"); the Aborting text
must **name** an already-filed feature issue (it's public/open) so an abandoned run doesn't claim the
ticket is untouched.

**On DECLINE:** one line ("staying ticketless — nothing filed"), then go. No re-offer later.

**Rule 5:** extend the allow-list (in `references/ticket-integration.md`) to permit this create-offer
write — explicit per-offer user acceptance, authored under Rules 1/4/6/8, target-repo aware. t05 does
the final coherence pass relating this to the Phase 8 filing offer.

## Writable surface
**Post-refactor layout + tight headroom.** The router (`SKILL.md`) is at ~17,370/20,000 chars — only
~2,630 left, shared with t05. Keep resident (router) additions **minimal**: only the small Phase 1
routing line, the resident anchor-**reader** rule, and the one-clause Aborting qualification go
resident; the offer/accept/decline procedure, the checkout-aware write-contract variants, and the
synthesized-cache detail all go in the new `references/ticket-creation.md`. The common Phase 1/Phase 2
procedure lives in `references/workflow-detail.md`; the ticket-path write-contract + per-phase hooks in
`references/ticket-integration.md`. Files:
- `.claude/skills/implement-feature/references/ticket-creation.md` (new — the whole offer flow)
- `.claude/skills/implement-feature/SKILL.md` (resident, minimal: Phase 1 skeleton routing line to
  ticket-creation.md; the resident anchor-**reader** rule in the resume/reconstruction area; the
  one-clause Aborting qualification naming an already-filed created ticket)
- `.claude/skills/implement-feature/references/workflow-detail.md` (Phase 1/Phase 2 "nothing posted
  before hand-off" wording qualified for the created-ticket exception; the Phase 3 FILE step)
- `.claude/skills/implement-feature/references/ticket-integration.md` (Rule 5 create-offer clause; Rule 9 note for the create case; relate to the Phase 8 filing offer)
- `.claude/skills/implement-feature/references/templates.md` (`Ticket:` field in the feature.md template)
- `doc/plan/12-fork-and-ticket-creation/feature.md` (add a `Ticket: –` line to this feature's own spec, for consistency with the new template)

## Approach constraints
- Reuse the existing discipline; do not invent a parallel rule set. The create-offer is the same kind
  of write as the Phase 8 filing offer — t05 finalizes their shared wording.
- The scope-mirror + explicit go still governs; the issue is authored *from* already-converged scope
  (Rule 2's "a ticket cannot self-authorize scope" is preserved by construction).
- Watch the router-size guard: the anchor-reader + accept-step routing add resident prose under the
  hard `≤ REINJECT_PER_SKILL_MAX_CHARS` gate — relocate detail into `references/ticket-creation.md`,
  never cut content.

## Left open
- Exact offer/accept/decline wording (UX drafts are a guide).
- Whether the `Ticket:` anchor sits at the top of feature.md or in a small metadata block (pick one,
  keep it machine-greppable and stable for the resident reader).

## Testing
Prose-only. The t01 guard test now also covers `references/ticket-creation.md` (linked ⇔ exists). No
existing test asserts the exact feature.md template text (docs investigation confirmed), so adding the
`Ticket:` field is safe. Correctness via review against this spec + the security findings (Rule 5
extension, Rule 9 dedup, no leakage, anchor reader present).

## Acceptance criteria
- [ ] Offer runs the Phase-8 reachability preconditions and silently skips on failure; appears after
      the scope mirror as its own exchange; previews exact title+body in conditional wording; separate
      from the build go.
- [ ] Consent at Phase 1; the `gh issue create` + `Ticket:` anchor write happen together at Phase 3;
      Rule 9 keyword dedup runs before create and offers reuse of plausible matches.
- [ ] Synthesized cache includes `labels: []`; working ref set to `<target>#N`; issue filed on
      `target` (upstream on a fork).
- [ ] Resident anchor **reader** added to the router; a post-Phase-3 resume adopts the ticket path
      instead of re-offering.
- [ ] Accept-step write-contract is routed by checkout kind (maintainer PR+comment vs. fork
      compare-URL hand-off) and reconciles the "nothing further posted to `<target>`" wording; all
      three "nothing posted before hand-off" sites + Aborting text updated for the created ticket.
- [ ] Rule 5 extended for the create-offer; decline is one line and not re-offered.
- [ ] typecheck and full test suite green

## Depends on
t01, t02, t03
