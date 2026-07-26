import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { clearPiccLauncherMarkers } from "../util/env.js";

export type PiccInstallKind = "source" | "installed";

export interface PiccLaunchContext {
  direct: boolean;
  version: string;
  installKind?: PiccInstallKind;
}
const INSTALL_KINDS = new Set<PiccInstallKind>([
  "source",
  "installed",
]);
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value: unknown): readonly [string, string, string] | undefined {
  if (typeof value !== "string") return undefined;
  const match = STABLE_VERSION_RE.exec(value);
  return match ? [match[1]!, match[2]!, match[3]!] : undefined;
}

function strictPid(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value ? parsed : undefined;
}

export function readLocalPiccVersion(): string | undefined {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { name?: unknown; version?: unknown };
    return manifest.name === "picc" && parseStableVersion(manifest.version)
      ? manifest.version as string
      : undefined;
  } catch {
    return undefined;
  }
}
/**
 * Capture the launch tuple once, then erase PICC_* immediately. Agreement with
 * the real parent and local package metadata recognizes direct lineage; it is
 * intentionally not described or treated as spoof-proof authentication.
 */
export function capturePiccLaunchContext(options: {
  env?: NodeJS.ProcessEnv;
  parentPid?: number;
  localVersion?: string | null;
} = {}): PiccLaunchContext {
  const env = options.env ?? process.env;
  const launcherPid = env.PICC_LAUNCHER_PID;
  const installKind = env.PICC_INSTALL_KIND;
  const markerVersion = env.PICC_VERSION;
  const skip = env.PI_SKIP_VERSION_CHECK;
  const hadPiccMarkers = launcherPid !== undefined || installKind !== undefined || markerVersion !== undefined;
  clearPiccLauncherMarkers(env);

  const localVersion = options.localVersion === undefined
    ? readLocalPiccVersion()
    : options.localVersion ?? undefined;
  const parsedKind = typeof installKind === "string" && INSTALL_KINDS.has(installKind as PiccInstallKind)
    ? installKind as PiccInstallKind
    : undefined;
  const direct =
    strictPid(launcherPid) === (options.parentPid ?? process.ppid) &&
    parsedKind !== undefined &&
    markerVersion === localVersion &&
    parseStableVersion(markerVersion) !== undefined &&
    skip === "1";
  // A stale or malformed PiCC tuple owns no suppression authority. An external
  // host with no PiCC markers keeps any independently configured Pi flag.
  if (hadPiccMarkers && !direct) delete env.PI_SKIP_VERSION_CHECK;
  return {
    direct,
    version: localVersion ?? "unknown",
    ...(direct ? { installKind: parsedKind } : {}),
  };
}

export function piccUpdateGuidance(context: PiccLaunchContext): string {
  switch (context.installKind) {
    case "source":
      return "PiCC is running from a source checkout. Exit this session, then run `picc update` to synchronize ignored dependencies for the currently checked-out revision. That command does not adopt newer source; use your reviewed Git workflow to update tracked source first.";
    case "installed":
      return "PiCC is running from an installed package. Exit this session, then run `picc update`. A global npm install updates through npm; another package owner receives owner-specific guidance.";
    default:
      return "PiCC was not launched through the PiCC launcher. Update or reinstall it through the installation owner.";
  }
}
// Release checks stay explicit so they inherit the user's npm configuration.
