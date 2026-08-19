import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { packRelease } from "../scripts/pack-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import {
  RELEASE_FILE_POLICY,
  RELEASE_STATIC_FILES,
  verifyArtifactIdentity,
  verifyRelease,
  verifyReleaseAdmission,
} from "../scripts/verify-release.mjs";

const PI = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const temporary: string[] = [];
function temp(prefix: string) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); temporary.push(dir); return dir;
}
function canonical(file: string) {
  return fs.realpathSync.native(file);
}
function fixture() {
  const root = temp("picc-release-source-");
  const dependencies = Object.fromEntries(PI.map((name) => [name, "0.82.0"]));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "@arnedeutsch/picc",
    version: "1.2.3",
    type: "module",
    publishConfig: { access: "public" },
    bin: { picc: "bin/picc.mjs" },
    dependencies,
  }));
  for (const name of PI) {
    const dir = path.join(root, "node_modules", ...name.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.82.0" }));
  }
  return root;
}
type Child = EventEmitter & { stdout: PassThrough; stderr: PassThrough };
function childResult({ stdout = "", stderr = "", code = 0, beforeClose }: {
  stdout?: string; stderr?: string; code?: number; beforeClose?: () => void;
} = {}) {
  const child = new EventEmitter() as Child;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  queueMicrotask(() => {
    beforeClose?.(); child.stdout.end(stdout); child.stderr.end(stderr); child.emit("close", code, null);
  });
  return child;
}
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("release identity", () => {
  it.each(["picc", "@other/picc"])("rejects the non-canonical package identity %s", (name) => {
    const root = fixture();
    const manifestFile = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.name = name;
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => verifyReleaseAdmission({ packageRoot: root, event: "manual" }))
      .toThrow(/@arnedeutsch\/picc/);
  });

  it.each([
    ["private access", (manifest: any) => { manifest.publishConfig.access = "restricted"; }],
    ["renamed executable", (manifest: any) => { manifest.bin = { other: "bin/picc.mjs" }; }],
  ])("rejects %s before release", (_label, mutate) => {
    const root = fixture();
    const manifestFile = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    mutate(manifest);
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => verifyReleaseAdmission({ packageRoot: root, event: "manual" }))
      .toThrow(/public access and the picc executable/);
  });

  it("passes physical package spelling through admission while comparing aliases safely", () => {
    const root = fixture();
    const alias = path.join(temp("picc-release-alias-"), "package-alias");
    fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    const admitted = verifyReleaseAdmission({ packageRoot: alias, event: "manual" });
    expect(admitted.packageRoot).toBe(root);
  });

  it("checks source version, tag, exact Pi pins, and artifact hash", () => {
    const root = fixture();
    const runtimeVerifier = () => ({ ok: true, manifest: { sourceDigest: "a".repeat(64) } });
    expect(verifyRelease({ mode: "source", event: "tag", tag: "v1.2.3", packageRoot: root, runtimeVerifier }))
      .toMatchObject({ version: "1.2.3", suiteVersion: "0.82.0" });
    expect(() => verifyRelease({ mode: "source", event: "tag", tag: "v9.9.9", packageRoot: root, runtimeVerifier })).toThrow(/tag/);
    const manifestFile = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.dependencies[PI[0]!] = "0.83.0";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => verifyRelease({ mode: "source", event: "manual", packageRoot: root, runtimeVerifier })).toThrow(/one exact Pi suite/);
    manifest.dependencies[PI[0]!] = "0.82.0";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "release bytes");
    const sha = createHash("sha256").update("release bytes").digest("hex");
    expect(verifyArtifactIdentity({ tarball, expectedSha256: sha }).sha256).toBe(sha);
    let inspected: any;
    expect(verifyRelease({
      mode: "artifact",
      event: "manual",
      packageRoot: root,
      tarball,
      expectedSha256: sha,
      inspectArtifact: true,
      sourceIdentityCollector: () => ({ sourceDigest: "c".repeat(64) }),
      artifactVerifier: (options: any) => { inspected = options; },
    })).toMatchObject({ sha256: sha });
    expect(inspected).toMatchObject({
      expectedPackage: { name: "@arnedeutsch/picc", version: "1.2.3", type: "module" },
      expectedSourceDigest: "c".repeat(64),
    });
    expect(inspected.archiveBytes.toString("utf8")).toBe("release bytes");
    expect(inspected.filePolicy.files).toContain("bin/picc-host.mjs");
    expect(inspected.filePolicy.files).toContain("picc/index.ts");
    expect(inspected.filePolicy.prefixes).toContain("dist/");

    fs.appendFileSync(tarball, "changed");
    expect(() => verifyArtifactIdentity({ tarball, expectedSha256: sha })).toThrow(/SHA-256/);
  });
});

describe("release file policy", () => {
  it("makes the sorted static inventory exact while leaving only schema-owned trees dynamic", () => {
    expect(RELEASE_FILE_POLICY.files).toBe(RELEASE_STATIC_FILES);
    expect(RELEASE_STATIC_FILES).toEqual([...RELEASE_STATIC_FILES].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right))));
    expect(RELEASE_FILE_POLICY.prefixes).toEqual(["dist/", "src/"]);
    for (const required of ["bin/picc-host.mjs", "bin/picc-mcp.mjs", "bin/picc.mjs", "doc/testing.md", "examples/hello-claude/CLAUDE.md", "picc/index.ts"]) {
      expect(RELEASE_STATIC_FILES).toContain(required);
      expect(RELEASE_FILE_POLICY.prefixes.some((prefix) => required.startsWith(prefix))).toBe(false);
    }
    for (const unexpected of ["bin/nested/tool.mjs", "doc/nested/extra.md", "examples/hello-claude/nested/extra.txt", "picc/nested/index.js"]) {
      expect(RELEASE_STATIC_FILES).not.toContain(unexpected);
      expect(RELEASE_FILE_POLICY.prefixes.some((prefix) => unexpected.startsWith(prefix))).toBe(false);
    }
  });
});

describe("pack release", () => {
  it("binds one npm pack JSON record to physical source identity, output, and SHA", async () => {
    const root = fixture();
    const rootAlias = path.join(temp("picc-release-pack-alias-"), "package-alias");
    fs.symlinkSync(root, rootAlias, process.platform === "win32" ? "junction" : "dir");
    const output = temp("picc-release-output-");
    const filename = "arnedeutsch-picc-1.2.3.tgz";
    let call: any;
    const operations: string[] = [];
    const runtimeManifest = { sourceDigest: "a".repeat(64), runtimeDigest: "b".repeat(64) };
    const result = await (packRelease as any)({
      packageRoot: rootAlias,
      outputDir: output,
      event: "manual",
      admissionVerifier: (options: any) => {
        operations.push("admit");
        expect(options.packageRoot).toBe(root);
        return verifyReleaseAdmission(options);
      },
      build: () => { operations.push("build"); },
      runtimeVerifier: () => { operations.push("verify-runtime"); return { ok: true, manifest: runtimeManifest }; },
      artifactVerifier: ({ archiveBytes }: { archiveBytes: Buffer }) => {
        operations.push("inspect-artifact");
        expect(archiveBytes.toString("utf8")).toBe("packed once");
      },
      runNpm: ((args: string[], options: any) => {
        operations.push("pack");
        call = { args, options };
        return childResult({
          stdout: JSON.stringify([{ name: "@arnedeutsch/picc", version: "1.2.3", filename }]),
          beforeClose: () => fs.writeFileSync(path.join(output, filename), "packed once"),
        });
      }) as never,
    });
    expect(operations).toEqual(["admit", "build", "verify-runtime", "pack", "inspect-artifact"]);
    expect(call.args).toEqual([
      "pack", canonical(root), "--json", "--ignore-scripts",
      `--pack-destination=${canonical(output)}`,
    ]);
    expect(call.options.cwd).toBe(canonical(root));
    expect(result).toMatchObject({
      name: "@arnedeutsch/picc",
      version: "1.2.3",
      sha256: createHash("sha256").update("packed once").digest("hex"),
    });

    const otherRoot = fixture();
    const otherOutput = temp("picc-release-output-");
    await expect((packRelease as any)({
      packageRoot: otherRoot,
      outputDir: otherOutput,
      event: "manual",
      build: () => undefined,
      runtimeVerifier: () => ({ ok: true, manifest: runtimeManifest }),
      artifactVerifier: () => undefined,
      runNpm: (() => childResult({
        stdout: JSON.stringify([{ name: "other", version: "1.2.3", filename }]),
      })) as never,
    })).rejects.toThrow(/matching @arnedeutsch\/picc artifact/);
  });

  it("admits event, tag, package, and Pi identity before build or pack", async () => {
    const root = fixture();
    const output = temp("picc-release-output-");
    const operations: string[] = [];
    await expect((packRelease as any)({
      packageRoot: root,
      outputDir: output,
      event: "tag",
      tag: "v9.9.9",
      admissionVerifier: (options: any) => {
        operations.push("admit");
        return verifyReleaseAdmission(options);
      },
      build: () => { operations.push("build"); },
      runNpm: (() => { operations.push("pack"); return childResult(); }) as never,
    })).rejects.toThrow(/tag/);
    expect(operations).toEqual(["admit"]);
    expect(fs.readdirSync(output)).toEqual([]);
  });
});

describe("publish release", () => {
  it("rehashes first and exposes the token only through NODE_AUTH_TOKEN and a temporary npmrc", async () => {
    const root = fixture();
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "verified release");
    const sha = createHash("sha256").update("verified release").digest("hex");
    const prior = {
      NPM_TOKEN: process.env.NPM_TOKEN,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      npm_config_cafile: process.env.npm_config_cafile,
      npm_config_userconfig: process.env.npm_config_userconfig,
      npm_config_globalconfig: process.env.npm_config_globalconfig,
    };
    Object.assign(process.env, {
      NPM_TOKEN: "ambient-token",
      HTTPS_PROXY: "https://proxy.example",
      npm_config_cafile: "C:/company/ca.pem",
      npm_config_userconfig: "C:/users/me/.npmrc",
      npm_config_globalconfig: "C:/node/etc/npmrc",
    });
    let call: any;
    try {
      await (publishRelease as any)({
        packageRoot: root, tarball, expectedSha256: sha, event: "tag", tag: "v1.2.3", token: "release-secret",
        runNpm: ((args: string[], options: any) => {
          call = { args, options, npmrc: fs.readFileSync(path.join(options.cwd, ".npmrc"), "utf8") };
          return childResult();
        }) as never,
      });
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(call.args).toEqual([
      "publish", canonical(tarball), "--registry=https://registry.npmjs.org/",
      "--access=public", "--ignore-scripts", "--provenance",
    ]);
    expect(call.args.join(" ")).not.toContain("release-secret");
    expect(call.npmrc).toBe("//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n");
    expect(call.npmrc).not.toContain("release-secret");
    expect(call.options.env).toMatchObject({
      NODE_AUTH_TOKEN: "release-secret",
      HTTPS_PROXY: "https://proxy.example",
      npm_config_cafile: "C:/company/ca.pem",
    });
    const inherited = (name: string) => Object.entries(call.options.env)
      .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    expect(inherited("npm_config_userconfig")).toBe("C:/users/me/.npmrc");
    expect(inherited("npm_config_globalconfig")).toBe("C:/node/etc/npmrc");
    expect(call.options.env.NPM_TOKEN).toBeUndefined();
    expect(fs.existsSync(call.options.cwd)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
  ])("refuses a %s token before invoking npm", async (_label, token) => {
    const root = fixture();
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "release");
    const prior = process.env.NPM_TOKEN;
    delete process.env.NPM_TOKEN;
    let ran = false;
    try {
      await expect((publishRelease as any)({
        packageRoot: root, tarball, expectedSha256: "0".repeat(64),
        event: "tag", tag: "v1.2.3", token,
        runNpm: (() => { ran = true; return childResult(); }) as never,
      })).rejects.toThrow(/NPM_TOKEN is required/);
    } finally {
      if (prior === undefined) delete process.env.NPM_TOKEN; else process.env.NPM_TOKEN = prior;
    }
    expect(ran).toBe(false);
  });

  it("refuses a bad hash before invoking npm", async () => {
    const root = fixture();
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "release");
    let ran = false;
    await expect((publishRelease as any)({
      packageRoot: root, tarball, expectedSha256: "0".repeat(64),
      event: "tag", tag: "v1.2.3", token: "token",
      runNpm: (() => { ran = true; return childResult(); }) as never,
    })).rejects.toThrow(/SHA-256/);
    expect(ran).toBe(false);
  });

  it.each([
    ["E401", /rejected authentication/],
    ["E403", /refused publication.*@arnedeutsch\/picc/],
    ["EPUBLISHCONFLICT", /version already exists/],
  ])("classifies %s without exposing raw npm output", async (code, expected) => {
    const root = fixture();
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "release");
    const sha = createHash("sha256").update("release").digest("hex");
    const attempt = (publishRelease as any)({
      packageRoot: root, tarball, expectedSha256: sha,
      event: "tag", tag: "v1.2.3", token: "release-secret",
      runNpm: (() => childResult({ code: 1, stderr: `npm ${code}: raw-secret-detail` })) as never,
    });
    await expect(attempt).rejects.toThrow(expected);
    await expect(attempt).rejects.not.toThrow(/raw-secret-detail/);
  });
});

describe("release workflow", () => {
  it.skipIf(process.platform !== "linux")("executes source admission against shallow local Git history", () => {
    const remote = path.join(temp("picc-release-remote-"), "origin.git");
    const source = temp("picc-release-git-source-");
    execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
    execFileSync("git", ["init"], { cwd: source, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Release Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "release@example.invalid"], { cwd: source });
    fs.writeFileSync(path.join(source, "release.txt"), "ancestor\n");
    execFileSync("git", ["add", "release.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "ancestor"], { cwd: source, stdio: "pipe" });
    execFileSync("git", ["branch", "-M", "main"], { cwd: source });
    execFileSync("git", ["branch", "ancestor"], { cwd: source });
    const ancestor = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    fs.appendFileSync(path.join(source, "release.txt"), "main\n");
    execFileSync("git", ["commit", "-am", "main"], { cwd: source, stdio: "pipe" });
    execFileSync("git", ["checkout", "-b", "divergent", ancestor], { cwd: source, stdio: "pipe" });
    fs.writeFileSync(path.join(source, "divergent.txt"), "divergent\n");
    execFileSync("git", ["add", "divergent.txt"], { cwd: source });
    execFileSync("git", ["commit", "-m", "divergent"], { cwd: source, stdio: "pipe" });
    const divergent = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: source });
    execFileSync("git", ["push", "origin", "main", "ancestor", "divergent"], { cwd: source, stdio: "pipe" });

    const workflow = YAML.parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8")) as any;
    const admission = workflow.jobs.package.steps.find(
      (step: any) => step.name === "Verify tagged commit is contained in current main",
    );
    const remoteUrl = pathToFileURL(remote).href;
    const localAdmission = admission.run.replace(
      "https://github.com/ArneDeutsch/PiCC.git",
      `'${remoteUrl}'`,
    );
    const execute = (branch: string, sha: string) => {
      const checkout = path.join(temp(`picc-release-${branch}-`), "checkout");
      execFileSync("git", ["clone", "--depth", "1", "--branch", branch, remoteUrl, checkout], { stdio: "pipe" });
      expect(execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: checkout, encoding: "utf8",
      }).trim()).toBe("true");
      const result = spawnSync("bash", ["-c", localAdmission], {
        cwd: checkout,
        env: { ...process.env, GITHUB_SHA: sha },
        encoding: "utf8",
      });
      expect(execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: checkout, encoding: "utf8",
      }).trim()).toBe("false");
      return result;
    };

    const admitted = execute("ancestor", ancestor);
    expect(admitted.status, admitted.stderr).toBe(0);
    const refused = execute("divergent", divergent);
    expect(refused.status).not.toBe(0);
  });

  it("packs once, hands the verified artifact to a protected publish job, and scopes the token", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.preversion).toBe("npm run verify:all");
    expect(manifest.scripts.version).toBeUndefined();
    expect(manifest.scripts.prepublishOnly).toBe("npm run verify:all");
    expect(manifest.scripts.build).toBe("node scripts/build-runtime.mjs");
    expect(manifest.scripts.setup).toBe("npm ci && npm run build && npm link");
    const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as any;
    expect(packageJson.homepage).toBe("https://github.com/ArneDeutsch/PiCC#readme");
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/ArneDeutsch/PiCC.git",
    });
    expect(packageJson.bugs).toEqual({ url: "https://github.com/ArneDeutsch/PiCC/issues" });
    expect(packageJson).toMatchObject({
      name: "@arnedeutsch/picc",
      version: "0.1.1",
      publishConfig: { access: "public" },
      bin: { picc: "bin/picc.mjs" },
    });
    expect(packageJson.files).toEqual([
      "dist", "src", "picc/index.ts", "bin", "examples", "doc/*.md",
      "CONTRIBUTING.md", "LICENSE", "README.md",
    ]);
    expect(packageJson.dependencies).not.toHaveProperty("jiti");
    expect(packageJson.devDependencies.jiti).toBe("2.7.0");
    const lock = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8")) as any;
    expect(lock).toMatchObject({
      name: "@arnedeutsch/picc",
      version: "0.1.1",
      packages: { "": { name: "@arnedeutsch/picc", version: "0.1.1", bin: { picc: "bin/picc.mjs" } } },
    });
    expect(lock.packages[""].dependencies).not.toHaveProperty("jiti");
    expect(lock.packages[""].devDependencies.jiti).toBe("2.7.0");
    expect(manifest.scripts["test:e2e:compiled"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e --exclude \"test/e2e-packaged-launcher.test.ts\" --exclude \"test/e2e-source-fallback.test.ts\"",
    );
    expect(manifest.scripts["test:e2e:source-fallback"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e test/e2e-source-fallback.test.ts",
    );
    expect(manifest.scripts["test:e2e"]).toBe(
      "npm run test:packaged && npm run test:e2e:compiled && npm run test:e2e:source-fallback",
    );
    expect(manifest.scripts["test:source"]).toBe(
      "npm run test:unit && npm run test:integration && npm run test:e2e:source-fallback",
    );
    expect(manifest.scripts["test:packaged"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e test/e2e-packaged-launcher.test.ts",
    );
    const workflow = YAML.parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8")) as any;
    expect(workflow.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["package", "publish"]);
    const packageJob = workflow.jobs.package;
    const publishJob = workflow.jobs.publish;
    expect(packageJob.if).toBeUndefined();
    expect(packageJob.environment).toBeUndefined();
    const packageSteps = packageJob.steps as any[];
    const publishSteps = publishJob.steps as any[];
    const allSteps = [...packageSteps, ...publishSteps];
    const runs = allSteps.map((step) => step.run ?? "");
    const checkout = packageSteps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    const sourceAdmission = packageSteps.find((step) => step.name === "Verify tagged commit is contained in current main");
    const install = packageSteps.find((step) => step.name === "Install dependencies");
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(sourceAdmission.if).toBe("${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') }}");
    expect(sourceAdmission.run).toContain("http.https://github.com/.extraheader=");
    expect(sourceAdmission.run).toContain("https://github.com/ArneDeutsch/PiCC.git");
    expect(sourceAdmission.run).toContain("+refs/heads/main:refs/remotes/origin/main");
    expect(sourceAdmission.run).toContain('tag_commit="$(git rev-parse "$GITHUB_SHA^{commit}")"');
    expect(sourceAdmission.run).toContain('git merge-base --is-ancestor "$tag_commit" refs/remotes/origin/main');
    expect(packageSteps.indexOf(checkout)).toBeLessThan(packageSteps.indexOf(sourceAdmission));
    expect(packageSteps.indexOf(sourceAdmission)).toBeLessThan(packageSteps.indexOf(install));
    expect(sourceAdmission["continue-on-error"]).toBeUndefined();
    expect(packageSteps.find((step) => step.name === "Verify build-free source lanes")?.run)
      .toBe("npm run typecheck:all && npm run test:unit && npm run test:integration");
    expect(packageSteps.find((step) => step.name === "Test exact packaged product")?.run)
      .toBe("npm run test:packaged");
    expect(runs.filter((run) => run.includes("scripts/pack-release.mjs"))).toHaveLength(1);
    const pack = packageSteps.find((step) => step.name === "Build verified runtime and pack once");
    const inspect = packageSteps.find((step) => step.name === "Inspect and hash exact packed artifact");
    expect(pack).toBeDefined();
    expect(inspect).toBeDefined();
    for (const step of [pack, inspect]) {
      expect(step.env).toEqual({
        RELEASE_EVENT: "${{ steps.context.outputs.event }}",
        RELEASE_TAG: "${{ steps.context.outputs.tag }}",
      });
      expect(step.run).toContain('--event "$RELEASE_EVENT"');
      expect(step.run).toContain('[[ "$RELEASE_EVENT" == "tag" ]]');
      expect(step.run).toContain('--tag "$RELEASE_TAG"');
      expect(step.run).not.toContain("${{ steps.context.outputs.event }}");
      expect(step.run).not.toContain("${{ steps.context.outputs.tag }}");
    }
    const hostileContext = {
      event: 'tag"; touch "$RUNNER_TEMP/event-injected"; #',
      tag: 'v1.2.3"; touch "$RUNNER_TEMP/tag-injected"; #',
    };
    const shellSource = `${pack.run}\n${inspect.run}`;
    const expressionExpandedSource = shellSource
      .replaceAll("${{ steps.context.outputs.event }}", hostileContext.event)
      .replaceAll("${{ steps.context.outputs.tag }}", hostileContext.tag);
    expect(expressionExpandedSource).toBe(shellSource);
    expect(shellSource).not.toContain("event-injected");
    expect(shellSource).not.toContain("tag-injected");
    expect(packageSteps.indexOf(sourceAdmission)).toBeLessThan(packageSteps.indexOf(pack));
    expect(packageSteps.indexOf(pack)).toBeLessThan(packageSteps.indexOf(inspect));
    expect(runs.filter((run) => /npm run build|build-runtime\.mjs/u.test(run))).toHaveLength(0);
    expect(publishSteps.map((step) => step.run ?? "").join("\n")).not.toMatch(/npm run build|pack-release\.mjs/u);
    expect(packageJob.outputs).toEqual({
      filename: "${{ steps.pack.outputs.filename }}",
      sha256: "${{ steps.pack.outputs.sha256 }}",
    });

    const packaged = packageSteps.find((step) => step.name === "Test exact packaged product");
    expect(packaged.env).toEqual({
      PICC_TEST_TARBALL: "${{ steps.pack.outputs.tarball }}",
      TEMP: "${{ runner.temp }}",
      TMP: "${{ runner.temp }}",
      TMPDIR: "${{ runner.temp }}",
    });
    const upload = packageSteps.find((step) => step.name === "Upload verified release artifact");
    const download = publishSteps.find((step) => step.name === "Download verified release artifact");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(download.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/);
    expect(download.with.name).toBe(upload.with.name);
    expect(publishJob.if).toBe("${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/') }}");
    expect(publishJob.needs).toBe("package");
    expect(publishJob.environment).toEqual({ name: "npm-publish" });
    expect(publishJob.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(JSON.stringify(packageJob)).not.toContain("id-token");
    expect(publishJob.env.RELEASE_FILENAME).toBe("${{ needs.package.outputs.filename }}");
    expect(publishJob.env.RELEASE_SHA256).toBe("${{ needs.package.outputs.sha256 }}");
    expect(JSON.stringify(publishJob.env)).not.toContain("runner.");

    const release = publishSteps.find((step) => step.name === "Create GitHub Release");
    const publish = publishSteps.find((step) => step.name === "Publish exact artifact to npm");
    const recheck = publishSteps.find((step) => step.name === "Recheck artifact before publication");
    expect(publishSteps.indexOf(recheck)).toBeLessThan(publishSteps.indexOf(release));
    expect(recheck.run).toContain("$RUNNER_TEMP/picc-release-$GITHUB_RUN_ID/$RELEASE_FILENAME");
    expect(recheck.run).toContain("$RELEASE_SHA256");
    expect(release.with.files).toContain("${{ runner.temp }}");
    expect(release.with.files).toContain("${{ needs.package.outputs.filename }}");
    const normalizedPublish = publish.run.replace(/\s+/gu, " ").trim();
    expect(normalizedPublish).toBe(
      "node scripts/publish-release.mjs "
      + "--tarball \"$RUNNER_TEMP/picc-release-$GITHUB_RUN_ID/$RELEASE_FILENAME\" "
      + "--expected-sha256 \"$RELEASE_SHA256\" --event tag --tag \"$GITHUB_REF_NAME\"",
    );
    expect(normalizedPublish).not.toMatch(/(?:&&|\|\||[;|])/u);
    expect(publish.if).toBeUndefined();
    expect(publish["continue-on-error"]).toBeUndefined();
    expect(publishSteps.at(-1)).toBe(publish);
    expect(publish.env).toEqual({ NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    expect(JSON.stringify(allSteps.filter((step) => step !== publish))).not.toContain("NPM_TOKEN");
    expect(JSON.stringify(packageJob)).not.toContain("secrets.");
    for (const step of allSteps.filter((item) => item.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });
});
