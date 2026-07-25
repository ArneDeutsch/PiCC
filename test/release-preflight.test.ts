import { EventEmitter } from "node:events";
import { gzipSync, gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { PI_SUITE_PACKAGES, VALIDATION_MODES, administrativeEnvironment, canonicalPath } from "../bin/picc-admin.mjs";
import { packRelease } from "../scripts/pack-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { inspectTarball, verifyArtifactIdentity, verifyRelease } from "../scripts/verify-release.mjs";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temp(prefix: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.push(directory);
  return fs.realpathSync(directory);
}

function fixture(version = "1.2.3") {
  const root = temp("picc-release-");
  const dependencies = Object.fromEntries(PI_SUITE_PACKAGES.map((name) => [name, "0.81.1"]));
  const manifest = { name: "picc", version, type: "module", bin: { picc: "bin/picc.mjs" }, dependencies };
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "bin", "picc.mjs"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "bin", "picc-admin.mjs"), "export {};\n");
  fs.writeFileSync(path.join(root, "src", "index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, "picc"), "#!/bin/sh\n");
  return { root, manifest };
}

interface TarEntry { name: string; data?: Buffer | string; type?: string; link?: string }
function octal(value: number, length: number) { return `${value.toString(8).padStart(length - 2, "0")} \0`; }
function tar(entries: TarEntry[], terminators = 2, remainder = Buffer.alloc(0)) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(octal(data.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")} \0`, 148, 8, "ascii");
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(terminators * 512), remainder);
  return gzipSync(Buffer.concat(blocks));
}

function paxRecord(key: string, value: string) {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  for (;;) {
    const record = `${length} ${body}`;
    if (Buffer.byteLength(record) === length) return record;
    length = Buffer.byteLength(record);
  }
}

function writeTar(root: string, name: string, bytes: Buffer) {
  const filename = path.join(root, name);
  fs.writeFileSync(filename, bytes);
  return canonicalPath(filename);
}

function artifact(source: ReturnType<typeof fixture>, options: { omit?: string; replace?: [string, Buffer | string]; extra?: TarEntry[] } = {}) {
  let entries: TarEntry[] = [
    { name: "package/package.json", data: fs.readFileSync(path.join(source.root, "package.json")) },
    { name: "package/bin/picc.mjs", data: "#!/usr/bin/env node\n" },
    { name: "package/bin/picc-admin.mjs", data: "export {};\n" },
    { name: "package/src/index.ts", data: "export {};\n" },
    { name: "package/picc", data: "#!/bin/sh\n" },
  ];
  entries = entries.filter(({ name }) => name !== options.omit);
  if (options.replace) entries = entries.map((entry) => entry.name === options.replace?.[0] ? { ...entry, data: options.replace[1] } : entry);
  entries.push(...(options.extra ?? []));
  return writeTar(source.root, `picc-${Math.random()}.tgz`, tar(entries));
}

function suite(ok = true, version = "0.81.1") {
  return (options: { mode: string }) => {
    expect(options.mode).toBe(VALIDATION_MODES.STRICT_EXACT);
    return ok ? { ok: true, version } : { ok: false, reason: "mixed installed graph" };
  };
}

function recalculateChecksum(block: Buffer) {
  block.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")} \0`, 148, 8, "ascii");
}

describe("release source and artifact preflight", () => {
  it("accepts exact tag/manual contracts and rejects unstable, mismatched, tagged-manual, and mixed graph inputs", () => {
    expect(verifyRelease({ mode: "source", event: "tag", tag: "v1.2.3", packageRoot: fixture().root, validateSuite: suite() }).version).toBe("1.2.3");
    expect(verifyRelease({ mode: "source", event: "manual", packageRoot: fixture().root, validateSuite: suite() }).version).toBe("1.2.3");
    expect(() => verifyRelease({ mode: "source", event: "manual", packageRoot: fixture("1.2.3-beta.1").root, validateSuite: suite() })).toThrow(/stable exact/);
    const source = fixture();
    expect(() => verifyRelease({ mode: "source", event: "tag", tag: "v1.2.4", packageRoot: source.root, validateSuite: suite() })).toThrow(/exactly match/);
    expect(() => verifyRelease({ mode: "source", event: "tag", packageRoot: source.root, validateSuite: suite() })).toThrow(/exactly match/);
    expect(() => verifyRelease({ mode: "source", event: "manual", tag: "v1.2.3", packageRoot: source.root, validateSuite: suite() })).toThrow(/must not carry/);
    expect(() => verifyRelease({ mode: "source", event: "manual", packageRoot: source.root, validateSuite: suite(false) })).toThrow(/mixed installed graph/);
  });

  it("returns SHA-256 and compares every required runtime/admin file byte-for-byte", () => {
    const source = fixture();
    const filename = artifact(source);
    const result = verifyRelease({ mode: "artifact", event: "manual", tarball: filename, packageRoot: source.root, validateSuite: suite() });
    expect(result).toMatchObject({ tarball: filename, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(verifyArtifactIdentity({ tarball: filename, expectedSha256: result.sha256, event: "manual" }).sha256).toBe(result.sha256);
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: artifact(source, { replace: ["package/src/index.ts", "export const substituted = true;\n"] }), packageRoot: source.root, validateSuite: suite() })).toThrow(/differs from source/);
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: artifact(source, { omit: "package/bin/picc-admin.mjs" }), packageRoot: source.root, validateSuite: suite() })).toThrow(/required regular tar member/);
    expect(() => verifyArtifactIdentity({ tarball: filename, expectedSha256: "0".repeat(64), event: "manual" })).toThrow(/SHA-256/);
  });

  it("binds every archive file and directory to an exact canonical source counterpart", () => {
    const source = fixture();
    fs.mkdirSync(path.join(source.root, "empty"));
    const withSourceDirectory = artifact(source, { extra: [{ name: "package/empty", type: "5" }] });
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: withSourceDirectory, packageRoot: source.root, validateSuite: suite() })).not.toThrow();
    const injected = artifact(source, { extra: [{ name: "package/generated.js", data: "generated\n" }] });
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: injected, packageRoot: source.root, validateSuite: suite() })).toThrow(/no canonical source counterpart/);
    const directoryOverFile = artifact(source, { omit: "package/picc", extra: [{ name: "package/picc", type: "5" }] });
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: directoryOverFile, packageRoot: source.root, validateSuite: suite() })).toThrow(/directory tar member/);
    const fileOverDirectory = artifact(source, { extra: [{ name: "package/empty", data: "not a directory" }] });
    expect(() => verifyRelease({ mode: "artifact", event: "manual", tarball: fileOverDirectory, packageRoot: source.root, validateSuite: suite() })).toThrow(/regular tar member/);
    expect(() => inspectTarball(writeTar(source.root, "node-modules.tgz", tar([{ name: "package/a/node_modules/x.js", data: "x" }])))).toThrow(/node_modules/);
  });

  it("requires an exact regular source-identical packed manifest", () => {
    const source = fixture();
    const verify = (tarball: string) => verifyRelease({ mode: "artifact", event: "manual", tarball, packageRoot: source.root, validateSuite: suite() });
    expect(() => verify(artifact(source, { replace: ["package/package.json", JSON.stringify(source.manifest)] }))).toThrow(/differs from source/);
    expect(() => verify(artifact(source, { replace: ["package/package.json", JSON.stringify({ ...source.manifest, description: "changed" })] }))).toThrow(/manifest does not exactly match/);
    expect(() => verify(artifact(source, { omit: "package/package.json" }))).toThrow(/manifest is missing/);
    expect(() => verify(artifact(source, { omit: "package/package.json", extra: [{ name: "package/package.json", type: "5" }] }))).toThrow(/manifest is missing or not a regular file/);
    expect(() => verify(artifact(source, { replace: ["package/package.json", "{not json"] }))).toThrow(/manifest is invalid JSON/);
  });

  it("accepts only regular files/directories and one local PAX path key", () => {
    const source = fixture();
    const allowed = writeTar(source.root, "pax.tgz", tar([
      { name: "package/PaxHeader", type: "x", data: paxRecord("path", "package/src/long-file.ts") },
      { name: "package/placeholder", data: "safe" },
      { name: "package/src", type: "5" },
    ]));
    expect([...inspectTarball(allowed).members.keys()]).toEqual(["package/src/long-file.ts", "package/src"]);
    for (const type of ["1", "2", "3", "4", "6", "7", "S", "g", "L", "Z"]) {
      expect(() => inspectTarball(writeTar(source.root, `type-${type}.tgz`, tar([{ name: "package/bad", type }])))).toThrow(/unsupported member type/);
    }
    expect(() => inspectTarball(writeTar(source.root, "link.tgz", tar([{ name: "package/file", link: "target" }])))).toThrow(/link metadata/);
    expect(() => inspectTarball(writeTar(source.root, "pax-size.tgz", tar([{ name: "package/pax", type: "x", data: paxRecord("size", "1") }, { name: "package/x", data: "x" }])))).toThrow(/unsupported PAX/);
    expect(() => inspectTarball(writeTar(source.root, "dangling.tgz", tar([{ name: "package/pax", type: "x", data: paxRecord("path", "package/x") }])))).toThrow(/dangling extension/);
  });

  it.each(["/absolute", "C:/absolute", "package/../escape", "package\\escape", "package/control\nname"])("rejects unsafe tar path %s", (name) => {
    const source = fixture();
    expect(() => inspectTarball(writeTar(source.root, "unsafe.tgz", tar([{ name, data: "bad" }])))).toThrow(/unsafe|control/);
  });

  it("rejects duplicate members, bad terminators/remainders, malformed headers, PAX, checksum, padding, and truncation", () => {
    const root = fixture().root;
    expect(() => inspectTarball(writeTar(root, "duplicate.tgz", tar([{ name: "package/a" }, { name: "package/a" }])))).toThrow(/duplicate/);
    expect(() => inspectTarball(writeTar(root, "one-zero.tgz", tar([{ name: "package/a" }], 1)))).toThrow(/two zero|truncated/);
    expect(() => inspectTarball(writeTar(root, "trailing.tgz", tar([{ name: "package/a" }], 2, Buffer.from("post"))))).toThrow(/post-terminator/);
    expect(() => inspectTarball(writeTar(root, "bad-pax.tgz", tar([{ name: "package/pax", type: "x", data: "8 path=x\n" }])))).toThrow(/malformed PAX/);
    const checksumArchive = gunzipSync(tar([{ name: "package/a" }])); checksumArchive[148] = 0x78;
    expect(() => inspectTarball(writeTar(root, "checksum.tgz", gzipSync(checksumArchive)))).toThrow(/checksum/);
    const numericArchive = gunzipSync(tar([{ name: "package/a" }])); numericArchive[124] = 0x39; recalculateChecksum(numericArchive.subarray(0, 512));
    expect(() => inspectTarball(writeTar(root, "numeric.tgz", gzipSync(numericArchive)))).toThrow(/size metadata/);
    const paddingArchive = gunzipSync(tar([{ name: "package/a", data: "x" }])); paddingArchive[513] = 1;
    expect(() => inspectTarball(writeTar(root, "padding.tgz", gzipSync(paddingArchive)))).toThrow(/padding/);
    const truncated = gunzipSync(tar([{ name: "package/a", data: "x" }])).subarray(0, 700);
    expect(() => inspectTarball(writeTar(root, "truncated.tgz", gzipSync(truncated)))).toThrow(/truncated|terminator/);
    const concatenated = Buffer.concat([tar([{ name: "package/a" }]), tar([{ name: "package/b" }])]);
    expect(() => inspectTarball(writeTar(root, "concatenated.tgz", concatenated))).toThrow(/concatenated|trailing compressed/);
  });

  it("enforces independent compressed and decompressed bounds", () => {
    const root = fixture().root;
    expect(() => inspectTarball(writeTar(root, "too-compressed.tgz", Buffer.alloc(32 * 1024 * 1024 + 1, 1)))).toThrow(/compressed size/);
    expect(() => inspectTarball(writeTar(root, "too-expanded.tgz", gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1))))).toThrow(/bounded gzip/);
  });
});

describe("sanitized pack helper", () => {
  it("runs trusted npm from private administration storage with exact fixed argv", async () => {
    const source = fixture();
    const outputDir = temp("picc-pack-output-");
    const poisonedDestination = temp("picc-pack-poison-");
    fs.writeFileSync(path.join(source.root, ".npmrc"), `pack-destination=${poisonedDestination}\nignore-scripts=false\n`);
    const calls: Array<{ args: string[]; options: Record<string, unknown>; userConfig: string; globalConfig: string }> = [];
    const result = await packRelease({
      packageRoot: source.root,
      outputDir,
      runNpm: ((args: string[], options: Record<string, unknown>) => {
        const userConfig = args.find((arg) => arg.startsWith("--userconfig="))!.slice("--userconfig=".length);
        const globalConfig = args.find((arg) => arg.startsWith("--globalconfig="))!.slice("--globalconfig=".length);
        calls.push({ args, options, userConfig: fs.readFileSync(userConfig, "utf8"), globalConfig: fs.readFileSync(globalConfig, "utf8") });
        expect(fs.existsSync(path.join(options.cwd as string, ".npmrc"))).toBe(false);
        fs.writeFileSync(path.join(outputDir, "picc-1.2.3.tgz"), "artifact");
        return new EventEmitter();
      }) as never,
      collect: (async (_child: unknown, options: Record<string, unknown>) => {
        expect(options).toEqual({ captureStdout: true, deadlineMs: 120_000 });
        return { ok: true, stdout: JSON.stringify([{ filename: "picc-1.2.3.tgz" }]) };
      }) as never,
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    const administrativeRoot = call.options.cwd as string;
    const userConfigPath = (call.args.find((arg) => arg.startsWith("--userconfig="))!).slice("--userconfig=".length);
    const globalConfigPath = (call.args.find((arg) => arg.startsWith("--globalconfig="))!).slice("--globalconfig=".length);
    expect(call.args).toEqual([
      "pack", canonicalPath(source.root), "--json", `--pack-destination=${canonicalPath(outputDir)}`,
      "--ignore-scripts", "--audit=false", "--fund=false", "--registry=https://registry.npmjs.org/",
      `--userconfig=${userConfigPath}`, `--globalconfig=${globalConfigPath}`,
      "--proxy=null", "--https-proxy=null", "--noproxy=*", "--strict-ssl=true",
      "--cafile=null", "--ca=null", "--cert=null", "--key=null",
    ]);
    expect(call.options).toEqual({ cwd: administrativeRoot, trustedRoots: [administrativeRoot], stdio: "pipe" });
    expect(call.userConfig).toBe("");
    expect(call.globalConfig).toBe("");
    expect(result.tarball).toBe(canonicalPath(path.join(outputDir, "picc-1.2.3.tgz")));
    expect(fs.readdirSync(poisonedDestination)).toEqual([]);
    expect(fs.existsSync(administrativeRoot)).toBe(false);
  });

  it("rejects malformed result contracts and cleans private administration state on every exit", async () => {
    const source = fixture();
    fs.mkdirSync(path.join(source.root, "out"));
    await expect(packRelease({ packageRoot: source.root, outputDir: path.join(source.root, "out") })).rejects.toThrow(/outside/);
    const nonempty = temp("picc-pack-nonempty-"); fs.writeFileSync(path.join(nonempty, "old"), "x");
    await expect(packRelease({ packageRoot: source.root, outputDir: nonempty })).rejects.toThrow(/empty/);

    const attempt = async ({ stdout = "[]", files = [], result = { ok: true }, runError, collectError }: { stdout?: string; files?: string[]; result?: { ok: boolean; category?: string }; runError?: boolean; collectError?: boolean }) => {
      const outputDir = temp("picc-pack-case-");
      let administrativeRoot = "";
      const promise = packRelease({
        packageRoot: source.root,
        outputDir,
        runNpm: ((_args: string[], options: Record<string, unknown>) => {
          administrativeRoot = options.cwd as string;
          if (runError) throw new Error("child setup failed");
          for (const file of files) fs.writeFileSync(path.join(outputDir, file), "artifact");
          return new EventEmitter();
        }) as never,
        collect: (async (_child: unknown, options: Record<string, unknown>) => {
          expect(options).toEqual({ captureStdout: true, deadlineMs: 120_000 });
          if (collectError) throw new Error("collector failed");
          return { ...result, stdout };
        }) as never,
      });
      await expect(promise).rejects.toThrow();
      expect(administrativeRoot).not.toBe("");
      expect(fs.existsSync(administrativeRoot)).toBe(false);
    };

    await attempt({ stdout: "not-json" });
    await attempt({ stdout: "[]" });
    await attempt({ stdout: JSON.stringify([{ filename: "a.tgz" }, { filename: "b.tgz" }]) });
    await attempt({ stdout: JSON.stringify([{ filename: "../escape.tgz" }]) });
    await attempt({ stdout: JSON.stringify([{ filename: "picc.txt" }]) });
    await attempt({ stdout: JSON.stringify([{ filename: "missing.tgz" }]) });
    await attempt({ stdout: JSON.stringify([{ filename: "picc.tgz" }]), files: ["picc.tgz", "other.tgz"] });
    await attempt({ result: { ok: false, category: "deadline exceeded" } });
    await attempt({ result: { ok: false, category: "nonzero exit" } });
    await attempt({ runError: true });
    await attempt({ collectError: true });
  });
});

describe("sanitized publication helper", () => {
  it("verifies exactly the original and private identities and publishes with an exact sanitized contract", async () => {
    const source = fixture();
    const filename = artifact(source);
    const sha256 = inspectTarball(filename).sha256;
    const verifyCalls: Array<Record<string, unknown>> = [];
    let administrativeRoot = "";
    let privateTarball = "";
    const npmCalls: Array<Record<string, unknown>> = [];
    const verify = (options: { tarball: string; expectedSha256: string; event: string; tag: string }) => {
      verifyCalls.push(options);
      return { tarball: options.tarball, sha256, version: "1.2.3" };
    };
    const result = await publishRelease({
      tarball: filename, expectedSha256: sha256, event: "tag", tag: "v1.2.3", token: "top-secret", verify,
      administration: () => {
        const environment = administrativeEnvironment();
        administrativeRoot = canonicalPath(path.dirname(environment.npm_config_userconfig));
        return environment;
      },
      runNpm: ((args: string[], options: Record<string, unknown>) => {
        privateTarball = args[1]!;
        const userConfigPath = args.find((arg) => arg.startsWith("--userconfig="))!.slice("--userconfig=".length);
        const globalConfigPath = args.find((arg) => arg.startsWith("--globalconfig="))!.slice("--globalconfig=".length);
        npmCalls.push({
          args, options, userConfigPath, globalConfigPath,
          userConfig: fs.readFileSync(userConfigPath, "utf8"),
          globalConfig: fs.readFileSync(globalConfigPath, "utf8"),
          bytes: fs.readFileSync(privateTarball),
        });
        return new EventEmitter();
      }) as never,
      collect: (async (_child: unknown, options: Record<string, unknown>) => {
        expect(options).toEqual({ deadlineMs: 120_000, stderrConsumer: expect.any(Function) });
        return { ok: true };
      }) as never,
    });
    expect(result).toEqual({ tarball: filename, sha256, version: "1.2.3" });
    expect(verifyCalls).toEqual([
      { tarball: filename, expectedSha256: sha256, event: "tag", tag: "v1.2.3" },
      { tarball: privateTarball, expectedSha256: sha256, event: "tag", tag: "v1.2.3" },
    ]);
    expect(npmCalls).toHaveLength(1);
    const call = npmCalls[0]!;
    const userConfigPath = call.userConfigPath as string;
    const globalConfigPath = call.globalConfigPath as string;
    expect(call.args).toEqual([
      "publish", privateTarball, "--access=public",
      "--ignore-scripts", "--audit=false", "--fund=false", "--registry=https://registry.npmjs.org/",
      `--userconfig=${userConfigPath}`, `--globalconfig=${globalConfigPath}`,
      "--proxy=null", "--https-proxy=null", "--noproxy=*", "--strict-ssl=true",
      "--cafile=null", "--ca=null", "--cert=null", "--key=null",
    ]);
    expect(call.options).toEqual({ token: "top-secret", cwd: administrativeRoot, trustedRoots: [administrativeRoot], stdio: "pipe" });
    expect(call.userConfig).toBe("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n");
    expect(call.globalConfig).toBe("");
    expect(call.bytes).toEqual(fs.readFileSync(filename));
    expect(JSON.stringify(call.args)).not.toContain("top-secret");
    expect(fs.existsSync(privateTarball)).toBe(false);
    expect(fs.existsSync(administrativeRoot)).toBe(false);
  });

  it("cleans private administration state after write, copy, verify, child, nonzero, and deadline failures", async () => {
    const source = fixture();
    const filename = artifact(source);
    const sha256 = inspectTarball(filename).sha256;
    const stages = ["copy", "write", "verify", "child", "nonzero", "deadline"] as const;
    for (const stage of stages) {
      let administrativeRoot = "";
      let verifyCount = 0;
      const fileSystem = {
        mkdirSync: fs.mkdirSync,
        copyFileSync: (...args: Parameters<typeof fs.copyFileSync>) => {
          if (stage === "copy") throw new Error("copy failed");
          return fs.copyFileSync(...args);
        },
        writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
          if (stage === "write") throw new Error("write failed");
          return (fs.writeFileSync as (...values: Parameters<typeof fs.writeFileSync>) => void)(...args);
        },
      };
      const promise = publishRelease({
        tarball: filename, expectedSha256: sha256, event: "manual", token: "token",
        administration: () => {
          const environment = administrativeEnvironment();
          administrativeRoot = canonicalPath(path.dirname(environment.npm_config_userconfig));
          return environment;
        },
        fileSystem,
        verify: ((options: { tarball: string }) => {
          verifyCount += 1;
          if (stage === "verify" && verifyCount === 2) throw new Error("private verify failed");
          return { tarball: options.tarball, sha256, version: "1.2.3" };
        }) as never,
        runNpm: (() => {
          if (stage === "child") throw new Error("child failed");
          return new EventEmitter();
        }) as never,
        collect: (async () => ({ ok: false, category: stage === "deadline" ? "deadline exceeded" : "nonzero exit" })) as never,
      });
      await expect(promise).rejects.toThrow();
      expect(fs.existsSync(administrativeRoot)).toBe(false);
    }
  });

  it("reports only bounded npm error classifications with actionable partial-release guidance", async () => {
    const source = fixture();
    const filename = artifact(source);
    const sha256 = inspectTarball(filename).sha256;
    const cases = [
      ["npm error code E401 token=super-secret /private/path", /rejected authentication/],
      ["npm error code E403 token=super-secret /private/path", /refused publication/],
      ["npm error code EPUBLISHCONFLICT token=super-secret /private/path", /version already exists/],
      ["unknown super-secret /private/path", /inspect the protected workflow logs/],
    ] as const;
    for (const [stderr, expected] of cases) {
      const verify = ({ tarball }: { tarball: string }) => ({ tarball, sha256, version: "1.2.3" });
      let message = "";
      try {
        await publishRelease({
          tarball: filename, expectedSha256: sha256, event: "manual", token: "super-secret", verify,
          runNpm: (() => new EventEmitter()) as never,
          collect: (async (_child: unknown, options: { stderrConsumer: (chunk: Buffer) => void }) => {
            const split = Math.floor(stderr.length / 2);
            options.stderrConsumer(Buffer.from(stderr.slice(0, split)));
            options.stderrConsumer(Buffer.from(stderr.slice(split)));
            return { ok: false, category: "untrusted category super-secret /private/path" };
          }) as never,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(expected);
      expect(message).toContain("GitHub Release may already exist");
      expect(message).not.toContain("super-secret");
      expect(message).not.toContain("/private/path");
    }
  });

  it("rejects malformed tokens and invalid first preflight identities before npm", async () => {
    const malformed = [undefined, "", "bad token", "bad\ntoken", "tökén", "x".repeat(4097), { token: true }];
    for (const token of malformed) await expect(publishRelease({ token, verify: () => { throw new Error("should not verify"); } })).rejects.toThrow(/NPM_TOKEN/);
    const source = fixture(); const filename = artifact(source); const sha256 = inspectTarball(filename).sha256;
    let ran = false;
    await expect(publishRelease({
      tarball: filename, expectedSha256: sha256, event: "manual", token: "token",
      verify: ({ tarball }: { tarball: string }) => ({ tarball, sha256: "0".repeat(64), version: "1.2.3" }),
      runNpm: (() => { ran = true; }) as never,
    })).rejects.toThrow(/expected canonical identity/);
    expect(ran).toBe(false);
  });
});

describe("release workflow contract", () => {
  it("pins exact triggers, jobs, consumers, ordering, action identities, and final-only token scope", () => {
    const workflow = YAML.parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8")) as any;
    expect(workflow.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: null });
    expect(Object.keys(workflow.jobs)).toEqual(["validate", "publish"]);
    const validate = workflow.jobs.validate;
    const publish = workflow.jobs.publish;
    expect(validate.permissions).toEqual({ contents: "read" });
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(publish.needs).toBe("validate");
    expect(publish.if).toBe("${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') }}");
    const pins = {
      "actions/checkout": "11d5960a326750d5838078e36cf38b85af677262",
      "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
      "actions/upload-artifact": "ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/download-artifact": "d3f86a106a0bac45b974a628896c90dbdf5c8093",
      "softprops/action-gh-release": "3bb12739c298aeb8a4eeaf626c5b8d85266b0e65",
    };
    for (const step of [...validate.steps, ...publish.steps]) {
      if (!step.uses) continue;
      const [action, sha] = step.uses.split("@");
      expect(sha).toBe((pins as Record<string, string>)[action]);
      expect(sha).toMatch(/^[a-f0-9]{40}$/);
    }
    expect(validate.steps[0]).toMatchObject({ uses: expect.stringMatching(/^actions\/checkout@/), with: { "persist-credentials": false } });
    expect(publish.steps[0]).toMatchObject({ uses: expect.stringMatching(/^actions\/checkout@/), with: { "persist-credentials": false } });
    const validationNames = validate.steps.map((step: any) => step.name);
    expect(validationNames).toEqual([
      undefined, undefined, "Install source dependencies", "Capture release context", "Typecheck", "Source and runtime tests", "Source release preflight",
      "Pack release tarball once", "Initial artifact release preflight", "Packaged-product end-to-end test", "Capture artifact names", "Final artifact release preflight", "Upload inspected release artifact",
    ]);
    const initial = validate.steps[8]; const packaged = validate.steps[9]; const finalVerification = validate.steps[11]; const upload = validate.steps[12];
    expect(initial.run).toContain('${{ steps.pack.outputs.tarball }}');
    expect(packaged.env).toEqual({ PICC_TEST_TARBALL: "${{ steps.pack.outputs.tarball }}" });
    expect(finalVerification.run).toContain('${{ steps.pack.outputs.tarball }}');
    expect(finalVerification.run).toContain('${{ steps.artifact.outputs.sha256 }}');
    expect(validate.steps.slice(11).map((step: any) => ({ name: step.name, uses: step.uses }))).toEqual([
      { name: "Final artifact release preflight", uses: undefined },
      { name: "Upload inspected release artifact", uses: expect.stringMatching(/^actions\/upload-artifact@/) },
    ]);
    expect(upload.with).toMatchObject({ name: "${{ steps.names.outputs.artifact-name }}", path: "${{ steps.pack.outputs.tarball }}" });
    expect(publish.steps[2].with).toEqual({ name: "${{ needs.validate.outputs.artifact-name }}", path: "${{ runner.temp }}/picc-release" });
    const consumerPath = '"${{ runner.temp }}/picc-release/${{ needs.validate.outputs.tarball-name }}"';
    for (const index of [3, 5]) {
      expect(publish.steps[index].run).toContain(consumerPath);
      expect(publish.steps[index].run).toContain('"${{ needs.validate.outputs.sha256 }}"');
    }
    expect(publish.steps[4].with.files).toBe("${{ runner.temp }}/picc-release/${{ needs.validate.outputs.tarball-name }}");
    expect(JSON.stringify(publish.steps.slice(0, -1))).not.toContain("NPM_TOKEN");
    expect(publish.steps.at(-1).env).toEqual({ NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    const allRuns = [...validate.steps, ...publish.steps].map((step: any) => step.run ?? "");
    expect(allRuns.filter((run: string) => run.includes("scripts/pack-release.mjs"))).toHaveLength(1);
    expect(allRuns.some((run: string) => /(^|\s)npm\s+pack(?:\s|$)/m.test(run))).toBe(false);
    expect(allRuns.some((run: string) => /(^|\s)npm\s+publish(?:\s|$)/m.test(run))).toBe(false);
    expect(validate.steps.some((step: any) => step.run === "npm run test:source")).toBe(true);
    expect(packaged.run).toBe("npm run test:packaged");
  });
});
