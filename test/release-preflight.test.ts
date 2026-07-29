import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { packRelease } from "../scripts/pack-release.mjs";
import { publishRelease } from "../scripts/publish-release.mjs";
import { verifyArtifactIdentity, verifyRelease } from "../scripts/verify-release.mjs";

const PI = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];
const temporary: string[] = [];
function temp(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temporary.push(dir); return dir;
}
function canonical(file: string) {
  const real = fs.realpathSync(file);
  return process.platform === "win32" ? real.toLowerCase() : real;
}
function fixture() {
  const root = temp("picc-release-source-");
  const dependencies = Object.fromEntries(PI.map((name) => [name, "0.82.0"]));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "picc", version: "1.2.3", dependencies }));
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
  it("checks source version, tag, exact Pi pins, and artifact hash", () => {
    const root = fixture();
    expect(verifyRelease({ mode: "source", event: "tag", tag: "v1.2.3", packageRoot: root }))
      .toMatchObject({ version: "1.2.3", suiteVersion: "0.82.0" });
    expect(() => verifyRelease({ mode: "source", event: "tag", tag: "v9.9.9", packageRoot: root })).toThrow(/tag/);
    const manifestFile = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    manifest.dependencies[PI[0]!] = "0.83.0";
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    expect(() => verifyRelease({ mode: "source", event: "manual", packageRoot: root })).toThrow(/one exact Pi suite/);
    const tarball = path.join(temp("picc-release-artifact-"), "picc.tgz");
    fs.writeFileSync(tarball, "release bytes");
    const sha = createHash("sha256").update("release bytes").digest("hex");
    expect(verifyArtifactIdentity({ tarball, expectedSha256: sha }).sha256).toBe(sha);
    fs.appendFileSync(tarball, "changed");
    expect(() => verifyArtifactIdentity({ tarball, expectedSha256: sha })).toThrow(/SHA-256/);
  });
});

describe("pack release", () => {
  it("binds one npm pack JSON record to source identity, output, and SHA", async () => {
    const root = fixture();
    const output = temp("picc-release-output-");
    const filename = "picc-1.2.3.tgz";
    let call: any;
    const result = await (packRelease as any)({
      packageRoot: root,
      outputDir: output,
      runNpm: ((args: string[], options: any) => {
        call = { args, options };
        return childResult({
          stdout: JSON.stringify([{ name: "picc", version: "1.2.3", filename }]),
          beforeClose: () => fs.writeFileSync(path.join(output, filename), "packed once"),
        });
      }) as never,
    });
    expect(call.args).toEqual([
      "pack", canonical(root), "--json", "--ignore-scripts",
      `--pack-destination=${canonical(output)}`,
    ]);
    expect(call.options.cwd).toBe(canonical(root));
    expect(result).toMatchObject({
      name: "picc",
      version: "1.2.3",
      sha256: createHash("sha256").update("packed once").digest("hex"),
    });

    const otherRoot = fixture();
    const otherOutput = temp("picc-release-output-");
    await expect((packRelease as any)({
      packageRoot: otherRoot,
      outputDir: otherOutput,
      runNpm: (() => childResult({
        stdout: JSON.stringify([{ name: "other", version: "1.2.3", filename }]),
      })) as never,
    })).rejects.toThrow(/matching picc artifact/);
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
      "--access=public", "--ignore-scripts",
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
    ["E403", /refused publication/],
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
  it("packs once, hands the verified artifact to a protected publish job, and scopes the token", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.preversion).toBe("npm run verify");
    expect(manifest.scripts.version).toBeUndefined();
    expect(manifest.scripts.prepublishOnly).toBe("npm run verify");
    const workflow = YAML.parse(fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8")) as any;
    expect(workflow.on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: null });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["package", "publish"]);
    const packageJob = workflow.jobs.package;
    const publishJob = workflow.jobs.publish;
    const packageSteps = packageJob.steps as any[];
    const publishSteps = publishJob.steps as any[];
    const allSteps = [...packageSteps, ...publishSteps];
    const runs = allSteps.map((step) => step.run ?? "");
    expect(runs.filter((run) => run.includes("scripts/pack-release.mjs"))).toHaveLength(1);
    expect(packageJob.outputs).toEqual({
      filename: "${{ steps.pack.outputs.filename }}",
      sha256: "${{ steps.pack.outputs.sha256 }}",
    });

    const packaged = packageSteps.find((step) => step.name === "Test exact packaged product");
    expect(packaged.env.PICC_TEST_TARBALL).toBe("${{ steps.pack.outputs.tarball }}");
    const upload = packageSteps.find((step) => step.name === "Upload verified release artifact");
    const download = publishSteps.find((step) => step.name === "Download verified release artifact");
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(download.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/);
    expect(download.with.name).toBe(upload.with.name);
    expect(publishJob.if).toContain("github.event_name == 'push'");
    expect(publishJob.if).toContain("startsWith(github.ref, 'refs/tags/')");
    expect(publishJob.needs).toBe("package");
    expect(publishJob.environment).toEqual({ name: "npm-publish" });
    expect(publishJob.permissions).toEqual({ contents: "write" });
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
    expect(publish.run).toContain("$RUNNER_TEMP/picc-release-$GITHUB_RUN_ID/$RELEASE_FILENAME");
    expect(publish.run).toContain("$RELEASE_SHA256");
    expect(publishSteps.at(-1)).toBe(publish);
    expect(publish.env).toEqual({ NPM_TOKEN: "${{ secrets.NPM_TOKEN }}" });
    expect(JSON.stringify(allSteps.filter((step) => step !== publish))).not.toContain("NPM_TOKEN");
    expect(JSON.stringify(packageJob)).not.toContain("secrets.");
    for (const step of allSteps.filter((item) => item.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  });
});
