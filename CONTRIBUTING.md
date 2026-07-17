# Contributing to PiCC

Thanks for your interest. PiCC is a Pi extension bundle that makes Claude Code projects run
unchanged on GPT/Codex models. This guide covers the essentials.

## Setup

```bash
git clone <this-repo> picc
cd picc
npm install --ignore-scripts
```

Node ≥ 22.19 and git are required (Pi's bundled undici 8.x does not run on Node 20). On Windows, Git Bash must be on PATH (see the user guide).

A pre-commit hook (`.githooks/pre-commit`) runs `npm run test:unit` before every commit. A plain
`npm install`/`npm ci` wires it automatically (prepare script); after an `--ignore-scripts`
install, wire it manually:

```bash
git config core.hooksPath .githooks
```

## Develop

The harness is TypeScript source loaded by Pi via jiti — there is **no build step**. Run it against
any Claude Code project with:

```bash
node bin/picc.mjs      # from inside the target project directory
# or: pi -e <path>/src/index.ts
```

Set `PICC_DEBUG=1` to trace load/skill/routing decisions to stderr.

## Test

```bash
npm run typecheck     # strict TypeScript, no emit
npm run test:unit     # fast: unit + offline-integration (fake Pi API)
npm run test:e2e      # slower: drives the REAL Pi CLI against a mock OpenAI server
npm run test:coverage # non-e2e lane coverage over src/** (guidance signal, no thresholds)
npm test              # everything
```

See [`doc/testing.md`](doc/testing.md) for the three-layer test strategy and how to add a new
end-to-end scenario. Tests must pass on Windows and Linux; guard OS/dependency-specific behavior
with `it.skipIf`.

## Guiding principles (from the plan)

- **Completeness floor.** No project input may crash the harness. Every artifact/field/tool/hook
  is either honored or degrades to a visible, documented no-op. Loaders never throw — they collect
  `Diagnostic`s.
- **Mechanical fidelity is strict.** Load-bearing mechanics (cwd swap, verbatim subagent return,
  deny enforcement, progressive disclosure, git handling) must behave the way an unchanged project
  expects.
- **No changes to the target project.** Harness state lives outside the project or in the
  gitignored, harness-owned `.claude/.picc/`.
- **No drift.** New capability claims go in `src/registry/capability-registry.ts`; the compatibility
  report and `doc/supported-features.md` are generated from it. Run `npm run gen:capabilities`
  after registry changes.

## Pull requests

- Keep changes focused; match the surrounding code style.
- Add or update tests for behavior changes — prefer an end-to-end scenario for anything a user
  would observe.
- Run `npm run typecheck` and `npm test` before opening the PR. CI runs the same across
  Windows/Linux on Node 22 and 24.
- Note any capability-registry or documentation updates in the PR description.

### Manual verification

Automated checks prove the code type-checks and the suite is green; they do **not** prove the
change behaves as intended when picc actually runs it. So a change with a runtime surface carries a
**manual-verification** expectation, split across **two distinct artifacts**:

- **In the PR description — verification _guidance_** (the plan a reviewer follows). Be concrete, not
  a vague "try it out": name the branch to check out, how to launch picc against a named `examples/`
  project, exactly what to do inside the app to exercise the change (or confirm the bug is fixed),
  and the **observable outcome** to expect. The `.github/pull_request_template.md` prompts for this.
- **A manual-verification comment — the author's _evidence_** (posted as a PR comment). State what
  you actually ran by hand and observed, on which OS/shell, and anything you could not verify.

They are separate on purpose: the **guidance is written _before_ you verify**, so a reviewer can
follow it independently; the **manual-verification comment is written _after_**, as evidence you
actually ran it (the template body cannot hold it, so it is a comment).

**When it applies — and the escape.** Manual verification is required only where the change has a
runtime surface to drive. A **docs-only change** (or one **fully and genuinely covered by automated
tests**) has nothing left to check by hand: write **"no manual verification needed: `<reason>`"** in
the PR (naming the covering tests, if that is the reason) instead of inventing a step. **Do not
mistake a skill / harness / prose change for docs** — picc *executes* it, so it **has** a runtime
surface and is **not** exempt: "the running app" for such a change is picc running the changed flow,
and you verify by driving that flow and observing the changed message or artifact (or its deliberate
absence).

**Worked example** (cross-platform — Windows Git Bash, macOS, and Linux). Say you changed how a skill
greets the user. Launch picc against the bundled `examples/hello-claude` fixture:

```bash
git checkout feature/<feature-slug>
cd examples/hello-claude
node ../../bin/picc.mjs        # runs picc in this directory (the target project)
```

The rule behind that `cd`: **launch picc from the root of whichever project's `.claude/`
corpus you changed.** Here the greeting lives in the fixture's own skill, so you launch
from the fixture. Had you instead changed picc's *own* skill under `.claude/skills/`, you
would launch from the checkout root — not the fixture — because that corpus only loads when
the checkout itself is the active project.

Then, in the PR description under **Start your review here**, spell out the in-app steps and the
outcome — e.g. "at the prompt type `/greet Ada`; the reply now opens with `<the new greeting>` instead
of `<the old one>`, and a `greeted: Ada` line is appended to `greetings.log`." After you run those same
steps yourself, post the manual-verification comment: e.g. "Ran the steps above on Windows 11 / Git
Bash, on macOS, and on Ubuntu; saw the new greeting and the `greetings.log` entry on all three; did
not test the `--model` override."

The `implement-feature` skill's hand-off produces this same launch-and-verify recipe for agent runs;
it is single-sourced in `.claude/skills/implement-feature/references/handoff.md`, so the contributor
and agent paths stay in step on the launch facts: the same cross-platform launch form, and — when a
run does pin a model — routing it through the `openai-codex` provider (never a bare `openai/…`
selector, which fails). The worked example above omits `--model` and runs the configured default, so
it does not itself exercise that flag.

## Reporting issues

Include: your OS and shell, Node version, the project's relevant `.claude/` artifact (minimized if
possible), and a `PICC_DEBUG=1` trace. `/doctor` output helps for compatibility questions.
