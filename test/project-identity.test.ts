import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalDirectory, projectIdentities } from "../src/util/project-identity.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-project-identity-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const directoryLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-project-identity-link-probe-"));
  try {
    const target = path.join(parent, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(parent, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})();

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function createLinkedMetadata(name: string): { main: string; linked: string } {
  const main = path.join(root, `${name}-main`);
  const linked = path.join(root, `${name}-linked`);
  const admin = path.join(main, ".git", "worktrees", name);
  fs.mkdirSync(linked, { recursive: true });
  write(path.join(linked, ".git"), `gitdir: ${admin}`);
  write(path.join(admin, "gitdir"), path.join(linked, ".git"));
  write(path.join(admin, "commondir"), "../..");
  return { main, linked };
}

function replaceMetadata(file: string, content: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function padMetadata(content: string, bytes: number): string {
  const valid = content.trimEnd();
  return valid + " ".repeat(bytes - Buffer.byteLength(valid));
}

describe("canonicalDirectory", () => {
  it("classifies canonical directories, definite non-candidates, and indeterminate failures", () => {
    const directory = path.join(root, "directory");
    const file = path.join(root, "file");
    fs.mkdirSync(directory);
    fs.writeFileSync(file, "file");

    expect(canonicalDirectory(directory)).toEqual({ kind: "canonical", path: fs.realpathSync.native(directory) });
    expect(canonicalDirectory(path.join(root, "missing"))).toEqual({ kind: "non-candidate", reason: "missing" });
    expect(canonicalDirectory(file)).toEqual({ kind: "non-candidate", reason: "not-directory" });
    expect(canonicalDirectory(path.join(file, "child"), {
      realpath: () => {
        const error = new Error("injected child of file");
        Object.assign(error, { code: "ENOTDIR" });
        throw error;
      },
    })).toEqual({ kind: "non-candidate", reason: "not-directory" });
    expect(canonicalDirectory(directory, {
      realpath: () => {
        const error = new Error("injected private path");
        Object.assign(error, { code: "EACCES" });
        throw error;
      },
    })).toEqual({ kind: "indeterminate" });
  });
});

describe("projectIdentities", () => {
  it("returns the canonical active checkout as the ordered primary identity outside a linked worktree", () => {
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    expect(projectIdentities(project)).toEqual([fs.realpathSync.native(project)]);
  });

  it.skipIf(!directoryLinkProbe)("uses native filesystem identity for directory-link and junction spellings", () => {
    const project = path.join(root, "project");
    const link = path.join(root, "project-link");
    fs.mkdirSync(project);
    fs.symlinkSync(project, link, process.platform === "win32" ? "junction" : "dir");
    expect(projectIdentities(link)).toEqual(projectIdentities(project));
  });

  it("puts a verified main checkout first and rejects copied, forged, malformed, and oversized metadata", () => {
    const main = path.join(root, "main");
    const linked = path.join(root, "linked");
    fs.mkdirSync(main);
    execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: main });
    write(path.join(main, "tracked.txt"), "tracked");
    execFileSync("git", ["add", "."], { cwd: main });
    execFileSync("git", ["-c", "user.name=Test", "commit", "-m", "fixture"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "linked-test", linked], { cwd: main, stdio: "ignore" });

    const expected = [fs.realpathSync.native(main), fs.realpathSync.native(linked)];
    expect(projectIdentities(linked)).toEqual(expected);
    const pointerFile = path.join(linked, ".git");
    const pointer = fs.readFileSync(pointerFile, "utf8");
    const admin = pointer.replace(/^gitdir:\s*/i, "").trim();
    for (const file of [pointerFile, path.join(admin, "gitdir"), path.join(admin, "commondir")]) {
      const original = fs.readFileSync(file, "utf8");
      replaceMetadata(file, padMetadata(original, 16 * 1024));
      expect(projectIdentities(linked)).toEqual(expected);
      replaceMetadata(file, padMetadata(original, 16 * 1024 + 1));
      expect(projectIdentities(linked)).toEqual([fs.realpathSync.native(linked)]);
      replaceMetadata(file, original);
    }

    const copied = path.join(root, "copied");
    fs.mkdirSync(copied);
    fs.copyFileSync(path.join(linked, ".git"), path.join(copied, ".git"));
    expect(projectIdentities(copied)).toEqual([fs.realpathSync.native(copied)]);

    const forged = path.join(root, "forged");
    const foreignAdmin = path.join(root, "foreign", "worktrees", "forged");
    fs.mkdirSync(forged);
    write(path.join(forged, ".git"), `gitdir: ${foreignAdmin}`);
    write(path.join(foreignAdmin, "gitdir"), path.join(forged, ".git"));
    write(path.join(foreignAdmin, "commondir"), path.relative(foreignAdmin, path.join(main, ".git")));
    expect(projectIdentities(forged)).toEqual([fs.realpathSync.native(forged)]);

    const malformed = path.join(root, "malformed");
    fs.mkdirSync(malformed);
    write(path.join(malformed, ".git"), "gitdir: missing-admin");
    expect(projectIdentities(malformed)).toEqual([fs.realpathSync.native(malformed)]);
  });

  it("does not read non-regular metadata and rejects a non-regular opened descriptor", () => {
    const precheck = createLinkedMetadata("precheck");
    const nonRegular = path.join(precheck.main, ".git", "worktrees", "precheck", "gitdir");
    const openFiles = new Map<number, string>();
    let nonRegularOpens = 0;
    let nonRegularReads = 0;
    expect(projectIdentities(precheck.linked, {
      stat: (value) => value === nonRegular
        ? { isFile: () => false } as fs.Stats
        : fs.statSync(value),
      open: (value) => {
        if (value === nonRegular) nonRegularOpens += 1;
        const fd = fs.openSync(value, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        openFiles.set(fd, value);
        return fd;
      },
      read: (fd, buffer, offset, length, position) => {
        if (openFiles.get(fd) === nonRegular) nonRegularReads += 1;
        return fs.readSync(fd, buffer, offset, length, position);
      },
      close: (fd) => {
        openFiles.delete(fd);
        fs.closeSync(fd);
      },
    })).toEqual([fs.realpathSync.native(precheck.linked)]);
    expect({ nonRegularOpens, nonRegularReads }).toEqual({ nonRegularOpens: 0, nonRegularReads: 0 });

    const revalidation = createLinkedMetadata("revalidation");
    let reads = 0;
    expect(projectIdentities(revalidation.linked, {
      fstat: () => ({ isFile: () => false }) as fs.Stats,
      read: () => {
        reads += 1;
        throw new Error("rejected descriptors must not be read");
      },
    })).toEqual([fs.realpathSync.native(revalidation.linked)]);
    expect(reads).toBe(0);
  });

  it("drops the linked-main candidate when closing an otherwise successful bounded read fails", () => {
    const fixture = createLinkedMetadata("close-failure");
    let closes = 0;
    let reads = 0;
    expect(projectIdentities(fixture.linked, {
      read: (fd, buffer, offset, length, position) => {
        reads += 1;
        return fs.readSync(fd, buffer, offset, length, position);
      },
      close: (fd) => {
        fs.closeSync(fd);
        closes += 1;
        throw new Error("injected close failure");
      },
    })).toEqual([fs.realpathSync.native(fixture.linked)]);
    expect(reads).toBeGreaterThan(0);
    expect(closes).toBe(1);
  });

  it.skipIf(process.platform === "win32")("preserves POSIX case distinctions", () => {
    const upper = path.join(root, "Project");
    const lower = path.join(root, "project");
    fs.mkdirSync(upper);
    fs.mkdirSync(lower);
    expect(projectIdentities(upper)).not.toEqual(projectIdentities(lower));
  });

  it.skipIf(process.platform !== "win32")("normalizes Windows case, drive, separator, and junction variants through native identity", () => {
    const project = path.join(root, "MiXeD", "PrOjEcT");
    fs.mkdirSync(project, { recursive: true });
    const oppositeComponents = path.join(root, "mIxEd", "pRoJeCt");
    const alternate = oppositeComponents
      .replace(/^[a-z]:/i, (drive) => `${drive[0] === drive[0]!.toUpperCase() ? drive[0]!.toLowerCase() : drive[0]!.toUpperCase()}:`)
      .replaceAll("\\", "/");
    expect(projectIdentities(alternate)).toEqual(projectIdentities(project));
  });
});
