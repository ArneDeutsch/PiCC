import type {
  ClaudeAgent,
  ClaudeMdFile,
  ClaudeRule,
  ClaudeSettings,
  ClaudeSkill,
  Diagnostic,
} from "../types.js";
import { renderSkillListing } from "../claude/skills.js";
import { renderAgentCatalog } from "../claude/agents.js";
import { findNestedClaudeMd } from "../claude/claude-md.js";
import type { MemorySnapshot } from "../claude/memory.js";
import { ruleAppliesTo } from "../claude/rules.js";
import {
  budgetSkillReinjection,
  REINJECT_PER_SKILL_MAX_CHARS,
} from "./skill-activation.js";

/**
 * Assembles the PiCC system-prompt suffix appended to Pi's prompt each turn
 * (design doc §2: before_agent_start). Because the system prompt is rebuilt every
 * turn and never compacted away, this is ALSO the primary compaction-preservation
 * mechanism (plan §9): root CLAUDE.md, unconditional rules, the skill listing, the
 * agent catalog, and rendered active skills always survive.
 */
export interface SessionContextState {
  /** Skill name -> rendered body (stays resident once activated — plan §4.1). */
  activeSkills: Map<string, string>;
  /** Absolute paths of CLAUDE.md files already in context (root set + injected nested). */
  loadedClaudeMd: Set<string>;
  /**
   * Path-scoped rules already injected, keyed by the rule's absolute source path —
   * same-named rules from different scopes/dirs are distinct rules and must all inject.
   */
  injectedRules: Set<string>;
  /** Path-scoped skills already surfaced on file touch (suggest once). */
  suggestedSkills: Set<string>;
}

export function newSessionContextState(claudeMd: ClaudeMdFile[]): SessionContextState {
  return {
    activeSkills: new Map(),
    loadedClaudeMd: new Set(claudeMd.map((f) => f.path)),
    injectedRules: new Set(),
    suggestedSkills: new Set(),
  };
}

/**
 * Reset the once-only injection markers after compaction (plan §9): nested
 * CLAUDE.md and path-scoped rules/skills were delivered as ordinary transcript
 * messages that compaction summarizes away, so they must re-inject on the next
 * relevant access. Active skills survive via the system-prompt suffix and stay.
 */
export function resetInjectionState(state: SessionContextState, claudeMd: ClaudeMdFile[]): void {
  state.loadedClaudeMd = new Set(claudeMd.map((f) => f.path));
  state.injectedRules.clear();
  state.suggestedSkills.clear();
}

export interface AssemblyInputs {
  claudeMd: ClaudeMdFile[];
  rules: ClaudeRule[];
  skills: ClaudeSkill[];
  agents: ClaudeAgent[];
  settings: ClaudeSettings;
  state: SessionContextState;
  steeringText?: string;
  compatNotice?: string;
  /** Auto memory (audit B4): injected as its own section when present (= enabled). */
  autoMemory?: MemorySnapshot;
  /** Approximate model context-window budget in chars for the skill listing. */
  contextWindowChars?: number;
  /**
   * Sink for assembly diagnostics — currently the skill-listing tier
   * degradation (G5). Called once per diagnostic per render; wrap it with
   * {@link createTierChangeReporter} to surface each tier change only once.
   */
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}

/**
 * Wrap a report callback so skill-listing tier-degradation diagnostics (G5)
 * surface once per TIER CHANGE, not once per render — the system-prompt suffix
 * is rebuilt every turn and would otherwise repeat the same message forever.
 */
export function createTierChangeReporter(
  report: (message: string) => void,
): (diagnostic: Diagnostic) => void {
  let lastKey: string | undefined;
  return (diagnostic: Diagnostic) => {
    const key = /tier (\d+)/.exec(diagnostic.message)?.[1] ?? diagnostic.message;
    if (key === lastKey) return;
    lastKey = key;
    report(diagnostic.message);
  };
}

/**
 * The acceptance budget (F24): the permanent collaborative-planning nudge is
 * pinned at "at most 120 words". Exported so the budget test asserts on the same
 * literal the ceiling is defined by (mirrors the exported `REINJECT_*` budgets).
 */
export const COLLABORATIVE_PLANNING_MAX_WORDS = 120;

/**
 * Always-on collaborative-planning nudge (F24), rendered as the trailing bullets
 * of {@link HARNESS_CONVENTIONS}. It is model-neutral — injected identically for
 * every model PiCC drives — and a soft default: it is emitted first in the suffix
 * so a project's CLAUDE.md, a loaded skill's approval gate, and steering all get
 * the last word. Guidance, not enforcement; observable effect is model-dependent.
 *
 * Declared ABOVE `HARNESS_CONVENTIONS` on purpose: that const interpolates this
 * one, so a lower declaration would be in the temporal dead zone and throw a
 * ReferenceError at module load. Kept <= {@link COLLABORATIVE_PLANNING_MAX_WORDS}
 * words (pinned by a budget test) because this block is re-sent every turn and
 * never compacted — every sentence is a permanent per-turn cost.
 */
export const COLLABORATIVE_PLANNING_GUIDANCE = `- Planning: for a substantial change, don't act as a mere approval gate. Ground yourself in the repo — resolve discoverable facts by reading, not asking, and investigate until the open questions are about intent, not facts. Ask only about goals, preferences, and material tradeoffs; when scope is already clear, say so and proceed instead of inventing questions. Surface alternatives and recommend one, briefly. Don't jump from restating a request to "go"/"confirm"; ask for a skill's explicit confirmation only after the intended convergence has happened.
- Implementation: once scope is agreed, act decisively; ask only when blocked, lacking authority, or when a choice changes the agreed scope. Concision limits what you say, not how thoroughly you investigate or verify.`;

const HARNESS_CONVENTIONS = `## Claude Code compatibility conventions (PiCC)

You are running a project authored for Claude Code. Honor its conventions:
- Claude tool names map onto your tools: Read/Write/Edit/Bash are read/write/edit/bash; use Grep/Glob/WebFetch/WebSearch/Agent/Task tools by their listed names.
- To use a skill from the listing below, call the Skill tool with its name (or the user invokes /name). Follow the skill's instructions exactly once loaded; bundled files are referenced relative to the skill directory.
- Subagents: dispatch with the Agent tool; choose subagent_type by matching the task against the agent descriptions in the catalog. Subagents run in the background by default — a dispatch returns a task id, not the result — so several dispatched in one turn run concurrently. Collect each result with TaskOutput before you rely on it or finalize an answer (or pass run_in_background: false for a synchronous inline result). Eligible uncollected results receive one bounded notice on a later interactive turn, but one-shot print mode may end before that turn. The collected result is the subagent's final message verbatim — parse it as the calling skill specifies.
- When a skill or instruction specifies an output format (e.g. a locked YAML block), reproduce it EXACTLY — downstream tooling parses it.
- Worktrees: EnterWorktree/ExitWorktree isolate work; while inside one, all relative paths and shell commands run there.
- Commits: when you're asked to commit — by the user, or by a skill or project instruction — first read the changes (git status/diff) and recent git log, and match this repository's commit-message style where it is richer; for a non-trivial change, still write a short body explaining why the change was made, not just what. Never use git commit --no-verify; project hooks must run.
${COLLABORATIVE_PLANNING_GUIDANCE}`;

/**
 * Conservative memory-write policy (F10). Single-line string, shared verbatim by the
 * main-session auto-memory guidance below and the per-agent `memory:` guidance in
 * index.ts so the two can never drift. It opens with a deference clause so a project's
 * own CLAUDE.md eager-write opt-in overrides the conservative default — that section is
 * emitted earlier and would otherwise lose to a bare conservative directive.
 */
export const MEMORY_WRITE_POLICY = `Unless this project's own instructions tell you to record memory proactively, do not write to memory on your own initiative — routine facts you pick up while working do not belong here, and low-value entries only crowd out what matters. Add or update an entry only when you are explicitly asked to remember something for the future (for example "remember to…", "from now on…", "in future don't…", or "make a note that…"). When you do, use the Write/Edit tools with one topic per file and MEMORY.md as the index (only MEMORY.md is loaded automatically — keep it under ~200 lines). Remove or correct an entry only when you are told it is wrong or obsolete.`;

/** Main-session framing lead-in; the shared policy is pushed as a separate part after it. */
const AUTO_MEMORY_LEAD_IN = `Any memory shown above is loaded every session — treat it as durable project knowledge and use it.`;

export function buildSystemPromptSuffix(inputs: AssemblyInputs): string {
  const sections: string[] = [];

  sections.push(HARNESS_CONVENTIONS);

  const claudeMdParts = inputs.claudeMd
    .filter((f) => f.loadAtStart)
    .map((f) => `<!-- ${f.path} -->\n${f.content.trim()}`)
    .filter((c) => c.trim().length > 0);
  if (claudeMdParts.length) {
    sections.push(`## Project instructions (CLAUDE.md)\n\n${claudeMdParts.join("\n\n---\n\n")}`);
  }

  if (inputs.autoMemory) {
    const parts = [`Memory directory: ${inputs.autoMemory.dir}`];
    const memContent = inputs.autoMemory.content?.trim();
    if (memContent) parts.push(memContent);
    parts.push(AUTO_MEMORY_LEAD_IN);
    parts.push(MEMORY_WRITE_POLICY);
    sections.push(`# Auto memory\n\n${parts.join("\n\n")}`);
  }

  const unconditionalRules = inputs.rules.filter((r) => !r.paths || r.paths.length === 0);
  if (unconditionalRules.length) {
    sections.push(
      `## Project rules\n\n${unconditionalRules.map((r) => `### ${r.id}\n${r.body.trim()}`).join("\n\n")}`,
    );
  }

  const listingDiagnostics: Diagnostic[] = [];
  const listing = renderSkillListing(inputs.skills, {
    budgetChars: skillListingBudget(inputs),
    maxDescChars: inputs.settings.skillListingMaxDescChars,
    diagnostics: listingDiagnostics,
  });
  if (inputs.onDiagnostic) for (const d of listingDiagnostics) inputs.onDiagnostic(d);
  if (listing.trim()) {
    sections.push(
      `## Available skills\n\nActivate a skill with the Skill tool when a task matches its description.\n\n${listing}`,
    );
  }

  if (inputs.agents.length) {
    sections.push(`## ${renderAgentCatalog(inputs.agents)}`);
  }

  if (inputs.state.activeSkills.size) {
    // The resident section re-sends every active body each turn, so it gets
    // the same ~20k-per-skill / ~100k-combined budget as compaction
    // re-injection (G7), most recently activated first (Map insertion order
    // reflects activation order).
    const active = [...inputs.state.activeSkills.entries()];
    const { text, dropped } = budgetSkillReinjection(active);
    const truncated = active.filter(
      ([name, body]) => !dropped.includes(name) && body.length > REINJECT_PER_SKILL_MAX_CHARS,
    ).length;
    const affected = truncated + dropped.length;
    const note =
      affected > 0
        ? `\n\n(${affected} older skill ${affected === 1 ? "body" : "bodies"} truncated/dropped for context budget)`
        : "";
    sections.push(`## Active skills\n\n${text}${note}`);
  }

  if (inputs.steeringText) {
    sections.push(`## Harness guidance\n\n${inputs.steeringText}`);
  }

  if (inputs.compatNotice) {
    sections.push(`## Compatibility\n\n${inputs.compatNotice}`);
  }

  return sections.join("\n\n");
}

function skillListingBudget(inputs: AssemblyInputs): number | undefined {
  const fraction = inputs.settings.skillListingBudgetFraction;
  if (fraction === undefined) return undefined;
  const windowChars = inputs.contextWindowChars ?? 200_000 * 4;
  return Math.max(500, Math.floor(windowChars * fraction));
}

/**
 * Context to inject when the model touches a file: nearest-ancestor nested CLAUDE.md
 * (not yet loaded) + newly matching path-scoped rules. Returns undefined when nothing new.
 */
export function contextForTouchedFile(opts: {
  filePath: string;
  cwd: string;
  projectRoot: string;
  rules: ClaudeRule[];
  settings: ClaudeSettings;
  state: SessionContextState;
  /** Skills with `paths:` scoping are surfaced (once) when a matching file is touched. */
  skills?: ClaudeSkill[];
}): string | undefined {
  const parts: string[] = [];

  const nested = findNestedClaudeMd(opts.filePath, {
    cwd: opts.cwd,
    projectRoot: opts.projectRoot,
    excludes: opts.settings.claudeMdExcludes,
    loaded: opts.state.loadedClaudeMd,
  });
  if (nested) {
    opts.state.loadedClaudeMd.add(nested.path);
    parts.push(`Directory instructions (${nested.path}):\n\n${nested.content.trim()}`);
  }

  for (const rule of opts.rules) {
    if (!rule.paths || rule.paths.length === 0) continue;
    if (opts.state.injectedRules.has(rule.source.path)) continue;
    if (ruleAppliesTo(rule, opts.filePath, opts.projectRoot, opts.cwd)) {
      opts.state.injectedRules.add(rule.source.path);
      parts.push(`Project rule (${rule.id}) — applies to files you are touching:\n\n${rule.body.trim()}`);
    }
  }

  // Path-scoped skills (plan §4.1/§4.2 shared glob engine): surface the skill
  // when the model first touches a matching file. Suggestion only — activation
  // stays explicit via the Skill tool, mirroring the startup listing.
  for (const skill of opts.skills ?? []) {
    if (!skill.paths || skill.paths.length === 0) continue;
    if (skill.disableModelInvocation) continue;
    if (opts.state.activeSkills.has(skill.name)) continue;
    if (opts.state.suggestedSkills.has(skill.name)) continue;
    const applies = skill.paths.some((p) =>
      ruleAppliesTo(
        { id: skill.name, paths: [p], body: "", source: skill.source, unknownKeys: [], diagnostics: [] },
        opts.filePath,
        opts.projectRoot,
        opts.cwd,
      ),
    );
    if (applies) {
      opts.state.suggestedSkills.add(skill.name);
      parts.push(
        `Skill for the files you are touching: "${skill.name}" — ${skill.description} (activate with the Skill tool if relevant)`,
      );
    }
  }

  return parts.length ? parts.join("\n\n") : undefined;
}
