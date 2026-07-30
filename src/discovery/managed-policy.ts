import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Diagnostic, ManagedPolicySourceClass } from "../types.js";

const POLICY_KEY = "SOFTWARE\\Policies\\ClaudeCode";
const REGISTRY_TIMEOUT_MS = 2_000;
const REGISTRY_MAX_BUFFER = 256 * 1024;
const PLUGIN_DIAGNOSTIC_LIMIT = 8;
const POWERSHELL_REGISTRY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $root = __REGISTRY_ROOT__
  $key = $root.OpenSubKey('SOFTWARE\Policies\ClaudeCode', $false)
  if ($null -eq $key) {
    [Console]::Out.Write('ABSENT')
    exit 0
  }
  try {
    $value = $key.GetValue('Settings', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $key.Dispose()
  }
  if ($null -eq $value) {
    [Console]::Out.Write('ABSENT')
  } elseif ($value -is [string]) {
    [Console]::Out.Write('PRESENT')
    [Console]::Out.Write([char]10)
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)))
  } else {
    [Console]::Out.Write('UNREADABLE')
  }
} catch {
  [Console]::Out.Write('UNREADABLE')
}
`.trim();
const ENCODED_REGISTRY_SCRIPTS: Record<"HKLM" | "HKCU", string> = {
  HKLM: encodePowerShellScript(
    POWERSHELL_REGISTRY_SCRIPT.replace(
      "__REGISTRY_ROOT__",
      "[Microsoft.Win32.Registry]::LocalMachine",
    ),
  ),
  HKCU: encodePowerShellScript(
    POWERSHELL_REGISTRY_SCRIPT.replace(
      "__REGISTRY_ROOT__",
      "[Microsoft.Win32.Registry]::CurrentUser",
    ),
  ),
};

function encodePowerShellScript(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

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

export type RegistryPolicyRead =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "present"; json: string };

export interface ManagedPolicyIo {
  readFile(filePath: string): ManagedFileRead;
  listJsonFiles(dir: string): ManagedDirectoryRead;
}

export interface ManagedRegistryAdapter {
  readSettings(hive: "HKLM" | "HKCU"): RegistryPolicyRead;
}

export interface RegistryCommandInvocation {
  executable: "powershell.exe";
  args: readonly string[];
  options: {
    encoding: "utf8";
    shell: false;
    timeout: number;
    maxBuffer: number;
    windowsHide: true;
    stdio: ["ignore", "pipe", "pipe"];
  };
}

export type RegistryCommandRunner = (invocation: RegistryCommandInvocation) => string;

export interface ManagedPolicyDiscoveryOptions {
  platform?: NodeJS.Platform;
  description?: ManagedPolicyDescription;
  io?: ManagedPolicyIo;
  registry?: ManagedRegistryAdapter;
  /** Explicit settings files bypass platform files, drop-ins, and registry. */
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
  administratorPresent: boolean;
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

const runRegistryCommand: RegistryCommandRunner = (invocation) =>
  execFileSync(invocation.executable, [...invocation.args], invocation.options);

/**
 * The child emits authored status tokens, so Windows-localized command errors
 * never participate in absence classification.
 */
export function createWindowsManagedRegistryAdapter(
  run: RegistryCommandRunner = runRegistryCommand,
): ManagedRegistryAdapter {
  return {
    readSettings(hive) {
      let output: string;
      try {
        output = run({
          executable: "powershell.exe",
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            ENCODED_REGISTRY_SCRIPTS[hive],
          ],
          options: {
            encoding: "utf8",
            shell: false,
            timeout: REGISTRY_TIMEOUT_MS,
            maxBuffer: REGISTRY_MAX_BUFFER,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        });
      } catch {
        return { status: "unreadable" };
      }
      if (output === "ABSENT") return { status: "absent" };
      if (output === "UNREADABLE") return { status: "unreadable" };
      if (!output.startsWith("PRESENT\n")) return { status: "unreadable" };
      const encoded = output.slice("PRESENT\n".length);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return { status: "unreadable" };
      }
      try {
        return {
          status: "present",
          json: Buffer.from(encoded, "base64").toString("utf8"),
        };
      } catch {
        return { status: "unreadable" };
      }
    },
  };
}

export const windowsManagedRegistryAdapter = createWindowsManagedRegistryAdapter();

interface PendingPolicyDiagnostic {
  diagnostic: Diagnostic;
  administratorFailure: boolean;
}

export function discoverManagedPolicy(
  options: ManagedPolicyDiscoveryOptions = {},
): ManagedPolicyResult {
  const platform = options.platform ?? process.platform;
  const description = options.description ?? defaultManagedPolicyDescription(platform);
  const io = options.io ?? nodeIo;
  const pendingDiagnostics: PendingPolicyDiagnostic[] = [];
  const events: ManagedPolicyEvent[] = [];
  const parsed: ManagedPolicySource[] = [];
  const seenFileSources = new Set<string>();
  let administratorPresent = false;
  let validAdministratorPresent = false;

  const addFile = (filePath: string, sourceClass: ManagedPolicySourceClass): void => {
    if (seenFileSources.has(filePath)) return;
    seenFileSources.add(filePath);
    const read = io.readFile(filePath);
    if (read.status === "absent") return;
    const administratorSource = sourceClass !== "override";
    if (administratorSource) administratorPresent = true;
    if (read.status === "unreadable") {
      addPendingDiagnostic(
        policyDiagnostic("managed-policy-unreadable", sourceClass, filePath),
        administratorSource,
        pendingDiagnostics,
        events,
      );
      return;
    }
    if (
      addJson(
        read.text,
        filePath,
        sourceClass,
        parsed,
        pendingDiagnostics,
        events,
      )
    ) {
      if (administratorSource) validAdministratorPresent = true;
    }
  };

  const overrides = options.overridePaths;
  if (overrides !== undefined) {
    for (const filePath of overrides) addFile(filePath, "override");
  } else {
    addFile(description.systemSettingsPath, "system-file");
    const dropIns = io.listJsonFiles(description.dropInDir);
    if (dropIns.status === "unreadable") {
      administratorPresent = true;
      addPendingDiagnostic(
        policyDiagnostic("managed-policy-unreadable", "system-drop-in", description.dropInDir),
        true,
        pendingDiagnostics,
        events,
      );
    } else if (dropIns.status === "present") {
      for (const filePath of [...dropIns.files].sort(comparePolicyPaths)) {
        addFile(filePath, "system-drop-in");
      }
    }

    if (platform === "win32") {
      const registry = options.registry ?? windowsManagedRegistryAdapter;
      const hklm = registry.readSettings("HKLM");
      if (hklm.status !== "absent") administratorPresent = true;
      if (
        addRegistry(
          hklm,
          "HKLM",
          "registry-hklm",
          parsed,
          pendingDiagnostics,
          events,
        )
      ) {
        validAdministratorPresent = true;
      }
      if (!administratorPresent) {
        addRegistry(
          registry.readSettings("HKCU"),
          "HKCU",
          "registry-hkcu",
          parsed,
          pendingDiagnostics,
          events,
        );
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

  // A failed administrator source has suppression impact only when its presence,
  // rather than another valid administrator policy, actually prevented HKCU fallback.
  if (platform === "win32" && administratorPresent && !validAdministratorPresent) {
    for (const pending of pendingDiagnostics) {
      if (pending.administratorFailure) pending.diagnostic.impact = "weaker-policy-suppressed";
    }
  }

  return {
    settings: parsed.length > 0 ? settings : undefined,
    source,
    sources: parsed,
    diagnostics,
    events,
    administratorPresent,
  };
}

function comparePolicyPaths(a: string, b: string): number {
  return path.basename(a).localeCompare(path.basename(b), "en");
}

function addRegistry(
  read: RegistryPolicyRead,
  hive: "HKLM" | "HKCU",
  sourceClass: ManagedPolicySourceClass,
  parsed: ManagedPolicySource[],
  diagnostics: PendingPolicyDiagnostic[],
  events: ManagedPolicyEvent[],
): boolean {
  const source = `${hive}\\${POLICY_KEY}\\Settings`;
  if (read.status === "absent") return false;
  if (read.status === "unreadable") {
    addPendingDiagnostic(
      policyDiagnostic("managed-policy-unreadable", sourceClass, source),
      sourceClass === "registry-hklm",
      diagnostics,
      events,
    );
    return false;
  }
  return addJson(read.json, source, sourceClass, parsed, diagnostics, events);
}

function addJson(
  text: string,
  source: string,
  sourceClass: ManagedPolicySourceClass,
  parsed: ManagedPolicySource[],
  diagnostics: PendingPolicyDiagnostic[],
  events: ManagedPolicyEvent[],
): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stripJsonc(text));
  } catch {
    addPendingDiagnostic(
      policyDiagnostic("managed-policy-malformed", sourceClass, source),
      sourceClass !== "registry-hkcu" && sourceClass !== "override",
      diagnostics,
      events,
    );
    return false;
  }
  if (!isPlainObject(value)) {
    addPendingDiagnostic(
      policyDiagnostic("managed-policy-malformed", sourceClass, source),
      sourceClass !== "registry-hkcu" && sourceClass !== "override",
      diagnostics,
      events,
    );
    return false;
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
  const contribution = { value: normalized, source, sourceClass };
  parsed.push(contribution);
  events.push({ type: "source", source: contribution });
  return true;
}

function addPendingDiagnostic(
  diagnostic: Diagnostic,
  administratorFailure: boolean,
  pending: PendingPolicyDiagnostic[],
  events: ManagedPolicyEvent[],
): void {
  pending.push({ diagnostic, administratorFailure });
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

export function isQualifiedPluginId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
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
