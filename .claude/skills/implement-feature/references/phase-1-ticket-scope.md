# Phase 1 — ticket scope from the cached issue + write-contract

Read this at **Phase 1** on the **ticket path** (a ticket ref was given). It opens the scope mirror from
the cached issue and extends it with the public-write contract shown before "go". Ticket-path only — a
ticketless run never loads it. The numbered **Rule N** reference below is to the nine non-negotiable
write-discipline rules in [ticket-integration.md](ticket-integration.md).

**With a ticket present,** open from the cached issue instead of a blank prompt: use its title, body,
labels, and comments (cached at approval-time hydration — the structured metadata resolved at Phase 0,
the free text `title`/`body`/`comments` cached only on the preflight approval; don't re-fetch — created
path: synthesized at Phase 3, which has no Phase 0/preflight) as the
*starting* scope so the user needn't restate the report. Present it as clearly-delimited quoted data (Rule 2); if
the body is thin, treat this as an ordinary Phase 1 and don't overpromise scope the ticket doesn't
carry.

**On the ticket path, extend the scope mirror with the write-contract** so the maintainer knows,
before "go", exactly what public writes will happen:

> On go I'll create the branch — nothing is posted to #<N> yet. At hand-off I'll open a pull request
> and post one comment on #<N> explaining what was built and how behaviour changes — one automated
> comment total, under your authenticated `gh` account and marked agent-generated. (If the build turns
> up out-of-scope bugs or improvements, I'll ask before filing any of them as separate issues.)
