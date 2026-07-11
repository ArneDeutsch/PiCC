import type { ClaudeAgent, ClaudeMdFile, ClaudeRule, ClaudeSettings, ClaudeSkill } from "../types.js";
import { renderSkillListing } from "../claude/skills.js";
import { renderAgentCatalog } from "../claude/agents.js";
import { findNestedClaudeMd } from "../claude/claude-md.js";
import { ruleAppliesTo } from "../claude/rules.js";

/**
 * Assembles the PiClauDex system-prompt suffix appended to Pi's prompt each turn
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
  /** Rule ids already injected (path-scoped ones inject once). */
  injectedRules: Set<string>;
}

export function newSessionContextState(claudeMd: ClaudeMdFile[]): SessionContextState {
  return {
    activeSkills: new Map(),
    loadedClaudeMd: new Set(claudeMd.map((f) => f.path)),
    injectedRules: new Set(),
  };
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
  /** Approximate model context-window budget in chars for the skill listing. */
  contextWindowChars?: number;
}

const HARNESS_CONVENTIONS = `## Claude Code compatibility conventions (PiClauDex)

You are running a project authored for Claude Code. Honor its conventions:
- Claude tool names map onto your tools: Read/Write/Edit/Bash are read/write/edit/bash; use Grep/Glob/WebFetch/WebSearch/Agent/Task tools by their listed names.
- To use a skill from the listing below, call the Skill tool with its name (or the user invokes /name). Follow the skill's instructions exactly once loaded; bundled files are referenced relative to the skill directory.
- Subagents: dispatch with the Agent tool; choose subagent_type by matching the task against the agent descriptions in the catalog. Return values are the subagent's final message verbatim — parse them as the calling skill specifies.
- When a skill or instruction specifies an output format (e.g. a locked YAML block), reproduce it EXACTLY — downstream tooling parses it.
- Worktrees: EnterWorktree/ExitWorktree isolate work; while inside one, all relative paths and shell commands run there.
- Never use git commit --no-verify; project hooks must run.`;

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

  const unconditionalRules = inputs.rules.filter((r) => !r.paths || r.paths.length === 0);
  if (unconditionalRules.length) {
    sections.push(
      `## Project rules\n\n${unconditionalRules.map((r) => `### ${r.id}\n${r.body.trim()}`).join("\n\n")}`,
    );
  }

  const listing = renderSkillListing(inputs.skills, {
    budgetChars: skillListingBudget(inputs),
    maxDescChars: inputs.settings.skillListingMaxDescChars,
  });
  if (listing.trim()) {
    sections.push(
      `## Available skills\n\nActivate a skill with the Skill tool when a task matches its description.\n\n${listing}`,
    );
  }

  if (inputs.agents.length) {
    sections.push(`## ${renderAgentCatalog(inputs.agents)}`);
  }

  if (inputs.state.activeSkills.size) {
    const active = [...inputs.state.activeSkills.entries()]
      .map(([name, body]) => `### Skill: ${name} (active)\n${body.trim()}`)
      .join("\n\n");
    sections.push(`## Active skills\n\n${active}`);
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
    if (opts.state.injectedRules.has(rule.id)) continue;
    if (ruleAppliesTo(rule, opts.filePath, opts.projectRoot)) {
      opts.state.injectedRules.add(rule.id);
      parts.push(`Project rule (${rule.id}) — applies to files you are touching:\n\n${rule.body.trim()}`);
    }
  }

  return parts.length ? parts.join("\n\n") : undefined;
}
