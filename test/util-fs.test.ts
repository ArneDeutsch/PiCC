import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseJsonSafe, readTextSafe, stripBom, walkFiles } from "../src/util/fs.js";

const BOM = "﻿";

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("BOM handling (Windows Notepad / PowerShell 5.1 files)", () => {
  it("stripBom removes a leading U+FEFF only", () => {
    expect(stripBom(`${BOM}{"a":1}`)).toBe('{"a":1}');
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom("")).toBe("");
    // Only the leading BOM is touched.
    expect(stripBom(`x${BOM}y`)).toBe(`x${BOM}y`);
  });

  it("readTextSafe strips a UTF-8 BOM from disk files", () => {
    const dir = mkTmp("picc-bom-");
    try {
      const file = path.join(dir, "settings.json");
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]));
      const text = readTextSafe(file);
      expect(text).toBe('{"ok":true}');
      expect(JSON.parse(text!)).toEqual({ ok: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseJsonSafe accepts BOM-prefixed JSON (plugin.json/hooks.json shape)", () => {
    expect(parseJsonSafe(`${BOM}{"name":"p"}`)).toEqual({ name: "p" });
    expect(parseJsonSafe('{"name":"p"}')).toEqual({ name: "p" });
    expect(parseJsonSafe(`${BOM}not json`)).toBeUndefined();
    expect(parseJsonSafe(undefined)).toBeUndefined();
  });
});

describe("walkFiles symlink/junction traversal", () => {
  const canSymlinkDir = (dir: string): boolean => {
    // Junctions work without privileges on Windows; plain symlinks on POSIX.
    const target = path.join(dir, "cap-target");
    const link = path.join(dir, "cap-link");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, link, "junction");
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(link, { recursive: true, force: true });
      fs.rmSync(target, { recursive: true, force: true });
    }
  };

  it("follows symlinked directories (junctions on Windows)", () => {
    const dir = mkTmp("picc-walk-");
    try {
      if (!canSymlinkDir(dir)) return; // environment cannot create links; skip
      const shared = path.join(dir, "shared-skills");
      fs.mkdirSync(path.join(shared, "my-skill"), { recursive: true });
      fs.writeFileSync(path.join(shared, "my-skill", "SKILL.md"), "---\nname: s\n---\n");
      const root = path.join(dir, "root");
      fs.mkdirSync(root);
      fs.symlinkSync(shared, path.join(root, "linked"), "junction");

      const found = walkFiles(root, (name) => name === "SKILL.md");
      expect(found.length).toBe(1);
      expect(found[0]).toContain("linked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is cycle-safe and does not duplicate files reachable twice", () => {
    const dir = mkTmp("picc-walk-cycle-");
    try {
      if (!canSymlinkDir(dir)) return;
      const root = path.join(dir, "root");
      fs.mkdirSync(path.join(root, "real"), { recursive: true });
      fs.writeFileSync(path.join(root, "real", "RULE.md"), "x");
      // Cycle: link inside the tree pointing back at the root...
      fs.symlinkSync(root, path.join(root, "real", "loop"), "junction");
      // ...and a second link to an already-visited directory.
      fs.symlinkSync(path.join(root, "real"), path.join(root, "real2"), "junction");

      const found = walkFiles(root, (name) => name === "RULE.md");
      expect(found.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips broken symlinks without throwing", () => {
    const dir = mkTmp("picc-walk-broken-");
    try {
      if (!canSymlinkDir(dir)) return;
      const root = path.join(dir, "root");
      fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, "keep.md"), "x");
      const gone = path.join(dir, "gone");
      fs.mkdirSync(gone);
      fs.symlinkSync(gone, path.join(root, "dangling"), "junction");
      fs.rmdirSync(gone);

      const found = walkFiles(root, (name) => name.endsWith(".md"));
      expect(found.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
