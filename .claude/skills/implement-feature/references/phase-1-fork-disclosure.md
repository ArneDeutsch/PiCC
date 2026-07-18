# Phase 1 — fork disclosure (any fork checkout)

Read this at **Phase 1** whenever Phase 0 resolved a **fork** checkout. The fork disclosure fires on
**any** fork checkout, **ticketless included**, independent of the ticket path — so a ticketless fork
run learns it's a fork here at Phase 1, not when the compare URL appears at hand-off.

Surface the fork detection result the moment it's known — fold it into the scope mirror (Phase 1),
before "go", so the manual-PR hand-off is expected. Present it as prose to the user:

> Heads up — this is a fork checkout: I can push to `<push>` but not to `<target>`. At hand-off I'll
> push the branch to your fork and hand you a compare URL plus paste-ready PR (and optional comment)
> texts so you open the PR against `<target>` yourself — which is the normal open-source contribution
> flow and is how you see and satisfy the upstream's PR template, CONTRIBUTING checklist, and any
> CLA/DCO gate. I will post nothing to `<target>` automatically.

Substitute the resolved `push`/`target` `owner/repo` names. On the **ticket** path this composes
with — does not replace — the ticket write-contract from
[ticket-integration.md](ticket-integration.md) (Per-phase ticket hooks → Phase 1): show both, so the
maintainer sees the ticket writes *and* that the PR is opened by hand against the upstream. When the
ticketless fork run **declines** the create-offer (staying ticketless), this disclosure is the *only*
Phase 1 write-contract moment; when it **accepts**, the create-offer adds its own accept contract
([ticket-creation.md](ticket-creation.md)) and this disclosure composes with it. Either way the
router's four-cell grid ties the two together.

If `gh` was unavailable so `target`/`push` could not be resolved (the no-gh degrade), there is no
fork disclosure to make — the run is on the git-only maintainer resolution and hands off generically
(see the no-gh degrade in [phase-9-fork-handoff.md](phase-9-fork-handoff.md)).
