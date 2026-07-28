# Phase 3 FILE step — file the file-and-build issue and persist its anchor

Read this at **Phase 3**, on the **ticketless** path, only for canonical **file and build** through
the deterministic branch in [phase-3-feature-spec.md](phase-3-feature-spec.md). Given-ticket and
build-ticketless runs never load this file. A valid durable anchor adopts the ticket path instead of
invoking FILE. The consent, preview, timing, and contract live in
[ticket-creation.md](ticket-creation.md).

This is a `gh issue create` **write site**: load the nine-rules floor
[ticket-integration.md](ticket-integration.md) first, and if it can't be read, **refuse the write**
and tell the user.

## Phase 3 FILE step (file-and-build outcome)

After `feature.md` is written, perform these together (both, or neither on a re-run):

1. **Rule 9 dedup — mandatory for every file-and-build outcome.** Before creating, run
   `gh issue list --repo <target> --state all --search "<Title>" --json number,title,state,url`.
   `<Title>` here must equal the display title frozen at build authorization byte-for-byte; do not derive or rewrite
   a search placeholder.
   `--search` is **keyword-based, not typo-fuzzy**, so surface only **plausible** near-matches, framed
   as a reuse choice — "found a possibly-related issue #M — file new, or reuse it?" — and **reuse**
   rather than double-file. This is the sole guard in the Phase 1→Phase 3 window (the anchor doesn't
   exist yet); the resident anchor reader guards after.
2. **File it.** Write the body with the Write tool to an **OS-temp path outside the worktree** (Rule 1),
   then `gh issue create --repo <target> --title "<Title>" --body-file <path>`. The title is one quoted
   argument and is the display title frozen at build authorization. **Echo the new issue
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
