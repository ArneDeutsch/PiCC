import fs from "node:fs";
import { resolveClaudeProfile, type ClaudeProfile } from "./discovery/claude-profile.js";
import type { ManagedRegistryAdapter } from "./discovery/managed-policy.js";
import { loadClaudeProject } from "./project.js";
import {
  parsePluginInventoryArgv,
  renderPluginInventoryOperation,
} from "./runtime/plugin-inventory-text.js";

const PROJECT_UNAVAILABLE = "PiCC plugin inventory could not access the target project directory. Run from an accessible target project directory.";
const INVENTORY_INCOMPLETE_PREFIX = "PiCC plugin inventory may be incomplete";
const INVENTORY_FORMAT_RECOVERY = "Update PiCC or report the unsupported plugin-state format.";
const INVENTORY_REPAIR_RECOVERY = "Repair the malformed or unreadable Claude plugin state outside PiCC.";
const INVENTORY_DOCTOR_RECOVERY = "Run PiCC interactively in the same project and profile, then use `/doctor` for details.";
const WINDOWS_REGISTRY_NOT_INSPECTED = "PiCC plugin inventory: Windows registry policy was not inspected. Managed files and drop-ins were still observed. Run PiCC interactively and use `/plugin list` or `/doctor` for registry-backed policy evidence.";

export interface PluginInventoryCliOutput {
  log(message: string): void;
  error(message: string): void;
}

export interface PluginInventoryCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

const unavailableRegistryPolicy: ManagedRegistryAdapter = {
  readSettings: () => ({ status: "unreadable" }),
};

function readableDirectory(directory: string): boolean {
  try {
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) return false;
    fs.accessSync(directory, fs.constants.R_OK);
    fs.readdirSync(directory, { withFileTypes: true });
    return true;
  } catch {
    return false;
  }
}

function readableProfile(userDir: string): boolean {
  try {
    const stat = fs.statSync(userDir, { throwIfNoEntry: false });
    return stat === undefined || readableDirectory(userDir);
  } catch {
    return false;
  }
}

function unreadableProfileMessage(profile: ClaudeProfile): string {
  switch (profile.source) {
    case "picc-override":
      return "PiCC plugin inventory could not read the Claude profile. Check PICC_CLAUDE_USER_DIR and permissions.";
    case "claude-config":
      return "PiCC plugin inventory could not read the Claude profile. Check CLAUDE_CONFIG_DIR and permissions.";
    case "default":
      return "PiCC plugin inventory could not read the Claude profile. Check default Claude profile permissions or set PICC_CLAUDE_USER_DIR.";
    case "explicit":
      return "PiCC plugin inventory could not read the selected Claude profile. Check its permissions.";
  }
}

function resolveCommandInputs(options: PluginInventoryCliOptions):
  | { cwd: string; profile: ClaudeProfile }
  | { error: string } {
  let cwd: string;
  try {
    cwd = options.cwd ?? process.cwd();
  } catch {
    return { error: PROJECT_UNAVAILABLE };
  }
  if (!readableDirectory(cwd)) return { error: PROJECT_UNAVAILABLE };

  const profile = resolveClaudeProfile({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
  });
  if (!readableProfile(profile.userDir)) return { error: unreadableProfileMessage(profile) };
  return { cwd, profile };
}

function incompleteStateWarning(
  installedStateStatus: "absent" | "valid" | "unreadable" | "unsupported" | "malformed",
  diagnostics: readonly { readonly category?: string; readonly sourceClass?: string; readonly message: string }[],
): string {
  const classes = new Set<string>();
  let unsupportedFormat = installedStateStatus === "unsupported";
  let repairState = installedStateStatus === "malformed" || installedStateStatus === "unreadable";
  for (const diagnostic of diagnostics) {
    const evidence = `${diagnostic.category ?? ""} ${diagnostic.sourceClass ?? ""} ${diagnostic.message}`.toLowerCase();
    if (/installed|blocklist/u.test(evidence)) classes.add("installed plugin state");
    if (/marketplace|catalog|allowlist/u.test(evidence)) classes.add("marketplace state");
    if (/managed-policy|registry-/u.test(evidence)) classes.add("managed policy state");
    if (/manifest|metadata/u.test(evidence)) classes.add("plugin metadata");
    const formatDiagnostic = /unsupported (?:format|version)|format is unsupported|undocumented/u.test(evidence);
    if (formatDiagnostic) unsupportedFormat = true;
    else if (/malformed|unreadable|could not be read|invalid type|wrong (?:type|shape)/u.test(evidence)) repairState = true;
  }
  const category = classes.size > 0 ? ` (${[...classes].sort().join(", ")})` : "";
  const actions = [
    ...(unsupportedFormat ? [INVENTORY_FORMAT_RECOVERY] : []),
    ...(repairState || !unsupportedFormat ? [INVENTORY_REPAIR_RECOVERY] : []),
    INVENTORY_DOCTOR_RECOVERY,
  ];
  return `${INVENTORY_INCOMPLETE_PREFIX}${category}. ${actions.join(" ")}`;
}

function isDefaultRegistryOmission(diagnostic: {
  readonly category?: string;
  readonly sourceClass?: string;
}): boolean {
  return diagnostic.category === "managed-policy-unreadable" && diagnostic.sourceClass === "registry-hklm";
}

export function runPluginInventoryCli(
  argv: readonly string[],
  output: PluginInventoryCliOutput = console,
  managedPolicyRegistry?: ManagedRegistryAdapter,
  options: PluginInventoryCliOptions = {},
): number {
  const parsed = parsePluginInventoryArgv(argv);
  if (parsed.kind === "usage") {
    output.error(parsed.usage);
    return 2;
  }

  const inputs = resolveCommandInputs(options);
  if ("error" in inputs) {
    output.error(inputs.error);
    return 1;
  }

  const platform = options.platform ?? process.platform;
  const defaultRegistryOmitted = platform === "win32" && managedPolicyRegistry === undefined;
  let project: ReturnType<typeof loadClaudeProject>;
  try {
    project = loadClaudeProject({
      cwd: inputs.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      managedPolicyRegistry: managedPolicyRegistry ?? unavailableRegistryPolicy,
      managedPolicyPlatform: platform,
      pluginInventoryLifetime: "command",
    });
  } catch {
    output.error(readableProfile(inputs.profile.userDir)
      ? PROJECT_UNAVAILABLE
      : unreadableProfileMessage(inputs.profile));
    return 1;
  }

  if (parsed.operation.kind === "details" && project.pluginInventory.find(parsed.operation.qualifiedIdentity) === undefined) {
    output.error(`PiCC plugin not found: ${parsed.operation.qualifiedIdentity}. The bounded launcher list can omit catalog-only identities. Run \`picc plugin list\` to copy a listed qualified identity, or run PiCC interactively in the same project and profile and use the literal \`/plugin\` filter.`);
    return 1;
  }

  output.log(renderPluginInventoryOperation(project.pluginInventory, parsed.operation));
  if (defaultRegistryOmitted) output.error(WINDOWS_REGISTRY_NOT_INSPECTED);
  const otherDiagnostics = defaultRegistryOmitted
    ? project.pluginInventory.diagnostics.filter((diagnostic) => !isDefaultRegistryOmission(diagnostic))
    : project.pluginInventory.diagnostics;
  if (otherDiagnostics.length > 0) output.error(incompleteStateWarning(project.pluginInventory.installedStateStatus, otherDiagnostics));
  return 0;
}
