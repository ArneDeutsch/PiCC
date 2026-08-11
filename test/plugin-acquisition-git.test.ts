import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitUntil } from "./helpers/async.js";
import {
  acquireResolvedGitSource,
  isGitAcquisitionEvidence,
  issueGitPostMaterializationWitnessForTest,
  issueGitSmartHttpWitnessEndpointForTest,
  productionGitRunner,
  readGitMarketplaceCatalog,
  resolveGitMarketplaceSource,
  resolveGitPluginSource,
  type GitRunRequest,
  type GitRunResult,
  type GitRunner,
} from "../src/plugin-lifecycle/acquisition/git.js";
import { normalizeGithubMarketplaceSource, normalizeGithubPluginSource } from "../src/plugin-lifecycle/acquisition/github.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";

const roots: string[] = [];
const activeServers = new Set<net.Server>();
function trackedServer<T extends net.Server>(server: T): T { activeServers.add(server); return server; }
async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
afterEach(async () => {
  await Promise.all([...activeServers].map(async (server) => { await closeServer(server); activeServers.delete(server); }));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function store(): Promise<OwnedStateStore> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "picc-git-acquire-")); roots.push(home);
  if (process.platform !== "win32") await fs.chmod(home, 0o700);
  const locations = createLifecycleLocations({ homeDir: home, profilePath: path.join(home, "profile"), platform: process.platform === "win32" ? "win32" : "posix" });
  if (!locations.ok) throw new Error(locations.error.message);
  const result = await establishOwnedStateStore(locations.value, home); if (!result.ok) throw new Error(result.message);
  return result.value;
}
const resolver = async (): Promise<readonly [{ readonly address: "8.8.8.8"; readonly family: 4 }]> => [{ address: "8.8.8.8", family: 4 }];
const COMMIT = "1".repeat(40); const OTHER = "2".repeat(40); const BLOB = "3".repeat(40);
const TEST_TLS_KEY = "-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCz5n5b2hyhbIdF\r\n/B8FRAIJn9IvZ7N3vUit+jgI+OMZuy7n54PejQTwjwtLcuULXpMPh/B7PzNvJxSp\r\n8s2j+wppdnWjDVXElMGcX60DqjyA2ORPt9+IOPknJSSzwQ8nluk6BfKCbHEjXVPZ\r\nhXokQcpCDnjabErNcsAijf+RRFZlMD9+S+lgZ1W5IzitFAzHPsfWF5rx6QchVxtb\r\nGHzH9FSJa8sbiWlW00Kgqv4JUIV0txFrkBIofGGtFvWSa+lwC/JRFUrDubRpOkhU\r\nryCA8XrI/OQ6imd/cIUQLZtqv9RVd8WERP6Szp/Oaq/ln+NfF4d/dXzSJstTOjG/\r\ng8qljKwdAgMBAAECggEABLYrRjO8xGPfrsR3Dy/UNNUnz6rcigIzV9kh5BGZUw3H\r\ntqD7NMDb6a1Ou1ZiQM1ki8eAk8ht4VdJmizcLWiwVwmYSaGvsXMVl1ybHv7eUEqT\r\nP4eTi2a17HbzfTYNHqPmw6ivDLLoi1JQ//VYDlXfGqKfOtXovJ+TgCQuFsDOhB5i\r\nNIDEOZCfPUNXTMwKUW9wk7nF9MqBTYqIpHMAY6TKTQx5QUeEi/J8/IxNapE6BaTT\r\nHbtRdz15WyhYQMQZbbpLyybrp2xeYJ74UAbGs0vZt87OMvOG/k0OhTyOX6Qi1unS\r\nu5sZppD6G9nIe5mckdSdclmb2Sc3ely+zi+YnwR7AQKBgQDfnCa4Y454rr4nwF9y\r\nK9UI0TImOAW2biT8PM2Ay0UckFhnvScwuePmKj7jy2gDPooYd4RNW9bHIllXJQZ0\r\ngDfPqCgRX146QQsaEtJzTmZvIFG54IYsQNsU2JfFOWlWclxwNoeWfBBCeubOyps3\r\neBNhIWM2UOJbduPMZOfV4aLtHQKBgQDN9YOOOvPpzCadCnv8MNVROLkB8nuhiAEp\r\nRn3eLE95UuJMTM5BSy8ueEsSUbLgavjYAhAwWelQnpjeAo3I4hkwDbstPCI77TG2\r\ntAvfdj+sin/8cBs7ut3Ag7BkuU9CzgPutoEALrZoozBOheGPI057z0EEIeCmXMuN\r\nLJybOOeLAQKBgHxkt72X1KgaPbqLcA1piOeQyN8uBy+HcpfHk2L0sYvEWQnM1kJr\r\nBvcBxV6fx0sWvWgDBNysHH1HBIBQHpkswt+IYlHXxemOSYjFs8FleeKUDiLjXoC7\r\ny6R7IWMcHxdyIy5hh2gVuE3jZQbg+xwOdmlwU2rh8CqFpxALilUXYrWZAoGAYVSk\r\nDgQIHrXOjapVu3FsbczLiYMJL+Xw/ouEkgkIqcIklYA6fJrGOkS43Xhkey+yV4pq\r\nEh97ZhD9FvXIAWXwF0h160Oevgky1C+z6K+eGbD+GNL1271MbF0PcBouvdhT/Wyb\r\n+/UXWM29123nkVhTD6l7BTPpUVVLEHVDsQssSQECgYEAs6+gc5JCdX7VwNVEeee5\r\nd2liBcyZL57Za3GdHUU+ixOJjxl0eSH5vWh0nlrytGUtoXSVo+Bvq3hpbyiXl4qt\r\nGCkNHr+C6aP5Y1GWsldqhwh2r687YngcJqPvXN1LCD3tH0PWU0dNGnbDfwkFYw8u\r\nRiVGnbWsELkHMDmG2uSInEc=\r\n-----END PRIVATE KEY-----\r\n";
const TEST_TLS_CERT = "-----BEGIN CERTIFICATE-----\r\nMIIDSTCCAjGgAwIBAgIUFNGf5iFY+uaVCPmMm2NegEY7vAgwDQYJKoZIhvcNAQEL\r\nBQAwIjEgMB4GA1UEAwwXZ2l0LXdpdG5lc3MuZXhhbXBsZS5vcmcwHhcNMjYwODEx\r\nMTk0NTU5WhcNMzYwODA4MTk0NTU5WjAiMSAwHgYDVQQDDBdnaXQtd2l0bmVzcy5l\r\neGFtcGxlLm9yZzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALPmflva\r\nHKFsh0X8HwVEAgmf0i9ns3e9SK36OAj44xm7Lufng96NBPCPC0ty5Qtekw+H8Hs/\r\nM28nFKnyzaP7Cml2daMNVcSUwZxfrQOqPIDY5E+334g4+SclJLPBDyeW6ToF8oJs\r\ncSNdU9mFeiRBykIOeNpsSs1ywCKN/5FEVmUwP35L6WBnVbkjOK0UDMc+x9YXmvHp\r\nByFXG1sYfMf0VIlryxuJaVbTQqCq/glQhXS3EWuQEih8Ya0W9ZJr6XAL8lEVSsO5\r\ntGk6SFSvIIDxesj85DqKZ39whRAtm2q/1FV3xYRE/pLOn85qr+Wf418Xh391fNIm\r\ny1M6Mb+DyqWMrB0CAwEAAaN3MHUwHQYDVR0OBBYEFLxKn2GOBiL1jIRAxd/Bf0+w\r\nCb+zMB8GA1UdIwQYMBaAFLxKn2GOBiL1jIRAxd/Bf0+wCb+zMA8GA1UdEwEB/wQF\r\nMAMBAf8wIgYDVR0RBBswGYIXZ2l0LXdpdG5lc3MuZXhhbXBsZS5vcmcwDQYJKoZI\r\nhvcNAQELBQADggEBAKmV0kT38dU+9m6ueg6zQ6gaNnca0P/RN649xjY65zKbwDfe\r\nHluiisB0nbfcD2cb3dLsqAOhprkk9CNm5QmIUEFhEQRtxsMGCVx6Qz6YfqHHOFTV\r\nTTDUW3vVhj1QmhF5/Q+D+5UQQuW1anXJt6Csqo0xRa+90DWPzTvMTMp9sMO6Fg+A\r\ntCla5ERt8bww7zeBZ1MdTa3nKm0AatSLcS94m/GR5qArB1p03NVzugQa/FD9YgRV\r\nCyhjQimfYLajqirlG/jnVvK3j/oSrwNAAyZrxZhpLIqn3/i3ARs41w03UVChxiS2\r\nOUmELq3Vq4LY9mmcLNk3BKQ/xSiwxRGccGWq+JI=\r\n-----END CERTIFICATE-----\r\n";
const WRONG_TLS_KEY = "-----BEGIN PRIVATE KEY-----\r\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC4ToGt47VApYuL\r\nNyHxvmiY8x1mCdVMBI/qyHdyFFi46RsqyPSjyMsLpLfJfNPwVUEUK+tCzIhCfakN\r\nbtc4FBEfM5Kie5zE3N8W3QmKV0YPhE9A3Sqc6fEImSyuLaGlPhd1by6PuYPZAhh9\r\nGpgeXBSBBx9LRTv0gPqVvHP6tvg7MAE11uarLIT+WW94YXyT/aUChXeFkQIshHOv\r\nhmak/wHcd2FSbVmcK0E2p8tREsPjsSJ8twaJPw2YxcYHsJEKVQgy+r/k7zmLBnUq\r\nrVPNlGBl42qhsBYhgdWJMbXNtqfp3Pr3OMFHz/ymCtfIvqTP//rMImW5N8t8oDqc\r\nEpcwW2j7AgMBAAECggEAAevJ9nEjEJwiuVFAsjkQJ9crRvoZD8FIBL3EYCghIp0S\r\nmOtEs+sh+EP/ws+UkyYFI+78DuBJFueIM9xXZvC8NI1Z9mwzODdH8s0ozjKjR5vs\r\nvY09Zl3nEsL4XPQBztI39i1+y6W2rGdISdy7zPk1urPDZwpYme+F04cfofN24LSj\r\nXCxeKme25ZKZuY76kvJjFsLkc2sK76IhXwZekuqxDbFraf9QLsodwWh+7g+sftee\r\n+Lbhv+Fp+jczIWzHWVhYzETpIHvtgm5KfDctDUmwQP9ZLWv5N7Ejc9/VVx3ZunYh\r\nxjSWzdcuQVkAHFkqmldLXdf2XIvppu1FVpuNoOIcqQKBgQDZfE6pur0i+QXAPkkP\r\n5Hc5Vm5DxhkQ0l9rvR36OiW87JMP7G2lPEZ3GcKE7aziGCjiRpCSHZfgt+ankAjX\r\naRahkcheKRwoH6hO/RGFor5Rb0UcIToYYazo+nFMjlBUuBiFrfxyY+e5uR0idoBd\r\nlcRRE+EJ622gU7L5PUl4AebneQKBgQDY8gkt2K7BI+iUEnG32nMukWCJ3UO31cqP\r\n0KBp1jGJcwf+HrV4v7iDYtgudQKpRl+CTmowE/jtO5KTRYIvCK39KmTdG3sTiJlb\r\nBGY5//xX709HWuQBsoG1zNFFGhOsTvBUVJrIOiVPzoO0JCf18FS7Ub89QeaTepQv\r\n/UaUIYxTEwKBgC6aF1UBQaPrzlKqRgeUwgNURN5a5WYYXf/9Dx5eNVXtL3n7BGei\r\nqcq9h1PqheAQozoROstEchXh8he3ol1eFE5cqZ2bm3/xgKQkUAvdmoBiomFrsUIm\r\nM+HcQEjSOd5dcEu8w1pTlATU6KxIziq/e8iPxOnWO7BeHvyPKF4BslOpAoGALugW\r\nJ/2Du2riLLHYOKJY6Saxst1OeP8WrwWyyW9wgoGGpuFI53S8llvW1iSikKsQl4IQ\r\n35hR6ClLReBvh2/e/rAd4tjAQbb1QYKv/7ZjfzfU8l6qkdtgxEgmr0Q2ILloqTMp\r\nzEUWMC08uMRgh4KRL3c7XClVi2mjhMTEb97ZElUCgYBCX6BQtUQCKyvS0rlRnEuR\r\n4UUwy2DNooz/VxXMM2u0intyzXdbnmG4J4c2K8p3xlppiBiWLvHiV/MJULJZnm/Y\r\nFbBYSpSJWPnfyq0+4xNkBZLZlr0TQLM8W6YG0v1bR9c2W/xmEvJDGcrp+wIjSsgz\r\nW8wjf6oGuF24L4lR+KkCcg==\r\n-----END PRIVATE KEY-----\r\n";
const WRONG_TLS_CERT = "-----BEGIN CERTIFICATE-----\r\nMIIDNzCCAh+gAwIBAgIUcqAIzJhTm1IDBhmlnAbgD+dWsA0wDQYJKoZIhvcNAQEL\r\nBQAwHDEaMBgGA1UEAwwRd3JvbmcuZXhhbXBsZS5vcmcwHhcNMjYwODExMTk0NjA5\r\nWhcNMzYwODA4MTk0NjA5WjAcMRowGAYDVQQDDBF3cm9uZy5leGFtcGxlLm9yZzCC\r\nASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALhOga3jtUCli4s3IfG+aJjz\r\nHWYJ1UwEj+rId3IUWLjpGyrI9KPIywukt8l80/BVQRQr60LMiEJ9qQ1u1zgUER8z\r\nkqJ7nMTc3xbdCYpXRg+ET0DdKpzp8QiZLK4toaU+F3VvLo+5g9kCGH0amB5cFIEH\r\nH0tFO/SA+pW8c/q2+DswATXW5qsshP5Zb3hhfJP9pQKFd4WRAiyEc6+GZqT/Adx3\r\nYVJtWZwrQTany1ESw+OxIny3Bok/DZjFxgewkQpVCDL6v+TvOYsGdSqtU82UYGXj\r\naqGwFiGB1Ykxtc22p+nc+vc4wUfP/KYK18i+pM//+swiZbk3y3ygOpwSlzBbaPsC\r\nAwEAAaNxMG8wHQYDVR0OBBYEFHMGnvJ8YP2Kt/9qZ+l9el5Mc+ybMB8GA1UdIwQY\r\nMBaAFHMGnvJ8YP2Kt/9qZ+l9el5Mc+ybMA8GA1UdEwEB/wQFMAMBAf8wHAYDVR0R\r\nBBUwE4IRd3JvbmcuZXhhbXBsZS5vcmcwDQYJKoZIhvcNAQELBQADggEBAEBDSlfq\r\ns5v8gCQ+32l4KdVpek+1Dc20MNz2Q2eDwCQySWsBoenH/NPK7crRPQWecb3LxkTm\r\nvdfHgI6Skz0xyvYPUpQnRZfT1DAPATQbl1NziFbyBxgji1zo5H+Vk7/pc41tx0uX\r\naMN2nSu+MCjpuuRnoKPhQG8UlnhHXnA8dQA+BGPi+WlZje47iCGc2WIR10PpPsHK\r\nAicFAFRpDpatZwZw0ek8lyb9Fe97w7Da1RIBfLb8wKEQ2dL3YbEFYiuYbjeSTEzf\r\nGPmPIzYbqFuaMy4vi4gkW3MAVZ2TokrGx/8gidfM8JiwFdtwvz+KvjvKCGXZ1An4\r\ncXexjC5uB128bfE=\r\n-----END CERTIFICATE-----\r\n";
const boundedExec = (file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): Buffer => execFileSync(file, [...args], {
  cwd, env, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
});
const gitSupportsAddressPinning = (() => {
  try { return boundedExec("git", ["help", "--config"], process.cwd()).toString("utf8").split(/\r?\n/).includes("http.curloptResolve"); }
  catch { return false; }
})();

function success(stdout: string | Uint8Array = ""): GitRunResult { return { code: 0, stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout, stderr: new Uint8Array() }; }
function syntheticRunner(options: { readonly moved?: boolean; readonly moveAtRemote?: number; readonly entries?: readonly { path: string; data: string; mode?: "100644" | "100755" }[] } = {}): { runner: GitRunner; calls: GitRunRequest[] } {
  const calls: GitRunRequest[] = []; let remotes = 0;
  const rows = options.entries ?? [{ path: ".claude-plugin/marketplace.json", data: '{"name":"safe","plugins":[]}' }, { path: "plugin/index.js", data: "export default 1" }];
  const hashes = rows.map((_, index) => `${index + 3}`.repeat(40));
  const runner: GitRunner = async (request) => {
    calls.push(request);
    if (request.args.join(" ") === "help --config") return success("http.curloptResolve\n");
    if (request.args.includes("ls-remote")) { remotes += 1; return success(`${(options.moved && remotes > 1) || (options.moveAtRemote !== undefined && remotes >= options.moveAtRemote) ? OTHER : COMMIT}\tHEAD\n`); }
    if (request.args.includes("init")) return success();
    if (request.args.includes("fetch")) return success();
    if (request.args.includes("-e")) return success();
    if (request.args.includes("ls-tree")) return success(Buffer.from(rows.map((row, index) => `${row.mode ?? "100644"} blob ${hashes[index]}\t${row.path}\0`).join("")));
    if (request.args.includes("--batch")) return success(Buffer.concat(rows.map((row, index) => {
      const body = Buffer.from(row.data); return Buffer.concat([Buffer.from(`${hashes[index]} blob ${body.byteLength}\n`), body, Buffer.from("\n")]);
    })));
    return { code: 1, stdout: new Uint8Array(), stderr: Buffer.from("credential-canary raw failure") };
  };
  return { runner, calls };
}

function transportCalls(calls: readonly GitRunRequest[]): readonly GitRunRequest[] {
  return calls.filter((call) => call.args.includes("ls-remote") || call.args.includes("fetch"));
}

interface SyntheticObject { readonly hash: string; readonly mode: "100644" | "100755" | "120000"; readonly path: string; readonly data: Uint8Array }
function subtreeRunner(outside: readonly SyntheticObject[], selected: readonly SyntheticObject[]): { readonly runner: GitRunner; readonly calls: GitRunRequest[] } {
  const calls: GitRunRequest[] = [];
  const objects = new Map([...outside, ...selected].map((item) => [item.hash, item]));
  const runner: GitRunner = async (request) => {
    calls.push(request);
    if (request.args.join(" ") === "help --config") return success("http.curloptResolve\n");
    if (request.args.includes("ls-remote")) return success(`${COMMIT}\tHEAD\n`);
    if (request.args.includes("init") || request.args.includes("fetch") || request.args.includes("-e")) return success();
    if (request.args.includes("ls-tree")) {
      const exactSubtree = request.args.at(-1) === `${COMMIT}:packages/tool`;
      const rows = exactSubtree ? selected : [...outside, ...selected.map((item) => ({ ...item, path: `packages/tool/${item.path}` }))];
      return success(Buffer.from(rows.map((item) => `${item.mode} ${item.mode === "120000" ? "blob" : "blob"} ${item.hash}\t${item.path}\0`).join("")));
    }
    if (request.args.includes("--batch")) {
      const requested = Buffer.from(request.input ?? []).toString("utf8").trim().split("\n").filter(Boolean);
      return success(Buffer.concat(requested.map((hash) => {
        const item = objects.get(hash); if (item === undefined) return Buffer.from(`${hash} missing\n`);
        return Buffer.concat([Buffer.from(`${hash} blob ${item.data.byteLength}\n`), Buffer.from(item.data), Buffer.from("\n")]);
      })));
    }
    return { code: 1, stdout: Buffer.from("https://user:stdout-secret@example.org"), stderr: Buffer.from("credential stderr-secret") };
  };
  return { runner, calls };
}

async function stagingNames(owned: OwnedStateStore): Promise<readonly string[]> {
  return (await fs.readdir(owned.stagingRoot)).sort();
}

function markerObject(hashDigit: string, entryPath: string, data: string, mode: SyntheticObject["mode"] = "100644"): SyntheticObject {
  return { hash: hashDigit.repeat(40), mode, path: entryPath, data: Buffer.from(data) };
}

function expectedTransportPrefix(host: string, caFile?: string): readonly string[] {
  const nullHooks = process.platform === "win32" ? "NUL" : "/dev/null";
  const pairs = [
    ["credential.helper", ""], ["credential.interactive", "never"], ["core.askPass", ""], ["core.hooksPath", nullHooks],
    ["http.proxy", ""], ["https.proxy", ""], ["http.followRedirects", "false"], ["http.cookieFile", ""], ["http.saveCookies", "false"],
    ["http.extraHeader", ""], ["protocol.allow", "never"], ["protocol.https.allow", "always"], ["protocol.version", "2"],
    ["fetch.recurseSubmodules", "false"], ["submodule.recurse", "false"], ["http.curloptResolve", host],
    ...(caFile === undefined ? [] : [["http.sslCAInfo", caFile]]),
  ];
  return pairs.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

describe("Git declaration and injected transport contract", () => {
  it("normalizes GitHub families while rejecting non-exact and getter-bearing declarations", () => {
    expect(normalizeGithubMarketplaceSource({ kind: "github", repository: "owner/repo", ref: "main" })).toEqual({ source: { kind: "github", repository: "owner/repo", ref: "main" }, url: "https://github.com/owner/repo.git" });
    expect(normalizeGithubPluginSource({ kind: "github", repository: "owner/repo.git", sha: COMMIT })).toEqual({ source: { kind: "github", repository: "owner/repo.git", sha: COMMIT }, url: "https://github.com/owner/repo.git" });
    expect(normalizeGithubMarketplaceSource({ kind: "github", repository: "owner/repo", extra: true })).toBeUndefined();
    expect(normalizeGithubMarketplaceSource(Object.defineProperty({ kind: "github" }, "repository", { get: () => "owner/repo", enumerable: true }))).toBeUndefined();
  });

  it("uses only pinned anonymous HTTPS argv and an exact isolated environment", async () => {
    const fixture = syntheticRunner(); const owned = await store();
    const preview = await resolveGitMarketplaceSource({ kind: "https-git", url: "https://git.example.org/repo.git" }, { store: owned, resolver, runner: fixture.runner });
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    expect(preview.value).toMatchObject({ declarationFamily: "https-git", commit: COMMIT, ref: "HEAD", reviewedEndpoint: { hostname: "git.example.org", address: "8.8.8.8", port: 443 } });
    const acquired = await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner });
    expect(acquired.ok).toBe(true); if (!acquired.ok) return;
    expect(isGitAcquisitionEvidence(acquired.value)).toBe(true);
    if (acquired.value.kind === "git-marketplace-snapshot") {
      const catalog = readGitMarketplaceCatalog(acquired.value); expect(Buffer.from(catalog ?? []).toString("utf8")).toContain('"name":"safe"');
      catalog?.fill(0); expect(Buffer.from(readGitMarketplaceCatalog(acquired.value) ?? []).toString("utf8")).toContain('"name":"safe"');
    }
    expect(acquired.value).toMatchObject({
      kind: "git-marketplace-snapshot", source: { kind: "https-git", url: "https://git.example.org/repo.git" }, commit: COMMIT,
      snapshotId: expect.stringMatching(/^marketplace-/), catalogDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      materialized: { treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/) },
      provenance: {
        adapter: "anonymous-https-git", declarationFamily: "https-git", commit: COMMIT, ref: "HEAD",
        reviewed: { canonicalUrl: "https://git.example.org/repo.git", address: "8.8.8.8" },
        artifactDigest: expect.stringMatching(/^sha256:/), treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), selectedRoot: { path: "" },
      },
    });
    expect(transportCalls(fixture.calls)).toHaveLength(5);
    for (const [callIndex, call] of fixture.calls.entries()) {
      const gitDirName = callIndex < 5 ? "preview.git" : "objects.git";
      expect(call.env.GIT_DIR).toBe(path.join(call.cwd, gitDirName));
      expect(call.env).toEqual({
        HOME: call.cwd, XDG_CONFIG_HOME: call.cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(call.cwd, "global-config"),
        GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_COUNT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C.UTF-8", LANG: "C.UTF-8",
        ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
        ...(process.platform === "win32" && process.env.SystemRoot !== undefined ? { SystemRoot: process.env.SystemRoot } : {}),
        GIT_DIR: path.join(call.cwd, gitDirName),
      });
      expect(call.args).not.toContain("checkout"); expect(call.args).not.toContain("--recurse-submodules");
      const commandIndex = call.args.findIndex((item) => item === "ls-remote" || item === "fetch");
      if (commandIndex >= 0) expect(call.args.slice(0, commandIndex)).toEqual(expectedTransportPrefix("git.example.org:443:8.8.8.8"));
      else expect(call.args).not.toContain("http.curloptResolve=git.example.org:443:8.8.8.8");
    }
    expect(fixture.calls.find((call) => call.args.includes("ls-tree"))?.args).toEqual(["ls-tree", "-rz", "-r", "-t", COMMIT]);
    expect(JSON.stringify(acquired)).not.toContain("credential-canary");
  });

  it("reads and publishes only the exact git-subdir subtree with outside-invariant evidence", async () => {
    const owned = await store();
    const selected = [markerObject("3", ".claude-plugin/plugin.json", "{}"), markerObject("4", "run.sh", "echo safe", "100755")];
    const outsideA = [
      markerObject("5", "sibling/oversized.bin", "x".repeat(9 * 1024 * 1024)),
      markerObject("6", "sibling/link", "../../escape", "120000"),
      markerObject("7", "Sibling/File.js", "a"), markerObject("8", "sibling/file.js", "b"),
    ];
    const outsideB = [markerObject("9", "unrelated/changed.txt", "outside-only change")];
    const results = [];
    for (const fixture of [subtreeRunner(outsideA, selected), subtreeRunner(outsideB, selected)]) {
      const withMainRef: GitRunner = async (request) => request.args.includes("ls-remote") ? success(`${COMMIT}\trefs/heads/main\n`) : fixture.runner(request);
      const preview = await resolveGitPluginSource({ kind: "https-git-subdir", url: "https://git.example.org/repo.git", path: "packages/tool", ref: "main", sha: COMMIT }, { store: owned, resolver, runner: withMainRef });
      expect(preview).toMatchObject({ ok: true, value: { source: { path: "packages/tool" }, declarationFamily: "https-git-subdir", selectedSubdirectory: "packages/tool" } });
      if (!preview.ok) return;
      const acquired = await acquireResolvedGitSource(preview.value, { store: owned, runner: withMainRef });
      expect(acquired).toMatchObject({
        ok: true,
        value: {
          kind: "git-plugin-acquisition", source: { kind: "https-git-subdir", path: "packages/tool", ref: "main", sha: COMMIT }, commit: COMMIT,
          artifactDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/),
          materialized: { rootSelection: { requested: "tree-root", path: "" }, entryCount: 3, fileCount: 2 },
          provenance: {
            adapter: "anonymous-https-git-subdir", declarationFamily: "https-git-subdir", selectedSubdirectory: "packages/tool", commit: COMMIT, ref: "main",
            reviewed: { canonicalUrl: "https://git.example.org/repo.git", address: "8.8.8.8" },
            artifactDigest: expect.stringMatching(/^sha256:/), treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), selectedRoot: { requested: "tree-root", path: "" },
          },
        },
      });
      if (!acquired.ok || acquired.value.kind !== "git-plugin-acquisition") return;
      expect(await fs.readdir(acquired.value.materialized.pluginRoot)).toEqual([".claude-plugin", "run.sh"]);
      expect(fixture.calls.find((call) => call.args.includes("ls-tree"))?.args).toEqual(["ls-tree", "-rz", "-r", "-t", `${COMMIT}:packages/tool`]);
      results.push(acquired.value);
    }
    expect(results[1]?.artifactDigest).toBe(results[0]?.artifactDigest);
    expect(results[1]?.treeDigest).toBe(results[0]?.treeDigest);
    expect(results[1]?.rootDigest).toBe(results[0]?.rootDigest);

    for (const selectedUnsafe of [
      [markerObject("a", "link", "../../escape", "120000")],
      [markerObject("b", "Plugin/File.js", "a"), markerObject("c", "plugin/file.js", "b")],
    ]) {
      const fixture = subtreeRunner([], selectedUnsafe);
      const preview = await resolveGitPluginSource({ kind: "https-git-subdir", url: "https://git.example.org/repo.git", path: "packages/tool" }, { store: owned, resolver, runner: fixture.runner });
      expect(preview.ok).toBe(true); if (preview.ok) expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner })).toEqual({
        ok: false, error: { code: "unsafe-source", message: "The Git commit does not contain a portable validated plugin tree" },
      });
    }
  });

  it("classifies declared revision disagreement, transport failure, status-2 absence, and both unconfirmable-ref checkpoints", async () => {
    const owned = await store();
    const notFoundMessage = "The anonymous Git repository or requested ref was not found; verify the public repository and ref, then resolve again";
    const statusTwoResolution = syntheticRunner();
    const statusTwoInitial: GitRunner = async (request) => request.args.includes("ls-remote")
      ? { code: 2, stdout: Buffer.from("credential-canary"), stderr: Buffer.from("credential-canary") }
      : statusTwoResolution.runner(request);
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://git.example.org/repo.git", ref: "main", sha: COMMIT }, { store: owned, resolver, runner: statusTwoInitial }))
      .toEqual({ ok: false, error: { code: "not-found", message: notFoundMessage } });

    const statusTwoMessages = [
      "The Git ref could not be confirmed unchanged after preview; resolve and confirm the source again",
      "The Git ref could not be confirmed unchanged during immutable acquisition; resolve and confirm the source again",
    ];
    for (const [checkpoint, message] of statusTwoMessages.entries()) {
      const fixture = syntheticRunner();
      const resolving: GitRunner = async (request) => request.args.includes("ls-remote") ? success(`${COMMIT}\trefs/heads/main\n`) : fixture.runner(request);
      const preview = await resolveGitPluginSource({ kind: "https-git", url: "https://git.example.org/repo.git", ref: "main", sha: COMMIT }, { store: owned, resolver, runner: resolving });
      expect(preview.ok).toBe(true); if (!preview.ok) return;
      let acquisitionRemotes = 0;
      const statusTwoConfirmation: GitRunner = async (request) => {
        if (request.args.includes("ls-remote")) {
          acquisitionRemotes += 1;
          if (acquisitionRemotes === checkpoint + 1) return { code: 2, stdout: Buffer.from("credential-canary"), stderr: Buffer.from("credential-canary") };
          return success(`${COMMIT}\trefs/heads/main\n`);
        }
        return await fixture.runner(request);
      };
      expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: statusTwoConfirmation }))
        .toEqual({ ok: false, error: { code: "source-changed", message } });
    }

    const revisionMessage = "Git revision or object evidence is ambiguous, malformed, or disagrees with the declared ref/SHA";
    const mismatch = syntheticRunner();
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://git.example.org/repo.git", ref: "main", sha: OTHER }, { store: owned, resolver, runner: async (request) => request.args.includes("ls-remote") ? success(`${COMMIT}\trefs/heads/main\n`) : mismatch.runner(request) }))
      .toEqual({ ok: false, error: { code: "integrity", message: revisionMessage } });
    const ambiguous = syntheticRunner();
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://git.example.org/repo.git", ref: "release" }, { store: owned, resolver, runner: async (request) => request.args.includes("ls-remote") ? success(`${COMMIT}\trefs/heads/release\n${OTHER}\trefs/tags/release\n`) : ambiguous.runner(request) }))
      .toEqual({ ok: false, error: { code: "integrity", message: revisionMessage } });

    const networkMessage = "The anonymous Git source could not be acquired under the required pinned transport. Confirm the repository is public and reachable without sign-in and allowed by your network/TLS policy; private repositories and credentials are unsupported";
    const transport = syntheticRunner();
    const transportPreview = await resolveGitMarketplaceSource({ kind: "https-git", url: "https://git.example.org/repo.git" }, { store: owned, resolver, runner: transport.runner });
    expect(transportPreview.ok).toBe(true); if (!transportPreview.ok) return;
    const failedRemote: GitRunner = async (request) => request.args.includes("ls-remote") ? { code: 17, stdout: Buffer.from(`${OTHER}\tHEAD\n`), stderr: Buffer.from("credential-canary") } : transport.runner(request);
    expect(await acquireResolvedGitSource(transportPreview.value, { store: owned, runner: failedRemote })).toEqual({ ok: false, error: { code: "network-failure", message: networkMessage } });

    const messages = [
      "The Git ref could not be confirmed unchanged after preview; resolve and confirm the source again",
      "The Git ref could not be confirmed unchanged during immutable acquisition; resolve and confirm the source again",
    ];
    for (const [[moveAtRemote, expectedFetches], message] of ([[2, 1], [3, 2]] as const).map((item, index) => [item, messages[index]!] as const)) {
      const moved = syntheticRunner({ moveAtRemote });
      const preview = await resolveGitMarketplaceSource({ kind: "https-git", url: "https://git.example.org/repo.git" }, { store: owned, resolver, runner: moved.runner });
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: moved.runner })).toEqual({ ok: false, error: { code: "source-changed", message } });
        const launches = moved.calls.length;
        expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: moved.runner })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
        expect(moved.calls).toHaveLength(launches);
      }
      expect(moved.calls.filter((call) => call.args.includes("fetch"))).toHaveLength(expectedFetches);
    }
  });

  it("consumes preview authority before success or failure and retains no invalid-catalog staging candidate", async () => {
    const owned = await store();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fixture = syntheticRunner({ entries: [{ path: ".claude-plugin/marketplace.json", data: "not-json" }] });
      const preview = await resolveGitMarketplaceSource({ kind: "https-git", url: "https://git.example.org/repo.git" }, { store: owned, resolver, runner: fixture.runner });
      expect(preview.ok).toBe(true); if (!preview.ok) return;
      expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner })).toEqual({
        ok: false, error: { code: "invalid-catalog", message: "The Git marketplace commit lacks a bounded valid marketplace catalog" },
      });
      expect(await stagingNames(owned)).toEqual([]);
      const launches = fixture.calls.length;
      expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner })).toEqual({
        ok: false, error: { code: "unsafe-source", message: "Git acquisition requires a newly issued immutable resolution preview" },
      });
      expect(fixture.calls).toHaveLength(launches);
    }
    const successful = syntheticRunner();
    const preview = await resolveGitMarketplaceSource({ kind: "github", repository: "owner/repo" }, { store: owned, resolver, runner: successful.runner });
    expect(preview).toMatchObject({ ok: true, value: { source: { kind: "github", repository: "owner/repo" }, declarationFamily: "github", reviewedEndpoint: { canonicalUrl: "https://github.com/owner/repo.git" }, commit: COMMIT, ref: "HEAD" } });
    if (!preview.ok) return;
    const github = await acquireResolvedGitSource(preview.value, { store: owned, runner: successful.runner });
    expect(github).toMatchObject({
      ok: true,
      value: {
        kind: "git-marketplace-snapshot", source: { kind: "github", repository: "owner/repo" }, commit: COMMIT,
        snapshotId: expect.stringMatching(/^marketplace-/), catalogDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        materialized: { treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), rootSelection: { requested: "tree-root", path: "" } },
        provenance: {
          adapter: "anonymous-https-git", declarationFamily: "github", reviewed: { canonicalUrl: "https://github.com/owner/repo.git", address: "8.8.8.8" }, commit: COMMIT, ref: "HEAD",
          artifactDigest: expect.stringMatching(/^sha256:/), treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), selectedRoot: { requested: "tree-root", path: "" },
        },
      },
    });
    if (github.ok && github.value.kind === "git-marketplace-snapshot") {
      expect(Buffer.from(readGitMarketplaceCatalog(github.value) ?? []).toString("utf8")).toBe('{"name":"safe","plugins":[]}');
    }
    const launches = successful.calls.length;
    expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: successful.runner })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(successful.calls).toHaveLength(launches);
  });

  it("rejects malformed Git mode/object-kind evidence before blob reads or materialization", async () => {
    const owned = await store();
    const legal = new Set(["040000 tree", "100644 blob", "100755 blob", "120000 blob", "160000 commit"]);
    const malformedPairs = ["040000", "100644", "100755", "120000", "160000"].flatMap((mode) => ["tree", "blob", "commit"].map((kind) => `${mode} ${kind}`)).filter((pair) => !legal.has(pair));
    expect(malformedPairs).toContain("040000 blob"); expect(malformedPairs).toContain("100644 tree");
    for (const pair of malformedPairs) {
      const fixture = syntheticRunner();
      const malformedRunner: GitRunner = async (request) => request.args.includes("ls-tree") ? success(`${pair} ${BLOB}\tentry\0`) : fixture.runner(request);
      const preview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: malformedRunner });
      expect(preview.ok).toBe(true); if (!preview.ok) return;
      const result = await acquireResolvedGitSource(preview.value, { store: owned, runner: malformedRunner });
      expect(result).toEqual({ ok: false, error: { code: "integrity", message: "Git revision or object evidence is ambiguous, malformed, or disagrees with the declared ref/SHA" } });
      expect(isGitAcquisitionEvidence(result)).toBe(false);
      expect(fixture.calls.some((call) => call.args.includes("--batch"))).toBe(false);
      expect(await stagingNames(owned)).toEqual([]);
    }
  });

  it("cancels after materialization, discards staging, issues no evidence, and consumes preview authority", async () => {
    const owned = await store(); const fixture = syntheticRunner(); const controller = new AbortController(); let triggered = false;
    const witness = issueGitPostMaterializationWitnessForTest(() => { triggered = true; controller.abort(); });
    const preview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: fixture.runner });
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const result = await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner, signal: controller.signal, postMaterializationWitness: witness });
    expect(triggered).toBe(true);
    expect(result).toEqual({ ok: false, error: { code: "cancelled", message: "Git acquisition was cancelled" } });
    expect(isGitAcquisitionEvidence(result)).toBe(false);
    expect(await stagingNames(owned)).toEqual([]);
    const launches = fixture.calls.length;
    expect(await acquireResolvedGitSource(preview.value, { store: owned, runner: fixture.runner })).toEqual({
      ok: false, error: { code: "unsafe-source", message: "Git acquisition requires a newly issued immutable resolution preview" },
    });
    expect(fixture.calls).toHaveLength(launches);
  });

  it("fails unsupported protocols, leading-dash refs, pinning rejection, cancellation, and unsafe trees without fallback", async () => {
    const owned = await store(); let launches = 0;
    const never: GitRunner = async () => { launches += 1; return success(); };
    for (const source of [
      { kind: "https-git", url: "ssh://host.example.org/repo" }, { kind: "https-git", url: "file:///repo" },
      { kind: "https-git", url: "https://user:secret@host.example.org/repo" }, { kind: "https-git", url: "https://host.example.org/repo", ref: "--upload-pack=canary" },
    ]) expect(await resolveGitPluginSource(source, { store: owned, resolver, runner: never })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(launches).toBe(0);

    const rejected: GitRunner = async (request) => { launches += 1; return request.args.join(" ") === "help --config" ? success("http.proxy\n") : success(`${COMMIT}\tHEAD\n`); };
    expect(await resolveGitMarketplaceSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: rejected })).toEqual({
      ok: false, error: { code: "unsafe-source", message: "Installed Git cannot safely pin anonymous HTTPS sources; upgrade Git to a version supporting http.curloptResolve and retry" },
    });
    expect(launches).toBe(1);

    expect(await resolveGitMarketplaceSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: productionGitRunner, gitExecutable: path.join(owned.profileRoot, "missing-git") })).toEqual({
      ok: false, error: { code: "unreadable", message: "Git is unavailable; install Git, put git on PATH, and retry" },
    });

    const controller = new AbortController(); controller.abort();
    expect(await resolveGitMarketplaceSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: productionGitRunner, signal: controller.signal })).toEqual({
      ok: false, error: { code: "cancelled", message: "Git source resolution was cancelled" },
    });

    for (const treeOutput of [
      `120000 blob ${BLOB}\tlink\0`,
      `160000 commit ${BLOB}\tsubmodule\0`,
      `100644 blob ${BLOB}\tPlugin/File.js\0` + `100644 blob ${OTHER}\tplugin/file.js\0`,
    ]) {
      const unsafe = syntheticRunner({ entries: [{ path: "placeholder", data: "target" }] });
      const unsafeRunner: GitRunner = async (request) => request.args.includes("ls-tree") ? success(treeOutput)
        : request.args.includes("--batch") ? success(treeOutput.startsWith("100644") ? `${BLOB} blob 6\ntarget\n${OTHER} blob 6\ntarget\n` : "") : unsafe.runner(request);
      const unsafePreview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: unsafeRunner });
      expect(unsafePreview.ok).toBe(true); if (unsafePreview.ok) expect(await acquireResolvedGitSource(unsafePreview.value, { store: owned, runner: unsafeRunner })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    }
  });

  it("preserves endpoint admission failures as unsafe-source without launching Git", async () => {
    const owned = await store(); let launches = 0;
    const runner: GitRunner = async () => { launches += 1; return success(); };
    const unsafeMessage = "The Git destination did not resolve exclusively to admitted public addresses";
    const urlPolicyMessage = "Anonymous Git requires HTTPS on an allowed port (443 or 8443)";
    const cases: readonly { readonly source: unknown; readonly message: string; readonly answers?: readonly { readonly address: string; readonly family: 4 | 6 }[] }[] = [
      { source: { kind: "https-git", url: "not a URL" }, message: urlPolicyMessage },
      { source: { kind: "https-git", url: "http://host.example.org/repo" }, message: urlPolicyMessage },
      { source: { kind: "https-git", url: "https://host.example.org:notaport/repo" }, message: urlPolicyMessage },
      { source: { kind: "https-git", url: "https://host.example.org:9443/repo" }, message: urlPolicyMessage },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "10.0.0.1", family: 4 }] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "fd00::1", family: 6 }] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "::ffff:10.0.0.1", family: 6 }] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "8.8.8.8", family: 6 }] },
      { source: { kind: "https-git", url: "https://host.example.org/repo" }, message: unsafeMessage, answers: [{ address: "not-an-address", family: 4 }] },
    ];
    for (const item of cases) {
      const result = await resolveGitPluginSource(item.source, { store: owned, resolver: async () => item.answers ?? [{ address: "8.8.8.8", family: 4 }], runner });
      expect(result).toEqual({ ok: false, error: { code: "unsafe-source", message: item.message } });
    }
    expect(launches).toBe(0);

    const rejected = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver: async () => { throw new Error("resolver credential-canary"); }, runner });
    expect(rejected).toMatchObject({ ok: false, error: { code: "network-failure" } });
    expect(JSON.stringify(rejected)).not.toContain("credential-canary"); expect(launches).toBe(0);
  });

  it("bounds DNS review even when the resolver ignores cancellation and never launches Git", async () => {
    const owned = await store(); let launches = 0; const ignoredSignals: AbortSignal[] = [];
    const ignoredResolver = async (_hostname: string, signal: AbortSignal | undefined): Promise<readonly never[]> => {
      if (signal !== undefined) ignoredSignals.push(signal);
      return await new Promise<readonly never[]>(() => undefined);
    };
    const runner: GitRunner = async () => { launches += 1; return success(); };
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver: ignoredResolver, runner, timeoutMilliseconds: 20 })).toEqual({
      ok: false, error: { code: "timeout", message: "The bounded Git source resolution timed out" },
    });
    expect(launches).toBe(0); expect(ignoredSignals).toHaveLength(1); expect(ignoredSignals[0]?.aborted).toBe(true);

    const controller = new AbortController();
    const cancelling = resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver: ignoredResolver, runner, signal: controller.signal, timeoutMilliseconds: 5_000 });
    await waitUntil({ predicate: () => ignoredSignals.length === 2, description: "resolver to receive the production cancellation signal" });
    controller.abort();
    await expect(cancelling).resolves.toEqual({ ok: false, error: { code: "cancelled", message: "Git source resolution was cancelled" } });
    expect(launches).toBe(0); expect(ignoredSignals[1]?.aborted).toBe(true);
  });

  it("keeps changed lifecycle storage, private staging, and materialization faults distinct from network failures", async () => {
    const beforeResolution = await store(); const resolutionFixture = syntheticRunner();
    await fs.rename(beforeResolution.stagingRoot, `${beforeResolution.stagingRoot}.changed`); await fs.mkdir(beforeResolution.stagingRoot);
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: beforeResolution, resolver, runner: resolutionFixture.runner })).toEqual({
      ok: false, error: { code: "unreadable", message: "PiCC lifecycle storage changed or became unavailable; retry the lifecycle operation" },
    });
    expect(resolutionFixture.calls).toHaveLength(0);

    const beforeAcquisition = await store(); const acquisitionFixture = syntheticRunner();
    const preview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: beforeAcquisition, resolver, runner: acquisitionFixture.runner });
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const callsBeforeAcquisition = acquisitionFixture.calls.length;
    await fs.rename(beforeAcquisition.stagingRoot, `${beforeAcquisition.stagingRoot}.changed`); await fs.mkdir(beforeAcquisition.stagingRoot);
    expect(await acquireResolvedGitSource(preview.value, { store: beforeAcquisition, runner: acquisitionFixture.runner })).toEqual({
      ok: false, error: { code: "unreadable", message: "PiCC lifecycle storage changed or became unavailable; retry the lifecycle operation" },
    });
    expect(acquisitionFixture.calls).toHaveLength(callsBeforeAcquisition);

    const stagingStore = await store(); const stagingFixture = syntheticRunner();
    const stagingPreview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: stagingStore, resolver, runner: stagingFixture.runner });
    expect(stagingPreview.ok).toBe(true); if (!stagingPreview.ok) return;
    let changed = false;
    const changedBeforeStaging: GitRunner = async (request) => {
      const result = await stagingFixture.runner(request);
      if (!changed && request.args.includes("--batch")) {
        changed = true; await fs.rename(stagingStore.stagingRoot, `${stagingStore.stagingRoot}.changed`); await fs.mkdir(stagingStore.stagingRoot);
      }
      return result;
    };
    expect(await acquireResolvedGitSource(stagingPreview.value, { store: stagingStore, runner: changedBeforeStaging })).toEqual({
      ok: false, error: { code: "unsafe-source", message: "PiCC refused an unsafe private staging location for Git content. Verify PiCC profile storage is writable and unchanged, then retry" },
    });
    expect(changed).toBe(true);

    const materializationStore = await store(); const materializationFixture = syntheticRunner();
    const materializationPreview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: materializationStore, resolver, runner: materializationFixture.runner });
    expect(materializationPreview.ok).toBe(true); if (!materializationPreview.ok) return;
    const originalMkdtemp = fs.mkdtemp;
    const refusingMkdtemp = async (prefix: string): Promise<string> => {
      if (prefix.includes(".picc-staging-")) throw new Error("injected materialization refusal");
      return await originalMkdtemp(prefix);
    };
    Object.defineProperty(fs, "mkdtemp", { configurable: true, value: refusingMkdtemp });
    try {
      expect(await acquireResolvedGitSource(materializationPreview.value, { store: materializationStore, runner: materializationFixture.runner })).toEqual({
        ok: false, error: { code: "integrity", message: "Git content could not be safely materialized in private staging. Verify PiCC profile storage is writable and unchanged, then retry" },
      });
    } finally { Object.defineProperty(fs, "mkdtemp", { configurable: true, value: originalMkdtemp }); }
  });

  it("maps bounded process faults without exposing credential-bearing Git output", async () => {
    const owned = await store();
    const overflowRunner: GitRunner = async (request) => await productionGitRunner({
      ...request, executable: process.execPath,
      args: ["-e", "process.stdout.write('https://user:stdout-secret@example.org\\n'.repeat(600000))"],
    });
    expect(await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: overflowRunner })).toEqual({
      ok: false, error: { code: "limit-exceeded", message: "Git source output exceeded the acquisition limit" },
    });

    const credentialRunner: GitRunner = async (request) => request.args.join(" ") === "help --config"
      ? success("http.curloptResolve\n")
      : await productionGitRunner({ ...request, executable: process.execPath, args: ["-e", "process.stdout.write('https://user:stdout-secret@example.org'); process.stderr.write('Authorization: stderr-secret'); process.exit(17)"] });
    const resolutionMessage = "The anonymous Git source could not be resolved under the required pinned transport. Confirm the repository is public and reachable without sign-in and allowed by your network/TLS policy; private repositories and credentials are unsupported";
    const acquisitionMessage = "The anonymous Git source could not be acquired under the required pinned transport. Confirm the repository is public and reachable without sign-in and allowed by your network/TLS policy; private repositories and credentials are unsupported";
    const failed = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: credentialRunner });
    expect(failed).toEqual({ ok: false, error: { code: "network-failure", message: resolutionMessage } });
    expect(JSON.stringify(failed)).not.toMatch(/stdout-secret|stderr-secret|Authorization|user:/);

    const successful = syntheticRunner();
    const preview = await resolveGitPluginSource({ kind: "https-git", url: "https://host.example.org/repo" }, { store: owned, resolver, runner: successful.runner });
    expect(preview.ok).toBe(true); if (!preview.ok) return;
    const failedAcquisition = await acquireResolvedGitSource(preview.value, { store: owned, runner: credentialRunner });
    expect(failedAcquisition).toEqual({ ok: false, error: { code: "network-failure", message: acquisitionMessage } });
    expect(JSON.stringify(failedAcquisition)).not.toMatch(/stdout-secret|stderr-secret|Authorization|user:/);
  }, 20_000);
});

describe("real local Git process witnesses", () => {
  it("runs the production init/fetch/cat-file/ls-tree plumbing sequence without hooks or filters", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "picc-git-real-")); roots.push(root);
    const repository = path.join(root, "repo"); await fs.mkdir(repository);
    boundedExec("git", ["init", "-q"], repository);
    const canary = path.join(root, "executable-canary");
    await fs.mkdir(path.join(repository, "packages", "tool", "nested"), { recursive: true });
    await fs.writeFile(path.join(repository, ".gitattributes"), "packages/tool/safe.txt filter=hostile\npackages/tool/nested/selected.txt filter=hostile\n");
    await fs.writeFile(path.join(repository, "packages", "tool", "safe.txt"), "safe");
    await fs.writeFile(path.join(repository, "packages", "tool", "nested", "selected.txt"), "nested-selected");
    await fs.writeFile(path.join(repository, "outside-only.txt"), "must not enter selected plumbing");
    const hook = path.join(repository, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, `#!/bin/sh\nprintf hostile > '${canary.replaceAll("'", "'\\''")}'\n`); await fs.chmod(hook, 0o700);
    boundedExec("git", ["-c", "user.name=witness", "-c", "user.email=witness@example.invalid", "add", "."], repository);
    boundedExec("git", ["-c", "user.name=witness", "-c", "user.email=witness@example.invalid", "commit", "-qm", "witness"], repository);
    const commit = boundedExec("git", ["rev-parse", "HEAD"], repository).toString("utf8").trim();
    const objects = path.join(root, "objects.git"); const emptyConfig = path.join(root, "empty-config"); await fs.writeFile(emptyConfig, "");
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: emptyConfig, GIT_DIR: objects, GIT_TERMINAL_PROMPT: "0" };
    const runReal = async (args: readonly string[], input?: Uint8Array): Promise<GitRunResult> => await productionGitRunner({
      executable: "git", args, cwd: root, env, ...(input === undefined ? {} : { input }), timeoutMilliseconds: 5_000, maximumOutputBytes: 4 * 1024 * 1024,
    });
    expect((await runReal(["init", "--bare", objects])).code).toBe(0);
    expect((await runReal(["fetch", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", "--depth=1", repository, commit])).code).toBe(0);
    expect((await runReal(["cat-file", "-e", `${commit}^{commit}`])).code).toBe(0);
    const listed = await runReal(["ls-tree", "-rz", "-r", "-t", `${commit}:packages/tool`]); expect(listed.code).toBe(0);
    const listing = Buffer.from(listed.stdout).toString("utf8");
    const safe = /100644 blob ([0-9a-f]{40})\tsafe\.txt\0/.exec(listing); const nested = /100644 blob ([0-9a-f]{40})\tnested\/selected\.txt\0/.exec(listing);
    expect(safe).not.toBeNull(); expect(nested).not.toBeNull();
    const batch = await runReal(["cat-file", "--batch"], Buffer.from(`${safe?.[1]}\n${nested?.[1]}\n`));
    const blobs = Buffer.from(batch.stdout).toString("utf8");
    expect(blobs).toContain(`${safe?.[1]} blob 4\nsafe\n`); expect(blobs).toContain(`${nested?.[1]} blob 15\nnested-selected\n`);
    await expect(fs.access(canary)).rejects.toThrow();
  });

  it.skipIf(process.platform !== "win32")("settles through direct-child fallback when the bounded taskkill helper fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "picc-git-taskkill-fallback-")); roots.push(root);
    await fs.copyFile(process.execPath, path.join(root, "taskkill.exe"));
    const ready = path.join(root, "ready"); const script = path.join(root, "child.mjs");
    await fs.writeFile(script, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.READY,String(process.pid)); setInterval(()=>{},1000);\n`);
    const controller = new AbortController(); let pid = 0;
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const running = productionGitRunner({ executable: process.execPath, args: [script], cwd: root, env: { PATH: root, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, READY: ready }, signal: controller.signal, timeoutMilliseconds: 10_000, maximumOutputBytes: 1024 });
    await waitUntil({ description: "absolute Node child readiness before taskkill failure", predicate: async () => {
      try { pid = Number(await fs.readFile(ready, "utf8")); return Number.isSafeInteger(pid) && pid > 0; } catch { return false; }
    } });
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
    await waitUntil({ description: "direct-child fallback to terminate the child", predicate: () => !alive() });
  }, 10_000);

  it("promptly cancels a production runner parent and descendant process tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "picc-git-cancel-")); roots.push(root);
    const script = path.join(root, "parent.mjs"); const ready = path.join(root, "ready.json");
    await fs.writeFile(script, `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs";\nconst child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});\nwriteFileSync(process.env.READY,JSON.stringify({parent:process.pid,child:child.pid})); setInterval(()=>{},1000);\n`);
    const controller = new AbortController(); let pids: { parent: number; child: number } | undefined;
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const running = productionGitRunner({ executable: process.execPath, args: [script], cwd: root, env: { ...process.env, READY: ready }, signal: controller.signal, timeoutMilliseconds: 10_000, maximumOutputBytes: 1024 });
    try {
      await waitUntil({ description: "runner parent and descendant readiness", predicate: async () => {
        try { pids = JSON.parse(await fs.readFile(ready, "utf8")) as { parent: number; child: number }; return Number.isSafeInteger(pids.parent) && Number.isSafeInteger(pids.child); } catch { return false; }
      } });
      controller.abort();
      await expect(running).rejects.toThrow("cancelled");
      await waitUntil({ description: "cancelled Git parent and descendant to terminate", predicate: () => pids !== undefined && !alive(pids.parent) && !alive(pids.child),
        describeObserved: () => pids === undefined ? "no pids" : `parent=${alive(pids.parent)} child=${alive(pids.child)}` });
    } finally {
      controller.abort();
      if (pids !== undefined && (alive(pids.parent) || alive(pids.child))) {
        if (process.platform === "win32") {
          for (const pid of [pids.parent, pids.child]) {
            try { boundedExec("taskkill", ["/PID", String(pid), "/T", "/F"], root); } catch { /* each known process gets independent best-effort cleanup */ }
          }
          await Promise.all([pids.parent, pids.child].map(async (pid) => {
            await waitUntil({ description: `known cancelled process ${pid} to terminate`, predicate: () => !alive(pid) }).catch(() => undefined);
          }));
        } else { try { process.kill(-pids.parent, "SIGKILL"); } catch { /* best-effort cleanup */ } }
      }
      await running.catch(() => undefined);
    }
  }, 20_000);
});


describe("production-shaped guarded smart-HTTP mediation witness", () => {
  it.skipIf(!gitSupportsAddressPinning)("uses the reviewed numeric address with hostname TLS while ignoring proxy, credentials, config, DNS changes, redirects, and alternates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "picc-git-smart-http-")); roots.push(root);
    const work = path.join(root, "work"); const projects = path.join(root, "projects"); await fs.mkdir(work); await fs.mkdir(projects);
    boundedExec("git", ["init", "-q"], work);
    await fs.mkdir(path.join(work, ".claude-plugin")); await fs.writeFile(path.join(work, ".claude-plugin", "marketplace.json"), '{"name":"smart","plugins":[]}');
    await fs.writeFile(path.join(work, "index.js"), "export default 'safe';\n");
    await fs.writeFile(path.join(work, ".gitattributes"), "* filter=hostile-canary\n");
    await fs.writeFile(path.join(work, ".gitmodules"), "[submodule \"hostile\"]\n\tpath = hostile\n\turl = ssh://credential-canary@example.org/repo\n");
    await fs.writeFile(path.join(work, ".git", "hooks", "post-checkout"), "credential-canary must never execute\n");
    boundedExec("git", ["add", "."], work);
    boundedExec("git", ["-c", "user.name=witness", "-c", "user.email=witness@example.invalid", "commit", "-qm", "smart witness"], work);
    boundedExec("git", ["clone", "--bare", work, path.join(projects, "repo.git")], root);

    const key = path.join(root, "key.pem"); const cert = path.join(root, "cert.pem");
    await fs.writeFile(key, TEST_TLS_KEY); await fs.writeFile(cert, TEST_TLS_CERT);
    const requests: string[] = []; const wireHeaders: string[] = []; const servernames: string[] = []; let backendLaunches = 0; let sockets = 0; let closedSockets = 0;
    let redirectLocation: string | undefined;
    const server = trackedServer(https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(cert) }, async (request, response) => {
      requests.push(`${request.method} ${request.url}`); wireHeaders.push(JSON.stringify(request.headers));
      if (redirectLocation !== undefined) { response.statusCode = 302; response.setHeader("Location", redirectLocation); response.end(); return; }
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of request) { total += Buffer.byteLength(chunk as Uint8Array); if (total > 4 * 1024 * 1024) { request.destroy(); return; } chunks.push(Buffer.from(chunk as Uint8Array)); }
      backendLaunches += 1;
      try {
        const parsed = new URL(request.url ?? "/", "https://git-witness.example.org");
        const backend = await productionGitRunner({ executable: "git", args: ["http-backend"], cwd: root, input: Buffer.concat(chunks), timeoutMilliseconds: 10_000,
          maximumOutputBytes: 8 * 1024 * 1024, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GIT_PROJECT_ROOT: projects, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: parsed.pathname,
            QUERY_STRING: parsed.search.slice(1), REQUEST_METHOD: request.method ?? "GET", CONTENT_TYPE: request.headers["content-type"] ?? "",
            CONTENT_LENGTH: request.headers["content-length"] ?? String(total), REMOTE_USER: "" } });
        if (backend.code !== 0) throw new Error("Git HTTP backend failed");
        const output = Buffer.from(backend.stdout); const split = output.indexOf(Buffer.from("\r\n\r\n")); const alternate = output.indexOf(Buffer.from("\n\n"));
        const boundary = split >= 0 ? split : alternate; const width = split >= 0 ? 4 : 2;
        if (boundary < 0) throw new Error("missing CGI headers");
        for (const line of output.subarray(0, boundary).toString("utf8").split(/\r?\n/)) {
          const separator = line.indexOf(":"); if (separator > 0) response.setHeader(line.slice(0, separator), line.slice(separator + 1).trim());
        }
        response.statusCode = 200; response.end(output.subarray(boundary + width));
      } catch { response.statusCode = 500; response.end(); }
    }));
    server.on("secureConnection", (socket) => { sockets += 1; servernames.push(typeof socket.servername === "string" ? socket.servername : ""); socket.once("close", () => { closedSockets += 1; }); });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const serverAddress = server.address(); if (serverAddress === null || typeof serverAddress === "string") throw new Error("reviewed server address unavailable");

    let proxyConnections = 0;
    const proxy = trackedServer(net.createServer((socket) => { proxyConnections += 1; socket.destroy(); }));
    await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
    const proxyAddress = proxy.address(); if (proxyAddress === null || typeof proxyAddress === "string") throw new Error("proxy address unavailable");
    let ipv6Connections = 0;
    const privateIpv6 = trackedServer(net.createServer((socket) => { ipv6Connections += 1; socket.destroy(); }));
    let ipv6Available = true;
    try { await new Promise<void>((resolve, reject) => { privateIpv6.once("error", reject); privateIpv6.listen(0, "::1", resolve); }); }
    catch { ipv6Available = false; }
    const ipv6Address = privateIpv6.address(); const ipv6Port = ipv6Address !== null && typeof ipv6Address !== "string" ? ipv6Address.port : 9;
    const executableCanary = path.join(root, "ambient-executable-canary"); const canaryPath = executableCanary.replaceAll("\\", "/").replaceAll("'", "'\\''");
    const hostileConfig = path.join(root, "hostile-global-config");
    await fs.writeFile(hostileConfig, `[credential]\n\thelper = !printf hostile > '${canaryPath}'\n[filter \"hostile-canary\"]\n\tsmudge = !printf hostile > '${canaryPath}'\n[http]\n\textraHeader = Authorization: credential-canary\n\tcookieFile = ${path.join(root, "cookie-canary").replaceAll("\\", "/")}\n\tproxy = http://127.0.0.1:${proxyAddress.port}\n[url \"ssh://credential-canary@example.org/\"]\n\tinsteadOf = https://git-witness.example.org/\n`);
    const askpassCanary = path.join(root, "askpass-canary"); await fs.writeFile(askpassCanary, `#!/bin/sh\nprintf hostile > '${canaryPath}'\n`); await fs.chmod(askpassCanary, 0o700);
    await fs.writeFile(path.join(work, ".git", "hooks", "post-checkout"), `#!/bin/sh\nprintf hostile > '${canaryPath}'\n`); await fs.chmod(path.join(work, ".git", "hooks", "post-checkout"), 0o700);
    const oldProxy = process.env["HTTPS_PROXY"]; const oldAskpass = process.env["GIT_ASKPASS"]; const oldSsh = process.env["SSH_AUTH_SOCK"]; const oldConfig = process.env["GIT_CONFIG_GLOBAL"];
    process.env["HTTPS_PROXY"] = `http://proxy-user:proxy-credential-canary@127.0.0.1:${proxyAddress.port}`;
    process.env["GIT_ASKPASS"] = askpassCanary; process.env["SSH_AUTH_SOCK"] = path.join(root, "agent-canary"); process.env["GIT_CONFIG_GLOBAL"] = hostileConfig;
    const owned = await store(); let directGitLaunches = 0;
    const countedRunner: GitRunner = async (request) => { directGitLaunches += 1; return await productionGitRunner(request); };
    const reviewed = Object.freeze({ kind: "https-destination" as const, origin: `https://git-witness.example.org:${serverAddress.port}`, hostname: "git-witness.example.org", port: serverAddress.port,
      address: "127.0.0.1", family: 4 as const, canonicalUrl: `https://git-witness.example.org:${serverAddress.port}/repo.git`, path: "/repo.git", redirectCount: 0, redirected: false });
    const endpoint = issueGitSmartHttpWitnessEndpointForTest(reviewed, cert); let resolverCalls = 0;
    try {
      const preview = await resolveGitMarketplaceSource({ kind: "https-git", url: reviewed.canonicalUrl }, { store: owned, runner: countedRunner, witnessEndpoint: endpoint, resolver: async () => { resolverCalls += 1; return [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]; } });
      expect(preview).toMatchObject({ ok: true }); if (!preview.ok) return;
      const acquired = await acquireResolvedGitSource(preview.value, { store: owned, runner: countedRunner });
      expect(acquired).toMatchObject({
        ok: true,
        value: {
          kind: "git-marketplace-snapshot", source: { kind: "https-git", url: reviewed.canonicalUrl }, commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          snapshotId: expect.stringMatching(/^marketplace-/), catalogDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
          materialized: { treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), rootSelection: { requested: "tree-root", path: "" } },
          provenance: {
            adapter: "anonymous-https-git", declarationFamily: "https-git", ref: "HEAD", reviewed: { hostname: "git-witness.example.org", address: "127.0.0.1", canonicalUrl: reviewed.canonicalUrl },
            artifactDigest: expect.stringMatching(/^sha256:/), treeDigest: expect.stringMatching(/^sha256:/), rootDigest: expect.stringMatching(/^sha256:/), selectedRoot: { requested: "tree-root", path: "" },
          },
        },
      });
      for (const target of [
        `https://127.0.0.1:${proxyAddress.port}/private`,
        `https://[::ffff:127.0.0.1]:${proxyAddress.port}/mapped-private`,
        `https://[::1]:${ipv6Port}/private-v6`,
      ]) {
        redirectLocation = target;
        expect(await resolveGitPluginSource({ kind: "https-git", url: reviewed.canonicalUrl }, { store: owned, runner: countedRunner, witnessEndpoint: endpoint }))
          .toEqual({ ok: false, error: { code: "network-failure", message: "The anonymous Git source could not be resolved under the required pinned transport. Confirm the repository is public and reachable without sign-in and allowed by your network/TLS policy; private repositories and credentials are unsupported" } });
      }
      redirectLocation = undefined;
    } finally {
      if (oldProxy === undefined) delete process.env["HTTPS_PROXY"]; else process.env["HTTPS_PROXY"] = oldProxy;
      if (oldAskpass === undefined) delete process.env["GIT_ASKPASS"]; else process.env["GIT_ASKPASS"] = oldAskpass;
      if (oldSsh === undefined) delete process.env["SSH_AUTH_SOCK"]; else process.env["SSH_AUTH_SOCK"] = oldSsh;
      if (oldConfig === undefined) delete process.env["GIT_CONFIG_GLOBAL"]; else process.env["GIT_CONFIG_GLOBAL"] = oldConfig;
      await closeServer(proxy);
      await closeServer(privateIpv6);
      await closeServer(server);
    }
    expect(resolverCalls).toBe(0); expect(proxyConnections).toBe(0); if (ipv6Available) expect(ipv6Connections).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(12);
    expect(requests.every((request) => request === "GET /repo.git/info/refs?service=git-upload-pack" || request === "POST /repo.git/git-upload-pack")).toBe(true);
    expect(`${requests.join("\n")}\n${wireHeaders.join("\n")}`).not.toContain("credential-canary"); expect(wireHeaders.join("\n").toLowerCase()).not.toContain("authorization"); expect(servernames).toEqual(Array(sockets).fill("git-witness.example.org"));
    expect(backendLaunches).toBeGreaterThan(0); expect(sockets).toBeGreaterThan(0); expect(closedSockets).toBe(sockets);
    await expect(fs.access(executableCanary)).rejects.toThrow();

    const wrongKey = path.join(root, "wrong-key.pem"); const wrongCert = path.join(root, "wrong-cert.pem");
    await fs.writeFile(wrongKey, WRONG_TLS_KEY); await fs.writeFile(wrongCert, WRONG_TLS_CERT);
    const attemptedSni: string[] = []; let wrongHostRequests = 0; let wrongHostConnections = 0;
    const wrongHost = trackedServer(https.createServer({ key: await fs.readFile(wrongKey), cert: await fs.readFile(wrongCert), SNICallback: (servername, callback) => { attemptedSni.push(servername); callback(null, undefined); } }, (_request, response) => { wrongHostRequests += 1; response.end(); }));
    wrongHost.on("connection", () => { wrongHostConnections += 1; }); wrongHost.on("tlsClientError", () => undefined);
    await new Promise<void>((resolve, reject) => { wrongHost.once("error", reject); wrongHost.listen(reviewed.port, "127.0.0.1", resolve); });
    try {
      const wrongEndpoint = issueGitSmartHttpWitnessEndpointForTest(reviewed, wrongCert);
      expect(await resolveGitPluginSource({ kind: "https-git", url: reviewed.canonicalUrl }, { store: owned, runner: countedRunner, witnessEndpoint: wrongEndpoint }))
        .toMatchObject({ ok: false, error: { code: "network-failure" } });
    } finally { await closeServer(wrongHost); }
    expect(attemptedSni).toEqual(["git-witness.example.org"]); expect(wrongHostConnections).toBe(1); expect(wrongHostRequests).toBe(0);

    let alternateConnections = 0;
    const alternate = trackedServer(net.createServer((socket) => { alternateConnections += 1; socket.destroy(); }));
    await new Promise<void>((resolve, reject) => { alternate.once("error", reject); alternate.listen(reviewed.port, "127.0.0.1", resolve); });
    try {
      const failedReviewed = Object.freeze({ ...reviewed, address: "127.0.0.2" });
      const failedEndpoint = issueGitSmartHttpWitnessEndpointForTest(failedReviewed, cert);
      expect(await resolveGitPluginSource({ kind: "https-git", url: reviewed.canonicalUrl }, { store: owned, runner: countedRunner, witnessEndpoint: failedEndpoint }))
        .toMatchObject({ ok: false, error: { code: "network-failure" } });
    } finally { await closeServer(alternate); }
    expect(alternateConnections).toBe(0); expect(directGitLaunches).toBeGreaterThanOrEqual(23);
  }, 60_000);
});
