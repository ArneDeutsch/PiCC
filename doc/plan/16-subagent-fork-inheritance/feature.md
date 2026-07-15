# F16: Task `subagent_type: "fork"` — parent-conversation inheritance

Ticket: ArneDeutsch/PiCC#28

## What

The Agent/Task tool gains a real `subagent_type: "fork"` dispatch: a fork is a
subagent that **inherits the parent conversation** instead of starting fresh.

Observable behavior when a dispatch requests `subagent_type: "fork"`:

- The forked subagent starts with the **parent session's message history** already
  in context — it can answer about, and act on, what the parent was doing without
  being re-told. **"Parent" here means the main/root session:** fork inheritance is
  honored only for a dispatch made *by the main session*. A `"fork"` dispatched from
  within a nested subagent cannot reach its own dispatcher's conversation (the
  runtime only exposes the root transcript), so — rather than silently seeding the
  *wrong* (root) conversation into it — it **visibly degrades** to fresh context
  (see the degrade notice below). This is a security boundary as much as a fidelity
  one: it prevents a tool-restricted subagent from forking the root conversation
  into itself to exfiltrate it.
- It runs with the **same tools and model** as the parent session, and a
  **faithful reconstruction of the parent's system prompt** (same project rules /
  skills / memory / steering context — *not* an agent-definition's persona). Its
  *input* isolation is dropped — this is the whole point of a fork. (Fidelity note:
  PiCC is an extension *on* a Pi-created session and does not own Pi's assembled
  base system prompt, so the fork's system prompt is a same-context reconstruction,
  not a byte-identical copy of the parent's base prompt — see Acceptance.)
- **Output isolation is kept**: only the fork's final result returns to the parent;
  its intermediate tool calls and reasoning stay out of the parent conversation, as
  with any other subagent.
- The feature is gated by the **`CLAUDE_CODE_FORK_SUBAGENT`** environment variable:
  `1` forces fork inheritance on, `0` forces it off (a `"fork"` dispatch then
  degrades explicitly rather than silently). **Unset ⇒ enabled** — a deliberate
  PiCC parity choice: Claude's own unset default is an under-specified
  "staged rollout", so PiCC picks the enabled-by-default behavior (matching
  `/fork`-default-on builds) and advertises this as a PiCC choice, not a documented
  default.
- A **fork cannot spawn another fork** — the second-level `"fork"` request is
  refused (degraded to fresh context) rather than inheriting a fork's context
  recursively.

When a `"fork"` dispatch cannot inherit — env forces off, no parent transcript
available (print/headless/no-session), a nested (non-main-session) dispatcher, a
fork trying to spawn a fork, or an SDK that cannot fork — it does **not** silently
masquerade as a fresh `general-purpose` agent. Instead it runs with fresh context
**and** surfaces a **specific notice** (distinct from the generic
"unknown subagent_type" warning) that names *why* it ran fresh. The notice is
surfaced both to the fork itself (so it doesn't answer as if it inherited) **and to
the developer running picc** (a muted result-footer line + an honest badge that
distinguishes an inherited fork from a degraded one); its **tone** is calm/by-design
for user-chosen or expected cases (env `=0`, a fork-spawns-fork refusal) and a
warning only for genuine can't-do cases (no transcript, SDK can't fork, fork threw).

The **capability registry** gains an explicit, truthful entry for the Task-tool
`"fork"` type describing the supported semantics **and its honest limits** (below),
so the capability matrix advertises the behavior accurately — at tier **partial**,
because several documented edges are deferred.

### Deferred / disclosed limits (advertised truthfully, not silently dropped)

- **System prompt is a same-context reconstruction, not byte-identical** — PiCC is
  an extension *on* a Pi-created session and does not own Pi's assembled base
  prompt; the fork reuses the parent's project rules/skills/memory/steering
  reconstruction. A consequence: the fork **loses the prompt-cache cost saving** a
  byte-identical fork would get.
- **Nested (non-main-session) forks degrade** to fresh context (above).
- **Print/headless/no-session forks degrade** (no parent transcript file to fork
  from) — Claude supports fork in `-p`/SDK; PiCC does not, for now.
- **Fork-mode's `run_in_background` removal is not adopted.** Claude's fork mode also
  strips the Agent tool's `run_in_background` parameter and forces *all* spawns to
  background; PiCC keeps F15's background-by-default (which already delivers the
  "all background" half) and **retains** `run_in_background:false` as a
  synchronous-run selector — a conscious, disclosed divergence.
- **`isolation:"worktree"` on a fork is not honored** — the fork shares the parent
  cwd; worktree-isolated forks are out of scope here.

### Non-goals

- The unrelated skill-frontmatter **`context: fork`** (runs a *skill* in a fresh,
  isolated subagent — maximum isolation) is untouched; it is a different feature
  that happens to share the word "fork".
- The **git fork / PR contribution workflow** (F12) is unrelated and untouched.
- **Normal named subagents keep fresh-context semantics** — that is correct and
  faithful to Claude Code; only `"fork"` inherits.
- We match the **documented** fork semantics, deliberately **not** reproducing
  Claude Code's own named-fork regression where a named fork silently inherits
  zero context (`anthropics/claude-code#76019`).

## Why

PiCC's premise is running Claude-format projects **unchanged** on GPT/Codex models.
Claude Code exposes `subagent_type: "fork"` as a first-class Task-tool option: a
project (or the model driving one) hands a side task to a fork *expecting it to
already know the whole situation*. Today PiCC never forwards parent conversation
into any subagent, so a `"fork"` dispatch falls through the unknown-type fallback
and silently runs as a **fresh-context `general-purpose`** agent — the *opposite*
of fork semantics. The failure is silent: the fork produces subtly wrong work
because it knows nothing about the conversation it was supposed to inherit, and
nothing surfaces an error.

Closing this gap makes a real Claude Code capability behave faithfully under PiCC,
and — where full fidelity isn't achievable — replaces a silent semantic inversion
with an honest, visible degrade, which is the parity contract this project holds
itself to.

## Acceptance

- Dispatching `subagent_type: "fork"` produces a subagent that can correctly answer
  a question that is only answerable from the parent conversation's earlier
  messages (demonstrating real inheritance), while its intermediate steps never
  leak back into the parent conversation (output isolation preserved).
- The forked subagent uses the parent's **tools and model** (not an
  agent-definition's), and a **system prompt reconstructed from the same project
  context** the parent carries (rules/skills/memory) — accepting that PiCC cannot
  reach Pi's byte-exact base prompt, this is the faithful maximum and is advertised
  truthfully in the capability registry.
- Fork inheritance is honored only for a **main-session** dispatch; a fork requested
  from a nested subagent degrades to fresh context with a specific notice (never
  seeds the root conversation into a nested subagent).
- Each degrade trigger — `CLAUDE_CODE_FORK_SUBAGENT=0`, no parent transcript
  (print/headless), nested dispatcher, fork-spawns-fork, SDK cannot fork — runs with
  fresh context **and** surfaces a specific notice (never the generic
  "unknown subagent_type" warning, never a silent fallback). The developer sees an
  honest signal (footer line + badge) that distinguishes an inherited fork from a
  degraded one, with by-design cases toned calmly and can't-do cases as warnings.
- A fork attempting to dispatch a further fork is refused (degraded to fresh),
  not honored; a fork may still spawn *normal* subagent types.
- The forked subagent is **not resumable** (its inherited context is the parent
  conversation at fork time and cannot be safely re-derived); SendMessage refuses it
  cleanly.
- The capability registry describes the Task-tool `"fork"` type truthfully **at tier
  `partial`** (naming the deferred/disclosed limits above), and the regenerated
  capability matrix reflects it; CHANGELOG and relevant docs updated.
- `npm run typecheck` and the full test suite are green.

## Tasks

- t01 Fork dispatch core — parent-conversation inheritance, env gate, visible degrade (depends on: –)
- t02 Fork-spawns-fork guard — runtime-set marker (depends on: t01)
- t03 Capability registry, research §, docs, CHANGELOG, matrix regen (depends on: t01, t02)
