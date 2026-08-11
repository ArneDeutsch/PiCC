import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { killProcessTree } from "../../util/process-tree.js";
import { routeCatalogPluginSource, routeMarketplaceSource } from "../source-matrix.js";
import { issuePrivateStagingParent, revalidateOwnedStateStore } from "../state-store.js";
import { discardMaterializedPluginTree, materializePluginTree, validatePluginTree, type MaterializedPluginTree, type PluginTreeEntry } from "../tree-materializer.js";
import type { CatalogPluginSource, MarketplaceRegistrationSource, Sha256 } from "../types.js";
import { acquisitionFailure, parseBoundedJsonObject, type AcquisitionFailure, type AcquisitionResult, type ReviewedHttpIdentity } from "./common.js";
import { ACCEPTED_PUBLIC_HTTPS_PORTS, isPublicAddress, productionResolver, type HttpResolver } from "./http.js";
import { normalizeGithubMarketplaceSource, normalizeGithubPluginSource } from "./github.js";
import type { OwnedStateStore } from "../state-store.js";

export const GIT_ACQUISITION_LIMITS = Object.freeze({ maximumOutputBytes: 18 * 1024 * 1024, timeoutMilliseconds: 15_000 });
const decoder = new TextDecoder("utf-8", { fatal: true });

type GitSource = Extract<MarketplaceRegistrationSource, { readonly kind: "github" | "https-git" }>
  | Extract<CatalogPluginSource, { readonly kind: "github" | "https-git" | "https-git-subdir" }>;

export interface GitRunRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly input?: Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds: number;
  readonly maximumOutputBytes: number;
}
export interface GitRunResult { readonly code: number; readonly stdout: Uint8Array; readonly stderr: Uint8Array }
export type GitRunner = (request: GitRunRequest) => Promise<GitRunResult>;

class ProcessFault extends Error { constructor(readonly kind: "cancelled" | "timeout" | "output" | "launch") { super(kind); } }
class GitFault extends Error {
  constructor(readonly kind: "unsupported-pinning" | "unreadable" | "integrity" | "changed-store" | "unsafe-staging" | "unsafe-materialization" | "unsafe-endpoint" | "url-policy") { super(kind); }
}
class ResolverFault extends Error { constructor(readonly kind: "cancelled" | "timeout") { super(kind); } }

const WINDOWS_TASKKILL_TIMEOUT_MS = 750;
const TERMINATION_SETTLEMENT_TIMEOUT_MS = 1_250;

function helperEnv(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    ...(env["PATH"] === undefined ? {} : { PATH: env["PATH"] }),
    ...(env["SystemRoot"] === undefined ? {} : { SystemRoot: env["SystemRoot"] }),
    ...(env["WINDIR"] === undefined ? {} : { WINDIR: env["WINDIR"] }),
    ...(env["PATHEXT"] === undefined ? {} : { PATHEXT: env["PATHEXT"] }),
  };
}

async function runBoundedWindowsTaskkill(pid: number, cwd: string, env: Readonly<NodeJS.ProcessEnv>): Promise<boolean> {
  return await new Promise((resolve) => {
    let helper: ChildProcessWithoutNullStreams;
    try {
      helper = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        cwd, env: helperEnv(env), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch { resolve(false); return; }
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(succeeded);
    };
    helper.on("error", () => finish(false));
    helper.on("close", (code) => finish(code === 0));
    helper.stdin.end(); helper.stdout.resume(); helper.stderr.resume();
    const timer = setTimeout(() => {
      try { helper.kill("SIGKILL"); } catch { /* helper timeout is explicitly classified as failure */ }
      finish(false);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref();
  });
}

async function terminateGitProcessTree(child: ChildProcessWithoutNullStreams, cwd: string, env: Readonly<NodeJS.ProcessEnv>): Promise<void> {
  if (child.pid === undefined) { try { child.kill("SIGKILL"); } catch { /* child never acquired a process id */ } return; }
  if (process.platform === "win32") {
    if (!await runBoundedWindowsTaskkill(child.pid, cwd, env)) {
      try { child.kill("SIGKILL"); } catch { /* taskkill may have raced with direct-child exit */ }
    }
    return;
  }
  // A private process group is required because Git may outlive its front process through a transport helper.
  try { process.kill(-child.pid, "SIGKILL"); } catch { killProcessTree(child); }
}

export const productionGitRunner: GitRunner = async (request) => await new Promise((resolve, reject) => {
  if (request.signal?.aborted === true) { reject(new ProcessFault("cancelled")); return; }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(request.executable, [...request.args], {
      cwd: request.cwd, env: { ...request.env }, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { reject(new ProcessFault("launch")); return; }
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  let bytes = 0; let terminal: ProcessFault | undefined; let settled = false; let terminationTimer: NodeJS.Timeout | undefined;
  const finish = (code: number | null): void => {
    if (settled) return; settled = true; clearTimeout(timer); if (terminationTimer !== undefined) clearTimeout(terminationTimer);
    request.signal?.removeEventListener("abort", abort);
    if (terminal !== undefined) reject(terminal);
    else resolve(Object.freeze({ code: code ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  };
  const stop = (fault: ProcessFault): void => {
    if (terminal !== undefined) return;
    terminal = fault;
    void terminateGitProcessTree(child, request.cwd, request.env);
    terminationTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* final direct-child fallback before forced settlement */ }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); finish(null);
    }, TERMINATION_SETTLEMENT_TIMEOUT_MS); terminationTimer.unref();
  };
  const collect = (target: Buffer[]) => (chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (bytes > request.maximumOutputBytes) stop(new ProcessFault("output"));
    else target.push(Buffer.from(chunk));
  };
  child.stdout.on("data", collect(stdout)); child.stderr.on("data", collect(stderr));
  child.on("error", () => stop(new ProcessFault("launch")));
  const abort = (): void => stop(new ProcessFault("cancelled"));
  request.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new ProcessFault("timeout")), request.timeoutMilliseconds); timer.unref();
  child.on("close", finish);
  child.stdin.on("error", () => undefined);
  child.stdin.end(request.input);
});

interface ExactSource { readonly source: GitSource; readonly url: string; readonly subdir?: string }

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(descriptors).every((item) => item.get === undefined && item.set === undefined);
}
function sameKeys(value: Record<string, unknown>, expected: object): boolean {
  const left = Object.getOwnPropertyNames(value).sort(); const right = Object.getOwnPropertyNames(expected).sort();
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
function exactMarketplaceSource(value: unknown): ExactSource | undefined {
  if (!plain(value)) return undefined;
  if (value["kind"] === "github") {
    const normalized = normalizeGithubMarketplaceSource(value);
    return normalized === undefined ? undefined : { source: normalized.source, url: normalized.url };
  }
  const routed = routeMarketplaceSource({ source: "git", url: value["url"], ...(value["ref"] === undefined ? {} : { ref: value["ref"] }) });
  if (!routed.ok || routed.value.descriptor.kind !== "https-git" || !sameKeys(value, routed.value.descriptor)) return undefined;
  const source = routed.value.descriptor;
  return value["kind"] === source.kind && value["url"] === source.url && value["ref"] === source.ref ? { source, url: source.url } : undefined;
}
function exactPluginSource(value: unknown): ExactSource | undefined {
  if (!plain(value)) return undefined;
  if (value["kind"] === "github") {
    const normalized = normalizeGithubPluginSource(value);
    return normalized === undefined ? undefined : { source: normalized.source, url: normalized.url };
  }
  const matrixSource = value["kind"] === "https-git-subdir" ? "git-subdir" : "url";
  const routed = routeCatalogPluginSource({
    source: matrixSource, url: value["url"], ...(value["path"] === undefined ? {} : { path: value["path"] }),
    ...(value["ref"] === undefined ? {} : { ref: value["ref"] }), ...(value["sha"] === undefined ? {} : { sha: value["sha"] }),
  }, { marketplaceSourceKind: "local-directory" });
  if (!routed.ok || (routed.value.descriptor.kind !== "https-git" && routed.value.descriptor.kind !== "https-git-subdir")
    || !sameKeys(value, routed.value.descriptor)) return undefined;
  const source = routed.value.descriptor;
  return value["kind"] === source.kind && value["url"] === source.url && value["ref"] === source.ref && value["sha"] === source.sha
    && (source.kind !== "https-git-subdir" || value["path"] === source.path)
    ? { source, url: source.url, ...(source.kind === "https-git-subdir" ? { subdir: source.path } : {}) } : undefined;
}

interface WitnessEndpoint { readonly reviewed: ReviewedHttpIdentity; readonly caFile: string }
declare const witnessBrand: unique symbol;
export interface GitSmartHttpWitnessEndpoint { readonly [witnessBrand]: true }
const witnesses = new WeakMap<GitSmartHttpWitnessEndpoint, WitnessEndpoint>();
export function issueGitSmartHttpWitnessEndpointForTest(reviewed: ReviewedHttpIdentity, caFile: string): GitSmartHttpWitnessEndpoint {
  if (process.env["VITEST"] !== "true" || reviewed.hostname !== "git-witness.example.org" || (reviewed.address !== "127.0.0.1" && reviewed.address !== "127.0.0.2")
    || reviewed.family !== 4 || reviewed.port < 1 || reviewed.port > 65535 || reviewed.canonicalUrl !== `https://git-witness.example.org:${reviewed.port}/repo.git`) {
    throw new Error("Invalid guarded Git smart-HTTP witness endpoint");
  }
  const capability = Object.freeze({}) as GitSmartHttpWitnessEndpoint;
  witnesses.set(capability, Object.freeze({ reviewed, caFile }));
  return capability;
}

declare const postMaterializationWitnessBrand: unique symbol;
export interface GitPostMaterializationWitness { readonly [postMaterializationWitnessBrand]: true }
const postMaterializationWitnesses = new WeakMap<GitPostMaterializationWitness, () => void>();
export function issueGitPostMaterializationWitnessForTest(trigger: () => void): GitPostMaterializationWitness {
  if (process.env["VITEST"] !== "true") throw new Error("Git post-materialization witnesses are test-only");
  const capability = Object.freeze({}) as GitPostMaterializationWitness;
  postMaterializationWitnesses.set(capability, trigger);
  return capability;
}

export interface GitAcquisitionOptions {
  readonly store: OwnedStateStore;
  readonly runner?: GitRunner;
  readonly resolver?: HttpResolver;
  readonly signal?: AbortSignal;
  readonly gitExecutable?: string;
  readonly timeoutMilliseconds?: number;
  readonly witnessEndpoint?: GitSmartHttpWitnessEndpoint;
  readonly postMaterializationWitness?: GitPostMaterializationWitness;
}

interface Runtime { readonly runner: GitRunner; readonly executable: string; readonly timeout: number; readonly signal?: AbortSignal }
function endpointUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url); const port = parsed.port === "" ? 443 : Number(parsed.port);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === ""
      && ACCEPTED_PUBLIC_HTTPS_PORTS.includes(port as 443 | 8443) ? parsed : undefined;
  } catch { return undefined; }
}
async function reviewEndpoint(sourceUrl: string, options: GitAcquisitionOptions): Promise<ReviewedHttpIdentity | undefined> {
  const witness = options.witnessEndpoint === undefined ? undefined : witnesses.get(options.witnessEndpoint);
  if (witness !== undefined) return witness.reviewed.canonicalUrl === sourceUrl ? witness.reviewed : undefined;
  const url = endpointUrl(sourceUrl); if (url === undefined) return undefined;
  const operation = new AbortController();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? GIT_ACQUISITION_LIMITS.timeoutMilliseconds;
  const addresses = await new Promise<readonly { readonly address: string; readonly family: 4 | 6 }[]>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); };
    const finish = (outcome: { readonly value: readonly { readonly address: string; readonly family: 4 | 6 }[] } | { readonly error: unknown }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ("error" in outcome) reject(outcome.error); else resolve(outcome.value);
    };
    const cancel = (): void => { operation.abort(); finish({ error: new ResolverFault("cancelled") }); };
    const timer = setTimeout(() => { operation.abort(); finish({ error: new ResolverFault("timeout") }); }, timeoutMilliseconds);
    timer.unref();
    options.signal?.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(async () => await (options.resolver ?? productionResolver)(url.hostname, operation.signal)).then(
      (value) => finish({ value }),
      (error: unknown) => finish({ error }),
    );
    if (options.signal?.aborted === true) cancel();
  });
  if (addresses.length === 0 || addresses.some((item) => item.family !== (item.address.includes(":") ? 6 : 4) || !isPublicAddress(item.address))) {
    throw new GitFault("unsafe-endpoint");
  }
  const selected = addresses[0]!; const port = url.port === "" ? 443 : Number(url.port);
  return Object.freeze({ kind: "https-destination", origin: url.origin, hostname: url.hostname, port, address: selected.address, family: selected.family,
    canonicalUrl: url.href, path: url.pathname, redirectCount: 0, redirected: false });
}
function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "global-config"),
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C.UTF-8", LANG: "C.UTF-8",
  };
  if (process.env["PATH"] !== undefined) env["PATH"] = process.env["PATH"];
  if (process.platform === "win32" && process.env["SystemRoot"] !== undefined) env["SystemRoot"] = process.env["SystemRoot"];
  return env;
}
function resolveValue(reviewed: ReviewedHttpIdentity): string {
  const address = reviewed.family === 6 ? `[${reviewed.address}]` : reviewed.address;
  return `${reviewed.hostname}:${reviewed.port}:${address}`;
}
function transportConfig(reviewed: ReviewedHttpIdentity, caFile: string | undefined): readonly string[] {
  const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  const pairs: readonly (readonly [string, string])[] = [
    ["credential.helper", ""], ["credential.interactive", "never"], ["core.askPass", ""], ["core.hooksPath", nullHooks],
    ["http.proxy", ""], ["https.proxy", ""], ["http.followRedirects", "false"], ["http.cookieFile", ""], ["http.saveCookies", "false"],
    ["http.extraHeader", ""], ["protocol.allow", "never"], ["protocol.https.allow", "always"], ["protocol.version", "2"],
    ["fetch.recurseSubmodules", "false"], ["submodule.recurse", "false"], ["http.curloptResolve", resolveValue(reviewed)],
    ...(caFile === undefined ? [] : [["http.sslCAInfo", caFile] as const]),
  ];
  return Object.freeze(pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]));
}
async function run(runtime: Runtime, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: Uint8Array): Promise<GitRunResult> {
  return await runtime.runner({ executable: runtime.executable, args, cwd, env, ...(input === undefined ? {} : { input }),
    ...(runtime.signal === undefined ? {} : { signal: runtime.signal }), timeoutMilliseconds: runtime.timeout, maximumOutputBytes: GIT_ACQUISITION_LIMITS.maximumOutputBytes });
}
async function prepareDirectory(store: OwnedStateStore): Promise<string> {
  const valid = await revalidateOwnedStateStore(store); if (!valid.ok) throw new GitFault("changed-store");
  try {
    const directory = await fs.mkdtemp(path.join(store.stagingRoot, ".picc-git-"));
    await fs.chmod(directory, 0o700); await fs.writeFile(path.join(directory, "global-config"), "", { mode: 0o600 });
    return directory;
  } catch { throw new GitFault("changed-store"); }
}
async function assertPinningCapability(runtime: Runtime, directory: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await run(runtime, directory, env, ["help", "--config"]);
  try {
    if (result.code !== 0 || !decoder.decode(result.stdout).split(/\r?\n/).includes("http.curloptResolve")) throw new GitFault("unsupported-pinning");
  } catch (error) {
    if (error instanceof GitFault) throw error;
    throw new GitFault("unsupported-pinning");
  }
}

function faultResult(error: unknown, signal: AbortSignal | undefined, operation: "resolution" | "acquisition"): AcquisitionFailure {
  if (signal?.aborted === true || (error instanceof ProcessFault && error.kind === "cancelled") || (error instanceof ResolverFault && error.kind === "cancelled")) {
    return acquisitionFailure("cancelled", operation === "resolution" ? "Git source resolution was cancelled" : "Git acquisition was cancelled");
  }
  if ((error instanceof ProcessFault || error instanceof ResolverFault) && error.kind === "timeout") {
    return acquisitionFailure("timeout", operation === "resolution" ? "The bounded Git source resolution timed out" : "The bounded Git acquisition timed out");
  }
  if (error instanceof ProcessFault && error.kind === "output") return acquisitionFailure("limit-exceeded", "Git source output exceeded the acquisition limit");
  if (error instanceof ProcessFault && error.kind === "launch") {
    return acquisitionFailure("unreadable", "Git is unavailable; install Git, put git on PATH, and retry");
  }
  if (error instanceof GitFault && error.kind === "unreadable") return acquisitionFailure("unreadable", "Git repository state could not be initialized or read safely");
  if (error instanceof GitFault && error.kind === "changed-store") {
    return acquisitionFailure("unreadable", "PiCC lifecycle storage changed or became unavailable; retry the lifecycle operation");
  }
  if (error instanceof GitFault && error.kind === "unsafe-staging") {
    return acquisitionFailure("unsafe-source", "PiCC refused an unsafe private staging location for Git content. Verify PiCC profile storage is writable and unchanged, then retry");
  }
  if (error instanceof GitFault && error.kind === "unsafe-materialization") {
    return acquisitionFailure("integrity", "Git content could not be safely materialized in private staging. Verify PiCC profile storage is writable and unchanged, then retry");
  }
  if (error instanceof GitFault && error.kind === "unsafe-endpoint") {
    return acquisitionFailure("unsafe-source", "The Git destination did not resolve exclusively to admitted public addresses");
  }
  if (error instanceof GitFault && error.kind === "url-policy") {
    return acquisitionFailure("unsafe-source", "Anonymous Git requires HTTPS on an allowed port (443 or 8443)");
  }
  if (error instanceof GitFault && error.kind === "unsupported-pinning") {
    return acquisitionFailure("unsafe-source", "Installed Git cannot safely pin anonymous HTTPS sources; upgrade Git to a version supporting http.curloptResolve and retry");
  }
  if (error instanceof GitFault && error.kind === "integrity") {
    return acquisitionFailure("integrity", "Git revision or object evidence is ambiguous, malformed, or disagrees with the declared ref/SHA");
  }
  const action = "Confirm the repository is public and reachable without sign-in and allowed by your network/TLS policy; private repositories and credentials are unsupported";
  return acquisitionFailure("network-failure", operation === "resolution"
    ? `The anonymous Git source could not be resolved under the required pinned transport. ${action}`
    : `The anonymous Git source could not be acquired under the required pinned transport. ${action}`);
}

function remotePatterns(ref: string | undefined): readonly string[] {
  if (ref === undefined) return Object.freeze(["HEAD"]);
  if (ref.startsWith("refs/heads/")) return Object.freeze([ref]);
  if (ref.startsWith("refs/tags/")) return Object.freeze([ref, `${ref}^{}`]);
  return Object.freeze([`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]);
}
function resolveRemote(stdout: Uint8Array, ref: string | undefined, declaredSha: string | undefined): string | undefined {
  const text = decoder.decode(stdout); const rows = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "" || line.startsWith("ref: ")) continue;
    const match = /^([0-9a-f]{40})\t([^\u0000-\u001f\u007f]+)$/.exec(line); if (match === null) return undefined;
    const existing = rows.get(match[2]!); if (existing !== undefined && existing !== match[1]) return undefined;
    rows.set(match[2]!, match[1]!);
  }
  let candidates: string[];
  if (ref === undefined && declaredSha !== undefined) candidates = [declaredSha];
  else if (ref === undefined) candidates = rows.get("HEAD") === undefined ? [] : [rows.get("HEAD")!];
  else if (ref.startsWith("refs/tags/")) candidates = [rows.get(`${ref}^{}`) ?? rows.get(ref)].filter((item): item is string => item !== undefined);
  else if (ref.startsWith("refs/heads/")) candidates = [rows.get(ref)].filter((item): item is string => item !== undefined);
  else {
    candidates = [rows.get(`refs/heads/${ref}`), rows.get(`refs/tags/${ref}^{}`) ?? rows.get(`refs/tags/${ref}`)].filter((item): item is string => item !== undefined);
  }
  candidates = [...new Set(candidates)];
  const commit = candidates.length === 1 ? candidates[0] : (ref === undefined && declaredSha !== undefined ? declaredSha : undefined);
  return commit !== undefined && (declaredSha === undefined || commit === declaredSha) ? commit : undefined;
}

function remoteMatches(stdout: Uint8Array, ref: string | undefined, declaredSha: string | undefined, commit: string): boolean {
  try { return resolveRemote(stdout, ref, declaredSha) === commit; } catch { return false; }
}

declare const previewBrand: unique symbol;
export interface ResolvedGitPreview {
  readonly [previewBrand]: true;
  readonly source: GitSource;
  readonly declarationFamily: GitSource["kind"];
  readonly reviewedEndpoint: ReviewedHttpIdentity;
  readonly commit: string;
  readonly ref: string;
  readonly selectedSubdirectory?: string;
}
interface PreviewPrivate { readonly exact: ExactSource; readonly surface: "marketplace" | "plugin"; readonly caFile?: string }
const previews = new WeakMap<ResolvedGitPreview, PreviewPrivate>();

async function resolveGitSource(sourceValue: unknown, surface: "marketplace" | "plugin", options: GitAcquisitionOptions): Promise<AcquisitionResult<ResolvedGitPreview>> {
  const exact = surface === "marketplace" ? exactMarketplaceSource(sourceValue) : exactPluginSource(sourceValue);
  if (exact === undefined) {
    if (plain(sourceValue) && (sourceValue["kind"] === "https-git" || sourceValue["kind"] === "https-git-subdir")
      && typeof sourceValue["url"] === "string" && endpointUrl(sourceValue["url"]) === undefined) {
      return acquisitionFailure("unsafe-source", "Anonymous Git requires HTTPS on an allowed port (443 or 8443)");
    }
    return acquisitionFailure("unsafe-source", "The Git source is not an exact supported anonymous HTTPS declaration");
  }
  let directory = "";
  try {
    const reviewed = await reviewEndpoint(exact.url, options); if (reviewed === undefined) throw new GitFault("url-policy");
    directory = await prepareDirectory(options.store); const env = isolatedEnv(directory); env["GIT_DIR"] = path.join(directory, "preview.git");
    const runtime: Runtime = { runner: options.runner ?? productionGitRunner, executable: options.gitExecutable ?? "git", timeout: options.timeoutMilliseconds ?? GIT_ACQUISITION_LIMITS.timeoutMilliseconds, ...(options.signal === undefined ? {} : { signal: options.signal }) };
    await assertPinningCapability(runtime, directory, env);
    const witness = options.witnessEndpoint === undefined ? undefined : witnesses.get(options.witnessEndpoint);
    const result = await run(runtime, directory, env, [...transportConfig(reviewed, witness?.caFile), "ls-remote", "--symref", "--exit-code", exact.url, ...remotePatterns(exact.source.ref)]);
    if (result.code === 2) return acquisitionFailure("not-found", "The anonymous Git repository or requested ref was not found; verify the public repository and ref, then resolve again");
    if (result.code !== 0) throw new Error("remote");
    const declaredSha = "sha" in exact.source ? exact.source.sha : undefined;
    let commit: string | undefined;
    try { commit = resolveRemote(result.stdout, exact.source.ref, declaredSha); } catch { throw new GitFault("integrity"); }
    if (commit === undefined) throw new GitFault("integrity");
    if ((await run(runtime, directory, env, ["init", "--bare", env["GIT_DIR"]!])).code !== 0) throw new GitFault("unreadable");
    if ((await run(runtime, directory, env, [...transportConfig(reviewed, witness?.caFile), "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", exact.url, commit])).code !== 0) throw new Error("fetch");
    if ((await run(runtime, directory, env, ["cat-file", "-e", `${commit}^{commit}`])).code !== 0) throw new GitFault("integrity");
    const preview = Object.freeze({ source: exact.source, declarationFamily: exact.source.kind, reviewedEndpoint: reviewed, commit,
      ref: exact.source.ref ?? "HEAD", ...(exact.subdir === undefined ? {} : { selectedSubdirectory: exact.subdir }) }) as ResolvedGitPreview;
    previews.set(preview, Object.freeze({ exact, surface, ...(witness === undefined ? {} : { caFile: witness.caFile }) }));
    return { ok: true, value: preview };
  } catch (error) {
    return faultResult(error, options.signal, "resolution");
  } finally { if (directory !== "") await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}

export async function resolveGitMarketplaceSource(sourceValue: unknown, options: GitAcquisitionOptions): Promise<AcquisitionResult<ResolvedGitPreview>> {
  return await resolveGitSource(sourceValue, "marketplace", options);
}

export async function resolveGitPluginSource(sourceValue: unknown, options: GitAcquisitionOptions): Promise<AcquisitionResult<ResolvedGitPreview>> {
  return await resolveGitSource(sourceValue, "plugin", options);
}

function parseTree(bytes: Uint8Array): { readonly entries: readonly PluginTreeEntry[]; readonly blobs: readonly string[] } | undefined {
  const text = decoder.decode(bytes); const entries: PluginTreeEntry[] = []; const blobs: string[] = [];
  for (const row of text.split("\0")) {
    if (row === "") continue;
    const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(row); if (match === null) return undefined;
    const [, mode, kind, object, entryPath] = match;
    const legalPair = (mode === "040000" && kind === "tree")
      || ((mode === "100644" || mode === "100755" || mode === "120000") && kind === "blob")
      || (mode === "160000" && kind === "commit");
    if (!legalPair) return undefined;
    if (mode === "120000" || mode === "160000") {
      entries.push(Object.freeze({ path: entryPath!, kind: mode === "120000" ? "symlink" : "special" })); continue;
    }
    if (kind === "tree") entries.push(Object.freeze({ path: entryPath!, kind: "directory" }));
    else { blobs.push(object!); entries.push(Object.freeze({ path: entryPath!, kind: "file", data: new Uint8Array(), executable: mode === "100755" })); }
  }
  return { entries: Object.freeze(entries), blobs: Object.freeze(blobs) };
}
function parseBatch(bytes: Uint8Array, objects: readonly string[]): readonly Uint8Array[] | undefined {
  const output: Uint8Array[] = []; let offset = 0;
  for (const object of objects) {
    const newline = bytes.indexOf(10, offset); if (newline < 0) return undefined;
    const header = decoder.decode(bytes.subarray(offset, newline)); const match = new RegExp(`^${object} blob ([0-9]+)$`).exec(header); if (match === null) return undefined;
    const size = Number(match[1]); if (!Number.isSafeInteger(size) || size < 0 || newline + 1 + size >= bytes.byteLength || bytes[newline + 1 + size] !== 10) return undefined;
    output.push(Uint8Array.from(bytes.subarray(newline + 1, newline + 1 + size))); offset = newline + 2 + size;
  }
  return offset === bytes.byteLength ? Object.freeze(output) : undefined;
}
async function readEntries(runtime: Runtime, directory: string, env: NodeJS.ProcessEnv, commit: string, subdir: string | undefined): Promise<readonly PluginTreeEntry[]> {
  const treeish = subdir === undefined ? commit : `${commit}:${subdir}`;
  const listed = await run(runtime, directory, env, ["ls-tree", "-rz", "-r", "-t", treeish]); if (listed.code !== 0) throw new GitFault("integrity");
  let parsed: ReturnType<typeof parseTree>;
  try { parsed = parseTree(listed.stdout); } catch { throw new GitFault("integrity"); }
  if (parsed === undefined) throw new GitFault("integrity");
  const batch = await run(runtime, directory, env, ["cat-file", "--batch"], Buffer.from(parsed.blobs.map((item) => `${item}\n`).join("")));
  if (batch.code !== 0) throw new GitFault("integrity");
  let data: ReturnType<typeof parseBatch>;
  try { data = parseBatch(batch.stdout, parsed.blobs); } catch { throw new GitFault("integrity"); }
  if (data === undefined) throw new GitFault("integrity");
  let index = 0;
  return Object.freeze(parsed.entries.map((entry) => entry.kind === "file" ? Object.freeze({ ...entry, data: data[index++]! }) : entry));
}

export interface GitAcquisitionProvenance {
  readonly adapter: "anonymous-https-git" | "anonymous-https-git-subdir";
  readonly declarationFamily: GitSource["kind"];
  readonly reviewed: ReviewedHttpIdentity;
  readonly commit: string;
  readonly ref: string;
  readonly selectedSubdirectory?: string;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly selectedRoot: MaterializedPluginTree["rootSelection"];
}
declare const evidenceBrand: unique symbol;
export interface GitPluginAcquisitionEvidence {
  readonly [evidenceBrand]: true; readonly kind: "git-plugin-acquisition"; readonly source: GitSource;
  readonly commit: string; readonly artifactDigest: Sha256; readonly treeDigest: Sha256; readonly rootDigest: Sha256;
  readonly materialized: MaterializedPluginTree; readonly provenance: GitAcquisitionProvenance;
}
export interface GitMarketplaceSnapshotEvidence {
  readonly [evidenceBrand]: true; readonly kind: "git-marketplace-snapshot"; readonly source: GitSource; readonly commit: string;
  readonly snapshotId: `marketplace-${string}`; readonly catalogDigest: Sha256; readonly materialized: MaterializedPluginTree; readonly provenance: GitAcquisitionProvenance;
}
const evidence = new WeakSet<object>();
const marketplaceCatalogs = new WeakMap<GitMarketplaceSnapshotEvidence, Uint8Array>();
export function isGitAcquisitionEvidence(value: unknown): value is GitPluginAcquisitionEvidence | GitMarketplaceSnapshotEvidence {
  return typeof value === "object" && value !== null && evidence.has(value);
}
export function readGitMarketplaceCatalog(evidenceValue: GitMarketplaceSnapshotEvidence): Uint8Array | undefined {
  const catalog = marketplaceCatalogs.get(evidenceValue);
  return catalog === undefined ? undefined : Uint8Array.from(catalog);
}
function digest(bytes: Uint8Array): Sha256 { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

export async function acquireResolvedGitSource(preview: ResolvedGitPreview, options: GitAcquisitionOptions): Promise<AcquisitionResult<GitPluginAcquisitionEvidence | GitMarketplaceSnapshotEvidence>> {
  const privateValue = previews.get(preview); if (privateValue === undefined) return acquisitionFailure("unsafe-source", "Git acquisition requires a newly issued immutable resolution preview");
  // Confirmation authority is one-shot: an operational failure must never make a stale review reusable.
  previews.delete(preview);
  let directory = ""; let materialized: MaterializedPluginTree | undefined;
  try {
    directory = await prepareDirectory(options.store); const env = isolatedEnv(directory); env["GIT_DIR"] = path.join(directory, "objects.git");
    const runtime: Runtime = { runner: options.runner ?? productionGitRunner, executable: options.gitExecutable ?? "git", timeout: options.timeoutMilliseconds ?? GIT_ACQUISITION_LIMITS.timeoutMilliseconds, ...(options.signal === undefined ? {} : { signal: options.signal }) };
    await assertPinningCapability(runtime, directory, env);
    const confirmed = await run(runtime, directory, env, [...transportConfig(preview.reviewedEndpoint, privateValue.caFile), "ls-remote", "--symref", "--exit-code", privateValue.exact.url, ...remotePatterns(privateValue.exact.source.ref)]);
    if (confirmed.code === 2) return acquisitionFailure("source-changed", "The Git ref could not be confirmed unchanged after preview; resolve and confirm the source again");
    if (confirmed.code !== 0) throw new Error("remote");
    if (!remoteMatches(confirmed.stdout, privateValue.exact.source.ref, "sha" in privateValue.exact.source ? privateValue.exact.source.sha : undefined, preview.commit)) {
      return acquisitionFailure("source-changed", "The Git ref could not be confirmed unchanged after preview; resolve and confirm the source again");
    }
    if ((await run(runtime, directory, env, ["init", "--bare", env["GIT_DIR"]!])).code !== 0) throw new GitFault("unreadable");
    const fetched = await run(runtime, directory, env, [...transportConfig(preview.reviewedEndpoint, privateValue.caFile), "fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", privateValue.exact.url, preview.commit]);
    if (fetched.code !== 0) throw new Error("fetch");
    if ((await run(runtime, directory, env, ["cat-file", "-e", `${preview.commit}^{commit}`])).code !== 0) throw new GitFault("integrity");
    const finalRef = await run(runtime, directory, env, [...transportConfig(preview.reviewedEndpoint, privateValue.caFile), "ls-remote", "--symref", "--exit-code", privateValue.exact.url, ...remotePatterns(privateValue.exact.source.ref)]);
    if (finalRef.code === 2) return acquisitionFailure("source-changed", "The Git ref could not be confirmed unchanged during immutable acquisition; resolve and confirm the source again");
    if (finalRef.code !== 0) throw new Error("remote");
    if (!remoteMatches(finalRef.stdout, privateValue.exact.source.ref, "sha" in privateValue.exact.source ? privateValue.exact.source.sha : undefined, preview.commit)) {
      return acquisitionFailure("source-changed", "The Git ref could not be confirmed unchanged during immutable acquisition; resolve and confirm the source again");
    }
    const entries = await readEntries(runtime, directory, env, preview.commit, privateValue.exact.subdir);
    let catalog: Uint8Array | undefined;
    if (privateValue.surface === "marketplace") {
      const catalogEntry = entries.find((item) => item.path === ".claude-plugin/marketplace.json" && item.kind === "file");
      if (catalogEntry?.data === undefined || parseBoundedJsonObject(catalogEntry.data) === undefined) {
        return acquisitionFailure("invalid-catalog", "The Git marketplace commit lacks a bounded valid marketplace catalog");
      }
      catalog = Uint8Array.from(catalogEntry.data);
    }
    const plan = validatePluginTree(entries, { kind: "tree-root" });
    if (!plan.ok) return acquisitionFailure("unsafe-source", "The Git commit does not contain a portable validated plugin tree");
    const staging = await issuePrivateStagingParent(options.store); if (!staging.ok) throw new GitFault("unsafe-staging");
    const made = await materializePluginTree(plan.value, staging.value); if (!made.ok) throw new GitFault("unsafe-materialization"); materialized = made.value;
    if (options.postMaterializationWitness !== undefined) postMaterializationWitnesses.get(options.postMaterializationWitness)?.();
    if (options.signal?.aborted === true) throw new ProcessFault("cancelled");
    const provenance: GitAcquisitionProvenance = Object.freeze({ adapter: privateValue.exact.subdir === undefined ? "anonymous-https-git" : "anonymous-https-git-subdir",
      declarationFamily: privateValue.exact.source.kind, reviewed: preview.reviewedEndpoint, commit: preview.commit, ref: preview.ref,
      ...(privateValue.exact.subdir === undefined ? {} : { selectedSubdirectory: privateValue.exact.subdir }), artifactDigest: materialized.treeDigest,
      treeDigest: materialized.treeDigest, rootDigest: materialized.rootDigest, selectedRoot: materialized.rootSelection });
    let result: GitPluginAcquisitionEvidence | GitMarketplaceSnapshotEvidence;
    if (privateValue.surface === "marketplace") {
      if (catalog === undefined) throw new GitFault("integrity");
      const catalogDigest = digest(catalog);
      result = Object.freeze({ kind: "git-marketplace-snapshot", source: privateValue.exact.source, commit: preview.commit,
        snapshotId: `marketplace-${createHash("sha256").update(`${preview.commit}\0${catalogDigest}\0${materialized.treeDigest}`).digest("base64url")}`,
        catalogDigest, materialized, provenance }) as GitMarketplaceSnapshotEvidence;
      marketplaceCatalogs.set(result, Uint8Array.from(catalog));
    } else result = Object.freeze({ kind: "git-plugin-acquisition", source: privateValue.exact.source, commit: preview.commit,
      artifactDigest: materialized.treeDigest, treeDigest: materialized.treeDigest, rootDigest: materialized.rootDigest, materialized, provenance }) as GitPluginAcquisitionEvidence;
    evidence.add(result); return { ok: true, value: result };
  } catch (error) {
    if (materialized !== undefined) await discardMaterializedPluginTree(materialized);
    return faultResult(error, options.signal, "acquisition");
  } finally { if (directory !== "") await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
}
