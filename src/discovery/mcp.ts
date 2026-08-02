import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandEnvVars } from "./settings.js";
import { normalizeMcpServerBlock, type McpJsonResult, type RawMcpEntry } from "../claude/mcp-config.js";
import type { ClaudeMcpStateResult } from "../claude/claude-mcp-state.js";
import { resolveRemoteMcpFields, type RemoteMcpWorkHooks } from "../claude/mcp-remote-config.js";
import type { ManagedMcpResult } from "../claude/managed-mcp.js";
import { compileMcpPolicy, evaluateMcpPolicy, MCP_POLICY_LIMITS } from "../engine/mcp-policy.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { sanitizedSubprocessEnv } from "../util/env.js";
import type {
  McpInactiveReason,
  McpPolicyInactiveReason,
  McpPolicySettingsEntry,
  McpPolicySourceFailure,
  McpServerStatus,
  McpSettingsEntry,
  McpSourceClass,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "../types.js";

/**
 * MCP precedence & enablement resolution with one fixed, sanitized Git probe seam.
 *
 * Combines native local/user state, project `.mcp.json`, and scope-tagged
 * settings-extension captures into one {@link ResolvedMcpConfig}.
 *
 * Same-name candidates resolve as whole entries in this order: native local,
 * `.mcp.json`, native user, then managed/local/project/user settings extension.
 * Project-origin extension and `.mcp.json` winners retain the existing approval
 * gate. Native runtime disablement is an exact-name final deny for authentic
 * winners only; settings `*McpjsonServers` remain confined to `.mcp.json` and
 * extension winners. Present unusable native state fails all MCP closed.
 * - Git-tracked local demotion (mandatory gate rule): a `settings.local.json`
 *   that is tracked in the project repository is attacker-committable, so its
 *   MCP contribution is treated as PROJECT scope (approvals ignored, servers
 *   pending) with a diagnostic. Probe failure / no git repo fails OPEN
 *   (treated as untracked) so non-git projects keep working.
 * - `${VAR}` / `${VAR:-default}` expansion applies to command/args/env at
 *   resolution time; unset-without-default keeps the literal and records a
 *   warning naming the VARIABLE NAME only (never values).
 *
 * Diagnostics carry raw (pre-expansion) strings only and every diagnostic
 * passes neutralize-text before storage. Never throws.
 */

/**
 * Probe seam: is `filePath` tracked by git in the project repository?
 * `undefined` = probe failed (no git, no repo, …) → callers FAIL OPEN.
 */
export type GitTrackedProbe = (filePath: string, projectRoot: string) => boolean | undefined;

export interface ResolveMcpConfigOptions {
  projectRoot: string;
  /** Explicit ordinary project input for direct resolver callers. */
  mcpJson?: McpJsonResult;
  /**
   * Production assembly seam for ordinary native/project acquisition. Invoked
   * only after the prepared policy snapshot establishes those inputs can matter.
   */
  loadOrdinaryMcp?: () => {
    nativeState: ClaudeMcpStateResult;
    mcpJson: McpJsonResult;
  };
  /** Scope-tagged settings captures, in ascending-precedence file order. */
  mcpSettings: McpSettingsEntry[];
  /** Inert native Claude snapshot; absence preserves the extension-only contract. */
  nativeState?: ClaudeMcpStateResult;
  /** Fixed profile provenance retained only for safe fail-closed repair guidance. */
  nativeStateProfile?: import("../types.js").ClaudeProfileSource;
  /** Ordered policy contributions and typed discovery failures from settings discovery. */
  mcpPolicySettings?: readonly McpPolicySettingsEntry[];
  mcpPolicySourceFailures?: readonly McpPolicySourceFailure[];
  mcpPolicyRestrictiveMaterialOmitted?: boolean;
  /** Standalone administrator-owned exclusive MCP state. */
  managedMcp?: ManagedMcpResult;
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to a `git ls-files --error-unmatch` child call. */
  isGitTracked?: GitTrackedProbe;
  /** Deterministic counters for enabled-only remote work. */
  remoteWorkHooksForTest?: RemoteMcpWorkHooks;
}

type McpOrigin =
  | "settings-user"
  | "settings-project"
  | "settings-local"
  | "settings-managed"
  | "native-user"
  | "mcpjson"
  | "native-local"
  | "managed-mcp";

const ORIGIN_RANK: Record<McpOrigin, number> = {
  "settings-user": 0,
  "settings-project": 1,
  "settings-local": 2,
  "settings-managed": 3,
  "native-user": 4,
  mcpjson: 5,
  "native-local": 6,
  "managed-mcp": 7,
};

interface Candidate {
  entry: RawMcpEntry;
  origin: McpOrigin;
  authentic: boolean;
  projectApprovalRequired: boolean;
  /** Global discovery index; among equal ranks the later (nearer) file wins. */
  order: number;
  source: McpSourceClass;
}

/**
 * Claude-parity list matching (binary-verified 2.1.218): Claude runs BOTH the
 * `enabledMcpjsonServers`/`disabledMcpjsonServers` entries and the server name
 * through its name sanitizer (`[^a-zA-Z0-9_-]` → `_`) before comparing. An
 * exact compare would miss the deny direction: `"my_server"` in
 * disabledMcpjsonServers must still catch a server named `my.server`.
 */
function sanitizeForListMatch(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function mcpGitProbeEnv(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return sanitizedSubprocessEnv(inherited);
}

function defaultGitTrackedProbe(filePath: string, projectRoot: string): boolean | undefined {
  try {
    // Probe the CANONICAL on-disk spelling, not the lexical lookup path: on a
    // case-insensitive filesystem (Windows/macOS) the loader happily reads a
    // committed ".claude/Settings.local.json" via the lowercase name, but git
    // pathspecs are case-sensitive — probing the lexical spelling would answer
    // "untracked" and bypass the demotion gate. realpath failure fails OPEN
    // (outer catch), like every other probe failure.
    const realFile = fs.realpathSync.native(filePath);
    const realRoot = fs.realpathSync.native(projectRoot);
    const rel = path.relative(realRoot, realFile);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
    const result = spawnSync(
      "git",
      ["-C", realRoot, "ls-files", "--error-unmatch", "--", rel.split(path.sep).join("/")],
      { stdio: "ignore", timeout: 5000, windowsHide: true, env: mcpGitProbeEnv() },
    );
    if (result.error) return undefined;
    if (result.status === 0) return true;
    if (result.status === 1) return false; // clean "not tracked" answer
    return undefined; // 128 = not a repo, and anything else unexpected
  } catch {
    return undefined;
  }
}

function snapshotEnvironment(source: NodeJS.ProcessEnv): {
  env: NodeJS.ProcessEnv;
  unavailable: boolean;
} {
  const snapshot = Object.create(null) as NodeJS.ProcessEnv;
  try {
    for (const key of Object.keys(source)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue;
      const value = source[key];
      if (value !== undefined) Object.defineProperty(snapshot, key, { value, enumerable: true });
    }
    return { env: Object.freeze(snapshot), unavailable: false };
  } catch {
    return { env: Object.freeze(snapshot), unavailable: true };
  }
}

/** Resolve precedence + the enablement gate into the runtime's data contract. */
export function resolveMcpConfig(opts: ResolveMcpConfigOptions): ResolvedMcpConfig {
  const environment = snapshotEnvironment(opts.env ?? process.env);
  const env = environment.env;
  const probe = opts.isGitTracked ?? defaultGitTrackedProbe;
  const trackedCache = new Map<string, boolean | undefined>();
  const classifyTracked = (filePath: string): boolean | undefined => {
    if (trackedCache.has(filePath)) return trackedCache.get(filePath);
    let tracked: boolean | undefined;
    try {
      tracked = probe(filePath, opts.projectRoot);
    } catch {
      tracked = undefined;
    }
    trackedCache.set(filePath, tracked);
    return tracked;
  };
  const diagnostics: string[] = [];
  const pushDiag = (message: string): void => {
    diagnostics.push(neutralizeControlChars(message));
  };
  const managedMcp = opts.managedMcp ?? { status: "absent" as const };
  const exclusiveCount = managedMcp.status === "loaded" ? managedMcp.servers.length : undefined;
  const standaloneFailure: McpPolicySourceFailure | undefined = managedMcp.status === "unusable"
    ? {
        kind: managedMcp.reason === "malformed" || managedMcp.reason === "wrong-root" || managedMcp.reason === "invalid-encoding"
          ? "malformed"
          : managedMcp.reason === "oversized" ? "omitted" : "unreadable",
        sourceClass: "system-file",
        authority: "administrator-controlled",
        remediation: "repair-administrator-policy",
      }
    : undefined;
  const suppliedFailures = opts.mcpPolicySourceFailures ?? [];
  const failures = standaloneFailure === undefined
    ? suppliedFailures
    : [standaloneFailure, ...suppliedFailures.slice(0, MCP_POLICY_LIMITS.sourceFailures - 1)];
  const failureOmitted = standaloneFailure !== undefined && suppliedFailures.length >= MCP_POLICY_LIMITS.sourceFailures;
  const policy = compileMcpPolicy({
    settings: opts.mcpPolicySettings ?? [],
    sourceFailures: failures,
    ...(exclusiveCount === undefined ? {} : { exclusiveManagedServerCount: exclusiveCount }),
    env,
    environmentUnavailable: environment.unavailable,
    restrictiveMaterialOmitted: opts.mcpPolicyRestrictiveMaterialOmitted === true || failureOmitted,
  });
  const admissionObservations = new Set(policy.observations);
  const policySnapshot = {
    policyPosture: policy.posture,
    policyAuthority: policy.authority,
    policyObservations: policy.observations,
    policyFailures: policy.failures,
    ...(managedMcp.status === "absent" ? {} : { policyOrdinarySourcesSuppressed: true as const }),
  };
  if (policy.posture === "fail-closed") {
    return { servers: [], diagnostics, ...policySnapshot };
  }
  if (policy.posture === "exclusive-empty") {
    return { servers: [], diagnostics, ...policySnapshot };
  }

  const exclusive = managedMcp.status === "loaded";
  const ordinary = !exclusive && opts.loadOrdinaryMcp !== undefined
    ? opts.loadOrdinaryMcp()
    : undefined;
  const mcpJson = ordinary?.mcpJson ?? opts.mcpJson ?? { servers: [], diagnostics: [], present: false };
  if (!exclusive) diagnostics.push(...mcpJson.diagnostics);
  const nativeState = exclusive
    ? { kind: "absent" as const, diagnostics: [] }
    : ordinary?.nativeState ?? opts.nativeState ?? { kind: "absent" as const, diagnostics: [] };
  if (nativeState.kind === "unusable") {
    return {
      servers: [],
      diagnostics: nativeState.diagnostics.map(neutralizeControlChars),
      failClosed: "native-state-unusable",
      ...(opts.nativeStateProfile === undefined ? {} : { failClosedProfile: opts.nativeStateProfile }),
      ...policySnapshot,
      policyPosture: "fail-closed",
    };
  }
  if (nativeState.kind === "loaded") diagnostics.push(...nativeState.diagnostics.map(neutralizeControlChars));

  // --- Effective origin per settings entry (git-tracked local demotion) -----
  const ordinarySettings = exclusive ? [] : opts.mcpSettings;
  const normalizedSettingsServers = ordinarySettings.map((entry) => entry.servers === undefined
    ? []
    : normalizeMcpServerBlock(entry.servers, "MCP settings"));
  const isPolicyAdmissible = (server: RawMcpEntry, source: McpSourceClass): boolean =>
    !server.skipped && !server.notConfigured && evaluateMcpPolicy(policy, server.remote === undefined
      ? { name: server.name, source, transport: "stdio", command: server.command, args: server.args }
      : { name: server.name, source, transport: server.remote.transportKind, url: server.remote.rawUrl }).status === "allowed";
  const higherFixedNames = new Set<string>([
    ...(nativeState.kind === "loaded" ? nativeState.user.servers.map((server) => server.name) : []),
    ...(nativeState.kind === "loaded" ? nativeState.local.servers.map((server) => server.name) : []),
    ...mcpJson.servers.map((server) => server.name),
    ...ordinarySettings.flatMap((setting, index) => setting.scope === "managed"
      ? normalizedSettingsServers[index]!.map((server) => server.name)
      : []),
  ]);
  const nativeLocalNames = new Set(nativeState.kind === "loaded"
    ? nativeState.local.servers.map((server) => server.name)
    : []);
  const approvalTargets = new Map<string, { server: RawMcpEntry; source: McpSourceClass }>();
  for (const server of mcpJson.servers) {
    if (!nativeLocalNames.has(server.name)) approvalTargets.set(server.name, { server, source: "project-mcpjson" });
  }
  for (let index = 0; index < ordinarySettings.length; index += 1) {
    if (ordinarySettings[index]!.scope !== "project") continue;
    for (const server of normalizedSettingsServers[index]!) {
      if (!higherFixedNames.has(server.name)) approvalTargets.set(server.name, { server, source: "settings-project" });
    }
  }
  const entries = ordinarySettings.map((entry, entryIndex) => {
    let origin: McpOrigin;
    let demoted = false;
    switch (entry.scope) {
      case "managed":
        origin = "settings-managed";
        break;
      case "local": {
        origin = "settings-local";
        // Demotion only matters for keys the gate treats differently by scope.
        // A file contributing ONLY disabledMcpjsonServers (honored from every
        // scope) needs no probe and no diagnostic — demotion changes nothing.
        const localServers = normalizedSettingsServers[entryIndex]!;
        const serverClassificationMatters = localServers.some((server) => {
          if (higherFixedNames.has(server.name)) return false;
          const projectContender = approvalTargets.get(server.name);
          return isPolicyAdmissible(server, "settings-local") || projectContender !== undefined &&
            projectContender.source === "settings-project" &&
            isPolicyAdmissible(projectContender.server, projectContender.source);
        });
        const approvalNames = new Set((entry.enabledMcpjsonServers ?? []).map(sanitizeForListMatch));
        const approvalClassificationMatters = [...approvalTargets.entries()].some(([name, target]) =>
          (entry.enableAllProjectMcpServers !== undefined || approvalNames.has(sanitizeForListMatch(name))) &&
          isPolicyAdmissible(target.server, target.source));
        if (!serverClassificationMatters && !approvalClassificationMatters) break;
        // A misbehaving injected probe must not break never-throw: a throw is
        // just another probe failure, and probe failure fails OPEN (untracked).
        const tracked = classifyTracked(entry.sourcePath);
        if (tracked === true) {
          origin = "settings-project";
          demoted = true;
          pushDiag(
            `"${entry.sourcePath}" is tracked by git, so a cloned repo could have authored it; ` +
              `its MCP configuration is treated as project scope (approvals ignored; any contributed servers are pending)`,
          );
        }
        break;
      }
      case "project":
        origin = "settings-project";
        break;
      default:
        origin = "settings-user";
        break;
    }
    return { entry, origin, demoted };
  });

  // --- Approvals ------------------------------------------------------------
  let enableAll: boolean | undefined;
  const enabledNames = new Set<string>();
  const disabledNames = new Set<string>();
  for (const { entry, origin, demoted } of entries) {
    // disabledMcpjsonServers is honored from EVERY scope and always wins.
    for (const name of entry.disabledMcpjsonServers ?? []) {
      disabledNames.add(sanitizeForListMatch(name));
    }
    const honored = origin === "settings-local" || origin === "settings-user" || origin === "settings-managed";
    if (!honored) {
      if (entry.enableAllProjectMcpServers !== undefined || entry.enabledMcpjsonServers !== undefined) {
        if (demoted) {
          pushDiag(
            `MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in ` +
              `${entry.sourcePath} cannot work while the file is tracked by git. Approve only explicitly ` +
              `trusted server names with "enabledMcpjsonServers" in user settings (~/.claude/settings.json, ` +
              `or the configured user directory). Create a local file from scratch only after a reviewed ` +
              `repository change stops tracking or removes the path; do not reuse project-supplied MCP content`,
          );
        } else {
          pushDiag(
            `MCP approvals ("enableAllProjectMcpServers"/"enabledMcpjsonServers") in project-scope ` +
              `settings are ignored — a cloned repo must not self-approve. Independently review server ` +
              `definitions, then add only explicitly trusted server names to "enabledMcpjsonServers" in ` +
              `user settings (~/.claude/settings.json, or the configured user directory) or a clean untracked ` +
              `.claude/settings.local.json; never copy project-supplied mcpServers, approval keys, or blanket ` +
              `approval (${entry.sourcePath})`,
          );
        }
      }
      continue;
    }
    // Ascending-precedence file order: the last honored value is nearest-wins.
    if (entry.enableAllProjectMcpServers !== undefined) enableAll = entry.enableAllProjectMcpServers;
    for (const name of entry.enabledMcpjsonServers ?? []) {
      enabledNames.add(sanitizeForListMatch(name));
    }
  }

  // --- Candidates & whole-entry precedence ---------------------------------
  let order = 0;
  // Map (not a plain object): server names may be "constructor"/"toString".
  const winners = new Map<string, Candidate>();
  const consider = (candidate: Candidate): void => {
    const current = winners.get(candidate.entry.name);
    if (
      current === undefined ||
      ORIGIN_RANK[candidate.origin] > ORIGIN_RANK[current.origin] ||
      (ORIGIN_RANK[candidate.origin] === ORIGIN_RANK[current.origin] && candidate.order > current.order)
    ) {
      winners.set(candidate.entry.name, candidate);
    }
  };
  if (managedMcp.status === "loaded") {
    for (const entry of managedMcp.servers) {
      consider({
        entry,
        origin: "managed-mcp",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "managed-mcp",
      });
    }
  }
  if (nativeState.kind === "loaded") {
    for (const entry of nativeState.user.servers) {
      consider({
        entry,
        origin: "native-user",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "native-user",
      });
    }
  }
  if (!exclusive) {
    for (const entry of mcpJson.servers) {
      consider({
        entry,
        origin: "mcpjson",
        authentic: true,
        projectApprovalRequired: true,
        order: order++,
        source: "project-mcpjson",
      });
    }
  }
  for (const { entry, origin } of entries) {
    if (entry.servers === undefined) continue;
    // Source reports the physical settings scope; a tracked local contribution
    // stays settings-local for display even when gating demotes its origin.
    const source: McpSourceClass = entry.scope === "managed"
      ? "settings-managed"
      : entry.scope === "local"
        ? "settings-local"
        : entry.scope === "project"
          ? "settings-project"
          : "settings-user";
    for (const raw of normalizeMcpServerBlock(entry.servers, source)) {
      consider({
        entry: raw,
        origin,
        authentic: false,
        projectApprovalRequired: origin === "settings-project",
        order: order++,
        source,
      });
    }
  }
  if (nativeState.kind === "loaded") {
    for (const entry of nativeState.local.servers) {
      consider({
        entry,
        origin: "native-local",
        authentic: true,
        projectApprovalRequired: false,
        order: order++,
        source: "native-local",
      });
    }
  }

  // --- Status + enabled-only expansion per winning entry -------------------
  const servers: ResolvedMcpServer[] = [];
  for (const { entry, authentic, projectApprovalRequired, source } of winners.values()) {
    const perDiags = [...entry.diagnostics];
    let status: McpServerStatus;
    let inactiveReason: McpInactiveReason | undefined;
    let policyInactiveReason: McpPolicyInactiveReason | undefined;
    if (entry.skipped) {
      status = "skipped";
    } else if (entry.notConfigured) {
      status = "not-configured";
    } else {
      const decision = evaluateMcpPolicy(policy, entry.remote === undefined
        ? {
            name: entry.name,
            source,
            transport: "stdio",
            command: entry.command,
            args: entry.args,
          }
        : {
            name: entry.name,
            source,
            transport: entry.remote.transportKind,
            url: entry.remote.rawUrl,
          });
      if ("observations" in decision) {
        for (const observation of decision.observations) admissionObservations.add(observation);
      }
      if (decision.status === "blocked") {
        status = "blocked";
        switch (decision.reason) {
          case "denied": policyInactiveReason = "policy-denied"; break;
          case "allow-miss": policyInactiveReason = "policy-allow-miss"; break;
          case "managed-only": policyInactiveReason = "policy-managed-only"; break;
          case "candidate-invalid": policyInactiveReason = "policy-candidate-invalid"; break;
          case "exclusive-control":
          case "fail-closed":
          case "allowed":
            // Aggregate-only decisions cannot reach a row; fail safely if an
            // invalid compiled token or future engine regression does so.
            policyInactiveReason = "policy-candidate-invalid";
            break;
        }
      } else if (
      authentic &&
      nativeState.kind === "loaded" &&
      nativeState.disabledMcpServers.has(entry.name)
    ) {
      status = "disabled";
      inactiveReason = "native-runtime-disabled";
    } else if (
      (!authentic || source === "project-mcpjson") &&
      disabledNames.has(sanitizeForListMatch(entry.name))
    ) {
      status = "disabled";
      inactiveReason = "mcpjson-rejected";
    } else if (
      projectApprovalRequired &&
      enableAll !== true &&
      !enabledNames.has(sanitizeForListMatch(entry.name))
    ) {
      status = "pending-approval";
      inactiveReason = "mcpjson-unapproved";
    } else {
      status = "enabled";
    }
    }

    const common = {
      name: entry.name,
      source,
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
    };
    const transportIdentity = entry.remote === undefined
      ? (entry.skipped ? {} : { transport: "stdio" as const })
      : {
          transport: entry.remote.transportKind,
          configuredType: entry.remote.configuredType,
        };

    // Inactive entries carry identity only: no raw templates, expanded values,
    // or fabricated fields can escape the resolver pipeline.
    if (status === "blocked") {
      servers.push({
        name: entry.name,
        source,
        ...transportIdentity,
        status: "blocked",
        inactiveReason: policyInactiveReason!,
        diagnostics: perDiags,
      });
      continue;
    }
    if (status !== "enabled") {
      servers.push({
        ...common,
        ...transportIdentity,
        status,
        ...(inactiveReason === undefined ? {} : { inactiveReason }),
        diagnostics: perDiags,
      });
      continue;
    }

    const unset = new Set<string>();
    const onUnset = (name: string): void => { unset.add(name); };
    if (entry.remote !== undefined) {
      const resolved = resolveRemoteMcpFields(
        entry.remote,
        env,
        onUnset,
        entry.name,
        source,
        opts.remoteWorkHooksForTest,
      );
      if (resolved.kind === "skipped") {
        servers.push({
          ...common,
          ...transportIdentity,
          status: "skipped",
          diagnostics: [...perDiags, ...resolved.diagnostics.map(neutralizeControlChars)],
        });
        continue;
      }
      servers.push({
        ...common,
        status: "enabled",
        transport: resolved.fields.transportKind,
        configuredType: resolved.fields.configuredType,
        url: resolved.fields.url,
        headers: resolved.fields.headers,
        ...(resolved.fields.sseDeprecation !== undefined
          ? { sseDeprecation: resolved.fields.sseDeprecation }
          : {}),
        diagnostics: [...perDiags, ...resolved.diagnostics.map(neutralizeControlChars)],
      });
      continue;
    }

    const command = expandEnvVars(entry.command, env, onUnset);
    const args = entry.args.map((arg) => expandEnvVars(arg, env, onUnset));
    const expandedEnv: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(entry.env)) {
      expandedEnv[key] = expandEnvVars(value, env, onUnset);
    }
    for (const name of unset) {
      perDiags.push(neutralizeControlChars(
        `environment variable "${name}" is not set and has no default; "\${${name}}" kept as literal text`,
      ));
    }
    servers.push({
      ...common,
      status: "enabled",
      transport: "stdio",
      command,
      args,
      env: expandedEnv,
      rawCommand: entry.command,
      diagnostics: perDiags,
    });
  }

  return {
    servers,
    diagnostics,
    ...policySnapshot,
    policyObservations: Object.freeze([...admissionObservations]),
  };
}
