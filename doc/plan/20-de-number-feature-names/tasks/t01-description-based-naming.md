# t01: Adopt description-based feature naming

## Goal
The shipped `implement-feature` workflow no longer allocates or propagates a global feature number. New runs use one safe, immutable descriptive slug across repository identities, while public titles use ordinary descriptive prose and linked GitHub issues remain the canonical numeric reference.

## Context & seams
The active naming contract is duplicated across the resident router and all six files under `.claude/skills/implement-feature/references/`; they must change as one unit. Current contributor guidance in `CONTRIBUTING.md` also shows the numbered branch form, and `CHANGELOG.md` records user-visible workflow changes.

Define these exact contracts:

- A new run authors one lowercase ASCII kebab-case `<feature-slug>` from the user-confirmed scope. It is independent model output, never copied, slugified, or mechanically transformed from raw ticket text. State the selected slug, branch, and plan path before workspace creation without adding a new approval prompt.
- Validate the slug against `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`, keep it concise (3–48 characters), reject Windows reserved device basenames (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) case-insensitively, and require `git check-ref-format --branch "feature/<feature-slug>"` to pass. Validation fails closed by authoring a different descriptive slug; do not silently sanitize, use a legacy-shaped leading-number identity, or append a numeric counter.
- Classify a resume before allocating a new-run slug. For a descriptive run, validate the recovered slug before shell/GitHub use and require agreement among every identity artifact that should exist at the phase reconstructed from git: immediately after workspace setup, the managed worktree basename and exact current `feature/<feature-slug>` branch are sufficient; after Phase 3, also require the exact `doc/plan/<feature-slug>` folder and feature heading; where commits exist, require the established commit prefix too. Treat self-owned matching artifacts as the current run, not collisions. Stop before further commands or writes and report each mismatch with a safe user-directed resolution. Recognize an existing legacy numbered run separately and preserve its established folder, branch, headings, and commit grammar exactly; never partially migrate it.
- For a new run, case-fold names for portable collision comparison and also use exact Git/path checks. Before `EnterWorktree`, reject the candidate plan path both in the fetched target-default tree and in the current filesystem (including a dangling link), any existing `.claude/worktrees/<feature-slug>` filesystem entry, registered worktree, local `feature/<feature-slug>` ref, local harness `worktree-<feature-slug>` ref, or fetched remote `feature/<feature-slug>` ref. On any visible collision, state what was occupied and author a more specific descriptive slug before invoking the tool; never increment a counter, overwrite, delete, reuse, or adopt the existing artifact.
- Keep the prose-only limitation explicit: preflight protects work visible in the shared/fetched repository but cannot atomically reserve a worktree or remote-branch name across simultaneous sessions or disconnected clones because `EnterWorktree` is create-or-reenter and ordinary push has no expected-absence guard under the existing no-force-push discipline. If `EnterWorktree` reports reuse despite preflight, perform no subsequent workflow-initiated repository/GitHub writes, leave the encountered worktree intact, and stop with the limitation and recovery options; acknowledge that seeding and a configured create hook may already have changed it. If a freshly created worktree then loses the non-forcing `git switch -c` race, perform no subsequent workflow writes, preserve the worktree and any seeded/hook-created state untouched, report its status for user-directed cleanup, and stop rather than retrying inside it. Immediately before push, fetch and repeat the exact remote-branch collision check; stop on a visible hit, while disclosing that a same-name remote branch created in the remaining check-to-push race may still be attached by a normal push when histories permit. Do not claim atomic or complete race elimination.
- Finalize the identity only after a fresh `EnterWorktree` and successful non-forcing `git switch -c`. From then on the slug is immutable and appears exactly in the worktree name, `feature/<feature-slug>`, `doc/plan/<feature-slug>/`, feature/review headings, and commit prefixes.
- Commit grammar becomes `<feature-slug>: plan — <title>`, `<feature-slug>: t<task-number> — <description>`, `<feature-slug>: review — <title>`, and `<feature-slug>: <description>`.
- Markdown headings become `# <feature-slug>: <Title>` and `# <feature-slug> Review: <Title>`.
- Author one stable human display title from the confirmed scope and reuse it in feature/review headings and issue/PR titles unless the user edits it; the exact slug remains the machine/repository identity. Public titles have no invented identifier prefix. Require a bounded (maximum 120 characters), single-line printable-ASCII title with no control characters or raw ticket text, passed as one quoted argument. Preserve preview/reconfirmation and idempotency rules. Ticket creation remains deferred until feature-spec creation so the public issue and durable `Ticket:` anchor are still coupled; remove only the obsolete number-dependent timing rationale.
- Preserve GitHub issue references (`#N`, `<target>#N`, closing-link rules) unchanged. Preserve local task ordering, but rename generic placeholders to `<task-number>` / `<task-slug>` so they cannot be confused with the removed feature counter; examples remain `t01`, `t02`, and so on.
- Push, PR lookup/creation, fork compare URLs, CI lookup, PR-body branch headings, abort/cleanup guidance, and final summaries all use the exact `feature/<feature-slug>` branch.
- Current operational docs and tests change; historical plans, research, changelog entries, branches, headings, and commits remain untouched. Add a new `[Unreleased]` **Changed** entry describing future slug-based naming, canonical ticket numbers, retained task-local numbering, and legacy preservation; do not alter older changelog entries.

Add focused, CRLF-normalized structural regression checks in `test/implement-feature-skill.test.ts`, localized per consuming file rather than satisfied by one concatenated marker. Reject obsolete new-run allocation, numbered branch/path/title/commit examples, and global-feature placeholders while explicitly allowing GitHub issue numbers, `<task-number>`, `t01`, and narrowly scoped legacy-resume prose. Positively pin:

- slug grammar/length, the complete Windows reserved-name families, quoted `git check-ref-format`, fail-closed re-authoring, and no numeric suffix fallback;
- case-insensitive plus exact checks for the plan path in both the fetched target-default tree and current filesystem, physical/registered worktree, harness branch, local feature branch, and fetched remote branch;
- the create-or-reenter and normal-push limitations, post-hook no-further-write stop, non-forcing branch race backstop, pre-push recheck, and honest non-atomic guarantee;
- resume-before-allocation precedence, phase-aware identity agreement/mismatch stop, immutability, and legacy preservation;
- workspace, templates, commits, ticket/PR hand-off, fork compare URL, CI, and cleanup use of the new identity;
- `CONTRIBUTING.md` uses `feature/<feature-slug>` and no obsolete checkout form.

Keep assertions semantic rather than mirroring full paragraphs, and do not scan historical plan or changelog content for forbidden markers.

## Writable surface
- `.claude/skills/implement-feature/SKILL.md`
- `.claude/skills/implement-feature/references/*.md`
- `test/implement-feature-skill.test.ts`
- `CONTRIBUTING.md`
- `CHANGELOG.md`
- `doc/plan/20-de-number-feature-names/log/t01.md`

Everything else is read-only.

## Approach constraints
- Preserve all ticket-write discipline, fork routing, resume safety, templates, and phase sequencing except where the obsolete feature number directly affects naming or ticket-title timing rationale.
- Keep the resident router within `REINJECT_PER_SKILL_MAX_CHARS`.
- Do not mass-rewrite historical numbered artifacts.
- Do not change PiCC runtime code, capability registry entries, generated capability documentation, or package behavior.

## Left open
- Exact prose organization and examples, provided the contracts above are explicit and consistent.
- The stable descriptive display-title wording for an individual run, within the safe-title rules.
- Exact structural-test matching details, provided checks remain localized, diagnostic, and tolerant of deliberate legacy prose.

## Testing
- Extend the unit-level structural checks in `test/implement-feature-skill.test.ts`.
- Run the targeted test, typecheck, and full test suite.
- Search only the active skill bundle and current contributor guidance for stale global-feature placeholders; do not treat historical records as failures.
- Verify cross-platform safety in prose and tests: CRLF-tolerant reads, case-folded collision comparison, portable lowercase slug grammar, Windows reserved names, Git-ref validity, and exact single-argument command usage.

## Acceptance criteria
- [ ] New-run instructions allocate no global feature number and use one validated descriptive slug across all repository identities.
- [ ] Visible collisions fail closed without appending a number or adopting existing work; the unchanged create-or-reenter API's narrow race is disclosed and stops without further writes if encountered.
- [ ] Issue/PR titles and ticket-creation timing no longer depend on `F<NN>`, while issue-number linking and durable anchors remain intact.
- [ ] Task-local numbering remains explicit and unambiguous.
- [ ] Legacy resumes preserve existing numbered identities and historical artifacts are unchanged.
- [ ] Handoff, fork, CI, cleanup, CONTRIBUTING, and CHANGELOG guidance are current.
- [ ] Structural tests protect the new contract without matching historical records.
- [ ] typecheck and full test suite green

## Depends on
–
