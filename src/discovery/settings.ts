import path from "node:path";
import { isFile, readTextSafe } from "../util/fs.js";
import { toBool } from "../util/markdown.js";
import type {
  ClaudeSettings,
  Diagnostic,
  HookHandler,
  HookHandlerType,
  HookMatcherEntry,
  Scope,
} from "../types.js";

/**
 * Settings loading & merging (plan §3, §5; research doc §4).
 *
 * Reads the standard settings hierarchy in ascending precedence:
 *   user (`<userDir>/settings.json`)
 *   → project (`<projectRoot>/.claude/settings.json`)
 *   → local (`<projectRoot>/.claude/settings.local.json`)
 *   → managed policy (platform-specific, highest; degrade-silent when absent)
 *
 * Merge semantics:
 * - `permissions.allow/deny/ask/additionalDirectories` ACCUMULATE across scopes (deduped).
 * - `hooks` accumulate per event (matcher entries concatenated).
 * - `env` merges key-wise, higher precedence wins.
 * - `claudeMdExcludes` accumulates (arrays merge across layers, per Claude docs).
 * - Scalar settings follow precedence (higher scope wins).
 *
 * Completeness floor: NO input throws. Malformed files degrade to a diagnostic and are
 * skipped; unrecognized keys land in `unknownKeys`; recognized-but-deferred keys land in
 * `deferredKeys`. JSONC tolerance: `//` line comments and trailing commas are stripped
 * before parsing (Claude Code tolerates these).
 */

export interface LoadSettingsOptions {
  cwd: string;
  projectRoot: string;
  userDir: string;
  /** Override managed/policy settings probe locations (used by tests). */
  managedPaths?: string[];
}

/** Keys recognized but gating DEFERRED subsystems (plan §7) — recorded, no-op. */
const DEFERRED_TOP_KEYS = new Set([
  "mcpServers",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "outputStyle",
  "statusLine",
  "forceLoginMethod",
  "awsAuthRefresh",
  "otelHeadersHelper",
  "checkpointing",
  "spinnerTipsEnabled",
  "alwaysThinkingEnabled",
  "plansDirectory",
  "showTurnDuration",
  "language",
  "autoUpdates",
]);

const KNOWN_HANDLER_TYPES: readonly string[] = ["command", "http", "prompt", "agent", "mcp_tool"];

/** Default managed/policy settings locations (research doc §4.1; degrade-silent when absent). */
function defaultManagedPaths(): string[] {
  if (process.platform === "win32") {
    return [path.join("C:\\", "ProgramData", "ClaudeCode", "managed-settings.json")];
  }
  return [path.join("/etc", "claude-code", "managed-settings.json")];
}

function createDefaultSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

/**
 * Strip `//` line comments, `/* ... ` block comments, and trailing commas from
 * JSONC-ish text, string-aware (never touches content inside string literals).
 */
export function stripJsonc(text: string): string {
  // Pass 1: remove comments.
  let noComments = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      noComments += ch;
      if (ch === "\\") {
        noComments += text.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      if (i < text.length) noComments += "\n";
      continue;
    }
    if (ch === "/" && text.charAt(i + 1) === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
      i += 1; // skip the closing "/" (loop increment skips past it)
      continue;
    }
    noComments += ch;
  }
  // Pass 2: drop trailing commas.
  let out = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += noComments.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments.charAt(j))) j++;
      const next = noComments.charAt(j);
      if (next === "}" || next === "]") continue; // trailing comma — drop it
    }
    out += ch;
  }
  return out;
}

/** Expand `${VAR}` from the process environment; unknown vars are left intact. */
export function expandEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => env[name] ?? match);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Coerce a settings value to string[], degrading non-string members with a diagnostic. */
function toStringArray(
  value: unknown,
  keyLabel: string,
  source: string,
  diagnostics: Diagnostic[],
): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "warning",
      message: `Setting "${keyLabel}" is not an array; ignored`,
      source,
    });
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      out.push(item);
    } else {
      diagnostics.push({
        severity: "warning",
        message: `Non-string entry in "${keyLabel}" ignored`,
        source,
      });
    }
  }
  return out;
}

function expectString(
  value: unknown,
  keyLabel: string,
  source: string,
  diagnostics: Diagnostic[],
): string | undefined {
  const s = asString(value);
  if (s === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `Setting "${keyLabel}" is not a string; ignored`,
      source,
    });
  }
  return s;
}

function expectNumber(
  value: unknown,
  keyLabel: string,
  source: string,
  diagnostics: Diagnostic[],
): number | undefined {
  const n = asFiniteNumber(value);
  if (n === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `Setting "${keyLabel}" is not a number; ignored`,
      source,
    });
  }
  return n;
}

function normalizeHookHandler(
  raw: Record<string, unknown>,
  source: string,
  diagnostics: Diagnostic[],
): HookHandler {
  const declared = asString(raw.type);
  // Missing type defaults to "command" (the overwhelmingly common Claude form).
  const type = (declared ?? "command") as HookHandlerType;
  if (declared !== undefined && !KNOWN_HANDLER_TYPES.includes(declared)) {
    diagnostics.push({
      severity: "info",
      message: `Unknown hook handler type "${declared}"; kept, will degrade at dispatch`,
      source,
    });
  }
  return {
    type,
    command: asString(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : undefined,
    shell: raw.shell === "powershell" ? "powershell" : raw.shell === "bash" ? "bash" : undefined,
    timeout: asFiniteNumber(raw.timeout),
    once: typeof raw.once === "boolean" ? raw.once : undefined,
    url: asString(raw.url),
    raw,
  };
}

/** Normalize a settings `hooks` block and concatenate its entries per event. */
function applyHooks(value: unknown, source: string, out: ClaudeSettings): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "hooks" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [event, entriesRaw] of Object.entries(value)) {
    if (!Array.isArray(entriesRaw)) {
      out.diagnostics.push({
        severity: "warning",
        message: `"hooks.${event}" is not an array; ignored`,
        source,
      });
      continue;
    }
    const entries: HookMatcherEntry[] = [];
    for (const entryRaw of entriesRaw) {
      if (!isPlainObject(entryRaw)) {
        out.diagnostics.push({
          severity: "warning",
          message: `Malformed matcher entry in "hooks.${event}" ignored`,
          source,
        });
        continue;
      }
      const handlers: HookHandler[] = [];
      if (Array.isArray(entryRaw.hooks)) {
        for (const handlerRaw of entryRaw.hooks) {
          if (isPlainObject(handlerRaw)) {
            handlers.push(normalizeHookHandler(handlerRaw, source, out.diagnostics));
          } else {
            out.diagnostics.push({
              severity: "warning",
              message: `Malformed hook handler in "hooks.${event}" ignored`,
              source,
            });
          }
        }
      } else {
        out.diagnostics.push({
          severity: "warning",
          message: `Matcher entry in "hooks.${event}" has no "hooks" array; kept with no handlers`,
          source,
        });
      }
      entries.push({
        matcher: asString(entryRaw.matcher),
        if: asString(entryRaw.if),
        hooks: handlers,
      });
    }
    if (entries.length > 0) {
      out.hooks[event] = [...(out.hooks[event] ?? []), ...entries];
    }
  }
}

function applyPermissions(value: unknown, scope: Scope, source: string, out: ClaudeSettings): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "permissions" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    switch (key) {
      case "allow":
      case "deny":
      case "ask":
        out.permissions[key].push(...toStringArray(sub, `permissions.${key}`, source, out.diagnostics));
        break;
      case "additionalDirectories":
        out.permissions.additionalDirectories.push(
          ...toStringArray(sub, "permissions.additionalDirectories", source, out.diagnostics).map((d) =>
            expandEnvVars(d),
          ),
        );
        break;
      case "defaultMode":
        // Interactive permission modes are a deferred subsystem (plan §6.1/§7): parsed, reported, no-op.
        out.deferredKeys.push({ key: "permissions.defaultMode", scope });
        if (typeof sub === "string") out.permissions.defaultMode = sub;
        break;
      case "disableBypassPermissionsMode":
        out.deferredKeys.push({ key: "permissions.disableBypassPermissionsMode", scope });
        break;
      default:
        out.unknownKeys.push({ key: `permissions.${key}`, scope });
        break;
    }
  }
}

function applyWorktree(value: unknown, scope: Scope, source: string, out: ClaudeSettings): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "worktree" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    if (key === "baseRef") {
      if (sub === "head" || sub === "fresh") {
        out.worktree.baseRef = sub;
      } else {
        out.diagnostics.push({
          severity: "warning",
          message: `"worktree.baseRef" must be "head" or "fresh" (got ${JSON.stringify(sub)}); keeping "${out.worktree.baseRef}"`,
          source,
        });
      }
    } else {
      out.unknownKeys.push({ key: `worktree.${key}`, scope });
    }
  }
}

function applySubagents(value: unknown, scope: Scope, source: string, out: ClaudeSettings): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "subagents" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    switch (key) {
      case "enabled":
        out.subagentsEnabled = toBool(sub, out.subagentsEnabled);
        break;
      case "maxDepth": {
        const n = expectNumber(sub, "subagents.maxDepth", source, out.diagnostics);
        if (n !== undefined) out.subagentMaxDepth = n;
        break;
      }
      case "concurrency": {
        const n = expectNumber(sub, "subagents.concurrency", source, out.diagnostics);
        if (n !== undefined) out.subagentConcurrency = n;
        break;
      }
      default:
        out.unknownKeys.push({ key: `subagents.${key}`, scope });
        break;
    }
  }
}

/** Apply one parsed settings file onto the accumulating result (called in ascending precedence). */
function applySettingsFile(
  raw: Record<string, unknown>,
  scope: Scope,
  source: string,
  out: ClaudeSettings,
): void {
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "$schema":
        break; // editor metadata — recognized no-op
      case "permissions":
        applyPermissions(value, scope, source, out);
        break;
      case "hooks":
        applyHooks(value, source, out);
        break;
      case "env": {
        if (!isPlainObject(value)) {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "env" is not an object; ignored`,
            source,
          });
          break;
        }
        for (const [envKey, envVal] of Object.entries(value)) {
          out.env[envKey] = expandEnvVars(String(envVal));
        }
        break;
      }
      case "model": {
        const s = expectString(value, "model", source, out.diagnostics);
        if (s !== undefined) out.model = expandEnvVars(s);
        break;
      }
      case "includeCoAuthoredBy":
        out.includeCoAuthoredBy = toBool(value, true);
        break;
      case "attribution": {
        if (isPlainObject(value)) {
          out.attribution = value;
        } else {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "attribution" is not an object; ignored`,
            source,
          });
        }
        break;
      }
      case "disableAllHooks":
        out.disableAllHooks = toBool(value, false);
        break;
      case "disableSkillShellExecution":
        out.disableSkillShellExecution = toBool(value, false);
        break;
      case "skillListingBudgetFraction": {
        const n = expectNumber(value, "skillListingBudgetFraction", source, out.diagnostics);
        if (n !== undefined) out.skillListingBudgetFraction = n;
        break;
      }
      case "skillListingMaxDescChars": {
        const n = expectNumber(value, "skillListingMaxDescChars", source, out.diagnostics);
        if (n !== undefined) out.skillListingMaxDescChars = n;
        break;
      }
      case "skillOverrides": {
        if (isPlainObject(value)) {
          Object.assign(out.skillOverrides, value);
        } else {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "skillOverrides" is not an object; ignored`,
            source,
          });
        }
        break;
      }
      case "claudeMdExcludes":
        // Arrays merge across settings layers (Claude docs), so accumulate.
        out.claudeMdExcludes.push(
          ...toStringArray(value, "claudeMdExcludes", source, out.diagnostics),
        );
        break;
      case "worktree":
        applyWorktree(value, scope, source, out);
        break;
      case "cleanupPeriodDays": {
        const n = expectNumber(value, "cleanupPeriodDays", source, out.diagnostics);
        if (n !== undefined) out.cleanupPeriodDays = n;
        break;
      }
      case "apiKeyHelper": {
        const s = expectString(value, "apiKeyHelper", source, out.diagnostics);
        if (s !== undefined) out.apiKeyHelper = expandEnvVars(s);
        break;
      }
      case "enabledPlugins": {
        if (isPlainObject(value)) {
          out.enabledPlugins = value as Record<string, boolean>;
        } else if (Array.isArray(value)) {
          out.enabledPlugins = value.map((v) => String(v));
        } else {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "enabledPlugins" is not an object or array; ignored`,
            source,
          });
        }
        break;
      }
      case "subagents":
        applySubagents(value, scope, source, out);
        break;
      case "disableSubagents":
        out.subagentsEnabled = !toBool(value, false);
        break;
      default:
        if (DEFERRED_TOP_KEYS.has(key)) {
          out.deferredKeys.push({ key, scope });
        } else {
          out.unknownKeys.push({ key, scope });
        }
        break;
    }
  }
}

/**
 * Load and merge the full settings hierarchy for a project.
 * Never throws — every problem degrades to a Diagnostic on the result.
 */
export function loadSettings(opts: LoadSettingsOptions): ClaudeSettings {
  const settings = createDefaultSettings();
  const managed = opts.managedPaths ?? defaultManagedPaths();

  // Ascending precedence: later files win on scalar conflicts.
  const files: Array<{ path: string; scope: Scope }> = [
    { path: path.join(opts.userDir, "settings.json"), scope: "user" },
    { path: path.join(opts.projectRoot, ".claude", "settings.json"), scope: "project" },
    { path: path.join(opts.projectRoot, ".claude", "settings.local.json"), scope: "local" },
    ...managed.map((p) => ({ path: p, scope: "managed" as Scope })),
  ];

  for (const file of files) {
    if (!isFile(file.path)) continue; // absent — degrade silently (incl. managed/policy)
    const text = readTextSafe(file.path);
    if (text === undefined) {
      settings.diagnostics.push({
        severity: "warning",
        message: "Settings file unreadable; skipped",
        source: file.path,
      });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonc(text));
    } catch (err) {
      settings.diagnostics.push({
        severity: "error",
        message: `Malformed settings JSON (${(err as Error).message}); file skipped`,
        source: file.path,
      });
      continue;
    }
    if (!isPlainObject(parsed)) {
      settings.diagnostics.push({
        severity: "error",
        message: "Settings root is not an object; file skipped",
        source: file.path,
      });
      continue;
    }
    applySettingsFile(parsed, file.scope, file.path, settings);
  }

  // Accumulating rule lists dedup while preserving first-seen order.
  const dedupe = (arr: string[]): string[] => Array.from(new Set(arr));
  settings.permissions.allow = dedupe(settings.permissions.allow);
  settings.permissions.deny = dedupe(settings.permissions.deny);
  settings.permissions.ask = dedupe(settings.permissions.ask);
  settings.permissions.additionalDirectories = dedupe(settings.permissions.additionalDirectories);
  settings.claudeMdExcludes = dedupe(settings.claudeMdExcludes);

  return settings;
}
