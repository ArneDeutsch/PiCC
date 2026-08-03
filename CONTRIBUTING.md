# Contributing to PiCC

Thanks for your interest. PiCC is a Pi extension bundle that makes Claude Code projects run
unchanged on GPT/Codex models. This guide covers the essentials.

## Setup

```bash
git clone https://github.com/ArneDeutsch/PiCC.git
cd PiCC
npm ci
npm run build
```

Requirements: Node ≥ 22.19 (Pi's bundled undici 8.x does not run on Node 20) and git. On
Windows, install Git for Windows; PiCC resolves its Git Bash installation automatically — see
[`doc/user-guide.md`](doc/user-guide.md).

`npm run build` compiles `src/` into the verified JavaScript runtime and emits external source maps.
Installing dependencies does not change the checkout's Git configuration. To opt into the bundled
pre-commit hook, run `npm run hooks:install`; it runs the routine `npm run verify` gate (typecheck
plus unit) before every commit.

## Develop

Author in `src/`. The checkout launcher uses the verified JavaScript runtime when it matches the
current source and package inputs. If that runtime is missing or stale, it visibly falls back to the
TypeScript development path; a damaged runtime fails closed. To force the explicit source path,
host it through an external Pi:

```bash
node <path-to-PiCC>/bin/picc.mjs
# explicit source development:
pi -e <path-to-PiCC>/src/index.ts
```

After source changes, run `npm run build`. The build publishes JavaScript and external source maps
as one verified runtime, so source-oriented stacks are available without promising identical stack
formatting on every host. A launcher-selected compiled runtime pins its verified generation for the
process, so `/reload` does not switch to a new build; exit and relaunch to exercise it. Source-hosted
reload remains source-hosted and may observe source edits under Pi's semantics. `PICC_DEBUG=1`
traces load/skill/routing decisions to stderr.

The dev loop:

```bash
npm run test:unit -- test/permissions.test.ts                 # focused unit-owned file
npm run test:integration -- test/integration-extension.test.ts # focused integration-owned file
npm run test:unit -- test/permissions.test.ts -t "^parseRule parses bare tool names$"
npm run verify                                                # routine: typecheck + unit
npm run verify:all                                            # complete: all three lanes
```

Vitest's `-t` is a regular expression; anchor the full name, including `describe` ancestry, for an
exact match. Select a focused file through its executable owning lane while iterating. The
pre-commit hook and routine development gate use `verify`; use `verify:all` for pull requests and
final integration. See `doc/testing.md` for lane selection and focused e2e commands.

[`doc/architecture.md`](doc/architecture.md) is the map of `src/` — the layering, what each module
owns, and where new code belongs. Read it before changing the harness.

[`doc/testing.md`](doc/testing.md) is the reference for the test lanes and what each one covers,
the three-layer strategy, and how to add an end-to-end scenario. Tests must pass on Windows and
Linux; guard OS/dependency-specific behavior with `it.skipIf`.

## How work happens here

**PiCC is built primarily by agents** running the workflows codified in `.claude/skills/`. The same
workflows are yours to drive, and they are the shortest path in.

### Working with the skills & agents

Two skills carry the work. Invoke either from a PiCC session (`node bin/picc.mjs` at the checkout
root):

- **`/implement-feature [#N | issue-url]`** — the full cycle for anything that deserves a plan and
  its own branch: converge on WHAT and WHY, break it into tasks, drive implementation and
  specialist review, integrate and push. It works in a dedicated git worktree, so parallel sessions
  on this repo never collide. Not for bug fixes, small tweaks, or questions about the code.
- **`/evaluate [#N | issue-url | pr-url]`** — rate an issue, a not-yet-filed proposal, or a PR
  against a value rubric and drive a disposition. It always previews its rating and confirms before
  any public write.

Both dispatch a roster of specialist agents in `.claude/agents/`, each with its own review lens.
The roster is deliberately heterogeneous — different viewpoints is the point:

| Agent | Lens |
|---|---|
| `implementer` | executes one task spec end to end |
| `coder` | implementation design and local code quality in `src/`, `test/` |
| `tester` | test completeness, layer placement, cross-platform coverage |
| `docs` | prose, code comments, and the generated matrix — enforces [`doc/documentation-guide.md`](doc/documentation-guide.md) |
| `security` | command execution, hooks, permissions, paths, worktrees, dispatch |
| `claude-parity` | how Claude Code actually behaves; truthfulness of the capability registry |
| `user-experience` | how the change feels to the person running picc |
| `generalist` | the lens-free adversarial whole-plan/whole-diff review |
| `evaluator` | the read-only sandbox reader for `/evaluate` |

You can also dispatch any of them directly when you want one specialist's read on a change.

### Upgrading the embedded Pi suite

Run Pi upgrades through an explicit `/implement-feature` workflow. After inspecting Pi's release
notes and changed contracts, update the complete direct Pi suite in the feature worktree:

```bash
npm run update:pi -- <stable-exact-version>
```

The helper runs one exact, scripts-disabled npm transaction using your normal npm configuration,
then validates the four direct Pi package manifests. Inspect Pi's package metadata for directly pinned
companion dependencies such as TypeBox and align those separately when required; they are not members
of the same-version four-package suite. If the helper fails, inspect or restore `package.json` and
`package-lock.json` with Git and run `npm ci`. It does not make compatibility decisions: adapt PiCC
semantics and documentation, run `npm run verify:all`, then submit the result as a human-reviewed
pull request. Never couple Pi release detection or adoption to automatic merging or publication.

### Cutting a PiCC release

Prepare the version in `package.json` and `package-lock.json` through reviewed work. Release only
from a clean, synchronized `main` whose CI is green. The Release workflow packages, tests, and
uploads one candidate on manual dispatch; manual runs do not request protected-environment
approval, access its npm secret, create a GitHub Release, or publish to npm.

From Git Bash or another POSIX shell, replace `X.Y.Z`, then rehearse the merged commit:

```bash
set -euo pipefail
VERSION=X.Y.Z
git switch main
git fetch --prune origin
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
REHEARSED_SHA="$(git rev-parse HEAD)"
node -e 'const p=require("./package.json"),l=require("./package-lock.json"),v=process.argv[1];if(p.version!==v||l.version!==v||l.packages?.[""]?.version!==v)process.exit(1)' "$VERSION"
gh workflow run release.yml --repo ArneDeutsch/PiCC --ref main
gh run list --repo ArneDeutsch/PiCC --workflow release.yml --event workflow_dispatch --limit 5
```

Open the new run and require its `headSha` to equal `REHEARSED_SHA`. Record the run URL, candidate
filename, and SHA-256; require the package and exact packaged-product steps to pass and `publish` to
be skipped. If `main` moves before tagging, rehearse its new tip instead.

After the rehearsal, run the complete gate and tag that same commit. Set `REHEARSED_SHA` to the
recorded full SHA. Run verification first, then repeat the identity checks immediately before the
mutation so a stale tree, moved branch, version mismatch, or existing tag stops the sequence:

```bash
set -euo pipefail
VERSION=X.Y.Z
REHEARSED_SHA=0123456789abcdef0123456789abcdef01234567
git switch main
npm run verify:all
git fetch --prune origin
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$REHEARSED_SHA"
test "$(git rev-parse origin/main)" = "$REHEARSED_SHA"
node -e 'const p=require("./package.json"),l=require("./package-lock.json"),v=process.argv[1];if(p.version!==v||l.version!==v||l.packages?.[""]?.version!==v)process.exit(1)' "$VERSION"
test -z "$(git tag --list "v$VERSION")"
test -z "$(git ls-remote --tags origin "refs/tags/v$VERSION")"
git tag --annotate "v$VERSION" "$REHEARSED_SHA" --message "PiCC v$VERSION"
test "$(git rev-list -n 1 "v$VERSION")" = "$REHEARSED_SHA"
git push origin "refs/tags/v$VERSION"
```

The tag starts a fresh run. Before personally approving its waiting `npm-publish` deployment,
require the tag and peeled commit to match the rehearsal, and inspect the package-job result,
version, candidate filename, and tag run's own SHA-256. The tag run independently creates its own
candidate; its SHA-256 need not equal the rehearsal candidate's. The workflow builds and packs once,
re-downloads and verifies that artifact in the protected job, attaches those bytes to the GitHub
Release, and gives the same archive to `npm publish --provenance`. Provenance identifies the public
repository and workflow that published the npm package; it does not by itself prove byte equality.

After the run succeeds, verify both destinations and launch the exact registry version from a test
Claude Code project:

```bash
gh release view "v$VERSION" --repo ArneDeutsch/PiCC --json url,tagName,targetCommitish,assets
npm view "@arnedeutsch/picc@$VERSION" version dist.tarball dist.integrity repository.url --json
cd /path/to/test-claude-code-project
npx --yes "@arnedeutsch/picc@$VERSION" --version
npx --yes "@arnedeutsch/picc@$VERSION"
```

Require the GitHub Release to contain `arnedeutsch-picc-X.Y.Z.tgz`, npm metadata to identify the intended
version and repository, and `picc --version` to report that version before checking normal startup.
Open npm's provenance details and require the repository, release workflow, tag, commit, and package
version to match.

If publication is partial or ambiguous, stop and preserve the tag, version, workflow run, candidate
filename, and SHA-256. Inspect the workflow and independently check GitHub Releases and npm before
any recovery action: a timed-out npm client may still have published. Never move, delete, or
recreate the remote tag; never rebuild or substitute bytes under that version; and never retry npm
until its immutable version is proven absent. A hash mismatch, missing evidence, or uncertain
outcome requires investigation rather than a blind rerun.

## Guiding principles

- **Completeness floor.** No project input may crash the harness. Every artifact/field/tool/hook is
  either honored or degrades to a visible, documented no-op. Loaders never throw — they collect
  `Diagnostic`s.
- **Mechanical fidelity is strict.** Load-bearing mechanics (cwd swap, verbatim subagent return,
  deny enforcement, progressive disclosure, git handling) must behave the way an unchanged project
  expects.
- **Behavioral fidelity is best-effort.** We do not try to make a GPT model reproduce Claude's
  judgment — that is not achievable and not the goal. What we owe a project is that its artifacts
  are *loaded, offered, and enforced* faithfully; how the model then reasons is the model's. Where
  behavior matters, we steer it with prompt text rather than pretend the mechanism guarantees it,
  and we verify by observing what the model actually does.
- **Implement the field, not just the corpus we test against.** A field or artifact that our
  reference projects never use is still worth implementing: other projects use other fields, and
  our own workflows adopt Claude features that exist but that we had not needed yet. Coverage
  tracks Claude Code's surface, not our current sample of it.
- **Keep harness state separate.** Harness state lives outside the project or in the harness-owned
  `.claude/.picc/`, which PiCC attempts to add to repository-local excludes.
- **No drift.** New capability claims go in `src/registry/capability-registry.ts`; the
  compatibility report and `doc/supported-features.md` are generated from it. Run
  `npm run gen:capabilities` after registry changes.

## Non-goals & rationale

Deliberately out of scope — each for a reason, not from neglect:

- **Full MCP surface parity.** Local stdio and selected remote HTTP/SSE servers expose tools,
  prompts, and resources, but some protocol and UX surfaces remain deferred. The
  [capability matrix](doc/supported-features.md) records the exact limits and tiers.
- **Plan mode.** Users plan through their own skills, with review cycles that fit their project.
- **`AskUserQuestion`.** Chat already suffices.
- **Plugin lifecycle / network acquisition.** PiCC observes local plugin and marketplace state and
  loads eligible installed content; it does not install, update, remove, refresh, or acquire it.
- **Fan-out / subscription economics.** How much parallelism a subscription tolerates is the
  project author's concern, not the harness's.
- **Console UX parity — recognizable, not identical.** We render the Claude-specific concepts that
  matter (subagent dispatch and output, skill activation, tool calls) so switching between Claude
  Code and PiCC has low friction, but we do not chase a 1:1 rebuild of Claude Code's console. We
  inherit and extend Pi's TUI rather than fight or replace it. UX parity is an open-ended sink;
  bounding it as best-effort keeps it from consuming the project.

## Pull requests

- Keep changes focused; match the surrounding code style.
- Add or update tests for behavior changes at the cheapest sufficient layer; reserve end-to-end
  scenarios for boundaries that require the real Pi CLI or agent loop.
- Run `npm run verify:all` before opening the PR. CI runs build-free unit and offline integration
  on Windows and Linux with Node 22 and 24. Its Node 22 e2e job on both OSes builds and packs the
  candidate checkout product once. The compiled lane exercises that checkout runtime; the isolated
  source-fallback witness copies the seeded product, drifts its own checkout, and intentionally
  rebuilds that copy during its reload check. Only the scripts-disabled packaged witness consumes
  the exact tarball bytes.
- Note any capability-registry or documentation updates in the PR description.

### Manual verification

Automated checks prove the code type-checks and the suite is green; they do not prove the change
behaves as intended when picc actually runs it. A change with a runtime surface therefore produces
**two artifacts**:

1. **Verification _guidance_ — in the PR description.** Written **before** you verify, so a
   reviewer can follow it independently. Name the branch, the launch command, the in-app steps, and
   the observable outcome. `.github/pull_request_template.md` prompts for this.
2. **A manual-verification comment** — posted **after**, as evidence you actually ran it. State what
   you ran and observed, on which OS/shell, and anything you could not verify. (It is a comment
   because the template body cannot hold it.)

**The escape.** If there is nothing to drive by hand — a **docs-only** change, or one **fully and
genuinely covered by automated tests** — write **"no manual verification needed: `<reason>`"** in
the PR, naming the covering tests if that is the reason.

**Do not mistake a skill / harness / prose change for docs.** picc *executes* those, so they have a
runtime surface and are not exempt: drive the changed flow and observe the changed message or
artifact (or its deliberate absence).

**Steps:**

```bash
git checkout feature/<feature-slug>
cd examples/hello-claude       # the root of the corpus you changed — see the rule below
node ../../bin/picc.mjs        # identical in PowerShell, cmd, and bash
```

**Launch from the root of whichever project's `.claude/` corpus you changed.** picc treats the
enclosing **git repo root** as the project root and loads every `.claude/` directory from your
launch directory up to it — nearest first, first match winning a name collision. So:

- **Changed a fixture's skill** (e.g. `examples/hello-claude/.claude/`)? Launch from that fixture.
  Its corpus is in the chain only when you launch at or below it; from the checkout root it does
  not load at all and you will see nothing happen.
- **Changed picc's own `.claude/skills/` or agents?** Launch from the checkout root, so you
  exercise that project corpus alone. It does still load from a fixture directory — but the
  fixture's own corpus stacks on top of it and shadows any same-named skill, so what you observe
  may not be your change.

If you pin a model, route it through the `openai-codex` provider — `--model openai-codex/gpt-5.5`.
A bare `openai/<id>` selector fails with "No API key found for openai". Omit `--model` to run the
configured default.

The `implement-feature` skill's hand-off produces the same launch-and-verify recipe for agent runs,
single-sourced in `.claude/skills/implement-feature/references/phase-9-handoff.md`, so the contributor and
agent paths stay in step on the launch facts.

## Reporting issues

Include: your OS and shell, Node version, the project's relevant `.claude/` artifact (minimized if
possible), and a `PICC_DEBUG=1` trace. `/doctor` output helps for compatibility questions.
