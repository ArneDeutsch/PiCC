import fs from "node:fs";
import path from "node:path";
import type { Diagnostic, ManagedPolicySourceClass } from "../types.js";
import {
  loadManagedMcpSnapshot,
  type ManagedMcpIo,
  type ManagedMcpResult,
} from "../claude/managed-mcp.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";

export { isQualifiedPluginId } from "../util/plugin-id.js";

const PLUGIN_DIAGNOSTIC_LIMIT = 8;

export interface ManagedPolicyDescription {
  systemSettingsPath: string;
  dropInDir: string;
  artifactDirs: string[];
}

export type ManagedFileRead =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "present"; text: string };

export type ManagedDirectoryRead =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "present"; files: string[] };

export interface ManagedPolicyIo {
  readFile(filePath: string): ManagedFileRead;
  listJsonFiles(dir: string): ManagedDirectoryRead;
}

export interface ManagedPolicyDiscoveryOptions {
  platform?: NodeJS.Platform;
  description?: ManagedPolicyDescription;
  io?: ManagedPolicyIo;
  /** Explicit settings files bypass platform files and drop-ins. */
  overridePaths?: string[];
}

export interface ManagedPolicySource {
  value: Record<string, unknown>;
  source: string;
  sourceClass: ManagedPolicySourceClass;
}

export type ManagedPolicyEvent =
  | { type: "diagnostic"; diagnostic: Diagnostic }
  | { type: "source"; source: ManagedPolicySource };

export interface ManagedPolicyResult {
  settings?: Record<string, unknown>;
  source: string;
  /** Ordered source contributions retained for direct discovery consumers. */
  sources: ManagedPolicySource[];
  diagnostics: Diagnostic[];
  /** Diagnostics and contributions in policy source order. */
  events: ManagedPolicyEvent[];
}

export function defaultManagedMcpPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-mcp.json";
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-mcp.json";
  return "/etc/claude-code/managed-mcp.json";
}

export interface ManagedMcpDiscoveryOptions {
  platform?: NodeJS.Platform;
  /** Structural authority reserved for deterministic tests; production callers use the fixed platform path. */
  testAuthority?: { readonly path: string; readonly io: ManagedMcpIo };
}

export function discoverManagedMcp(options: ManagedMcpDiscoveryOptions = {}): ManagedMcpResult {
  const authority = options.testAuthority;
  return loadManagedMcpSnapshot(
    authority?.path ?? defaultManagedMcpPath(options.platform ?? process.platform),
    authority?.io,
  );
}

export function defaultManagedPolicyDescription(
  platform: NodeJS.Platform = process.platform,
): ManagedPolicyDescription {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const systemSettingsPath =
    platform === "win32"
      ? paths.join("C:\\", "Program Files", "ClaudeCode", "managed-settings.json")
      : platform === "darwin"
        ? paths.join("/Library", "Application Support", "ClaudeCode", "managed-settings.json")
        : paths.join("/etc", "claude-code", "managed-settings.json");
  const base = paths.dirname(systemSettingsPath);
  return {
    systemSettingsPath,
    dropInDir: paths.join(base, "managed-settings.d"),
    artifactDirs: [base],
  };
}

const nodeIo: ManagedPolicyIo = {
  readFile(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { status: "unreadable" };
    } catch (error) {
      return isMissing(error) ? { status: "absent" } : { status: "unreadable" };
    }
    try {
      return { status: "present", text: fs.readFileSync(filePath, "utf8") };
    } catch {
      return { status: "unreadable" };
    }
  },
  listJsonFiles(dir) {
    try {
      const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            !entry.name.startsWith(".") &&
            entry.name.toLowerCase().endsWith(".json"),
        )
        .map((entry) => path.join(dir, entry.name))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "en"));
      return { status: "present", files };
    } catch (error) {
      return isMissing(error) ? { status: "absent" } : { status: "unreadable" };
    }
  },
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function discoverManagedPolicy(
  options: ManagedPolicyDiscoveryOptions = {},
): ManagedPolicyResult {
  const platform = options.platform ?? process.platform;
  const description = options.description ?? defaultManagedPolicyDescription(platform);
  const io = options.io ?? nodeIo;
  const events: ManagedPolicyEvent[] = [];
  const parsed: ManagedPolicySource[] = [];
  const seenFileSources = new Set<string>();

  const addFile = (filePath: string, sourceClass: ManagedPolicySourceClass): void => {
    if (seenFileSources.has(filePath)) return;
    seenFileSources.add(filePath);
    const read = io.readFile(filePath);
    if (read.status === "absent") return;
    if (read.status === "unreadable") {
      addDiagnostic(
        policyDiagnostic("managed-policy-unreadable", sourceClass, filePath),
        events,
      );
      return;
    }
    addJson(read.text, filePath, sourceClass, parsed, events);
  };

  const overrides = options.overridePaths;
  if (overrides !== undefined) {
    for (const filePath of overrides) addFile(filePath, "override");
  } else {
    addFile(description.systemSettingsPath, "system-file");
    const dropIns = io.listJsonFiles(description.dropInDir);
    if (dropIns.status === "unreadable") {
      addDiagnostic(
        policyDiagnostic("managed-policy-unreadable", "system-drop-in", description.dropInDir),
        events,
      );
    } else if (dropIns.status === "present") {
      for (const filePath of [...dropIns.files].sort(comparePolicyPaths)) {
        addFile(filePath, "system-drop-in");
      }
    }
  }

  const settings: Record<string, unknown> = Object.create(null);
  const diagnostics = events.flatMap((event) =>
    event.type === "diagnostic" ? [event.diagnostic] : [],
  );
  let source = "<managed-policy>";
  for (const item of parsed) {
    mergeManagedObject(settings, item.value);
    source = item.source;
  }

  return {
    settings: parsed.length > 0 ? settings : undefined,
    source,
    sources: parsed,
    diagnostics,
    events,
  };
}

function comparePolicyPaths(a: string, b: string): number {
  return path.basename(a).localeCompare(path.basename(b), "en");
}

function addJson(
  text: string,
  source: string,
  sourceClass: ManagedPolicySourceClass,
  parsed: ManagedPolicySource[],
  events: ManagedPolicyEvent[],
): void {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonc(text));
  } catch {
    addDiagnostic(policyDiagnostic("managed-policy-malformed", sourceClass, source), events);
    return;
  }
  if (!isPlainObject(value)) {
    addDiagnostic(policyDiagnostic("managed-policy-malformed", sourceClass, source), events);
    return;
  }

  if (Object.hasOwn(value, "enabledPlugins")) {
    const pluginDiagnostics: Diagnostic[] = [];
    const report = createPluginDiagnosticReporter(source, pluginDiagnostics);
    const sanitized = sanitizeManagedPluginEnablement(value.enabledPlugins, report);
    if (sanitized === undefined) delete value.enabledPlugins;
    else value.enabledPlugins = sanitized;
    for (const diagnostic of pluginDiagnostics) {
      events.push({ type: "diagnostic", diagnostic });
    }
  }
  const normalized = mergeManagedObject(
    Object.create(null) as Record<string, unknown>,
    value,
  );
  // Policy fields are compiler material: generic managed merging may deduplicate
  // arrays, but each attributed physical contribution must remain verbatim.
  for (const key of ["allowedMcpServers", "deniedMcpServers", "allowManagedMcpServersOnly"] as const) {
    if (Object.hasOwn(value, key)) {
      Object.defineProperty(normalized, key, {
        value: value[key], writable: true, enumerable: true, configurable: true,
      });
    }
  }
  const contribution = { value: normalized, source, sourceClass };
  parsed.push(contribution);
  events.push({ type: "source", source: contribution });
}

function addDiagnostic(diagnostic: Diagnostic, events: ManagedPolicyEvent[]): void {
  events.push({ type: "diagnostic", diagnostic });
}

function policyDiagnostic(
  category: "managed-policy-malformed" | "managed-policy-unreadable",
  sourceClass: ManagedPolicySourceClass,
  source: string,
): Diagnostic {
  return {
    severity: "error",
    message:
      category === "managed-policy-malformed"
        ? "Managed policy JSON is malformed; source ignored"
        : "Managed policy source is unreadable; source ignored",
    source,
    category,
    sourceClass,
    impact: "source-ignored",
  };
}

export function createPluginDiagnosticReporter(
  source: string,
  diagnostics: Diagnostic[],
): (message: string) => void {
  let emitted = 0;
  let summarized = false;
  return (message) => {
    if (emitted < PLUGIN_DIAGNOSTIC_LIMIT) {
      diagnostics.push({ severity: "warning", message, source });
      emitted++;
    } else if (!summarized) {
      diagnostics.push({
        severity: "warning",
        message: 'Additional malformed "enabledPlugins" entries omitted',
        source,
      });
      summarized = true;
    }
  };
}

function sanitizeManagedPluginEnablement(
  incoming: unknown,
  report: (message: string) => void,
): Record<string, boolean> | undefined {
  if (!isPlainObject(incoming)) {
    report('Setting "enabledPlugins" is not an object; ignored');
    return undefined;
  }
  const sanitized: Record<string, boolean> = Object.create(null);
  for (const [pluginId, enabled] of Object.entries(incoming)) {
    if (!isQualifiedPluginId(pluginId)) {
      report('Invalid plugin identity in "enabledPlugins" ignored');
    } else if (typeof enabled !== "boolean") {
      report(`Plugin "${pluginId}" in "enabledPlugins" must be a literal boolean; ignored`);
    } else {
      sanitized[pluginId] = enabled;
    }
  }
  return sanitized;
}

export function mergeManagedObject(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, incomingValue] of Object.entries(incoming)) {
    const currentValue = Object.hasOwn(target, key) ? target[key] : undefined;
    let mergedValue: unknown;
    if (Array.isArray(currentValue) && Array.isArray(incomingValue)) {
      mergedValue = stableDedupe([...currentValue, ...incomingValue]);
    } else if (isPlainObject(currentValue) && isPlainObject(incomingValue)) {
      mergedValue = mergeManagedObject(currentValue, incomingValue);
    } else if (isPlainObject(incomingValue)) {
      mergedValue = mergeManagedObject(
        Object.create(null) as Record<string, unknown>,
        incomingValue,
      );
    } else if (Array.isArray(incomingValue)) {
      mergedValue = stableDedupe(incomingValue);
    } else {
      mergedValue = incomingValue;
    }
    Object.defineProperty(target, key, {
      value: mergedValue,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}

function stableDedupe(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = canonicalJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSONC normalization is shared so BOM stripping and string-aware comment /
 * trailing-comma handling cannot diverge between ordinary and managed files.
 */
export function stripJsonc(text: string): string {
  // A BOM must not silently discard a settings file and its deny rules.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let noComments = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inString) {
      noComments += ch;
      if (ch === "\\") noComments += text.charAt(++i);
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      noComments += ch;
    } else if (ch === "/" && text.charAt(i + 1) === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i++;
      if (i < text.length) noComments += "\n";
    } else if (ch === "/" && text.charAt(i + 1) === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i++;
      i++;
    } else {
      noComments += ch;
    }
  }
  let out = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments.charAt(i);
    if (inString) {
      out += ch;
      if (ch === "\\") out += noComments.charAt(++i);
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let next = i + 1;
      while (next < noComments.length && /\s/.test(noComments.charAt(next))) next++;
      if (noComments.charAt(next) !== "}" && noComments.charAt(next) !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}
