#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PI_SUITE_PACKAGES,
  physicalPath,
  findPackageRoot,
  parseStableExactVersion,
  pathsEqual,
  validatePiSuite,
} from "../bin/picc-admin.mjs";
import { collectCompilationIdentity, verifyCompiledRuntime } from "../bin/picc-runtime.mjs";
import { verifyRuntimeArtifact } from "./runtime-artifact.mjs";

export const RELEASE_STATIC_FILES = Object.freeze([
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "bin/picc-admin.mjs",
  "bin/picc-host.mjs",
  "bin/picc-mcp.mjs",
  "bin/picc-plugin.mjs",
  "bin/picc-runtime.mjs",
  "bin/picc-update.mjs",
  "bin/picc.mjs",
  "doc/architecture.md",
  "doc/documentation-guide.md",
  "doc/pi-integration.md",
  "doc/supported-features.md",
  "doc/testing.md",
  "doc/threat-model.md",
  "doc/tui-extension-guide.md",
  "doc/user-guide.md",
  "examples/full-surface/.claude-plugin/plugin.json",
  "examples/full-surface/.claude-plugin/skills/plugin-skill/SKILL.md",
  "examples/full-surface/.claude/agents/async-researcher.md",
  "examples/full-surface/.claude/agents/future-agent.md",
  "examples/full-surface/.claude/agents/iso-writer.md",
  "examples/full-surface/.claude/agents/isolated-worker.md",
  "examples/full-surface/.claude/agents/midrun-worktree-runner.md",
  "examples/full-surface/.claude/agents/planner.md",
  "examples/full-surface/.claude/agents/researcher.md",
  "examples/full-surface/.claude/agents/reviewer.md",
  "examples/full-surface/.claude/agents/selected-main.md",
  "examples/full-surface/.claude/commands/bg-research.md",
  "examples/full-surface/.claude/commands/ship.md",
  "examples/full-surface/.claude/rules/general.md",
  "examples/full-surface/.claude/rules/nested/git.md",
  "examples/full-surface/.claude/rules/rust.md",
  "examples/full-surface/.claude/settings.json",
  "examples/full-surface/.claude/skills/deploy/SKILL.md",
  "examples/full-surface/.claude/skills/fork-research/SKILL.md",
  "examples/full-surface/.claude/skills/ps-info/SKILL.md",
  "examples/full-surface/.claude/skills/repo-info/SKILL.md",
  "examples/full-surface/.claude/skills/rust-helper/SKILL.md",
  "examples/full-surface/.claude/skills/secret-ritual/SKILL.md",
  "examples/full-surface/.mcp.json",
  "examples/full-surface/.worktreeinclude",
  "examples/full-surface/CLAUDE.local.md",
  "examples/full-surface/CLAUDE.md",
  "examples/full-surface/README.md",
  "examples/full-surface/analysis.ipynb",
  "examples/full-surface/docs/imported.md",
  "examples/full-surface/docs/level2.md",
  "examples/full-surface/src/CLAUDE.md",
  "examples/full-surface/src/lib.rs",
  "examples/full-surface/src/main.rs",
  "examples/full-surface/tools/preflight.sh",
  "examples/full-surface/tools/write-guard.sh",
  "examples/hello-claude/.claude/agents/reviewer.md",
  "examples/hello-claude/.claude/commands/status.md",
  "examples/hello-claude/.claude/rules/style.md",
  "examples/hello-claude/.claude/settings.json",
  "examples/hello-claude/.claude/skills/greet/SKILL.md",
  "examples/hello-claude/AGENTS.md",
  "examples/hello-claude/CLAUDE.md",
  "examples/hello-claude/README.md",
  "examples/hello-claude/src/hello.js",
  "package.json",
  "picc/index.ts",
]);

export const RELEASE_FILE_POLICY = Object.freeze({
  files: RELEASE_STATIC_FILES,
  prefixes: Object.freeze(["dist/", "src/"]),
});

const USAGE = "Usage: node scripts/verify-release.mjs <source|artifact> --event <tag|manual> [--tag vX.Y.Z] [--tarball path] [--expected-sha256 hex]";

function fail(message) { throw new Error(`Release verification failed: ${message}`); }

function readManifest(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch { fail("source package manifest is invalid"); }
}

export function verifyReleaseAdmission({ packageRoot, event, tag } = {}) {
  let root;
  try { root = physicalPath(packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { fail("package root is unavailable"); }
  const manifest = readManifest(root);
  if (manifest?.name !== "@arnedeutsch/picc" || manifest?.type !== "module" || !parseStableExactVersion(manifest.version)) fail("package name/version/type must identify @arnedeutsch/picc as a stable ESM package");
  if (manifest.publishConfig?.access !== "public" || manifest.bin?.picc !== "bin/picc.mjs") {
    fail("package metadata must declare public access and the picc executable");
  }
  if (event === "tag" && tag !== `v${manifest.version}`) fail("tag must exactly match v<package version>");
  if (event === "manual" && tag !== undefined) fail("manual verification must not carry a tag");
  if (event !== "tag" && event !== "manual") fail("event must be tag or manual");
  const pins = PI_SUITE_PACKAGES.map((name) => manifest.dependencies?.[name]);
  if (pins.some((version) => !parseStableExactVersion(version)) || new Set(pins).size !== 1) fail("manifest must pin one exact Pi suite");
  const suite = validatePiSuite({ packageRoot: root });
  if (!suite.ok || suite.version !== pins[0]) fail(suite.reason ?? "installed Pi suite is invalid");
  return { manifest, version: manifest.version, suiteVersion: pins[0], packageRoot: root };
}

function regularArtifact(tarball) {
  const resolved = path.resolve(tarball);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("tarball must be a regular file");
  const physical = physicalPath(resolved);
  if (!pathsEqual(physical, resolved)) fail("tarball must be canonical");
  return physical;
}

export function hashArtifact(tarball) {
  const filename = regularArtifact(tarball);
  const sha256 = createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  return { tarball: filename, sha256 };
}

export function verifyArtifactIdentity({ tarball, expectedSha256 } = {}) {
  if (typeof tarball !== "string") fail("artifact verification requires a tarball");
  const artifact = hashArtifact(tarball);
  if (expectedSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(expectedSha256) || artifact.sha256 !== expectedSha256)) {
    fail("tarball SHA-256 does not match");
  }
  return artifact;
}

/** @param {any} options */
export function verifyRelease(options = {}) {
  const {
    mode,
    event,
    tag,
    tarball,
    expectedSha256,
    packageRoot,
    runtimeVerifier = verifyCompiledRuntime,
    artifactVerifier = verifyRuntimeArtifact,
    inspectArtifact = false,
    sourceIdentityCollector = collectCompilationIdentity,
  } = options;
  const source = verifyReleaseAdmission({ packageRoot, event, tag });
  const root = source.packageRoot;
  if (mode === "source") {
    if (tarball !== undefined || expectedSha256 !== undefined) fail("source mode does not accept artifact arguments");
    const runtime = runtimeVerifier({ packageRoot: root, checkSource: true });
    if (!runtime.ok) fail(`compiled runtime is not source-current (${runtime.category})`);
    return { ...source, runtime: runtime.manifest, packageRoot: root };
  }
  if (mode !== "artifact" || typeof tarball !== "string") fail("artifact mode requires a tarball");
  const artifact = verifyArtifactIdentity({ tarball, expectedSha256 });
  if (inspectArtifact) {
    artifactVerifier({
      archiveBytes: fs.readFileSync(artifact.tarball),
      expectedPackage: {
        name: source.manifest.name,
        version: source.manifest.version,
        type: source.manifest.type,
      },
      expectedSourceDigest: sourceIdentityCollector(root).sourceDigest,
      filePolicy: RELEASE_FILE_POLICY,
    });
  }
  return { ...source, ...artifact, packageRoot: root };
}

function parseCli(argv) {
  const [mode, ...rest] = argv;
  const values = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    const property = { "--event": "event", "--tag": "tag", "--tarball": "tarball", "--expected-sha256": "expectedSha256" }[key];
    if (!property || value === undefined || values[property] !== undefined) fail(USAGE);
    values[property] = value;
  }
  return values;
}

export function runVerifyReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    const values = parseCli(argv);
    const result = verifyRelease({ ...values, inspectArtifact: values.mode === "artifact" });
    output.log(JSON.stringify({ version: result.version, tarball: result.tarball, sha256: result.sha256 }));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Release verification failed");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runVerifyReleaseCli();
}
