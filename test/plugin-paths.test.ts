import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  authorizePluginRoot,
  resolvePluginDataLocation,
  resolvePluginPath,
  revalidatePluginDataLocation,
  revalidatePluginPath,
  sanitizePluginDataKey,
  walkPluginFiles,
  type AuthorizedPluginRoot,
  type ClaudeUserDirectory,
  type PluginDataLocation,
  type ValidatedPluginPath,
} from "../src/claude/plugin-paths.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = "picc-plugin-paths-"): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function makeRoot(): { parent: string; rootPath: string; root: AuthorizedPluginRoot } {
  const parent = temporaryDirectory();
  const rootPath = path.join(parent, "plugin");
  fs.mkdirSync(rootPath);
  const result = authorizePluginRoot(rootPath);
  expect(result.ok).toBe(true);
  return { parent, rootPath, root: result.ok ? result.value : undefined as never };
}

function resolve(
  root: AuthorizedPluginRoot,
  declaredPath: string,
  kind: "file" | "directory" | "either" = "file",
  inputKind: "explicit" | "generated" = "explicit",
) {
  return resolvePluginPath({ root, declaredPath, inputKind, kind });
}

const directoryLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugin-link-probe-"));
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

const fileLinkProbe = (() => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugin-file-link-probe-"));
  try {
    const target = path.join(parent, "target");
    fs.writeFileSync(target, "probe");
    fs.symlinkSync(target, path.join(parent, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
})();

function directoryLink(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

function fileLink(target: string, link: string): void {
  fs.symlinkSync(target, link, "file");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(() => {
  expect(temporaryDirectories).toHaveLength(0);
});

describe("installed root authorization", () => {
  it("requires native fully-qualified absolute syntax before filesystem lookup", () => {
    const existing = temporaryDirectory("picc-plugin-native-root-");
    expect(authorizePluginRoot(existing)).toMatchObject({ ok: true });

    const parent = temporaryDirectory("picc-plugin-relative-root-");
    fs.mkdirSync(path.join(parent, "existing"));
    const previous = process.cwd();
    try {
      process.chdir(parent);
      expect(fs.existsSync("existing")).toBe(true);
      expect(authorizePluginRoot("existing")).toMatchObject({ ok: false, code: "invalid-path" });
      expect(authorizePluginRoot(`.${path.sep}existing`)).toMatchObject({ ok: false, code: "invalid-path" });
      expect(authorizePluginRoot(`..${path.sep}${path.basename(parent)}`)).toMatchObject({ ok: false, code: "invalid-path" });
    } finally {
      process.chdir(previous);
    }

    const invalid = process.platform === "win32"
      ? [
          "\\rooted", "/rooted", "C:relative", "//server/share",
          "\\\\?\\C:\\device", "\\\\.\\C:\\device", "\\??\\C:\\nt", "\\\\??\\C:\\nt",
          "//?/C:/device", "//./C:/device", "/??/C:/nt", "//??/C:/nt",
          "\\GLOBALROOT\\Device", "\\\\GLOBALROOT\\Device", "/GLOBALROOT/Device", "//GLOBALROOT/Device",
        ]
      : ["C:\\foreign", "C:/foreign", "\\\\server\\share", "\\\\?\\C:\\device", "\\??\\C:\\nt", "//server/share"];
    for (const spelling of invalid) {
      expect(authorizePluginRoot(spelling)).toMatchObject({ ok: false, code: "invalid-path" });
    }
  });

  it.skipIf(process.platform !== "win32")("accepts a valid native UNC root without network lookup", () => {
    const rootPath = "\\\\server\\share";
    const lexicalPath = path.normalize(rootPath);
    const realpath = vi.spyOn(fs.realpathSync, "native").mockReturnValue(lexicalPath);
    const stat = vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => false,
      isDirectory: () => true,
    } as fs.Stats);
    try {
      expect(authorizePluginRoot(rootPath)).toMatchObject({
        ok: true,
        value: { lexicalPath, canonicalPath: lexicalPath },
      });
      expect(realpath).toHaveBeenCalledWith(lexicalPath);
      expect(stat).toHaveBeenCalledWith(lexicalPath);
    } finally {
      realpath.mockRestore();
      stat.mockRestore();
    }
  });

  it("classifies root lookup and kind failures without fallback", () => {
    expect(authorizePluginRoot("")).toMatchObject({ ok: false, code: "invalid-path" });
    expect(authorizePluginRoot("bad\0root")).toMatchObject({ ok: false, code: "invalid-path" });
    const parent = temporaryDirectory("picc-plugin-root-errors-");
    expect(authorizePluginRoot(path.join(parent, "missing"))).toMatchObject({ ok: false, code: "unreadable-path" });
    const file = path.join(parent, "file");
    fs.writeFileSync(file, "not a directory");
    expect(authorizePluginRoot(file)).toMatchObject({ ok: false, code: "wrong-kind" });
  });

  it("does not cwd-resolve an existing foreign-named directory", () => {
    const parent = temporaryDirectory("picc-plugin-foreign-root-");
    const foreignName = process.platform === "win32" ? "rooted" : "C:\\foreign";
    fs.mkdirSync(path.join(parent, foreignName));
    const previous = process.cwd();
    try {
      process.chdir(parent);
      const spelling = process.platform === "win32" ? `\\${foreignName}` : foreignName;
      expect(fs.existsSync(foreignName)).toBe(true);
      expect(authorizePluginRoot(spelling)).toMatchObject({ ok: false, code: "invalid-path" });
    } finally {
      process.chdir(previous);
    }
  });
});

describe("opaque plugin path capabilities", () => {
  it("does not accept structurally matching plain objects", () => {
    expectTypeOf<{ lexicalPath: string; canonicalPath: string }>().not.toExtend<AuthorizedPluginRoot>();
    expectTypeOf<{
      root: AuthorizedPluginRoot;
      inputKind: "explicit";
      declaredPath: string;
      relativePath: string;
      lexicalPath: string;
      canonicalPath: string;
      kind: "file";
    }>().not.toExtend<ValidatedPluginPath>();
    expectTypeOf<{
      qualifiedIdentity: string;
      key: string;
      collisionToken: string;
      userDir: ClaudeUserDirectory;
      lexicalBasePath: string;
      canonicalBasePath: string;
      lexicalPath: string;
      canonicalPath: string;
    }>().not.toExtend<PluginDataLocation>();
    expectTypeOf<PluginDataLocation["userDir"]>().not.toExtend<AuthorizedPluginRoot>();
    expectTypeOf<PluginDataLocation["userDir"]>().not.toExtend<Parameters<typeof resolvePluginPath>[0]["root"]>();
    expectTypeOf<PluginDataLocation["userDir"]>().not.toExtend<Parameters<typeof walkPluginFiles>[0]["directory"]>();
  });
});

describe("portable plugin path syntax", () => {
  it("accepts explicit and internally generated relative paths, including the explicit root", () => {
    const { rootPath, root } = makeRoot();
    fs.mkdirSync(path.join(rootPath, "skills", "nested"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "skills", "nested", "SKILL.md"), "body");
    fs.writeFileSync(path.join(rootPath, "SKILL.md"), "root body");

    expect(resolve(root, "./skills/nested/SKILL.md")).toMatchObject({
      ok: true,
      value: { kind: "file", relativePath: path.join("skills", "nested", "SKILL.md") },
    });
    expect(resolve(root, "skills/nested", "directory", "generated")).toMatchObject({
      ok: true,
      value: { kind: "directory" },
    });
    expect(resolve(root, "./", "directory")).toMatchObject({ ok: true, value: { relativePath: "", kind: "directory" } });
    expect(resolve(root, "./", "either")).toMatchObject({ ok: true, value: { relativePath: "", kind: "directory" } });
    expect(resolve(root, "./", "file")).toMatchObject({ ok: false, code: "wrong-kind" });
    expect(resolve(root, "", "directory", "generated")).toMatchObject({ ok: false, code: "invalid-path" });
    const walkedRoot = resolve(root, "./", "directory");
    expect(walkedRoot.ok && walkPluginFiles({
      directory: walkedRoot.value,
      predicate: (name) => name === "SKILL.md",
    }).files.map((file) => file.relativePath)).toEqual([
      "SKILL.md",
      path.join("skills", "nested", "SKILL.md"),
    ]);
  });

  it.each([
    ["empty", ""],
    ["NUL", "./a\0b"],
    ["missing explicit marker", "skills"],
    ["POSIX absolute", "/etc/passwd"],
    ["parent traversal", "./skills/../secret"],
    ["mixed-separator traversal", "./skills\\..\\secret"],
    ["rooted Windows", "\\Windows\\system.ini"],
    ["drive absolute", "C:\\Windows\\system.ini"],
    ["drive relative", "C:secret.txt"],
    ["UNC", "\\\\server\\share\\secret"],
    ["device namespace", "\\\\?\\C:\\secret"],
    ["NT namespace", "\\??\\C:\\secret"],
    ["ADS", "./safe.txt:stream"],
    ["Windows wildcard", "./safe/*.md"],
    ["Windows forbidden punctuation", "./safe/a|b"],
    ["Windows control character", "./safe/a\u0001b"],
    ["reserved device", "./con.txt"],
    ["reserved nested device", "./safe/LPT9.log"],
    ["trailing dot", "./unsafe./file"],
    ["trailing space", "./unsafe /file"],
    ["repeated separator", "./safe//file"],
    ["repeated trailing separator", "./safe//"],
    ["embedded current segment", "./safe/./file"],
  ])("rejects %s syntax on every host", (_label, declaredPath) => {
    const { root } = makeRoot();
    expect(resolve(root, declaredPath)).toMatchObject({ ok: false, code: "invalid-path" });
  });

  it.each([
    ["empty", ""],
    ["NUL", "a\0b"],
    ["parent traversal", "skills/../secret"],
    ["mixed traversal", "skills\\..\\secret"],
    ["POSIX absolute", "/etc/passwd"],
    ["rooted Windows", "\\Windows\\system.ini"],
    ["drive absolute", "C:\\Windows\\system.ini"],
    ["drive relative", "C:secret"],
    ["UNC", "\\\\server\\share\\secret"],
    ["device", "\\\\?\\C:\\secret"],
    ["NT namespace", "\\??\\C:\\secret"],
    ["current segment", "skills/./file"],
    ["explicit marker", "./skills/file"],
    ["repeated separator", "skills//file"],
    ["ADS", "skills/file:stream"],
    ["reserved device", "skills/CON.md"],
    ["trailing dot", "skills/name."],
    ["trailing space", "skills/name "],
  ])("rejects generated %s syntax", (_label, declaredPath) => {
    const { root } = makeRoot();
    expect(resolve(root, declaredPath, "either", "generated")).toMatchObject({ ok: false, code: "invalid-path" });
  });

  it("validates existence and every requested path kind", () => {
    const { rootPath, root } = makeRoot();
    fs.mkdirSync(path.join(rootPath, "folder"));
    fs.writeFileSync(path.join(rootPath, "file.md"), "x");

    expect(resolve(root, "./missing.md")).toMatchObject({ ok: false, code: "unreadable-path" });
    expect(resolve(root, "./folder", "file")).toMatchObject({ ok: false, code: "wrong-kind" });
    expect(resolve(root, "./file.md", "directory")).toMatchObject({ ok: false, code: "wrong-kind" });
    expect(resolve(root, "./folder", "either")).toMatchObject({ ok: true, value: { kind: "directory" } });
    expect(resolve(root, "./file.md", "either")).toMatchObject({ ok: true, value: { kind: "file" } });
  });

  it.runIf(directoryLinkProbe)("does not confuse a sibling-prefix path with containment", () => {
    const parent = temporaryDirectory();
    const rootPath = path.join(parent, "plugin");
    const sibling = path.join(parent, "plugin-evil");
    fs.mkdirSync(rootPath);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "secret.md"), "secret");
    const root = authorizePluginRoot(rootPath);
    expect(root.ok).toBe(true);
    if (!root.ok) return;

    directoryLink(sibling, path.join(rootPath, "alias"));
    expect(resolve(root.value, "./alias/secret.md")).toMatchObject({ ok: false, code: "path-escape" });
  });

  it("uses native host case semantics", () => {
    const { rootPath, root } = makeRoot();
    fs.writeFileSync(path.join(rootPath, "Case.md"), "x");
    const result = resolve(root, "./case.md");
    expect(result.ok).toBe(fs.existsSync(path.join(rootPath, "case.md")));
  });
});

describe.runIf(directoryLinkProbe)("canonical directory links and deferred reads", () => {
  it("canonicalizes a linked root and rejects deterministic root retargeting", () => {
    const parent = temporaryDirectory();
    const first = path.join(parent, "first");
    const second = path.join(parent, "second");
    const linkedRoot = path.join(parent, "installed");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "file.md"), "first");
    fs.writeFileSync(path.join(second, "file.md"), "second");
    directoryLink(first, linkedRoot);

    const root = authorizePluginRoot(linkedRoot);
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    const source = resolve(root.value, "./file.md");
    expect(source.ok).toBe(true);
    fs.rmSync(linkedRoot, { recursive: true, force: true });
    directoryLink(second, linkedRoot);
    expect(source.ok && revalidatePluginPath(source.value)).toMatchObject({ ok: false, code: "changed-path" });
  });

  it("accepts contained links, rejects escaping and broken links, and records canonical metadata", () => {
    const { parent, rootPath, root } = makeRoot();
    const inside = path.join(rootPath, "inside");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, "ok.md"), "ok");
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    directoryLink(inside, path.join(rootPath, "inside-link"));
    directoryLink(outside, path.join(rootPath, "outside-link"));
    const broken = path.join(rootPath, "broken");
    directoryLink(path.join(parent, "absent"), broken);

    const contained = resolve(root, "./inside-link/ok.md");
    expect(contained).toMatchObject({ ok: true, value: { lexicalPath: path.join(rootPath, "inside-link", "ok.md") } });
    expect(contained.ok && contained.value.canonicalPath).toBe(path.join(inside, "ok.md"));
    expect(resolve(root, "./outside-link/secret.md")).toMatchObject({ ok: false, code: "path-escape" });
    expect(resolve(root, "./broken", "directory")).toMatchObject({ ok: false, code: "unreadable-path" });
  });

  it("revalidates lazy sources close to use and rejects a retargeted directory link", () => {
    const { parent, rootPath, root } = makeRoot();
    const first = path.join(rootPath, "first");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(first);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(first, "SKILL.md"), "safe");
    fs.writeFileSync(path.join(outside, "SKILL.md"), "unsafe");
    const alias = path.join(rootPath, "lazy");
    directoryLink(first, alias);
    const source = resolve(root, "./lazy/SKILL.md");
    expect(source.ok).toBe(true);
    fs.rmSync(alias, { recursive: true, force: true });
    directoryLink(outside, alias);

    expect(source.ok && revalidatePluginPath(source.value)).toMatchObject({ ok: false, code: "path-escape" });
  });
});

describe.runIf(fileLinkProbe)("canonical file links and deferred reads", () => {
  it("accepts contained file links and rejects escaping and broken links", () => {
    const { parent, rootPath, root } = makeRoot();
    const inside = path.join(rootPath, "inside.md");
    const outside = path.join(parent, "outside.md");
    fs.writeFileSync(inside, "inside");
    fs.writeFileSync(outside, "outside");
    fileLink(inside, path.join(rootPath, "contained.md"));
    fileLink(outside, path.join(rootPath, "escaping.md"));
    fileLink(path.join(parent, "absent.md"), path.join(rootPath, "broken.md"));

    const contained = resolve(root, "./contained.md");
    expect(contained).toMatchObject({
      ok: true,
      value: {
        root,
        inputKind: "explicit",
        declaredPath: "./contained.md",
        relativePath: "contained.md",
        lexicalPath: path.join(rootPath, "contained.md"),
        canonicalPath: inside,
      },
    });
    expect(resolve(root, "./escaping.md")).toMatchObject({ ok: false, code: "path-escape" });
    expect(resolve(root, "./broken.md")).toMatchObject({ ok: false, code: "unreadable-path" });
  });

  it("pins outside retargets as escapes and different contained targets as changed paths", () => {
    const { parent, rootPath, root } = makeRoot();
    const first = path.join(rootPath, "first.md");
    const second = path.join(rootPath, "second.md");
    const outside = path.join(parent, "outside.md");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    fs.writeFileSync(outside, "outside");
    const alias = path.join(rootPath, "lazy.md");
    fileLink(first, alias);
    const source = resolve(root, "./lazy.md");
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    fs.rmSync(alias);
    fileLink(outside, alias);
    expect(revalidatePluginPath(source.value)).toMatchObject({ ok: false, code: "path-escape" });

    fs.rmSync(alias);
    fileLink(second, alias);
    expect(revalidatePluginPath(source.value)).toMatchObject({ ok: false, code: "changed-path" });
    expect(source.value).toMatchObject({ declaredPath: "./lazy.md", lexicalPath: alias, canonicalPath: first });
  });
});

describe("contained plugin walker", () => {
  it("returns validated file sources in deterministic order", () => {
    const { rootPath, root } = makeRoot();
    fs.mkdirSync(path.join(rootPath, "skills", "b"), { recursive: true });
    fs.mkdirSync(path.join(rootPath, "skills", "a"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "skills", "b", "SKILL.md"), "b");
    fs.writeFileSync(path.join(rootPath, "skills", "a", "SKILL.md"), "a");
    fs.writeFileSync(path.join(rootPath, "skills", "a", "other.txt"), "x");
    const directory = resolve(root, "./skills", "directory");
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    const walked = walkPluginFiles({ directory: directory.value, predicate: (name) => name === "SKILL.md" });
    expect(walked.failures).toEqual([]);
    expect(walked.diagnostics).toEqual([]);
    expect(walked.files.map((file) => file.relativePath)).toEqual([
      path.join("skills", "a", "SKILL.md"),
      path.join("skills", "b", "SKILL.md"),
    ]);
    expect(walked.files.every((file) => revalidatePluginPath(file).ok)).toBe(true);
  });

  it("diagnoses depth exhaustion and malformed limits deterministically", () => {
    const { rootPath, root } = makeRoot();
    fs.mkdirSync(path.join(rootPath, "tree", "at", "over"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, "tree", "root.md"), "root");
    fs.writeFileSync(path.join(rootPath, "tree", "at", "at.md"), "at");
    fs.writeFileSync(path.join(rootPath, "tree", "at", "over", "over.md"), "over");
    const directory = resolve(root, "./tree", "directory");
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    const walked = walkPluginFiles({ directory: directory.value, maxDepth: 1 });
    expect(walked.files.map((file) => path.basename(file.lexicalPath))).toEqual(["at.md", "root.md"]);
    expect(walked.failures).toEqual([
      expect.objectContaining({
        code: "walk-failure",
        diagnostic: expect.objectContaining({
          message: "Plugin directory content was skipped because it exceeds maximum traversal depth 1",
          source: path.join(rootPath, "tree", "at", "over"),
        }),
      }),
    ]);
    expect(walked.diagnostics).toEqual(walked.failures.map((item) => item.diagnostic));
    for (const maxDepth of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(walkPluginFiles({ directory: directory.value, maxDepth }).diagnostics)
        .toEqual([expect.objectContaining({ message: expect.stringContaining("non-negative safe integer") })]);
    }
  });

  it.skipIf(process.platform === "win32")("omits portable-invalid native file and directory names", () => {
    const { rootPath, root } = makeRoot();
    fs.writeFileSync(path.join(rootPath, "CON.md"), "reserved");
    fs.writeFileSync(path.join(rootPath, "colon:name.md"), "colon");
    fs.writeFileSync(path.join(rootPath, "literal\\backslash.md"), "backslash");
    fs.mkdirSync(path.join(rootPath, "trailing."));
    fs.writeFileSync(path.join(rootPath, "trailing.", "hidden.md"), "hidden");
    fs.writeFileSync(path.join(rootPath, "valid.md"), "valid");
    const directory = resolve(root, "./", "directory");
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    const walked = walkPluginFiles({ directory: directory.value });
    expect(walked.files.map((file) => file.relativePath)).toEqual(["valid.md"]);
    expect(walked.failures.map((item) => [item.code, item.diagnostic.source])).toEqual([
      ["invalid-path", path.join(rootPath, "CON.md")],
      ["invalid-path", path.join(rootPath, "colon:name.md")],
      ["invalid-path", path.join(rootPath, "literal\\backslash.md")],
      ["invalid-path", path.join(rootPath, "trailing.")],
    ]);
    expect(walked.diagnostics).toEqual(walked.failures.map((item) => item.diagnostic));
  });

  it.runIf(process.platform !== "win32" && directoryLinkProbe)("retains deterministic mixed typed failures in diagnostic order", () => {
    const { parent, rootPath, root } = makeRoot();
    const outside = path.join(parent, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    fs.writeFileSync(path.join(rootPath, "CON.md"), "reserved");
    directoryLink(path.join(parent, "missing"), path.join(rootPath, "a-broken"));
    directoryLink(outside, path.join(rootPath, "b-escape"));
    directoryLink(rootPath, path.join(rootPath, "c-loop"));
    fs.mkdirSync(path.join(rootPath, "d-deep"));
    fs.writeFileSync(path.join(rootPath, "d-deep", "skipped.md"), "skipped");
    fs.writeFileSync(path.join(rootPath, "z-safe.md"), "safe");
    const directory = resolve(root, "./", "directory");
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    const walked = walkPluginFiles({ directory: directory.value, maxDepth: 0 });
    expect(walked.files.map((file) => file.relativePath)).toEqual(["z-safe.md"]);
    expect(walked.failures.map((item) => [item.code, item.diagnostic.source])).toEqual([
      ["invalid-path", path.join(rootPath, "CON.md")],
      ["unreadable-path", path.join(rootPath, "a-broken")],
      ["path-escape", path.join(rootPath, "b-escape")],
      ["walk-failure", path.join(rootPath, "c-loop")],
      ["walk-failure", path.join(rootPath, "d-deep")],
    ]);
    expect(walked.diagnostics).toEqual(walked.failures.map((item) => item.diagnostic));
  });

  it.runIf(directoryLinkProbe)("omits nested escaping descendants and link loops with diagnostics", () => {
    const { parent, rootPath, root } = makeRoot();
    const skills = path.join(rootPath, "skills");
    const nested = path.join(skills, "nested");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(nested, "safe.md"), "safe");
    fs.writeFileSync(path.join(outside, "secret.md"), "secret");
    directoryLink(outside, path.join(nested, "escape"));
    directoryLink(skills, path.join(nested, "loop"));
    const directory = resolve(root, "./skills", "directory");
    expect(directory.ok).toBe(true);
    if (!directory.ok) return;

    const walked = walkPluginFiles({ directory: directory.value });
    expect(walked.files.map((file) => path.basename(file.lexicalPath))).toEqual(["safe.md"]);
    expect(walked.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(/outside|loop|duplicate/);
  });
});

describe("qualified plugin data locations", () => {
  it("preserves Claude case while exposing punctuation and case-folded collisions", () => {
    expect(sanitizePluginDataKey("Plugin.Name@Market")).toBe("Plugin-Name-Market");
    expect(sanitizePluginDataKey("a.b@c")).toBe(sanitizePluginDataKey("a-b@c"));
    expect(sanitizePluginDataKey("safe_Name-1@market")).toBe("safe_Name-1-market");
    const userDir = temporaryDirectory("picc-plugin-collision-");
    const dotted = resolvePluginDataLocation(userDir, "Plugin.Name@Market");
    const dashed = resolvePluginDataLocation(userDir, "Plugin-Name@market");
    expect(dotted).toMatchObject({ ok: true, value: { key: "Plugin-Name-Market", collisionToken: "plugin-name-market" } });
    expect(dashed).toMatchObject({ ok: true, value: { key: "Plugin-Name-market", collisionToken: "plugin-name-market" } });
  });

  it("enforces the portable 255-character data-key boundary before user-directory lookup", () => {
    const userDir = temporaryDirectory("picc-plugin-key-length-");
    expect(resolvePluginDataLocation(userDir, `${"a".repeat(253)}@m`)).toMatchObject({ ok: true });
    const overlongIdentity = `${"a".repeat(254)}@m`;
    expect(resolvePluginDataLocation(userDir, overlongIdentity)).toMatchObject({
      ok: false,
      code: "invalid-path",
      diagnostic: { message: expect.stringContaining("at most 255 ASCII characters") },
    });
    expect(resolvePluginDataLocation(path.join(userDir, "unavailable"), overlongIdentity)).toMatchObject({
      ok: false,
      code: "invalid-path",
      diagnostic: { message: expect.stringContaining("at most 255 ASCII characters") },
    });
  });

  it("returns a typed lazy location beneath the user data base and revalidates it", () => {
    const userDir = temporaryDirectory("picc-plugin-user-");
    expect(resolvePluginDataLocation(userDir, "unqualified")).toMatchObject({ ok: false, code: "invalid-path" });
    const result = resolvePluginDataLocation(userDir, "plugin.name@market");
    expect(result).toMatchObject({
      ok: true,
      value: {
        key: "plugin-name-market",
        lexicalBasePath: path.join(userDir, "plugins", "data"),
        lexicalPath: path.join(userDir, "plugins", "data", "plugin-name-market"),
      },
    });
    expect(result.ok && revalidatePluginDataLocation(result.value)).toMatchObject({ ok: true });
  });

  it("names Claude user/data directories in root and projection failures", () => {
    expect(resolvePluginDataLocation("relative-user", "plugin@market")).toMatchObject({
      ok: false,
      diagnostic: { message: expect.stringContaining("Claude user directory") },
    });
    const userDir = temporaryDirectory("picc-plugin-data-diagnostic-");
    fs.mkdirSync(path.join(userDir, "plugins"));
    fs.writeFileSync(path.join(userDir, "plugins", "data"), "not a directory");
    expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({
      ok: false,
      code: "wrong-kind",
      diagnostic: { message: expect.stringContaining("plugin data path") },
    });
  });

  it.each(["plugins", path.join("plugins", "data"), path.join("plugins", "data", "plugin-market")])(
    "rejects a file at generated directory component %s",
    (component) => {
      const userDir = temporaryDirectory("picc-plugin-data-kind-");
      fs.mkdirSync(path.dirname(path.join(userDir, component)), { recursive: true });
      fs.writeFileSync(path.join(userDir, component), "file");
      expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({ ok: false, code: "wrong-kind" });
    },
  );

  it.runIf(directoryLinkProbe)("accepts contained existing links and ancestors", () => {
    const userDir = temporaryDirectory("picc-plugin-data-contained-");
    const actualPlugins = path.join(userDir, "actual-plugins");
    const actualData = path.join(actualPlugins, "data");
    const actualKey = path.join(actualData, "actual-key");
    fs.mkdirSync(actualKey, { recursive: true });
    directoryLink(actualPlugins, path.join(userDir, "plugins"));
    directoryLink(actualKey, path.join(actualData, "plugin-market"));
    expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({
      ok: true,
      value: { canonicalBasePath: actualData, canonicalPath: actualKey },
    });
  });

  it.runIf(directoryLinkProbe)("rejects broken data links", () => {
    const userDir = temporaryDirectory("picc-plugin-data-broken-");
    fs.mkdirSync(path.join(userDir, "plugins"));
    directoryLink(path.join(userDir, "absent"), path.join(userDir, "plugins", "data"));
    expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({ ok: false, code: "unreadable-path" });
  });

  it.runIf(directoryLinkProbe)("rejects existing data-base and identity links that escape", () => {
    const parent = temporaryDirectory("picc-plugin-data-");
    const userDir = path.join(parent, "user");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.mkdirSync(outside);
    directoryLink(outside, path.join(userDir, "plugins", "data"));
    expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({ ok: false, code: "path-escape" });

    fs.rmSync(path.join(userDir, "plugins", "data"), { recursive: true, force: true });
    fs.mkdirSync(path.join(userDir, "plugins", "data"));
    directoryLink(outside, path.join(userDir, "plugins", "data", "plugin-market"));
    expect(resolvePluginDataLocation(userDir, "plugin@market")).toMatchObject({ ok: false, code: "path-escape" });
  });

  it.runIf(directoryLinkProbe)("pins contained-to-contained data retargeting as a changed path", () => {
    const userDir = temporaryDirectory("picc-plugin-data-contained-retarget-");
    const dataBase = path.join(userDir, "plugins", "data");
    const first = path.join(dataBase, "first");
    const second = path.join(dataBase, "second");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second);
    const locationPath = path.join(dataBase, "plugin-market");
    directoryLink(first, locationPath);
    const location = resolvePluginDataLocation(userDir, "plugin@market");
    expect(location.ok).toBe(true);
    fs.rmSync(locationPath, { recursive: true, force: true });
    directoryLink(second, locationPath);
    expect(location.ok && revalidatePluginDataLocation(location.value)).toMatchObject({ ok: false, code: "changed-path" });
  });

  it.runIf(directoryLinkProbe)("rejects deterministic data-location retargeting on deferred use", () => {
    const parent = temporaryDirectory("picc-plugin-data-retarget-");
    const userDir = path.join(parent, "user");
    const dataBase = path.join(userDir, "plugins", "data");
    const contained = path.join(dataBase, "actual");
    const outside = path.join(parent, "outside");
    fs.mkdirSync(contained, { recursive: true });
    fs.mkdirSync(outside);
    const locationPath = path.join(dataBase, "plugin-market");
    directoryLink(contained, locationPath);
    const location = resolvePluginDataLocation(userDir, "plugin@market");
    expect(location.ok).toBe(true);
    fs.rmSync(locationPath, { recursive: true, force: true });
    directoryLink(outside, locationPath);

    expect(location.ok && revalidatePluginDataLocation(location.value)).toMatchObject({ ok: false, code: "path-escape" });
  });
});
