# Phase 8 — close-vs-keep-open, write preview (ticket path only)

Read this at **Phase 8**, inside the close review ([phase-8-close-review.md](phase-8-close-review.md)), **only on the ticket path** — with an empty `$ARGUMENTS` there is no ticket to close, so a maintainer-ticketless run never loads it. The Phase 9 writes this preview commits to obey the nine-rules floor in [ticket-integration.md](ticket-integration.md).

**On the ticket path, fold the close-vs-keep-open judgement and a write preview into that gate.**
Before agreeing to close, show the user: what the ticket **asked** for, what was **delivered**, and
what was **not** — then state the judgement. If the feature **fully** delivers the ticket, the Phase 9
PR body will close it (`Closes #N`); if it only **partly** does, the PR references it with a bare `#N`
(the ticket stays open) and you name the remaining scope. **Bias to keep-open when uncertain** — a
wrongly-open ticket is a one-click fix, a wrongly-closed one silently drops scope. Then **show the two
actual texts you intend to post — the PR body and the issue comment.** They differ in audience: the PR
body guides the reviewer through verifying the change in the running app (carrying phase-9-handoff.md's
launch-and-verify recipe); the issue comment explains,
for the ticket's readers, what was built and how behaviour changes against the original ask. Both go
public under the user's identity, so get explicit confirmation before any Phase 9 write. Author that
preview from the material that exists now — `observations.md` and the task logs (`review.md` — written in [phase-8-close-review.md](phase-8-close-review.md) — distills the same sources, so it adds nothing the preview can't already contain). The
confirmed text is the exact bytes Phase 9 posts; if anything changes between here and the write,
re-confirm rather than posting something the user didn't see.
