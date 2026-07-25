import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { clearPiccLauncherMarkers } from "../util/env.js";

export const PICC_REGISTRY_LATEST_URL = "https://registry.npmjs.org/picc/latest";
export const PICC_UPDATE_CHECK_TIMEOUT_MS = 2_500;
export const PICC_UPDATE_CHECK_MAX_BYTES = 64 * 1024;

export type PiccInstallKind =
  | "verified public-registry global npm"
  | "source"
  | "known local package"
  | "unknown/other";

export interface PiccLaunchContext {
  direct: boolean;
  version: string;
  installKind?: PiccInstallKind;
}

const INSTALL_KINDS = new Set<PiccInstallKind>([
  "verified public-registry global npm",
  "source",
  "known local package",
  "unknown/other",
]);
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableVersion(value: unknown): readonly [string, string, string] | undefined {
  if (typeof value !== "string") return undefined;
  const match = STABLE_VERSION_RE.exec(value);
  return match ? [match[1]!, match[2]!, match[3]!] : undefined;
}

function compareDecimal(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareStableVersions(left: string, right: string): number | undefined {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const compared = compareDecimal(a[index]!, b[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
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
    case "verified public-registry global npm":
      return "PiCC is installed from the public npm registry. Exit this session, then run `picc update` in your terminal. The running session is not modified.";
    case "source":
      return "PiCC is running from a source checkout. Exit this session, then run `picc update` to synchronize ignored dependencies for the currently checked-out revision. That command does not adopt newer source; use your reviewed Git workflow to update tracked source first.";
    case "known local package":
      return "PiCC is running from a local package owned by its installer or package owner. This session will not mutate it. Exit, update or reinstall that package through its owner, then run `picc --version` to verify the complete product.";
    default:
      return "PiCC installation ownership is unknown, so this session will not mutate it. Exit, repair or reinstall PiCC through the installation owner, then run `picc --version` to verify the complete product.";
  }
}

export function newerPiccReleaseNotice(version: string): string {
  return `PiCC ${version} is available. Exit this session, then run \`picc update\` in your terminal.`;
}

async function boundedResponseText(response: Response, maxBytes: number): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function envEnabled(value: string | undefined): boolean {
  return value !== undefined && /^(1|true|yes|on)$/i.test(value.trim());
}

export async function checkForNewerPiccRelease(options: {
  currentVersion: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (envEnabled(env.PI_OFFLINE) || envEnabled(env.PICC_SKIP_UPDATE_CHECK)) return undefined;
  if (!parseStableVersion(options.currentVersion)) return undefined;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(undefined);
    }, options.timeoutMs ?? PICC_UPDATE_CHECK_TIMEOUT_MS);
    timer.unref?.();
  });
  const request = (async (): Promise<string | undefined> => {
    try {
      const response = await (options.fetch ?? fetch)(PICC_REGISTRY_LATEST_URL, {
        headers: { accept: "application/json", "user-agent": "picc-release-check" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.url !== PICC_REGISTRY_LATEST_URL) return undefined;
      const text = await boundedResponseText(response, options.maxBytes ?? PICC_UPDATE_CHECK_MAX_BYTES);
      if (text === undefined) return undefined;
      const parsed = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (parsed?.name !== "picc" || typeof parsed.version !== "string") return undefined;
      return compareStableVersions(parsed.version, options.currentVersion) === 1
        ? parsed.version
        : undefined;
    } catch {
      return undefined;
    }
  })();
  try {
    // The race is required even though native fetch honors AbortSignal: a test
    // double or partial implementation may ignore abort, and late work must
    // never retain notification authority.
    return await Promise.race([request, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A once-only, detached advisory checker. Errors and non-new releases stay silent. */
export function createPiccReleaseAdvisory(options: {
  context: PiccLaunchContext;
  env?: NodeJS.ProcessEnv;
  check?: typeof checkForNewerPiccRelease;
}): { start(notify: (message: string) => void): void } {
  let started = false;
  let notified = false;
  return {
    start(notify): void {
      if (started || !options.context.direct ||
          options.context.installKind !== "verified public-registry global npm") return;
      started = true;
      void (options.check ?? checkForNewerPiccRelease)({
        currentVersion: options.context.version,
        env: options.env,
      }).then((version) => {
        if (!version || notified) return;
        notified = true;
        notify(newerPiccReleaseNotice(version));
      }).catch(() => undefined);
    },
  };
}
