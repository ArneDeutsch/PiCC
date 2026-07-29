import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expandEnvVars } from "./settings.js";
import { normalizeMcpServerBlock, type McpJsonResult, type RawMcpEntry } from "../claude/mcp-config.js";
import { resolveRemoteMcpFields } from "../claude/mcp-remote-config.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { sanitizedSubprocessEnv } from "../util/env.js";
import type {
  McpServerStatus,
  McpSettingsEntry,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from "../types.js";

/**
 * MCP precedence & enablement resolution — pure data, no processes.
 *
 * Combines the project `.mcp.json` with the scope-tagged `mcpServers` settings
 * captures into one {@link ResolvedMcpConfig}:
 *
 * - Same server name in several sources: the WHOLE entry from the
 *   highest-precedence source wins — managed > local > project-settings >
 *   `.mcp.json` > user; fields are never merged across sources.
 * - Enablement gate: project-origin servers (`.mcp.json`, project-scope
 *   settings) are pending approval by default. `enableAllProjectMcpServers`
 *   and `enabledMcpjsonServers` are honored ONLY from user-authored scopes
 *   (local/user/managed); project-scope occurrences are ignored with a
 *   diagnostic. `disabledMcpjsonServers` is honored from every scope and
 *   always wins. List keys accumulate-and-dedupe across honored scopes
 *   (the `permissions.allow/deny` idiom); the boolean is nearest-wins.
 *   List membership compares SANITIZED names on both sides (Claude parity —
 *   see {@link sanitizeForListMatch}), so `"my_server"` in a list matches a
 *   server named `my.server`.
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
  /** Result of {@link loadMcpJson} for the project root. */
  mcpJson: McpJsonResult;
  /** Scope-tagged settings captures, in ascending-precedence file order. */
  mcpSettings: McpSettingsEntry[];
  env?: NodeJS.ProcessEnv;
  /** Test seam; defaults to a `git ls-files --error-unmatch` child call. */
  isGitTracked?: GitTrackedProbe;
}

/** Origin category of a candidate; "mcpjson" ranks between project and user. */
type McpOrigin = "user" | "mcpjson" | "project" | "local" | "managed";

const ORIGIN_RANK: Record<McpOrigin, number> = {
  user: 0,
  mcpjson: 1,
  project: 2,
  local: 3,
  managed: 4,
};

interface Candidate {
  entry: RawMcpEntry;
  origin: McpOrigin;
  /** Global discovery index; among equal ranks the later (nearer) file wins. */
  order: number;
  source: string;
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

/** Resolve precedence + the enablement gate into the runtime's data contract. */
export function resolveMcpConfig(opts: ResolveMcpConfigOptions): ResolvedMcpConfig {
  const env = opts.env ?? process.env;
  const probe = opts.isGitTracked ?? defaultGitTrackedProbe;
  const diagnostics: string[] = [];
  const pushDiag = (message: string): void => {
    diagnostics.push(neutralizeControlChars(message));
  };
  diagnostics.push(...opts.mcpJson.diagnostics);

  // --- Effective origin per settings entry (git-tracked local demotion) -----
  const entries = opts.mcpSettings.map((entry) => {
    let origin: McpOrigin;
    let demoted = false;
    switch (entry.scope) {
      case "managed":
        origin = "managed";
        break;
      case "local": {
        origin = "local";
        // Demotion only matters for keys the gate treats differently by scope.
        // A file contributing ONLY disabledMcpjsonServers (honored from every
        // scope) needs no probe and no diagnostic — demotion changes nothing.
        const contributesGated =
          entry.servers !== undefined ||
          entry.enableAllProjectMcpServers !== undefined ||
          entry.enabledMcpjsonServers !== undefined;
        if (!contributesGated) break;
        // A misbehaving injected probe must not break never-throw: a throw is
        // just another probe failure, and probe failure fails OPEN (untracked).
        let tracked: boolean | undefined;
        try {
          tracked = probe(entry.sourcePath, opts.projectRoot);
        } catch {
          tracked = undefined;
        }
        if (tracked === true) {
          origin = "project";
          demoted = true;
          pushDiag(
            `"${entry.sourcePath}" is tracked by git, so a cloned repo could have authored it; ` +
              `its MCP configuration is treated as project scope (approvals ignored, servers pending)`,
          );
        }
        break;
      }
      case "project":
        origin = "project";
        break;
      default:
        origin = "user";
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
    const honored = origin === "local" || origin === "user" || origin === "managed";
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
  for (const entry of opts.mcpJson.servers) {
    consider({ entry, origin: "mcpjson", order: order++, source: ".mcp.json" });
  }
  for (const { entry, origin } of entries) {
    if (entry.servers === undefined) continue;
    // Source names the PHYSICAL scope; a demoted local file keeps
    // "settings:local" for display while gating as project origin.
    const source = `settings:${entry.scope}`;
    for (const raw of normalizeMcpServerBlock(entry.servers, source)) {
      consider({ entry: raw, origin, order: order++, source });
    }
  }

  // --- Status + enabled-only expansion per winning entry -------------------
  const servers: ResolvedMcpServer[] = [];
  for (const { entry, origin, source } of winners.values()) {
    const perDiags = [...entry.diagnostics];
    let status: McpServerStatus;
    if (entry.skipped) {
      status = "skipped";
    } else if (entry.notConfigured) {
      status = "not-configured";
    } else if (disabledNames.has(sanitizeForListMatch(entry.name))) {
      status = "disabled";
    } else if (origin === "mcpjson" || origin === "project") {
      status =
        enableAll === true || enabledNames.has(sanitizeForListMatch(entry.name))
          ? "enabled"
          : "pending-approval";
    } else {
      status = "enabled";
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
    if (status !== "enabled") {
      servers.push({ ...common, ...transportIdentity, status, diagnostics: perDiags });
      continue;
    }

    const unset = new Set<string>();
    const onUnset = (name: string): void => { unset.add(name); };
    if (entry.remote !== undefined) {
      const resolved = resolveRemoteMcpFields(entry.remote, env, onUnset, entry.name, source);
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

  return { servers, diagnostics };
}
