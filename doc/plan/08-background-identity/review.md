# F08 Review: Consistent Background-Task Identity

## Outcome

Shipped the agreed wording feature across TaskStop results, pushed settlement notices, and SendMessage resume acknowledgments. All three now use the compact `Task(task-N) · Agent(<type>) · agent-<id>` vocabulary, with bounded and validated identity metadata. Lifecycle behavior, tool schemas, structured results, settlement delivery and safety framing, and resume mechanics remain unchanged. The only scope clarification was that these strings are model-visible wording rather than renderer-only display; the maintainer approved that distinction before planning continued.

## Planning errors & spec gaps

The ticket inherited F04's “display-only / no model-contract change” framing, but the three target strings enter tool results or coordinator context. Planning corrected the promise to lifecycle- and schema-preserving model-visible wording. Initial plan language also treated the displayed type as one universal value; implementation investigation established that fresh records normally store the requested/display label while resumed records use the resolved registry name. Canonicalizing that value requires broader dispatch identity plumbing and was explicitly deferred. Security review further exposed that simple single-line sanitization was insufficient for a structured tuple because unconstrained agent names could spoof delimiters or minted-looking ids; the task contract was tightened before implementation.

## Friction

Initial formatter tests made two incorrect assumptions: BEL removal did not preserve the expected adjacency, and JavaScript string length counts surrogate pairs as two code units. Review also initially missed new untracked formatter/test/log files because `git diff HEAD` does not include them; staging the complete task diff before subsequent review fixed the visibility problem. Documentation review needed multiple passes to balance exhaustive capability truthfulness against concise startup/doctor-facing prose. The generated capability matrix emitted the repository's usual Windows LF/CRLF working-copy warnings but remained fresh and deterministic.

## Bugs discovered

- PiCC `TaskStop` accepts only `task_id`; Claude Code 2.1.198+ also accepts an agent id or name. Not fixed here; documented in the capability registry and user guide.
- PiCC permits `SendMessage` resume after `TaskStop`; the Claude Code 2.1.x reference refuses stopped-agent resume. Not fixed here; documented.
- Requested/displayed type and resolved registry name can differ after fallback or case-insensitive resolution, so the stable agent id—not the displayed type—is the reliable cross-run key. Not fixed here; documented and explicitly deferred.
- Partial capabilities may not appear in startup or `/doctor` findings, which can allow an overly optimistic compatibility summary. Not fixed here; requires a separate compatibility-reporting change.

## Improvement opportunities

The background identity source could be canonicalized when dispatch identity is created and carried across fresh and resumed task records, eliminating the documented requested/resolved distinction. TaskStop addressing and stopped-agent resume behavior should be brought up to the current Claude baseline rather than remaining documentation-only gaps. Review prompts should require `git status --short` alongside `git diff HEAD`, or the coordinator should stage complete task changes before dispatching reviewers. Compatibility findings should account for material `partial` capabilities without flooding startup output.

## Proposed follow-ups

1. **Canonical background display type** — carry one resolved/display identity through fresh dispatch, settlement, stop, and resume while preserving stable agent correlation.
2. **TaskStop addressing parity** — accept task id, agent id, or agent name with registry-only resolution and cross-spawn visibility matching the current Claude reference.
3. **Stopped-agent resume parity** — refuse SendMessage resume after TaskStop and explain the refusal clearly.
4. **Partial-capability reporting** — make `/doctor` and startup findings expose relevant partial gaps without turning normal startup into exhaustive noise.
5. **Review untracked-file visibility** — update the implementation workflow so whole-diff reviews cannot silently omit newly created files.
