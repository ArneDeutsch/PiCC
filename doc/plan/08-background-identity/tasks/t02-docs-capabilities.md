# t02: Document the Identity Contract

## Goal

User-facing documentation, release notes, and capability records accurately describe the compact background identity wording and its model-visible, lifecycle- and schema-preserving nature.

## Context & seams

The runtime behavior from t01 covers TaskStop results, pushed settlement notices, and SendMessage resume acknowledgments. Documentation must explain the useful identity relationship without implying that every channel has identical punctuation, that model-visible bytes are unchanged, or that PiCC has verified exact Claude Code wording.

A background run has a `task-N`; its agent has a clean displayed type label and stable `agent-<id>`. TaskStop and settlement read the background task record's stored display type. Fresh dispatch records normally store the requested/display label; resumed task records and resume acknowledgments use the clean resolved registry name. Resume creates a new task id while retaining the stable agent id, which is the reliable correlation key. Broader canonical-type plumbing remains deferred by maintainer decision. The wording is a PiCC consistency contract, and TaskStop's post-stop behavior remains explicitly PiCC-defined.

Claude-reference verification also established two runtime gaps that this documentation task records without changing behavior: PiCC TaskStop accepts only `task_id`, while Claude 2.1.198+ also accepts agent id/name; and PiCC permits `SendMessage` resume after TaskStop, while the Claude Code 2.1.x reference refuses to resume a stopped agent.

Update exactly `tool.TaskStop`, `tool.SendMessage`, and `feature.background-agents` in the source capability registry without changing their tiers or existing parity caveats, then regenerate the derived capability matrix. TaskOutput behavior and `tool.TaskOutput` are unchanged.

## Writable surface

- `CHANGELOG.md`
- `doc/user-guide.md`
- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (generator output only)
- `doc/architecture.md` (close-review addition: the new shared formatter became a contributor-facing runtime seam)
- `test/registry.test.ts`
- `doc/plan/08-background-identity/log/t02.md`

## Approach constraints

- Add a concise `[Unreleased]` **Changed** entry.
- State that wording is model-visible while schemas, lifecycle behavior, delivery, framing, and limits are unchanged.
- Describe consistent identity vocabulary and correlation fields, not guaranteed equality of requested/resolved type-label values or identical visual framing across every channel; scope any existing absolute “every surface” wording to the lifecycle surfaces it actually enumerates.
- Keep the explanation concise and oriented toward correlating work; do not enumerate implementation internals.
- Preserve existing parity caveats and capability tiers. Do not claim exact Claude wording, a new parity level, or that the displayed/requested type always equals the resolved fallback definition.
- Generate `doc/supported-features.md` with `npm run gen:capabilities`; never hand-edit it.
- README, testing docs, and examples are out of scope unless implementation reveals a statement made materially false by this feature. Close review may add the new shared formatter to the architecture module map because implementation made it a contributor-facing runtime seam.

## Left open

- Exact prose and placement within the existing Unreleased Changed and Observing subagents sections.
- Whether the capability notes use one shared phrase or surface-specific concise descriptions.

## Testing

- Extend registry tests with durable semantic assertions for the three named capabilities: identity/resume correlation, the two newly verified current-Claude gaps, tiers, and existing PiCC/Claude caveats. Do not pin editorially exhaustive prose.
- Run the capability generator and verify its freshness test passes.
- Run typecheck and the full test suite.
- Check generated capability tiers/counts remain unchanged and only notes reflect the wording feature.

## Acceptance criteria

- [ ] CHANGELOG and user guide accurately explain the three newly consistent surfaces and resume identity relationship.
- [ ] Capability registry notes remain truthful and retain existing tiers/parity caveats.
- [ ] Registry tests pin the new claims without overstating exact Claude parity.
- [ ] Generated capability documentation is current.
- [ ] Documentation does not call the change renderer-only, byte-identical for the model, or universally resolved-agent identity.
- [ ] typecheck and full test suite green

## Depends on

t01
