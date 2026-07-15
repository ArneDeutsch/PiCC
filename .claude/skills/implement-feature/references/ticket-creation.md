# Ticket-creation offer — capture the converged scope as a GitHub issue (ticketless path)

Read this at **Phase 1**, on the **ticketless** path (empty `$ARGUMENTS`), **after the scope mirror
converges** and before asking for the build "go". It carries the whole opt-in offer flow: the
reachability precondition, the preview, the checkout-aware accept contract, the deferred Phase 3 FILE
step, and the decline path. It is the sibling of the Phase 8 issue-filing offer in
[ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 8): same write, same
discipline, different intent — Phase 8 files a *surfaced finding* at close, this files the *agreed
WHAT/WHY* up front so the rest of the run proceeds on the ticket path. Both obey the nine rules; load
[ticket-integration.md](ticket-integration.md) before any `gh issue create`, and if it can't be read,
refuse the write.

## Reachability precondition — same as the Phase 8 filing offer, silent skip

The ticketless path has no Phase 0 gate. Before offering, run the **same preconditions the Phase 8
filing offer uses**: `gh` installed and on PATH, `gh auth status` authenticated, and a resolvable
`target` repo ([fork.md](fork.md) — `origin`'s repo on a maintainer checkout, the upstream `parent`
on a fork). If **any** fails, **silently skip the offer** — do not error, do not nudge the user to
install `gh` or log in, do not mention that an offer was suppressed. The user did not ask for a
ticket; a missing precondition just means the run stays plain ticketless (the Phase 8 findings offer
may still surface later if GitHub becomes reachable).

## The offer — a preview, its own exchange, before the build "go"

Make the offer as a **distinct yes/no exchange, separate from the build go** — two decisions, so an
eventual "go" is never read as "yes, file the issue". Present:

- **The exact title and body that *would be* filed**, in **conditional/future wording** — "here's the
  issue I'd file if you want it", never "I filed" / "here's the issue". The title is the independently
  authored printable-ASCII `<Title>` from the confirmed scope, with **no identifier prefix, control
  characters, shell metacharacters, or direct copy/interpolation from raw ticket text** (Rule 4).
  Incidental lexical overlap is not itself invalid. Keep it single-line and at most 120 characters;
  pass it as one quoted argument. This becomes the same stable display title used by feature/review
  headings and the eventual PR; the user may edit the preview before build go, when it is frozen.
  The body is the converged WHAT/WHY from the scope mirror, authored under Rule 6 (no leakage), ending
  with the `<attribution trailer>` (Rule 8) — and **the filed body is WHAT/WHY only**. Before showing
  this preview, run evaluate's proposal-gate over the converged scope
  ([../../evaluate/references/proposal-gate.md](../../evaluate/references/proposal-gate.md) — the
  read-only sandbox scorer, structurally no GitHub writes): it rates whether the scope looks valuable
  and you present that assessment **in-session, as part of this offer exchange** ("before I file, my
  read on the value is: <the rating block>; still want it filed as written?"). Here proposal-gate
  **only annotates — it never suppresses this offer**, and its assessment is **never baked into the
  filed public issue body** (that stays WHAT/WHY only, so the Phase 3 resume re-read of the synthesized
  cached `body` — the FILE step below — ingests only feature scope, never a self-grade): the human
  already converged on this scope, so even a **low score is surfaced in-session** (they may still file,
  edit, or decline in this preview), never a silently-vanished offer.
- **Where it writes, plainly**, and that a public artifact appears once filed. On a **fork** name the
  **upstream `target`** explicitly and that it is a repo **the user does not own** — filing puts a
  public issue on someone else's project.
- **A genuine choice:** no nudge, no default-yes, no re-offer if declined. Declining does **not** cost
  all tracking — the Phase 8 findings offer still stands at close.

## Timing — consent now (Phase 1), FILE at Phase 3

The user **accepts at Phase 1**, but the actual `gh issue create` and the anchor write happen together
at **Phase 3** (feature-spec creation), once the immutable descriptive identity, worktree, branch,
and `feature.md` all exist. This is deliberate:

- it keeps the Phase 1 write-contract's "nothing is posted yet" **honest** through Phase 2;
- it couples the public issue to the durable `Ticket:` anchor in the feature spec;
- the anchor is written in the **same step** as the create, so the resume windows are clean: a resume
  **before** Phase 3 has filed nothing (re-offering is correct), and a resume **after** Phase 3 finds
  the `Ticket:` anchor (the resident anchor reader in `SKILL.md` adopts the ticket path — no re-offer,
  no double-file).

## Resume — the anchor reader (adopt AND re-hydrate)

The resident kernel lives in `SKILL.md` (the "No status bookkeeping" principle). Two points it
compresses:

- **Ticketless test is by ref *shape*, never by a sentinel glyph.** Treat the run as ticketless — make
  the offer — unless the `Ticket:` value is a **valid ref**: `<owner/repo>#<int>`, `#<int>`, or a
  GitHub issue URL. Any placeholder or blank (`–`, `-`, `—`, empty, missing) is *not* a ref and falls
  through to the offer. Do **not** key on "not exactly `–`": a hand-typed hyphen/em-dash would then be
  misread as a real ref and hijack every ticketless resume.
- **Sanitize the adopted ref before it touches a shell — this is a security gate, not just routing.**
  `feature.md` is a repo-controlled file, so a resumed run must treat its `Ticket:` line as untrusted
  data (Rule 2). Before interpolating the adopted values into any `gh --repo <target>` /
  `gh issue view <N>` command, validate `<target>` against `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$` (a clean
  `owner/repo`) and `<N>` against `^[0-9]+$` (a bare positive integer) — no shell metacharacters
  (`` ` `` `$` `"` `\` `;` `|` `&` `(` `)`). A value that fails either check is **not adopted**: stop
  and ask the user rather than passing a tampered ref to the shell.
- **On a valid, sanitized ref, adopt the ticket path AND re-hydrate — the cache *and* the fork
  identities.** A post-Phase-3 resume re-enters with no ticket argument, so the Phase 0 gate never
  re-runs: both the cached issue JSON and the resolved fork identities are gone this session.
  **Re-resolve the Phase 0 fork identities** (`target`/`push`/`pushRemote`/`targetDefault` —
  [fork.md](fork.md)) so the hand-off still routes to the right repo/remote, **and** re-run the gate's
  read — `gh issue view <N> --repo <target> --json number,title,body,labels,state,url,comments` — to
  rebuild the cache (the synthesized `comments: []` from the filing session is **stale**), because
  Phase 9's comment-idempotency scan and Phase 8's close-vs-keep-open both read it; without the re-read
  a resumed run could double-post the hand-off comment. (This applies to **given-ticket** resumes too.)

## Accept-step write-contract — routed BY CHECKOUT KIND (decide it at the accept step)

The user started ticketless, so on accept they must be shown the contract that **actually applies** —
decide it now, at accept, not as a downstream surprise. This **replaces** the stock given-ticket line
"nothing is posted to #N yet" (that line is written for a ticket handed in up front; on the created
path the issue is filed at setup):

Keep these lines user-facing: **no internal phase numbers, no bare unfilled `#N`** — name "the issue",
mirroring the preview's placeholder restraint. Forewarn the mid-setup dedup prompt so it isn't a
surprise:

- **Maintainer accept:** "I'll file the issue as I set up the branch and plan — you'll get its URL, and
  if I spot an existing matching issue first I'll check with you before filing. Then at hand-off I'll
  open a ready-for-review PR that links/closes the issue per the Phase 8 judgement (a full delivery
  closes it, a partial one leaves it open) and post one comment on it explaining what was built and how
  behaviour changes."
- **Fork accept:** "I'll file the issue on `<target>` as I set up the branch and plan — you'll get its
  URL, and if I spot an existing matching issue first I'll check with you before filing. Then at hand-off
  I'll push to your fork and hand you a compare URL plus a paste-ready PR (and an optional paste-ready
  comment). I will post nothing *further* to `<target>` automatically."
  **Reconcile the apparent contradiction explicitly:** the feature issue is the *one consented public
  write* on `<target>`; nothing *else* is auto-posted there, and the PR is opened **by the user** via
  the compare URL (the fork hand-off — [fork.md](fork.md) Phase 9), **never** an auto-PR.

## Phase 3 FILE step (on accept)

At Phase 3, after `feature.md` is written, perform these together (both, or neither on a re-run):

1. **Rule 9 dedup — mandatory, unconditional on every accept.** Before creating, run
   `gh issue list --repo <target> --state all --search "<Title>" --json number,title,state,url`.
   `<Title>` here must equal the display title frozen at build go byte-for-byte; do not derive or rewrite
   a search placeholder.
   `--search` is **keyword-based, not typo-fuzzy**, so surface only **plausible** near-matches, framed
   as a reuse choice — "found a possibly-related issue #M — file new, or reuse it?" — and **reuse**
   rather than double-file. This is the sole guard in the Phase 1→Phase 3 window (the anchor doesn't
   exist yet); the resident anchor reader guards after.
2. **File it.** Write the body with the Write tool to an **OS-temp path outside the worktree** (Rule 1),
   then `gh issue create --repo <target> --title "<Title>" --body-file <path>`. The title is one quoted
   argument and is the display title frozen at build go. **Echo the new issue
   URL** in-session (Rule 7); the body ends with the `<attribution trailer>` (Rule 8) and is
   leakage-stripped (Rule 6). On a fork the issue lands on `<target>` (the upstream).
3. **Synthesize the cached-issue JSON** the Phase 0 gate would have produced, so every downstream
   "with a ticket present" branch reads it with **no re-fetch**:
   `number=N`, `title=<Title>`, `body=<the WHAT/WHY just filed>`, **`labels: []`** (the gate
   caches `labels` and Phase 1 reads them — omitting it breaks a downstream `labels` read). The cached `title` must equal the exact frozen `<Title>` passed to dedup and create; no synthesized alias or
   rewritten placeholder is permitted. The remaining fields are
   `state="open"`, `url=<echoed URL>`, `comments=[]`. Set the working ticket ref to **`<target>#N`**.
4. **Persist the anchor.** Write `Ticket: <target>#N` into `feature.md` (the `Ticket:` metadata line —
   see [templates.md](templates.md)) so a resumed run reconstructs the ticket path. For a given ticket
   the same line carries its ref; a plain ticketless run leaves it `–`.

From here the run **is** on the ticket path: the Phase 8 close hooks and the Phase 9 hand-off (auto-PR
+ comment on maintainer; compare-URL paste-ready on fork) apply exactly as for a ticket given up front.

## Invariant reconciliation — the "nothing posted before hand-off" claim

With file-at-Phase-3 the claim stays true through Phase 2 (nothing is filed until Phase 3), so the
Phase 1/Phase 2 sites need only note the created-ticket exception ("except the feature issue you
approved, filed at Phase 3"). But once the issue is filed it is **public and open**, so the **Aborting**
text must **name** it (with its URL) rather than claim the ticket is untouched — an abandoned run leaves
a real, filed issue the user may want to keep or close (never close it yourself — Rule 5). See the
resident Aborting qualification in `SKILL.md`, and [workflow-detail.md](workflow-detail.md)
(Phase 1/Phase 2).

## Decline

One line — "staying ticketless — nothing filed" — then proceed to the build "go". **No re-offer** later
in the run; the Phase 8 findings offer is the remaining tracking opportunity.

## Rule 5

This create-offer write is permitted under the **same** exception the Phase 8 filing offer uses (Rule 5
in [ticket-integration.md](ticket-integration.md)): `gh issue create` with **explicit per-offer user
acceptance**, authored under Rules 1/4/6/8, target-repo aware (`--repo <target>`). Same discipline,
different intent (agreed scope up front vs. a surfaced finding at close). Rule 5 now names both offers
as the allow-list's two per-item `gh issue create` exceptions — this offer and the Phase 8 filing
offer are the whole of that exception, nothing else.
