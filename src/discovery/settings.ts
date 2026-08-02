import path from "node:path";
import { isFile, readTextSafe } from "../util/fs.js";
import {
  isDocumentedMarketplaceName,
  normalizeMarketplacePolicyDescriptor,
  normalizeMarketplaceRegistrationRecord,
} from "../util/plugin-marketplace-descriptor.js";
import {
  createPluginDiagnosticReporter,
  discoverManagedPolicy,
  isQualifiedPluginId,
  mergeManagedObject,
  stripJsonc,
  type ManagedPolicyDiscoveryOptions,
} from "./managed-policy.js";
import type {
  ClaudeSettings,
  Diagnostic,
  HookHandler,
  HookHandlerType,
  HookMatcherEntry,
  McpSettingsEntry,
  PluginMarketplaceSettingsContribution,
  Scope,
} from "../types.js";

export { stripJsonc } from "./managed-policy.js";

/**
 * Settings loading and merging in ascending scope precedence. Managed files,
 * drop-ins, and registry values are validated in source order while preserving
 * their deep-object and stable-array merge behavior at managed scope.
 *
 * Rule lists and hooks accumulate, `env` and `enabledPlugins` merge key-wise,
 * and valid scalar values replace lower-precedence values. Malformed entries
 * diagnose without discarding unrelated settings or valid lower-scope values.
 */
export interface LoadSettingsOptions {
  /** Launch directory; nested settings between here and projectRoot load too. */
  cwd: string;
  projectRoot: string;
  userDir: string;
  /** Explicit paths bypass ambient managed-policy discovery. */
  managedPaths?: string[];
  /** Injectable ambient managed-policy boundary (used by deterministic tests). */
  managedPolicy?: ManagedPolicyDiscoveryOptions;
}

const DEFERRED_TOP_KEYS = new Set([
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

function createDefaultSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    autoMemoryEnabled: true,
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    // maxDepth accepts positive integers, but nesting requires a value greater than 1.
    // Main-session-only remains the default to avoid unexpected recursive fan-out
    // draining subscription capacity (a PiCC extension, not Claude-settings parity).
    subagentMaxDepth: 1,
    subagentConcurrency: 10,
    enabledPlugins: undefined,
    effectivePluginEnablement: {},
    pluginMarketplaceSettings: [],
    pluginMarketplaceSettingsOmissions: { contributions: 0, declarations: 0 },
    mcpSettings: [],
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

/**
 * Expand `${VAR}` and `${VAR:-default}` from the process environment.
 * - `${VAR}` with an unset variable keeps the literal text and reports the
 *   variable name via `onUnset` (callers surface it as a warning diagnostic).
 * - `${VAR:-default}` substitutes the default ONLY when the variable is unset;
 *   an empty-string value counts as set and yields `""` (Claude Code
 *   semantics — NOT bash `:-`, which would also default on empty). The default
 *   ends at the first `}`, so it cannot itself contain `}`.
 */
export function expandEnvVars(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
  onUnset?: (name: string) => void,
): string {
  // The FUNCTION replacer form is load-bearing: a string replacement would let
  // env values containing `$&`/`$'`-style replacement patterns inject text.
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
    (match, name: string, defaultPart?: string, defaultValue?: string) => {
      const current = env[name];
      if (defaultPart !== undefined) {
        return current !== undefined ? current : (defaultValue ?? "");
      }
      if (current === undefined) {
        onUnset?.(name);
        return match;
      }
      return current;
    },
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalSettingValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSettingValue).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSettingValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
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

/**
 * Positive-integer validation mirroring expectNumber: accepts a value only as an
 * integer >= 1 (reusing asFiniteNumber's string tolerance), IGNORING anything
 * else (zero, negative, fractional, non-numeric) with a diagnostic — so a
 * malformed value at a higher scope never overrides a valid lower-scope value.
 * Reject-and-keep, never clamp: clamping a bad higher-scope value (e.g. 0 -> 1)
 * would wrongly override a lower scope's explicit setting. No upper bound.
 */
function expectPositiveInt(
  value: unknown,
  keyLabel: string,
  source: string,
  diagnostics: Diagnostic[],
): number | undefined {
  const n = asFiniteNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < 1) {
    diagnostics.push({
      severity: "warning",
      message: `Setting "${keyLabel}" must be a positive integer (>= 1); ignored`,
      source,
    });
    return undefined;
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
    async: typeof raw.async === "boolean" ? raw.async : undefined,
    url: asString(raw.url),
    raw,
  };
}

interface ManagedApplyState {
  hookEntries: Map<string, Set<string>>;
  attributionOwned: boolean;
  skillOverrideKeys: Set<string>;
}

/** Normalize a settings `hooks` block and concatenate its entries per event. */
function applyHooks(
  value: unknown,
  source: string,
  out: ClaudeSettings,
  managedState?: ManagedApplyState,
): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "hooks" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [event, entriesRaw] of Object.entries(value)) {
    const eventSource = source;
    if (skipUnsafeKey(event, "hooks", eventSource, out.diagnostics)) continue;
    if (!Array.isArray(entriesRaw)) {
      out.diagnostics.push({
        severity: "warning",
        message: `"hooks.${event}" is not an array; ignored`,
        source: eventSource,
      });
      continue;
    }
    const entries: HookMatcherEntry[] = [];
    for (const entryRaw of entriesRaw) {
      if (!isPlainObject(entryRaw)) {
        out.diagnostics.push({
          severity: "warning",
          message: `Malformed matcher entry in "hooks.${event}" ignored`,
          source: eventSource,
        });
        continue;
      }
      const handlers: HookHandler[] = [];
      if (Array.isArray(entryRaw.hooks)) {
        for (const handlerRaw of entryRaw.hooks) {
          if (isPlainObject(handlerRaw)) {
            handlers.push(normalizeHookHandler(handlerRaw, eventSource, out.diagnostics));
          } else {
            out.diagnostics.push({
              severity: "warning",
              message: `Malformed hook handler in "hooks.${event}" ignored`,
              source: eventSource,
            });
          }
        }
      } else {
        out.diagnostics.push({
          severity: "warning",
          message: `Matcher entry in "hooks.${event}" has no "hooks" array; kept with no handlers`,
          source: eventSource,
        });
      }
      const entry = {
        matcher: asString(entryRaw.matcher),
        if: asString(entryRaw.if),
        hooks: handlers,
      };
      if (managedState !== undefined) {
        const seen = managedState.hookEntries.get(event) ?? new Set<string>();
        managedState.hookEntries.set(event, seen);
        const identity = canonicalSettingValue(entryRaw);
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      entries.push(entry);
    }
    if (entries.length > 0) {
      const existing = Object.hasOwn(out.hooks, event) ? out.hooks[event]! : [];
      out.hooks[event] = [...existing, ...entries];
    }
  }
}

function applyPermissions(
  value: unknown,
  scope: Scope,
  source: string,
  out: ClaudeSettings,
): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "permissions" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    const fieldSource = source;
    switch (key) {
      case "allow":
      case "deny":
      case "ask":
        out.permissions[key].push(
          ...toStringArray(sub, `permissions.${key}`, fieldSource, out.diagnostics),
        );
        break;
      case "additionalDirectories":
        out.permissions.additionalDirectories.push(
          ...toStringArray(
            sub,
            "permissions.additionalDirectories",
            fieldSource,
            out.diagnostics,
          ).map((d) =>
            expandEnvVars(d),
          ),
        );
        break;
      case "defaultMode":
        // Interactive permission modes are a deferred subsystem: parsed, reported, no-op.
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

function applyWorktree(
  value: unknown,
  scope: Scope,
  source: string,
  out: ClaudeSettings,
): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "worktree" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    const fieldSource = source;
    if (key === "baseRef") {
      if (sub === "head" || sub === "fresh") {
        out.worktree.baseRef = sub;
      } else {
        out.diagnostics.push({
          severity: "warning",
          message: `"worktree.baseRef" must be "head" or "fresh" (got ${JSON.stringify(sub)}); keeping "${out.worktree.baseRef}"`,
          source: fieldSource,
        });
      }
    } else {
      out.unknownKeys.push({ key: `worktree.${key}`, scope });
    }
  }
}

function applySubagents(
  value: unknown,
  scope: Scope,
  source: string,
  out: ClaudeSettings,
): void {
  if (!isPlainObject(value)) {
    out.diagnostics.push({
      severity: "warning",
      message: `Setting "subagents" is not an object; ignored`,
      source,
    });
    return;
  }
  for (const [key, sub] of Object.entries(value)) {
    const fieldSource = source;
    switch (key) {
      case "enabled": {
        const b = expectBool(sub, "subagents.enabled", fieldSource, out.diagnostics);
        if (b !== undefined) out.subagentsEnabled = b;
        break;
      }
      case "maxDepth": {
        const n = expectPositiveInt(sub, "subagents.maxDepth", fieldSource, out.diagnostics);
        if (n !== undefined) out.subagentMaxDepth = n;
        break;
      }
      case "concurrency": {
        const n = expectPositiveInt(sub, "subagents.concurrency", fieldSource, out.diagnostics);
        if (n !== undefined) out.subagentConcurrency = n;
        break;
      }
      default:
        out.unknownKeys.push({ key: `subagents.${key}`, scope });
        break;
    }
  }
}

/**
 * Find-or-create the scope-tagged MCP entry for the settings file currently
 * being applied. MCP keys are captured per file and NEVER merged across
 * scopes: the enablement gate (discovery/mcp.ts) needs each value's origin.
 */
function mcpEntryFor(out: ClaudeSettings, scope: Scope, source: string): McpSettingsEntry {
  const list = (out.mcpSettings ??= []);
  const last = list[list.length - 1];
  if (
    last !== undefined &&
    (last.sourcePath === source || (scope === "managed" && last.scope === "managed"))
  ) {
    last.sourcePath = source;
    return last;
  }
  const entry: McpSettingsEntry = { scope, sourcePath: source };
  list.push(entry);
  return entry;
}

const MAX_MARKETPLACE_SETTINGS_CONTRIBUTIONS = 256;
const MAX_MARKETPLACE_SETTINGS_DECLARATIONS = 256;

function marketplaceDeclarationCount(out: ClaudeSettings): number {
  return (out.pluginMarketplaceSettings ?? []).reduce((count, contribution) =>
    count + Object.keys(contribution.extraKnownMarketplaces ?? {}).length +
    (contribution.strictKnownMarketplaces?.length ?? 0) + (contribution.blockedMarketplaces?.length ?? 0), 0);
}

function reportMarketplaceOmission(out: ClaudeSettings, kind: "contributions" | "declarations", source: string): void {
  const omissions = (out.pluginMarketplaceSettingsOmissions ??= { contributions: 0, declarations: 0 });
  omissions[kind]++;
  if (omissions[kind] === 1) out.diagnostics.push({
    severity: "warning",
    message: `Additional plugin marketplace settings ${kind} omitted after the aggregate safe limit`,
    source,
  });
}

function marketplaceEntryFor(
  out: ClaudeSettings,
  scope: Scope,
  source: string,
): PluginMarketplaceSettingsContribution | undefined {
  const list = (out.pluginMarketplaceSettings ??= []);
  const last = list.at(-1);
  if (last !== undefined && last.scope === scope && last.sourcePath === source) return last;
  if (list.length >= MAX_MARKETPLACE_SETTINGS_CONTRIBUTIONS) {
    reportMarketplaceOmission(out, "contributions", source);
    return undefined;
  }
  const entry: PluginMarketplaceSettingsContribution = { scope, sourcePath: source };
  list.push(entry);
  return entry;
}

/** Apply one parsed settings file onto the accumulating result (called in ascending precedence). */
function applySettingsFile(
  raw: Record<string, unknown>,
  scope: Scope,
  source: string,
  out: ClaudeSettings,
  managedState?: ManagedApplyState,
): void {
  for (const [key, value] of Object.entries(raw)) {
    switch (key) {
      case "$schema":
        break; // editor metadata — recognized no-op
      case "permissions":
        applyPermissions(value, scope, source, out);
        break;
      case "hooks":
        applyHooks(value, source, out, managedState);
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
          if (scope === "managed") {
            const firstManaged = managedState !== undefined && !managedState.attributionOwned;
            if (managedState !== undefined) managedState.attributionOwned = true;
            out.attribution = mergeManagedObject(
              firstManaged || out.attribution === undefined
                ? (Object.create(null) as Record<string, unknown>)
                : out.attribution,
              value,
            );
          } else {
            out.attribution = value;
          }
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
            const current = out.skillOverrides[skillKey];
            if (scope === "managed") {
              const firstManaged =
                managedState !== undefined && !managedState.skillOverrideKeys.has(skillKey);
              managedState?.skillOverrideKeys.add(skillKey);
              out.skillOverrides[skillKey] =
                !firstManaged && isPlainObject(current) && isPlainObject(mode)
                  ? mergeManagedObject(current, mode)
                  : isPlainObject(mode)
                    ? mergeManagedObject(
                        Object.create(null) as Record<string, unknown>,
                        mode,
                      )
                    : mode;
            } else {
              out.skillOverrides[skillKey] = mode;
            }
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
      case "autoMemoryEnabled": {
        const b = expectBool(value, "autoMemoryEnabled", source, out.diagnostics);
        if (b !== undefined) out.autoMemoryEnabled = b;
        break;
      }
      case "autoMemoryDirectory": {
        const s = expectString(value, "autoMemoryDirectory", source, out.diagnostics);
        if (s !== undefined) out.autoMemoryDirectory = expandEnvVars(s);
        break;
      }
      case "claudeMd": {
        // Inline CLAUDE.md content is a managed-policy mechanism: only
        // the managed scope may inject it; elsewhere it is ignored with a diagnostic.
        if (scope !== "managed") {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "claudeMd" is only honored in managed settings; ignored`,
            source,
          });
          break;
        }
        const s = expectString(value, "claudeMd", source, out.diagnostics);
        if (s !== undefined) out.managedClaudeMd = { content: s, source };
        break;
      }
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
        const report = createPluginDiagnosticReporter(source, out.diagnostics);
        if (!isPlainObject(value)) {
          report('Setting "enabledPlugins" is not an object; ignored');
          break;
        }
        // Merge per qualified identity: a higher scope may override one plugin,
        // but must not erase unrelated enablement from a lower scope.
        const merged = out.enabledPlugins ?? {};
        for (const [pluginKey, enabled] of Object.entries(value)) {
          const entrySource = source;
          if (!isQualifiedPluginId(pluginKey)) {
            report('Invalid plugin identity in "enabledPlugins" ignored');
            continue;
          }
          if (typeof enabled !== "boolean") {
            report(`Plugin "${pluginKey}" in "enabledPlugins" must be a literal boolean; ignored`);
            continue;
          }
          merged[pluginKey] = enabled;
          (out.effectivePluginEnablement ??= {})[pluginKey] = {
            enabled,
            scope,
            source: entrySource,
          };
        }
        out.enabledPlugins = Object.keys(merged).length > 0 ? merged : undefined;
        break;
      }
      case "subagents":
        applySubagents(value, scope, source, out);
        break;
      case "extraKnownMarketplaces": {
        if (!isPlainObject(value)) {
          out.diagnostics.push({
            severity: "warning",
            message: 'Setting "extraKnownMarketplaces" is not an object; ignored',
            source,
          });
          break;
        }
        const entry = marketplaceEntryFor(out, scope, source);
        if (entry === undefined) break;
        const declarations: NonNullable<PluginMarketplaceSettingsContribution["extraKnownMarketplaces"]> = Object.create(null);
        let remaining = Math.max(0, MAX_MARKETPLACE_SETTINGS_DECLARATIONS - marketplaceDeclarationCount(out));
        let invalidNameIndex = 0;
        for (const name of Object.keys(value).sort()) {
          if (remaining-- <= 0) {
            reportMarketplaceOmission(out, "declarations", source);
            continue;
          }
          const normalized = normalizeMarketplaceRegistrationRecord(value[name], scope);
          const validName = isDocumentedMarketplaceName(name);
          const observation = validName ? normalized : { validity: "invalid" as const };
          declarations[validName ? name : `<invalid-marketplace-${invalidNameIndex++}>`] = observation;
          if (!validName || observation.validity !== "valid") out.diagnostics.push({
            severity: "warning",
            message: `Setting "extraKnownMarketplaces.${validName ? name : "<redacted-invalid-name>"}" has an invalid name or a malformed, unsafe, or indeterminate descriptor; retained as inert evidence`,
            source,
          });
        }
        entry.extraKnownMarketplaces = declarations;
        break;
      }
      case "strictKnownMarketplaces":
      case "blockedMarketplaces": {
        if (!Array.isArray(value)) {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "${key}" is not an array; ignored`,
            source,
          });
          break;
        }
        const entry = marketplaceEntryFor(out, scope, source);
        if (entry === undefined) break;
        const remaining = Math.max(0, MAX_MARKETPLACE_SETTINGS_DECLARATIONS - marketplaceDeclarationCount(out));
        entry[key] = value.slice(0, remaining).map((raw, index) => {
          const observation = normalizeMarketplacePolicyDescriptor(raw);
          if (observation.validity !== "valid") out.diagnostics.push({
            severity: "warning",
            message: `Setting "${key}[${index}]" has a malformed, unsafe, or unsupported descriptor; retained as inert evidence`,
            source,
          });
          return observation;
        });
        for (let index = remaining; index < value.length; index++) reportMarketplaceOmission(out, "declarations", source);
        break;
      }
      case "mcpServers": {
        if (!isPlainObject(value)) {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "mcpServers" is not an object; ignored`,
            source,
          });
          break;
        }
        // Null-prototype copy: server names are JSON-controlled and may
        // collide with Object.prototype members ("constructor", "toString").
        const servers: Record<string, unknown> = Object.create(null);
        for (const [name, entryRaw] of Object.entries(value)) servers[name] = entryRaw;
        const entry = mcpEntryFor(out, scope, source);
        entry.servers =
          scope === "managed" && entry.servers !== undefined
            ? mergeManagedObject(entry.servers, servers)
            : servers;
        break;
      }
      case "enableAllProjectMcpServers": {
        const b = expectBool(value, "enableAllProjectMcpServers", source, out.diagnostics);
        if (b !== undefined) mcpEntryFor(out, scope, source).enableAllProjectMcpServers = b;
        break;
      }
      case "enabledMcpjsonServers":
      case "disabledMcpjsonServers": {
        // Deliberately stricter than toStringArray alone: a bare string is NOT
        // coerced to a one-element list for these security-gating keys.
        if (!Array.isArray(value)) {
          out.diagnostics.push({
            severity: "warning",
            message: `Setting "${key}" is not an array; ignored`,
            source,
          });
          break;
        }
        const entry = mcpEntryFor(out, scope, source);
        const strings = toStringArray(value, key, source, out.diagnostics);
        entry[key] =
          scope === "managed" ? Array.from(new Set([...(entry[key] ?? []), ...strings])) : strings;
        break;
      }
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
 * monorepo walk-up of discoverArtifactDirs: cwd up to projectRoot.
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

/**
 * Load and merge the full settings hierarchy for a project.
 * Never throws — every problem degrades to a Diagnostic on the result.
 */
export function loadSettings(opts: LoadSettingsOptions): ClaudeSettings {
  const settings = createDefaultSettings();

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

  const managed = discoverManagedPolicy({
    ...opts.managedPolicy,
    ...(opts.managedPaths !== undefined ? { overridePaths: opts.managedPaths } : {}),
  });
  const managedState: ManagedApplyState = {
    hookEntries: new Map(),
    attributionOwned: false,
    skillOverrideKeys: new Set(),
  };
  for (const event of managed.events) {
    if (event.type === "diagnostic") {
      settings.diagnostics.push(event.diagnostic);
    } else {
      applySettingsFile(
        event.source.value,
        "managed",
        event.source.source,
        settings,
        managedState,
      );
    }
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
