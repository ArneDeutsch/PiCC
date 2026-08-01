import fs from "node:fs";
import path from "node:path";
import type {
  Diagnostic,
  NormalizedPluginInstallation,
  PluginInstallationScope,
} from "../types.js";
import { parseJsonSafe, stripBom } from "../util/fs.js";
import {
  isQualifiedPluginId,
  MAX_QUALIFIED_PLUGIN_ID_LENGTH,
  parseQualifiedPluginId,
} from "../util/plugin-id.js";

const INSTALLED_STATE_VERSION = 2;
const INSTALLED_STATE_FILENAME = "installed_plugins.json";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_JSON_NESTING = 32;
const MAX_RECORDS = 1024;
const MAX_DIAGNOSTICS = 64;
const MAX_SCOPE_LENGTH = 32;
const MAX_VERSION_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_TIMESTAMP_LENGTH = 256;
const INSTALLATION_SCOPES = new Set<PluginInstallationScope>([
  "managed",
  "local",
  "project",
  "user",
]);

export type PluginInstalledStateStatus =
  | "absent"
  | "valid"
  | "unreadable"
  | "unsupported"
  | "malformed";

export type InstalledPluginObservationProblem =
  | "record-not-object"
  | "scope-invalid"
  | "install-path-invalid"
  | "version-invalid"
  | "project-path-invalid"
  | "project-path-required"
  | "installed-at-invalid"
  | "last-updated-invalid";

export interface InstalledPluginObservation {
  qualifiedIdentity: string;
  lifecycleName: string;
  marketplaceName: string;
  validity: "valid" | "invalid";
  loadEligibility: "observation-only";
  declared: {
    scope?: string;
    installPath?: string;
    version?: string;
    projectPath?: string;
    installedAt?: string;
    lastUpdated?: string;
  };
  problems: InstalledPluginObservationProblem[];
}

export interface InstalledPluginObservationOmissions {
  records: number;
  diagnostics: number;
}

export interface LoadPluginInstalledStateResult {
  status: PluginInstalledStateStatus;
  installations: NormalizedPluginInstallation[];
  observations: InstalledPluginObservation[];
  observationDiagnostics: Diagnostic[];
  observationOmissions: InstalledPluginObservationOmissions;
  diagnostics: Diagnostic[];
}

interface ParsedRecord {
  observation: InstalledPluginObservation;
  installation?: NormalizedPluginInstallation;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function boundedNonBlankString(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length <= maximumLength && value.trim().length > 0
    ? value
    : undefined;
}

function isInstallationScope(value: unknown): value is PluginInstallationScope {
  return typeof value === "string" && INSTALLATION_SCOPES.has(value as PluginInstallationScope);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareInstallations(
  left: NormalizedPluginInstallation,
  right: NormalizedPluginInstallation,
): number {
  return (
    compareText(left.pluginId, right.pluginId) ||
    compareText(left.scope, right.scope) ||
    compareText(left.projectPath ?? "", right.projectPath ?? "") ||
    compareText(left.installPath, right.installPath) ||
    compareText(left.version, right.version) ||
    compareText(left.provenance.installedAt ?? "", right.provenance.installedAt ?? "") ||
    compareText(left.provenance.lastUpdated ?? "", right.provenance.lastUpdated ?? "")
  );
}

function compareObservations(
  left: InstalledPluginObservation,
  right: InstalledPluginObservation,
): number {
  return (
    compareText(left.qualifiedIdentity, right.qualifiedIdentity) ||
    compareText(left.declared.scope ?? "", right.declared.scope ?? "") ||
    compareText(left.declared.projectPath ?? "", right.declared.projectPath ?? "") ||
    compareText(left.declared.installPath ?? "", right.declared.installPath ?? "") ||
    compareText(left.declared.version ?? "", right.declared.version ?? "") ||
    compareText(left.declared.installedAt ?? "", right.declared.installedAt ?? "") ||
    compareText(left.declared.lastUpdated ?? "", right.declared.lastUpdated ?? "") ||
    compareText(left.problems.join("\u0000"), right.problems.join("\u0000"))
  );
}

function retainSmallestObservation(
  heap: InstalledPluginObservation[],
  observation: InstalledPluginObservation,
): void {
  if (heap.length < MAX_RECORDS) {
    heap.push(observation);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareObservations(heap[parent]!, heap[index]!) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
    return;
  }
  if (compareObservations(observation, heap[0]!) >= 0) return;
  heap[0] = observation;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let greatest = index;
    if (left < heap.length && compareObservations(heap[left]!, heap[greatest]!) > 0) greatest = left;
    if (right < heap.length && compareObservations(heap[right]!, heap[greatest]!) > 0) greatest = right;
    if (greatest === index) return;
    [heap[index], heap[greatest]] = [heap[greatest]!, heap[index]!];
    index = greatest;
  }
}

function diagnosticIdentity(pluginId: string): string {
  return pluginId.length <= 128 ? `"${pluginId}"` : "a qualified identity";
}

function emptyResult(
  status: PluginInstalledStateStatus,
  diagnostics: Diagnostic[] = [],
): LoadPluginInstalledStateResult {
  return {
    status,
    installations: [],
    observations: [],
    observationDiagnostics: [],
    observationOmissions: { records: 0, diagnostics: 0 },
    diagnostics,
  };
}

function terminal(
  status: Exclude<PluginInstalledStateStatus, "absent" | "valid">,
  message: string,
): LoadPluginInstalledStateResult {
  return emptyResult(status, [{ severity: "warning", message }]);
}

function readBoundedFile(statePath: string): Buffer {
  const descriptor = fs.openSync(statePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const consumed = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (consumed === 0) break;
      offset += consumed;
    }
    return bytes.subarray(0, offset);
  } finally {
    fs.closeSync(descriptor);
  }
}

function exceedsNestingLimit(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth++;
      if (depth > MAX_JSON_NESTING) return true;
    } else if (character === "}" || character === "]") {
      depth--;
    }
  }
  return false;
}

function parseRecord(
  qualifiedIdentity: string,
  lifecycleName: string,
  marketplaceName: string,
  rawRecord: unknown,
  statePath: string,
  reportMalformed: (message: string) => void,
): ParsedRecord {
  const declared: InstalledPluginObservation["declared"] = {};
  const problems: InstalledPluginObservationProblem[] = [];
  const identity = diagnosticIdentity(qualifiedIdentity);
  const problem = (code: InstalledPluginObservationProblem, message: string): void => {
    problems.push(code);
    reportMalformed(message);
  };

  if (!isPlainObject(rawRecord)) {
    problem("record-not-object", `Installed plugin record for ${identity} is not an object`);
  } else {
    const rawScope = ownValue(rawRecord, "scope");
    const scope = boundedNonBlankString(rawScope, MAX_SCOPE_LENGTH);
    if (scope !== undefined) declared.scope = scope;
    if (!isInstallationScope(rawScope)) {
      problem("scope-invalid", `Installed plugin record scope for ${identity} is unsupported`);
    }

    const rawInstallPath = ownValue(rawRecord, "installPath");
    const installPath = boundedNonBlankString(rawInstallPath, MAX_PATH_LENGTH);
    if (installPath !== undefined) declared.installPath = installPath;
    if (installPath === undefined) {
      problem("install-path-invalid", `Installed plugin record install path for ${identity} is invalid`);
    }

    const rawVersion = ownValue(rawRecord, "version");
    const version = boundedNonBlankString(rawVersion, MAX_VERSION_LENGTH);
    if (version !== undefined) declared.version = version;
    if (version === undefined) {
      problem("version-invalid", `Installed plugin record version for ${identity} is invalid`);
    }

    const rawProjectPath = ownValue(rawRecord, "projectPath");
    const projectPath = boundedNonBlankString(rawProjectPath, MAX_PATH_LENGTH);
    if (projectPath !== undefined) declared.projectPath = projectPath;
    if (rawProjectPath !== undefined && projectPath === undefined) {
      problem("project-path-invalid", `Installed plugin record project path for ${identity} is invalid`);
    }
    if ((rawScope === "project" || rawScope === "local") && projectPath === undefined) {
      problem("project-path-required", `Installed plugin record project path for ${identity} is required`);
    }

    for (const [key, declarationKey, code, label] of [
      ["installedAt", "installedAt", "installed-at-invalid", "installed timestamp"],
      ["lastUpdated", "lastUpdated", "last-updated-invalid", "update timestamp"],
    ] as const) {
      const rawTimestamp = ownValue(rawRecord, key);
      const timestamp = boundedNonBlankString(rawTimestamp, MAX_TIMESTAMP_LENGTH);
      if (timestamp !== undefined) declared[declarationKey] = timestamp;
      if (rawTimestamp !== undefined && timestamp === undefined) {
        problem(code, `Installed plugin record ${label} for ${identity} is invalid`);
      }
    }
  }

  const observation: InstalledPluginObservation = {
    qualifiedIdentity,
    lifecycleName,
    marketplaceName,
    validity: problems.length === 0 ? "valid" : "invalid",
    loadEligibility: "observation-only",
    declared,
    problems,
  };
  if (problems.length > 0) return { observation };

  return {
    observation,
    installation: {
      pluginId: qualifiedIdentity,
      scope: declared.scope as PluginInstallationScope,
      ...(declared.projectPath === undefined ? {} : { projectPath: declared.projectPath }),
      installPath: declared.installPath!,
      version: declared.version!,
      provenance: {
        statePath,
        stateVersion: INSTALLED_STATE_VERSION,
        ...(declared.installedAt === undefined ? {} : { installedAt: declared.installedAt }),
        ...(declared.lastUpdated === undefined ? {} : { lastUpdated: declared.lastUpdated }),
      },
    },
  };
}

export function loadPluginInstalledState(userDir: string): LoadPluginInstalledStateResult {
  const statePath = path.join(userDir, "plugins", INSTALLED_STATE_FILENAME);
  let bytes: Buffer;
  try {
    bytes = readBoundedFile(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return emptyResult("absent");
    return terminal("unreadable", "Installed plugin state is unreadable; no installations imported");
  }

  if (bytes.length > MAX_FILE_BYTES) {
    return terminal(
      "malformed",
      "Installed plugin state exceeds the safe size limit; no installations imported",
    );
  }
  const text = stripBom(bytes.toString("utf8"));
  if (exceedsNestingLimit(text)) {
    return terminal(
      "malformed",
      "Installed plugin state exceeds the safe nesting limit; no installations imported",
    );
  }

  const parsed = parseJsonSafe(text);
  if (!isPlainObject(parsed)) {
    return terminal(
      "malformed",
      "Installed plugin state root is not a valid object; no installations imported",
    );
  }
  const stateVersion = ownValue(parsed, "version");
  if (typeof stateVersion !== "number") {
    return terminal(
      "malformed",
      "Installed plugin state version is invalid; no installations imported",
    );
  }
  if (stateVersion !== INSTALLED_STATE_VERSION) {
    return terminal(
      "unsupported",
      "Installed plugin state version is unsupported; no installations imported",
    );
  }

  const plugins = ownValue(parsed, "plugins");
  if (!isPlainObject(plugins)) {
    return terminal(
      "malformed",
      'Installed plugin state field "plugins" is not an object; no installations imported',
    );
  }

  const observationHeap: InstalledPluginObservation[] = [];
  const installationCandidates: NormalizedPluginInstallation[] = [];
  const observationDiagnostics: Diagnostic[] = [];
  let observationCandidates = 0;
  let identityOmissions = 0;
  let omittedDiagnostics = 0;
  let recordCount = 0;
  let malformed = false;
  let firstMalformedMessage: string | undefined;
  const reportObservation = (message: string): void => {
    if (observationDiagnostics.length < MAX_DIAGNOSTICS) {
      observationDiagnostics.push({ severity: "warning", message });
      observationDiagnostics.sort((left, right) => compareText(left.message, right.message));
      return;
    }
    omittedDiagnostics++;
    const last = observationDiagnostics.at(-1)!;
    if (compareText(message, last.message) < 0) {
      observationDiagnostics[observationDiagnostics.length - 1] = { severity: "warning", message };
      observationDiagnostics.sort((left, right) => compareText(left.message, right.message));
    }
  };
  const reportMalformed = (message: string): void => {
    malformed = true;
    if (firstMalformedMessage === undefined || compareText(message, firstMalformedMessage) < 0) {
      firstMalformedMessage = message;
    }
    reportObservation(message);
  };

  for (const pluginId of Object.keys(plugins).sort(compareText)) {
    const rawRecords = ownValue(plugins, pluginId);
    if (!isQualifiedPluginId(pluginId)) {
      reportMalformed("Installed plugin state contains an invalid qualified identity");
      if (Array.isArray(rawRecords)) identityOmissions += rawRecords.length;
      continue;
    }
    const boundedIdentity = parseQualifiedPluginId(pluginId, MAX_QUALIFIED_PLUGIN_ID_LENGTH);
    if (!Array.isArray(rawRecords)) {
      reportMalformed(`Installed plugin records for ${diagnosticIdentity(pluginId)} are not an array`);
      continue;
    }
    if (boundedIdentity === undefined) {
      identityOmissions += rawRecords.length;
      reportObservation("Installed plugin observations omitted records with an overlong qualified identity");
    }

    for (const rawRecord of rawRecords) {
      recordCount++;
      const separator = pluginId.indexOf("@");
      const record = parseRecord(
        pluginId,
        boundedIdentity?.lifecycleName ?? pluginId.slice(0, separator),
        boundedIdentity?.marketplaceName ?? pluginId.slice(separator + 1),
        rawRecord,
        statePath,
        reportMalformed,
      );
      if (record.installation !== undefined && recordCount <= MAX_RECORDS) {
        installationCandidates.push(record.installation);
      }
      if (boundedIdentity !== undefined) {
        observationCandidates++;
        retainSmallestObservation(observationHeap, record.observation);
      }
    }
  }

  if (recordCount > MAX_RECORDS) {
    reportMalformed("Installed plugin records were omitted after the safe record limit");
  }
  const observations = observationHeap.sort(compareObservations);
  const omittedRecords = identityOmissions + observationCandidates - observations.length;
  observationDiagnostics.sort((left, right) =>
    compareText(left.message, right.message) || compareText(left.severity, right.severity));
  installationCandidates.sort(compareInstallations);

  const diagnostics = malformed
    ? [{
        severity: "warning" as const,
        message: `${firstMalformedMessage ?? "Installed plugin state contains malformed or bounded data"}; no installations imported`,
      }]
    : [];
  return {
    status: malformed ? "malformed" : "valid",
    installations: malformed ? [] : installationCandidates,
    observations,
    observationDiagnostics,
    observationOmissions: { records: omittedRecords, diagnostics: omittedDiagnostics },
    diagnostics,
  };
}
