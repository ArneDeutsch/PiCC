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
  /**
   * Per-session native-safe scratch dir literal path (#48/feature 25). When set, a
   * scratchpad section is injected on ALL platforms (mirroring Claude Code) naming
   * this literal path and steering temp files here instead of `/tmp`. Computed once
   * in index.ts (the composition root) so this module never imports from `engine/`.
   */
  scratchDir?: string;
  /**
   * True when the shell↔native namespace split (Windows + pinned Git Bash) means a
   * bare `/tmp/...` written via the Bash tool is unreadable by the native file tools.
   * Gates the extra Windows note under the scratchpad section. Computed in index.ts
   * from `shellNamespaceDiffersFromNative()` — same reason: no `engine/` import here.
   */
  windowsTempNote?: boolean;
  /**
   * True only for the main session (#69): injects the `## Working with the user`
   * interaction posture ({@link INTERACTION_POSTURE}). Dispatched subagents leave it
   * unset — they return reports and have no user to converse with — so they receive
   * the mechanical conventions but not the posture. Gated via `=== true`.
   */
  includeInteractionPosture?: boolean;
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
 * Always-on, main-session-only interaction posture (#69, successor to F24). A
 * standalone `## Working with the user` section gearing the model PiCC drives
 * toward the grounded, collaborative partner a Claude Code session is. It is
 * model-neutral — injected identically for every model — and a soft default:
 * {@link buildSystemPromptSuffix} emits it after the mechanical conventions but
 * before CLAUDE.md/skills/steering, so those more-specific sections still get the
 * last word. Gated by `includeInteractionPosture` so only the main session (which
 * has a user to converse with) receives it; dispatched subagents do not. Guidance,
 * not enforcement; observable effect is model-dependent. A plain top-level const
 * referencing nothing else — no module-load coupling, no TDZ hazard.
 */
export const INTERACTION_POSTURE = `## Working with the user

You are driving a project authored for Claude Code, and the person you're working with expects the collaborative partner Claude Code is — not a terse command-runner. Other guidance tells you to be concise: concision limits how much you *say*, never how much you investigate, verify, or engage.

On any substantial or open-ended request — planning, design, a feature, an ambiguous ask:
- Ground first, then talk. Before concluding or asking, inspect the repo with read-only tools — the code, files, and history the request touches. Resolve every discoverable fact yourself instead of asking. Then share what you found: name the specific files, lines, and constraints that shape the answer, so the user sees your reasoning, not just a verdict.
- Ask about intent, not facts. Save questions for goals, preferences, and tradeoffs that materially change the outcome — what only the user can decide. When the request is already clear, don't invent ceremonial questions: say what you'll do and proceed.
- Surface the real choices. When a genuine decision exists, give the options with their consequences, recommend one briefly, and invite the user to steer.
- Don't collapse to "go". Never jump straight from restating a request to "reply go" / "confirm". Reach a skill's confirmation gate only after real convergence — grounding, tradeoffs, a recommendation — has happened, and frame it as an invitation to steer, not a press to approve.
- Verify load-bearing claims. When a claim — yours or a subagent's — drives a decision, read the code yourself before relying on it.

Once scope is agreed, stop asking and act: implement decisively and autonomously, raising something again only when you're blocked, lack authority, or hit a choice that changes the agreed scope. Not every turn needs a question — when nothing genuine is unresolved, proceed.`;

const HARNESS_CONVENTIONS = `## Claude Code compatibility conventions (PiCC)

You are running a project authored for Claude Code. Honor its conventions:
- Claude tool names map onto your tools: Read/Write/Edit/Bash are read/write/edit/bash; use Grep/Glob/WebFetch/WebSearch/Agent/Task tools by their listed names.
- To use a skill from the listing below, call the Skill tool with its name (or the user invokes /name). Follow the skill's instructions exactly once loaded; bundled files are referenced relative to the skill directory.
- Subagents: dispatch with the Agent tool; choose subagent_type by matching the task against the agent descriptions in the catalog. Subagents run in the background by default — a dispatch returns a task id, not the result — so several dispatched in one turn run concurrently. Collect each result with TaskOutput before you rely on it or finalize an answer (or pass run_in_background: false for a synchronous inline result). Eligible uncollected results receive one bounded notice on a later interactive turn, but one-shot print mode may end before that turn. The collected result is the subagent's final message verbatim — parse it as the calling skill specifies.
- When a skill or instruction specifies an output format (e.g. a locked YAML block), reproduce it EXACTLY — downstream tooling parses it.
- Worktrees: EnterWorktree/ExitWorktree isolate work; while inside one, all relative paths and shell commands run there.
- Commits: when you're asked to commit — by the user, or by a skill or project instruction — first read the changes (git status/diff) and recent git log, and match this repository's commit-message style where it is richer; for a non-trivial change, still write a short body explaining why the change was made, not just what. Never use git commit --no-verify; project hooks must run.`;

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

  // Main-session-only (#69): posted after the mechanical conventions but before
  // CLAUDE.md/skills/steering, so those more-specific sections still get the last word.
  if (inputs.includeInteractionPosture === true) sections.push(INTERACTION_POSTURE);

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

  if (inputs.scratchDir) {
    sections.push(buildScratchpadSection(inputs.scratchDir, inputs.windowsTempNote === true));
  }

  return sections.join("\n\n");
}

/**
 * Scratchpad guidance section (#48/feature 25). Mirrors Claude Code's own scratchpad
 * section: an emphatic all-platform directive naming the literal resolved path and
 * steering temp files there instead of `/tmp` — Claude's actual contract (a
 * Claude-authored skill reads the path out of the prompt), so it MUST be the literal
 * path, not an env-var reference. On the shell↔native namespace split (Windows +
 * pinned Git Bash) an extra note explains why a bare `/tmp` fails and pins the safe
 * addressing of temp files. Wording kept imperative and short: the directive leads,
 * the rationale trails, so a less-reliable model obeys rather than skims.
 */
function buildScratchpadSection(scratchDir: string, windowsTempNote: boolean): string {
  const parts = [
    `IMPORTANT: Always use this per-session scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories: \`${scratchDir}\`` +
      "\n\nIt is session-specific and isolated from the project. Put every temporary file here — " +
      `whether you create it with a shell redirect (\`… > "${scratchDir}/name"\`), \`mktemp -p "${scratchDir}"\`, ` +
      "or the Write tool. When a skill asks only for a generic temporary or out-of-worktree location, " +
      "this directory is that location; defer to a skill only when it names a specific literal path of " +
      "its own. Only use `/tmp` if the user explicitly requests it.",
  ];
  if (windowsTempNote) {
    parts.push(
      "On Windows the harness shell (Git Bash) and the native Read/Grep/Glob tools resolve path " +
        "strings in different namespaces, so a bare `/tmp/...` path written through the Bash tool is " +
        "read drive-relative by the native tools and will not be found. Always address a temp file by " +
        `the scratchpad path above — redirect to \`"${scratchDir}/name"\` or run \`mktemp -p "${scratchDir}"\` — ` +
        "never a bare `/tmp/...`, `$TEMP`, or `$TMP`. Its forward-slash drive-letter form is resolved " +
        "identically by the shell and the native tools.",
    );
  }
  return `## Scratchpad directory\n\n${parts.join("\n\n")}`;
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
