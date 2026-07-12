/**
 * Agents loader (§4.3): parses `.claude/agents/*.md` files into ClaudeAgent
 * records and renders the description-driven routing catalog injected into
 * the orchestrator context.
 *
 * The subagent RUNTIME (dispatch tool, fan-out, depth caps) lives elsewhere;
 * this module only loads agent definitions and provides lookup/rendering.
 *
 * Completeness floor: never throws. Malformed files degrade with diagnostics.
 */

import path from "node:path";
import type {
  ClaudeAgent,
  Diagnostic,
  HookConfig,
  HookHandler,
  HookHandlerType,
  HookMatcherEntry,
  Scope,
} from "../types.js";
import { listDirSafe, readTextSafe } from "../util/fs.js";
import { parseMarkdown, toStringList } from "../util/markdown.js";

/** Frontmatter keys we recognize (everything else lands in unknownKeys). */
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "tools",
  "allowed-tools",
  "disallowedTools",
  "disallowed-tools",
  "model",
  "permissionMode",
  "maxTurns",
  "skills",
  "effort",
  "color",
  "isolation",
  "initialPrompt",
  "metadata",
  "memory",
  "mcpServers",
  "hooks",
]);

const KNOWN_HANDLER_TYPES: readonly string[] = [
  "command",
  "http",
  "prompt",
  "agent",
  "mcp_tool",
];

/** Tools whose presence makes an agent NOT read-only for catalog purposes. */
const WRITE_CAPABLE_TOOLS = new Set(["write", "edit", "bash"]);

export interface LoadAgentsResult {
  agents: ClaudeAgent[];
  diagnostics: Diagnostic[];
}

/**
 * Load agent definitions from the given directories (in the given order —
 * output order is deterministic: dir order, then sorted relative paths).
 *
 * Each `*.md` directly in an agent dir is an agent; one level of
 * subdirectories is also scanned (deeper nesting is ignored).
 */
export function loadAgents(
  agentDirs: Array<{ dir: string; scope: Scope }>,
  opts?: { pluginName?: string },
): LoadAgentsResult {
  const agents: ClaudeAgent[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const { dir, scope } of agentDirs) {
    for (const filePath of collectAgentFiles(dir)) {
      const agent = loadAgentFile(filePath, scope, diagnostics, opts?.pluginName);
      if (agent) agents.push(agent);
    }
  }
  return { agents, diagnostics };
}

/** *.md directly in dir plus one level of subdirectories, deterministically sorted. */
function collectAgentFiles(dir: string): string[] {
  const direct: string[] = [];
  const subdirs: string[] = [];
  for (const entry of listDirSafe(dir)) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      direct.push(path.join(dir, entry.name));
    } else if (entry.isDirectory()) {
      subdirs.push(entry.name);
    }
  }
  direct.sort((a, b) => compareNames(path.basename(a), path.basename(b)));
  subdirs.sort(compareNames);

  const out = [...direct];
  for (const sub of subdirs) {
    const subPath = path.join(dir, sub);
    const files = listDirSafe(subPath)
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => path.join(subPath, e.name))
      .sort((a, b) => compareNames(path.basename(a), path.basename(b)));
    out.push(...files);
  }
  return out;
}

/** Locale-independent name ordering (Windows-safe determinism). */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function loadAgentFile(
  filePath: string,
  scope: Scope,
  globalDiagnostics: Diagnostic[],
  pluginName?: string,
): ClaudeAgent | undefined {
  const content = readTextSafe(filePath);
  if (content === undefined) {
    globalDiagnostics.push({
      severity: "warning",
      message: "Could not read agent file; skipped",
      source: filePath,
    });
    return undefined;
  }

  const parsed = parseMarkdown(content, filePath);
  const fm = parsed.frontmatter;
  const agentDiagnostics: Diagnostic[] = [...parsed.diagnostics];

  // description is required: without it the agent has no routing surface.
  const description = toOptionalString(fm["description"]);
  if (!description || !description.trim()) {
    globalDiagnostics.push(...agentDiagnostics);
    globalDiagnostics.push({
      severity: "warning",
      message: "Agent has no description; skipped (description is the routing trigger)",
      source: filePath,
    });
    return undefined;
  }

  const name =
    toOptionalString(fm["name"])?.trim() || path.basename(filePath, path.extname(filePath));

  // tools / allowed-tools alias (tools wins when both present)
  const tools = toStringList(fm["tools"] !== undefined ? fm["tools"] : fm["allowed-tools"]);
  const disallowedTools = toStringList(
    fm["disallowedTools"] !== undefined ? fm["disallowedTools"] : fm["disallowed-tools"],
  );

  // model: "inherit" is the Claude default and means "no override".
  let model = toOptionalString(fm["model"])?.trim();
  if (model !== undefined && model.toLowerCase() === "inherit") model = undefined;
  if (model === "") model = undefined;

  const maxTurns = toOptionalNumber(fm["maxTurns"], "maxTurns", agentDiagnostics, filePath);

  // isolation: only "worktree" is recognized.
  let isolation: "worktree" | undefined;
  const isolationRaw = fm["isolation"];
  if (isolationRaw !== undefined && isolationRaw !== null) {
    const s = String(isolationRaw).trim().toLowerCase();
    if (s === "worktree") {
      isolation = "worktree";
    } else if (s !== "") {
      agentDiagnostics.push({
        severity: "warning",
        message: `Unrecognized isolation value "${String(isolationRaw)}"; ignored (only "worktree" is supported)`,
        source: filePath,
      });
    }
  }

  // metadata: must be a plain object.
  let metadata: Record<string, unknown> = {};
  const metadataRaw = fm["metadata"];
  if (metadataRaw !== undefined && metadataRaw !== null) {
    if (typeof metadataRaw === "object" && !Array.isArray(metadataRaw)) {
      metadata = metadataRaw as Record<string, unknown>;
    } else {
      agentDiagnostics.push({
        severity: "warning",
        message: "metadata frontmatter is not a mapping; ignored",
        source: filePath,
      });
    }
  }

  const hooks = normalizeHooks(fm["hooks"], agentDiagnostics, filePath);

  const unknownKeys = Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k));

  const agent: ClaudeAgent = {
    name,
    description,
    tools,
    disallowedTools,
    model,
    effort: toOptionalString(fm["effort"])?.trim() || undefined,
    permissionMode: toOptionalString(fm["permissionMode"])?.trim() || undefined,
    maxTurns,
    skills: toStringList(fm["skills"]),
    color: toOptionalString(fm["color"])?.trim() || undefined,
    isolation,
    initialPrompt: toOptionalString(fm["initialPrompt"]),
    metadata,
    // Deferred subsystems (§7): parsed and preserved raw, not interpreted here.
    memory: fm["memory"],
    mcpServers: fm["mcpServers"],
    hooks,
    body: parsed.body,
    source: { path: filePath, scope, pluginName },
    unknownKeys,
    diagnostics: agentDiagnostics,
  };
  return agent;
}

function toOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function toOptionalNumber(
  value: unknown,
  field: string,
  diagnostics: Diagnostic[],
  source: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  diagnostics.push({
    severity: "warning",
    message: `${field} is not a number ("${String(value)}"); ignored`,
    source,
  });
  return undefined;
}

/**
 * Light normalization of an agent-scoped `hooks:` block into HookConfig.
 * Deferred subsystem: shape is preserved (raw handler definitions kept on
 * `raw`) so nothing is lost; interpretation happens in the hooks engine.
 */
function normalizeHooks(
  value: unknown,
  diagnostics: Diagnostic[],
  source: string,
): HookConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push({
      severity: "warning",
      message: "hooks frontmatter is not a mapping; ignored",
      source,
    });
    return undefined;
  }
  const out: HookConfig = {};
  for (const [event, rawEntries] of Object.entries(value as Record<string, unknown>)) {
    const list = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
    const entries: HookMatcherEntry[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        diagnostics.push({
          severity: "warning",
          message: `hooks.${event} entry is not a mapping; ignored`,
          source,
        });
        continue;
      }
      const rec = item as Record<string, unknown>;
      const handlersRaw = Array.isArray(rec["hooks"]) ? (rec["hooks"] as unknown[]) : [];
      const handlers: HookHandler[] = [];
      for (const h of handlersRaw) {
        if (typeof h !== "object" || h === null || Array.isArray(h)) continue;
        const hr = h as Record<string, unknown>;
        const typeRaw = typeof hr["type"] === "string" ? hr["type"] : "command";
        if (!KNOWN_HANDLER_TYPES.includes(typeRaw)) {
          diagnostics.push({
            severity: "info",
            message: `hooks.${event} handler type "${typeRaw}" is not recognized; preserved for degraded handling`,
            source,
          });
        }
        handlers.push({
          // Unknown handler types are preserved as-is; the hooks engine degrades them.
          type: typeRaw as HookHandlerType,
          command: typeof hr["command"] === "string" ? hr["command"] : undefined,
          args: toStringList(hr["args"]),
          shell:
            hr["shell"] === "powershell" ? "powershell" : hr["shell"] === "bash" ? "bash" : undefined,
          timeout: typeof hr["timeout"] === "number" ? hr["timeout"] : undefined,
          once: typeof hr["once"] === "boolean" ? hr["once"] : undefined,
          async: typeof hr["async"] === "boolean" ? hr["async"] : undefined,
          url: typeof hr["url"] === "string" ? hr["url"] : undefined,
          raw: hr,
        });
      }
      entries.push({
        matcher: typeof rec["matcher"] === "string" ? rec["matcher"] : undefined,
        if: typeof rec["if"] === "string" ? rec["if"] : undefined,
        hooks: handlers,
      });
    }
    out[event] = entries;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Built-in agent types (audit E1/E6)
// ---------------------------------------------------------------------------

/** Truthy env-flag semantics: set and not an explicit "off" value. */
function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** Tools the read-only built-ins (Explore/Plan) must never receive. */
const READONLY_BUILTIN_DISALLOWED = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
];

/**
 * The Claude Code built-in agent types, constructed in code (audit E1):
 * `general-purpose` (all tools), `Explore` and `Plan` (read-only, skip
 * CLAUDE.md/rules — audit E6). Callers resolve project/user/plugin agents
 * FIRST so a same-named project agent overrides a built-in.
 * `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes Explore and Plan
 * (general-purpose always stays).
 */
export function builtinAgents(env: NodeJS.ProcessEnv = process.env): ClaudeAgent[] {
  const base = {
    metadata: {},
    source: { path: "<builtin>", scope: "builtin" as Scope },
    builtin: true,
    unknownKeys: [],
    diagnostics: [],
  };
  const agents: ClaudeAgent[] = [
    {
      ...base,
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks",
      body: "You are a general-purpose agent. Research the question or execute the task you are given thoroughly and autonomously, then reply with a concise, complete report of your findings and actions — the caller sees only your final message.",
    },
  ];
  if (!isEnvTruthy(env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS)) {
    agents.push(
      {
        ...base,
        name: "Explore",
        description:
          "Fast read-only agent for exploring the codebase: locating files, code, and answering questions by searching. Cannot edit files or dispatch further agents. Specify the desired thoroughness in the prompt (e.g. quick look vs. very thorough search across naming conventions).",
        disallowedTools: [...READONLY_BUILTIN_DISALLOWED],
        skipProjectContext: true,
        body: "You are a read-only exploration agent. Search and read the codebase to answer the question you were given — honor the thoroughness the caller asked for. Do not modify anything. Reply with your findings, citing absolute file paths (and line numbers where useful).",
      },
      {
        ...base,
        name: "Plan",
        description:
          "Software-architect agent for designing implementation plans: analyzes the codebase read-only and returns a step-by-step plan, the critical files involved, and the architectural trade-offs. Cannot edit files or dispatch further agents.",
        disallowedTools: [...READONLY_BUILTIN_DISALLOWED],
        skipProjectContext: true,
        body: "You are a software architect. Study the codebase read-only and design an implementation plan for the task you were given: concrete steps in order, the critical files to touch, and the trade-offs considered. Do not modify anything. Reply with the plan itself — the caller sees only your final message.",
      },
    );
  }
  return agents;
}

// ---------------------------------------------------------------------------
// Routing catalog
// ---------------------------------------------------------------------------

/**
 * Render the description-driven routing surface injected into the
 * orchestrator context. Input order is preserved (deterministic).
 */
export function renderAgentCatalog(agents: ClaudeAgent[]): string {
  const lines: string[] = [
    "Available subagents (dispatch with the Agent tool, subagent_type = name):",
  ];
  for (const agent of agents) {
    const marker = isReadOnlyAgent(agent) ? " (read-only)" : "";
    const descLines = agent.description.replace(/\r\n/g, "\n").split("\n");
    lines.push(`- ${agent.name}${marker}: ${descLines[0] ?? ""}`);
    for (const extra of descLines.slice(1)) {
      lines.push(`  ${extra}`);
    }
  }
  return lines.join("\n");
}

/** Read-only = an explicit tools allowlist containing none of Write/Edit/Bash. */
function isReadOnlyAgent(agent: ClaudeAgent): boolean {
  if (!agent.tools) return false; // undefined = inherits all tools
  return !agent.tools.some((t) => {
    const base = t.split("(")[0]?.trim().toLowerCase() ?? "";
    return WRITE_CAPABLE_TOOLS.has(base) || base === "*";
  });
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** Resolve a subagent_type: exact name match first, then case-insensitive fallback. */
export function resolveAgent(
  agents: ClaudeAgent[],
  subagentType: string,
): ClaudeAgent | undefined {
  const exact = agents.find((a) => a.name === subagentType);
  if (exact) return exact;
  const lower = subagentType.toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === lower);
}
