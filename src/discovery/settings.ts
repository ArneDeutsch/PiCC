import path from "node:path";
import { isFile, readTextSafe } from "../util/fs.js";
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
 *   → project (`.claude/settings.json` + `.claude/settings.local.json` at every
 *     directory from the repo root down to cwd — monorepo walk-up, nearest wins)
 *   → managed policy (platform-specific, highest; degrade-silent when absent)
 *
 * Merge semantics:
 * - `permissions.allow/deny/ask/additionalDirectories` ACCUMULATE across scopes (deduped).
 * - `hooks` accumulate per event (matcher entries concatenated).
 * - `env` merges key-wise, higher precedence wins.
 * - `enabledPlugins` merges key-wise, higher precedence wins per plugin key.
 * - `claudeMdExcludes` accumulates (arrays merge across layers, per Claude docs).
 * - Scalar settings follow precedence (higher scope wins; a malformed value at a
 *   higher scope is ignored with a diagnostic, keeping the lower-scope value).
 *
 * Completeness floor: NO input throws. Malformed files degrade to a diagnostic and are
 * skipped; unrecognized keys land in `unknownKeys`; recognized-but-deferred keys land in
 * `deferredKeys`. JSONC tolerance: `//` line comments and trailing commas are stripped
 * before parsing (Claude Code tolerates these).
 */

export interface LoadSettingsOptions {
  /** Launch directory; nested `.claude/settings*.json` between here and projectRoot load too. */
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
  // A UTF-8 BOM (written by Notepad / PowerShell 5.1 by default) must not
  // reject the file — JSON.parse chokes on it, and losing a settings file
  // silently drops its deny rules.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
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

/**
 * JSON-controlled keys that collide with `Object.prototype` members ("__proto__",
 * "constructor", "toString", ...) must never become keys of plain-object
 * accumulators: assigning "__proto__" rewires the prototype and reading an
 * inherited member instead of an own entry crashes or corrupts downstream
 * merges (never-throw floor). Such keys are dropped with a diagnostic.
 */
function isUnsafeKey(key: string): boolean {
  return key in Object.prototype;
}

function skipUnsafeKey(key: string, keyLabel: string, source: string, diagnostics: Diagnostic[]): boolean {
  if (!isUnsafeKey(key)) return false;
  diagnostics.push({
    severity: "warning",
    message: `Unsafe key "${key}" in "${keyLabel}" ignored`,
    source,
  });
  return true;
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

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(s)) return true;
    if (["false", "no", "off", "0"].includes(s)) return false;
  }
  return undefined;
}

/**
 * Boolean coercion mirroring expectNumber/expectString: an unrecognized value
 * is IGNORED with a diagnostic (returns undefined), so a malformed value at a
 * higher scope never resets a lower scope's explicit setting.
 */
function expectBool(
  value: unknown,
  keyLabel: string,
  source: string,
  diagnostics: Diagnostic[],
): boolean | undefined {
  const b = asBool(value);
  if (b === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `Setting "${keyLabel}" is not a boolean; ignored`,
      source,
    });
  }
  return b;
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
    if (skipUnsafeKey(event, "hooks", source, out.diagnostics)) continue;
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
      const existing = Object.hasOwn(out.hooks, event) ? out.hooks[event]! : [];
      out.hooks[event] = [...existing, ...entries];
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
      case "enabled": {
        const b = expectBool(sub, "subagents.enabled", source, out.diagnostics);
        if (b !== undefined) out.subagentsEnabled = b;
        break;
      }
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
          if (skipUnsafeKey(envKey, "env", source, out.diagnostics)) continue;
          out.env[envKey] = expandEnvVars(String(envVal));
        }
        break;
      }
      case "model": {
        const s = expectString(value, "model", source, out.diagnostics);
        if (s !== undefined) out.model = expandEnvVars(s);
        break;
      }
      case "includeCoAuthoredBy": {
        const b = expectBool(value, "includeCoAuthoredBy", source, out.diagnostics);
        if (b !== undefined) out.includeCoAuthoredBy = b;
        break;
      }
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
      case "disableAllHooks": {
        const b = expectBool(value, "disableAllHooks", source, out.diagnostics);
        if (b !== undefined) out.disableAllHooks = b;
        break;
      }
      case "disableSkillShellExecution": {
        const b = expectBool(value, "disableSkillShellExecution", source, out.diagnostics);
        if (b !== undefined) out.disableSkillShellExecution = b;
        break;
      }
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
          for (const [skillKey, mode] of Object.entries(value)) {
            if (skipUnsafeKey(skillKey, "skillOverrides", source, out.diagnostics)) continue;
            out.skillOverrides[skillKey] = mode;
          }
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
        // Key-wise merge across scopes (like `env`): the nearer scope wins PER
        // PLUGIN KEY — a project file enabling its own plugins must not wipe the
        // user's enabled set. Array form normalizes to `{ name: true }`.
        let entries: Array<[string, boolean]> | undefined;
        if (isPlainObject(value)) {
          entries = Object.entries(value).map(([k, v]) => [k, Boolean(v)]);
        } else if (Array.isArray(value)) {
          entries = value.map((v) => [String(v), true]);
        }
        if (entries === undefined) {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "enabledPlugins" is not an object or array; ignored`,
            source,
          });
          break;
        }
        const merged: Record<string, boolean> = isPlainObject(out.enabledPlugins)
          ? out.enabledPlugins
          : {};
        for (const [pluginKey, enabled] of entries) {
          if (skipUnsafeKey(pluginKey, "enabledPlugins", source, out.diagnostics)) continue;
          merged[pluginKey] = enabled;
        }
        out.enabledPlugins = merged;
        break;
      }
      case "subagents":
        applySubagents(value, scope, source, out);
        break;
      case "disableSubagents": {
        const b = expectBool(value, "disableSubagents", source, out.diagnostics);
        if (b !== undefined) out.subagentsEnabled = !b;
        break;
      }
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
/** Path equality that tolerates Windows case-insensitivity. */
function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  if (process.platform === "win32") return ra.toLowerCase() === rb.toLowerCase();
  return ra === rb;
}

/**
 * Directories contributing project-scope settings, ordered ROOT-FIRST so the
 * nearest directory is applied last (= wins on scalar conflicts). Mirrors the
 * monorepo walk-up of discoverArtifactDirs (plan §3): cwd up to projectRoot.
 */
function settingsDirChain(cwd: string, projectRoot: string): string[] {
  const chain: string[] = [];
  const root = path.resolve(projectRoot);
  let dir = path.resolve(cwd);
  for (;;) {
    chain.push(dir);
    if (samePath(dir, root)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root without meeting projectRoot
    dir = parent;
  }
  return chain.reverse();
}

export function loadSettings(opts: LoadSettingsOptions): ClaudeSettings {
  const settings = createDefaultSettings();
  const managed = opts.managedPaths ?? defaultManagedPaths();

  // Ascending precedence: later files win on scalar conflicts. Project scope
  // walks repo root → cwd so nested/monorepo .claude/settings.json files load
  // too, nearest directory last (highest of the project layers).
  const files: Array<{ path: string; scope: Scope }> = [
    { path: path.join(opts.userDir, "settings.json"), scope: "user" },
  ];
  for (const dir of settingsDirChain(opts.cwd, opts.projectRoot)) {
    files.push({ path: path.join(dir, ".claude", "settings.json"), scope: "project" });
    files.push({ path: path.join(dir, ".claude", "settings.local.json"), scope: "local" });
  }
  files.push(...managed.map((p) => ({ path: p, scope: "managed" as Scope })));

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
