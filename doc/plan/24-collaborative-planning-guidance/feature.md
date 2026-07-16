# F24: Lean collaborative-planning guidance in the PiCC system prompt

Ticket: ArneDeutsch/PiCC#51

## What

PiCC gains a small, always-on collaboration nudge in its own system-prompt
assembly, so any model it drives — Claude and non-Claude alike — adopts a
collaborative Claude-Code-style posture during planning, exploration, and
open-ended discussion, while staying decisive during implementation.

The nudge is model-neutral: it is injected identically for every model. Its
observable behaviour is still model-*dependent* — it is guidance, not
enforcement — so different models honour it to different degrees.

Concretely, once this ships, a model running under PiCC on a substantial
planning request should:

- ground itself with targeted read-only inspection before drawing conclusions
  or asking questions, when repository facts matter;
- resolve discoverable facts itself, and ask the human only about goals,
  preferences, and tradeoffs that materially change the result;
- surface meaningful alternatives and recommend one with concise reasoning;
- **not** collapse a substantial planning phase into a restatement of the
  request followed immediately by "go"/"confirm"/"proceed";
- honour a skill's explicit confirmation gate, but ask for that confirmation
  only after the intended convergence has genuinely happened;
- not manufacture ceremonial questions when the scope is already clear —
  instead state that no material ambiguity remains and briefly invite
  corrections.

During implementation (after scope is agreed) the same model should continue to
act decisively and autonomously within the confirmed scope, turning routine
implementation details into progress rather than repeated questions, and asking
only when blocked, when authority is missing, or when a decision would
materially alter the agreed behaviour/scope. Concision constrains user-facing
verbosity, not the depth of tool use or verification.

### Non-goals

- No target-project artefact changes: no `CLAUDE.md`, skill, agent, or prompt in
  any project PiCC runs is modified to obtain the behaviour. The fix lives
  entirely in PiCC's own prompt assembly.
- Not a copy of Claude Code's or Codex's full system prompt; not Plan mode; not
  the `AskUserQuestion` UI; not a deterministic conversation state machine; does
  not force every task to ask a question or use a subagent.
- The nudge is model-neutral (applies to all models); per-model tailoring is out
  of scope. Users who want a different interaction style use the existing
  steering override rather than a new knob.

## Why

PiCC's purpose is to run projects authored for Claude Code **unchanged**. A
Claude-authored skill (e.g. `implement-feature`) that expresses "direction
before proposal, converge on WHAT/WHY, scout while discussing, confirm before
implementing" behaves well under Claude Code, but under PiCC with a non-Claude
model it tends to short-circuit: load the skill, run the gate, restate the
issue, and immediately ask for "go" — with real scouting happening only after
confirmation. Side-by-side sessions (issue #51's evidence) show Claude Code
grounding and engaging before the scope mirror where the same skill under
PiCC + GPT-5.6 Sol did not.

The right fix is at the harness level, not in each skill: Claude Code normally
contributes this general interaction posture around a project's instructions,
and Pi/PiCC currently supplies almost none of it. Rewriting each skill to
compensate per model would undermine PiCC's core promise. So PiCC should supply
the compact, always-present behavioural posture itself.

## Acceptance

- No target-project `CLAUDE.md`, skill, agent, or prompt is modified to obtain
  the behaviour.
- PiCC injects an always-on collaboration nudge in its own system-prompt
  assembly, present for every model it drives.
- The permanent guidance is compact — at most 120 words — and a test pins its
  text, its placement, and a word/character budget (ceiling equal to the 120-word
  criterion) so later edits cannot silently bloat it.
- The guidance distinguishes planning/exploration/human-discussion from in-scope
  implementation; tells the model to inspect discoverable facts, discuss
  material preferences/tradeoffs, and avoid premature "go"/"confirm" requests;
  explicitly preserves decisive autonomous implementation after convergence;
  explicitly preserves skill-authored approval gates; and does not require
  fabricated questions when scope is already decision-complete.
- Existing context-assembly, skill-activation, compaction-preservation,
  model-steering, and capability tests remain green.
- Documentation states that the behaviour is guidance-only and model-dependent,
  and names the supported steering override (`~/.picc/config.json` /
  `.claude/.picc/config.json`) for users who want a different interaction style.
- The behavioural evaluation (targeted pre-conclusion scouting, a material
  tradeoff surfaced under ambiguity, no immediate restatement-to-"go" collapse,
  decisive continuation after confirmation, and no extra interview rounds on a
  clear request) is **run by the maintainer separately in picc with GPT-5.6 Sol**
  and is *not* a blocking deliverable of this PR. This feature's deliverable for
  it is a committed `evaluation.md` scenarios reference in the plan folder that
  the maintainer's run follows.

## Tasks

- t01 Collaborative-planning nudge in the conventions block + tests (depends on: –)
- t02 Capability registry entry, generated matrix, CHANGELOG, user-guide (depends on: t01)

The recorded before/after GPT-5.6 Sol behavioural evaluation is run by the
maintainer separately in picc (not a blocking deliverable of this feature and not
tracked as a follow-up issue); t02 leaves a `evaluation.md` scenarios reference in
the plan folder for that run.
