import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalPath,
  deduplicatePhysicalPaths,
  isPathInside,
  pathComponentEquals,
  pathIdentity,
  pathsEqual,
  physicalPath,
} from "../bin/picc-admin.mjs";

const temporary: string[] = [];

function temp(prefix: string): string {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

describe("physical path identity", () => {
  it("keeps native filesystem spelling separate from comparison identity", () => {
    const root = temp("picc-path-identity-");
    const directory = path.join(root, "Native-Spelling");
    fs.mkdirSync(directory);

    expect(physicalPath(directory)).toBe(fs.realpathSync.native(directory));
    expect(canonicalPath(directory)).toBe(physicalPath(directory));
    expect(pathIdentity("C:\\Native-Spelling\\File.mjs", "win32"))
      .toBe("c:\\native-spelling\\file.mjs");
    expect(pathIdentity("/Native-Spelling/File.mjs", "linux"))
      .toBe("/Native-Spelling/File.mjs");
    expect(() => pathIdentity("relative/path", "linux")).toThrow(/physical absolute path/);
  });

  it("compares aliases by platform without changing the retained physical value", () => {
    const first = "C:\\Program Files\\PiCC\\bin\\picc.mjs";
    const alias = "c:\\PROGRAM FILES\\picc\\BIN\\PICC.MJS";
    expect(pathsEqual(first, alias, "win32")).toBe(true);
    expect(pathsEqual("/opt/PiCC", "/opt/picc", "linux")).toBe(false);
    expect(pathComponentEquals("NODE_MODULES", "node_modules", "win32")).toBe(true);
    expect(pathComponentEquals("NODE_MODULES", "node_modules", "linux")).toBe(false);
    expect(deduplicatePhysicalPaths([first, alias, "D:\\PiCC"], "win32"))
      .toEqual([first, "D:\\PiCC"]);
  });

  it("uses relative containment and rejects siblings, escapes, drives, and UNC roots", () => {
    expect(isPathInside("C:\\Work\\PiCC", "c:\\work", "win32")).toBe(true);
    expect(isPathInside("C:\\Work\\PiCC", "C:\\Worker", "win32")).toBe(false);
    expect(isPathInside("C:\\escape", "C:\\Work", "win32")).toBe(false);
    expect(isPathInside("D:\\Work\\PiCC", "C:\\Work", "win32")).toBe(false);
    expect(isPathInside("\\\\server\\share\\PiCC", "\\\\server\\share", "win32")).toBe(true);
    expect(isPathInside("\\\\other\\share\\PiCC", "\\\\server\\share", "win32")).toBe(false);
    expect(isPathInside("/work/picc", "/work", "linux")).toBe(true);
    expect(isPathInside("/work-escape/picc", "/work", "linux")).toBe(false);
  });

  it("resolves symlink aliases before containment and deduplication", () => {
    const root = temp("picc-path-alias-");
    const parent = path.join(root, "parent");
    const target = path.join(root, "outside");
    fs.mkdirSync(parent);
    fs.mkdirSync(target);
    const alias = path.join(parent, "alias");
    fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");

    const physicalParent = physicalPath(parent);
    const physicalTarget = physicalPath(target);
    const physicalAlias = physicalPath(alias);
    expect(physicalAlias).toBe(physicalTarget);
    expect(isPathInside(physicalAlias, physicalParent)).toBe(false);
    expect(deduplicatePhysicalPaths([physicalTarget, physicalAlias])).toEqual([physicalTarget]);
  });

  it.skipIf(process.platform !== "win32")("returns native mixed-case spelling for a real Windows alias", () => {
    const root = temp("picc-path-native-case-");
    const mixed = path.join(root, "MiXeD-Directory");
    fs.mkdirSync(mixed);
    const alias = path.join(root, "mixed-directory");
    const physical = physicalPath(alias);
    expect(physical).toBe(fs.realpathSync.native(alias));
    expect(path.basename(physical)).toBe("MiXeD-Directory");
    expect(pathsEqual(physical, alias)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("keeps real case-distinct filesystem paths separate", () => {
    const root = temp("picc-path-native-case-");
    const upper = path.join(root, "Case");
    const lower = path.join(root, "case");
    fs.mkdirSync(upper);
    fs.mkdirSync(lower);
    expect(pathsEqual(physicalPath(upper), physicalPath(lower))).toBe(false);
    expect(deduplicatePhysicalPaths([physicalPath(upper), physicalPath(lower)])).toHaveLength(2);
  });
});
