import fs from "node:fs";
import path from "node:path";
import type {
  Diagnostic,
  NormalizedPluginInstallation,
  PluginInstallationScope,
} from "../types.js";
import { parseJsonSafe, stripBom } from "../util/fs.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";

const INSTALLED_STATE_VERSION = 2;
const INSTALLED_STATE_FILENAME = "installed_plugins.json";
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

export interface LoadPluginInstalledStateResult {
  status: PluginInstalledStateStatus;
  installations: NormalizedPluginInstallation[];
  diagnostics: Diagnostic[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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

function diagnosticIdentity(pluginId: string): string {
  return pluginId.length <= 128 ? `"${pluginId}"` : "a qualified identity";
}

function terminal(
  status: Exclude<PluginInstalledStateStatus, "absent" | "valid">,
  message: string,
): LoadPluginInstalledStateResult {
  return {
    status,
    installations: [],
    diagnostics: [{ severity: "warning", message }],
  };
}

/**
 * Import Claude Code's captured v2 installed-plugin state without inspecting plugin storage.
 * Unsupported or malformed state fails closed to no installation records.
 */
export function loadPluginInstalledState(userDir: string): LoadPluginInstalledStateResult {
  const statePath = path.join(userDir, "plugins", INSTALLED_STATE_FILENAME);
  let text: string;
  try {
    text = stripBom(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { status: "absent", installations: [], diagnostics: [] };
    }
    return terminal(
      "unreadable",
      "Installed plugin state is unreadable; no installations imported",
    );
  }

  const parsed = parseJsonSafe(text);
  if (!isPlainObject(parsed)) {
    return terminal(
      "malformed",
      "Installed plugin state root is not a valid object; no installations imported",
    );
  }
  const stateVersion = parsed["version"];
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

  const plugins = parsed["plugins"];
  if (!isPlainObject(plugins)) {
    return terminal(
      "malformed",
      'Installed plugin state field "plugins" is not an object; no installations imported',
    );
  }

  const installations: NormalizedPluginInstallation[] = [];
  for (const [pluginId, rawRecords] of Object.entries(plugins)) {
    if (!isQualifiedPluginId(pluginId)) {
      return terminal(
        "malformed",
        "Installed plugin state contains an invalid qualified identity; no installations imported",
      );
    }
    const identity = diagnosticIdentity(pluginId);
    if (!Array.isArray(rawRecords)) {
      return terminal(
        "malformed",
        `Installed plugin records for ${identity} are not an array; no installations imported`,
      );
    }

    for (const rawRecord of rawRecords) {
      if (!isPlainObject(rawRecord)) {
        return terminal(
          "malformed",
          `Installed plugin record for ${identity} is not an object; no installations imported`,
        );
      }

      const scope = rawRecord["scope"];
      if (!isInstallationScope(scope)) {
        return terminal(
          "malformed",
          `Installed plugin record scope for ${identity} is unsupported; no installations imported`,
        );
      }
      const installPath = rawRecord["installPath"];
      if (!isNonBlankString(installPath)) {
        return terminal(
          "malformed",
          `Installed plugin record install path for ${identity} is invalid; no installations imported`,
        );
      }
      const version = rawRecord["version"];
      if (!isNonBlankString(version)) {
        return terminal(
          "malformed",
          `Installed plugin record version for ${identity} is invalid; no installations imported`,
        );
      }

      const rawProjectPath = rawRecord["projectPath"];
      if (rawProjectPath !== undefined && !isNonBlankString(rawProjectPath)) {
        return terminal(
          "malformed",
          `Installed plugin record project path for ${identity} is invalid; no installations imported`,
        );
      }
      if ((scope === "project" || scope === "local") && !isNonBlankString(rawProjectPath)) {
        return terminal(
          "malformed",
          `Installed plugin record project path for ${identity} is required; no installations imported`,
        );
      }

      const installedAt = rawRecord["installedAt"];
      if (installedAt !== undefined && !isNonBlankString(installedAt)) {
        return terminal(
          "malformed",
          `Installed plugin record installed timestamp for ${identity} is invalid; no installations imported`,
        );
      }
      const lastUpdated = rawRecord["lastUpdated"];
      if (lastUpdated !== undefined && !isNonBlankString(lastUpdated)) {
        return terminal(
          "malformed",
          `Installed plugin record update timestamp for ${identity} is invalid; no installations imported`,
        );
      }

      installations.push({
        pluginId,
        scope,
        ...(rawProjectPath === undefined ? {} : { projectPath: rawProjectPath }),
        installPath,
        version,
        provenance: {
          statePath,
          stateVersion: INSTALLED_STATE_VERSION,
          ...(installedAt === undefined ? {} : { installedAt }),
          ...(lastUpdated === undefined ? {} : { lastUpdated }),
        },
      });
    }
  }

  installations.sort(compareInstallations);
  return { status: "valid", installations, diagnostics: [] };
}
