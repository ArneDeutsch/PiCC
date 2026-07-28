# Phase 1 — fork disclosure (any fork checkout)

Read this at **Phase 1** whenever Phase 0 resolved a **fork** checkout. The fork disclosure fires on
**any** fork checkout, **ticketless included**, independent of the ticket path — so a ticketless fork
run learns it's a fork here at Phase 1, not when the compare URL appears at hand-off.

Fold the fork result into the scope mirror before build authorization, so the manual-PR hand-off is
expected. Substitute the resolved `push`/`target` `owner/repo` names and use the applicable variant:

- **Given ticket or ticketless create-offer unavailable:**
  > Heads up — this is a fork checkout: I can push to `<push>` but not to `<target>`. At hand-off I'll
  > push the branch to your fork and hand you a compare URL plus paste-ready PR (and optional comment)
  > texts so you open the PR against `<target>` yourself — the normal open-source contribution flow,
  > where you see and satisfy the upstream's PR template, CONTRIBUTING checklist, and any CLA/DCO gate.
  > I will post nothing to `<target>` automatically.
- **Ticketless create-offer presented:**
  > Heads up — this is a fork checkout: I can push to `<push>` but not to `<target>`. At hand-off I'll
  > push the branch to your fork and hand you a compare URL plus paste-ready PR (and optional comment)
  > texts so you open the PR against `<target>` yourself — the normal open-source contribution flow,
  > where you see and satisfy the upstream's PR template, CONTRIBUTING checklist, and any CLA/DCO gate.
  > I will post nothing to `<target>` automatically except the optional feature issue if you choose **file and build** below.

On the **ticket** path the first variant composes with — does not replace — the ticket write-contract
from [phase-1-ticket-scope.md](phase-1-ticket-scope.md) (Phase 1 — ticket scope + write-contract): show
both, so the maintainer sees the ticket writes *and* that the PR is opened by hand against the
upstream. On the ticketless path, use the second variant only when [ticket-creation.md](ticket-creation.md)
presents the combined choice; otherwise use the first.

If `gh` was unavailable so `target`/`push` could not be resolved (the no-gh degrade), there is no
fork disclosure to make — the run is on the git-only maintainer resolution and hands off generically
(see the no-gh degrade in [phase-9-fork-handoff.md](phase-9-fork-handoff.md)).
