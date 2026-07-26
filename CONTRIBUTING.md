# Contributing to PiCC

Thanks for your interest. PiCC is a Pi extension bundle that makes Claude Code projects run
unchanged on GPT/Codex models. This guide covers the essentials.

## Setup

```bash
git clone https://github.com/ArneDeutsch/PiCC.git
cd PiCC
npm ci
```

Requirements: Node ≥ 22.19 (Pi's bundled undici 8.x does not run on Node 20) and git. On
Windows, install Git for Windows; PiCC resolves its Git Bash installation automatically — see
[`doc/user-guide.md`](doc/user-guide.md).

Installing dependencies does not change the checkout's Git configuration. To opt into the bundled
pre-commit hook, run `npm run hooks:install`; it runs `npm run typecheck:all` and then
`npm run test:unit` before every commit.

## Develop

The harness is TypeScript loaded by Pi via jiti — there is **no build step**. Run it against any
Claude Code project from inside that project's directory:

```bash
node <path-to-PiCC>/bin/picc.mjs
# or: pi -e <path-to-PiCC>/src/index.ts
```

`PICC_DEBUG=1` traces load/skill/routing decisions to stderr.

The dev loop:

```bash
npm run typecheck:all                              # strict TypeScript over src + tests, no emit
npm run test:unit                                  # complete non-E2E lane
npm run test:unit -- test/permissions.test.ts      # focused exact file
npm run test:unit -- test/permissions.test.ts -t "^parseRule parses bare tool names$"
npm run verify                                     # authoritative complete check before integration
```

Vitest's `-t` is a regular expression; anchor the full name, including `describe` ancestry, for an
exact match. The pre-commit hook runs the first two commands. Use the focused commands while
iterating and `verify` before integration.

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
then validates the four direct Pi package manifests. If it fails, inspect or restore `package.json` and
`package-lock.json` with Git and run `npm ci`. It does not make compatibility decisions: adapt PiCC
semantics and documentation, run `npm run verify`, then submit the result as a human-reviewed pull
request. Never couple Pi release detection or adoption to automatic merging or publication.

### Cutting a PiCC release

Release only a reviewed, clean default branch. Choose `patch`, `minor`, `major`, or an exact stable
version:

```bash
npm version patch
git push origin HEAD --follow-tags
```

`npm version` runs the complete verification gate before it updates `package.json` and
`package-lock.json`, commits them, and creates the matching `v<version>` tag. The tag workflow uses
one job: it packs once, verifies and tests that exact tarball, then hands the same bytes to the
GitHub Release and npm publication steps. A manual workflow run stops after producing its temporary
artifact; it does not publish a release.

If a tagged workflow fails after either publication step, inspect all three identities before doing
anything else: the verified SHA-256 in the workflow log, the asset on the GitHub Release for the tag,
and `npm view picc@<version> dist`. Never rebuild or retag the version, and never publish bytes with a
different hash. If neither destination exists, rerun the tagged workflow. If one or both exist,
reconcile the missing destination from the already verified artifact; do not repeat an immutable npm
publication that already succeeded.

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
- **No changes to the target project.** Harness state lives outside the project or in the
  gitignored, harness-owned `.claude/.picc/`.
- **No drift.** New capability claims go in `src/registry/capability-registry.ts`; the
  compatibility report and `doc/supported-features.md` are generated from it. Run
  `npm run gen:capabilities` after registry changes.

## Non-goals & rationale

Deliberately out of scope — each for a reason, not from neglect:

- **Full MCP surface parity.** Local stdio MCP servers run with Claude-compatible tool exposure;
  the remaining MCP surfaces (remote transports, prompts/resources, and more) are deferred — the
  capability matrix ([doc/supported-features.md](doc/supported-features.md)) records each tier.
- **Plan mode.** Users plan through their own skills, with review cycles that fit their project.
- **`AskUserQuestion`.** Chat already suffices.
- **Plugin installation / marketplace.** PiCC loads installed plugins' *content*; it does not
  install them.
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
- Run `npm run verify` before opening the PR. CI runs `test:unit` and
  `test:e2e` as separate lanes on Windows and Linux — unit on Node 22 and 24, e2e on Node 22.
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
