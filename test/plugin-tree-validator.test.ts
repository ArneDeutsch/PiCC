import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindPrivateStagingParentForTrustedCode,
  discardMaterializedPluginTree,
  materializePluginTree as materializeWithCapability,
  type PrivateStagingParent,
} from "../src/plugin-lifecycle/tree-materializer.js";
import {
  PORTABLE_TREE_LIMITS,
  validatePluginTree,
  type PluginTreeEntry,
  type ValidatedPluginTree,
} from "../src/plugin-lifecycle/tree-validator.js";

const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");
const file = (entryPath: string, value = "content", executable = false): PluginTreeEntry => ({
  path: entryPath,
  kind: "file",
  data: bytes(value),
  executable,
});

function probeNativeLinks(): { readonly directoryAlias: boolean; readonly hardlink: boolean } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugin-link-probe-"));
  let directoryAlias = false;
  let hardlink = false;
  try {
    const directory = path.join(root, "directory");
    fs.mkdirSync(directory);
    try {
      const alias = path.join(root, "alias");
      fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
      directoryAlias = fs.lstatSync(alias).isSymbolicLink();
    } catch {}
    const source = path.join(root, "source");
    fs.writeFileSync(source, "inert");
    try {
      fs.linkSync(source, path.join(root, "hardlink"));
      hardlink = fs.statSync(source).nlink >= 2;
    } catch {}
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { directoryAlias, hardlink };
}

const nativeLinks = probeNativeLinks();

function validated(entries: readonly PluginTreeEntry[], root: Parameters<typeof validatePluginTree>[1] = { kind: "tree-root" }): ValidatedPluginTree {
  const result = validatePluginTree(entries, root);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function testCapability(parent: string): Promise<PrivateStagingParent> {
  const result = await bindPrivateStagingParentForTrustedCode(parent);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function materializePluginTree(plan: ValidatedPluginTree, parent: string) {
  return materializeWithCapability(plan, await testCapability(parent));
}

const temporaryRoots = new Set<string>();
function privateParent(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-plugin-tree-")));
  fs.chmodSync(root, 0o700);
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("portable plugin tree validation", () => {
  it.each([
    "/absolute", "\\rooted", "C:/drive", "C:drive", "//server/share", "\\\\server\\share",
    "\\?\\C:\\device", "../escape", "a/../escape", "a\\..\\escape", "./dot", "a//empty",
    "nul", "COM1.txt", "clock$", "trailing. ", "trailing.", "trailing ", "stream:payload",
    "bad<name", "bad>name", "bad\"name", "bad|name", "bad?name", "bad*name", "control\u0001name",
    "delete\u007fname", "control\u0085name", "control\u202ename", "unpaired\ud800name", "unpaired\udfffname",
  ])("rejects unsafe portable path %j", (entryPath) => {
    expect(validatePluginTree([file(entryPath)], { kind: "tree-root" }).ok).toBe(false);
  });

  it("accepts well-formed astral filenames", () => {
    expect(validatePluginTree([file("commands/launch-🚀.md")], { kind: "tree-root" }).ok).toBe(true);
  });

  it.each([
    ["POSIX exact", "same", "same"],
    ["Windows case-fold", "Docs/Readme.md", "docs/README.md"],
    ["macOS normalization", "caf\u00e9/file", "cafe\u0301/file"],
    ["multi-code-point case fold", "Straße/plugin.json", "STRASSE/plugin.json"],
    ["capital multi-code-point case fold", "ẞ/plugin.json", "SS/plugin.json"],
  ])("rejects %s aliases on every host", (_semantics, left, right) => {
    expect(validatePluginTree([file(left), file(right)], { kind: "tree-root" }).ok).toBe(false);
  });

  it("rejects file/directory prefix conflicts, implicit aliases, and duplicate entries", () => {
    expect(validatePluginTree([file("plugin"), file("plugin/manifest.json")], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([file("A/one"), file("a/two")], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([file("same"), file("same")], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([
      { path: "dir", kind: "directory" },
      { path: "dir", kind: "directory" },
    ], { kind: "tree-root" }).ok).toBe(false);
  });

  it.each(["symlink", "hardlink", "junction", "special"] as const)("rejects %s entries before materialization", (kind) => {
    expect(validatePluginTree([{ path: "unsafe", kind, target: "outside" }], { kind: "tree-root" }).ok).toBe(false);
  });

  it("rejects hostile and malformed metadata inertly", () => {
    expect(validatePluginTree([{ ...file("sparse"), sparse: true }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ path: "file", kind: "file" }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ path: "file", kind: "file", data: "not-bytes" as never }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ path: "file", kind: "file", data: bytes("x"), executable: "yes" as never }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ path: "dir", kind: "directory", data: bytes("no") }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ ...file("unknown"), unknown: true } as never], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([{ ...file("symbol"), [Symbol("hostile")]: true } as never], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([Object.assign(Object.create({ inherited: true }), file("prototype"))], { kind: "tree-root" }).ok).toBe(false);
    let accesses = 0;
    const accessor = { kind: "file", data: bytes("x"), get path() { accesses += 1; return "accessed"; } };
    expect(validatePluginTree([accessor as PluginTreeEntry], { kind: "tree-root" }).ok).toBe(false);
    expect(accesses).toBe(0);
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("hostile"); } });
    expect(() => validatePluginTree([hostile as PluginTreeEntry], { kind: "tree-root" })).not.toThrow();
    expect(validatePluginTree([hostile as PluginTreeEntry], { kind: "tree-root" }).ok).toBe(false);
  });

  it("accepts exact depth and UTF-8 path maxima and rejects plus one", () => {
    expect(validatePluginTree([file(`${"d/".repeat(PORTABLE_TREE_LIMITS.maximumDepth - 1)}f`)], { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([file(`${"d/".repeat(PORTABLE_TREE_LIMITS.maximumDepth)}f`)], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([file("x".repeat(PORTABLE_TREE_LIMITS.maximumPathBytes))], { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([file("x".repeat(PORTABLE_TREE_LIMITS.maximumPathBytes + 1))], { kind: "tree-root" }).ok).toBe(false);
    const multibyteMaximum = "é".repeat(PORTABLE_TREE_LIMITS.maximumPathBytes / 2);
    expect(Buffer.byteLength(multibyteMaximum, "utf8")).toBe(PORTABLE_TREE_LIMITS.maximumPathBytes);
    expect(validatePluginTree([file(multibyteMaximum)], { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([file(`${multibyteMaximum}x`)], { kind: "tree-root" }).ok).toBe(false);
  });

  it("accepts exact explicit and materialized entry maxima and rejects plus one", () => {
    const exactExplicit = Array.from({ length: PORTABLE_TREE_LIMITS.maximumEntries }, (_, index) => file(`f-${index}`, ""));
    expect(validatePluginTree(exactExplicit, { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([...exactExplicit, file("overflow", "")], { kind: "tree-root" }).ok).toBe(false);

    const exactExpanded = Array.from({ length: PORTABLE_TREE_LIMITS.maximumEntries / 2 }, (_, index) => file(`d-${index}/f`, ""));
    expect(validatePluginTree(exactExpanded, { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([...exactExpanded, file("d-0/g", "")], { kind: "tree-root" }).ok).toBe(false);
  });

  it("accepts exact file and total byte maxima and rejects plus one", () => {
    const maximumFile = new Uint8Array(PORTABLE_TREE_LIMITS.maximumFileBytes);
    expect(validatePluginTree([{ path: "maximum", kind: "file", data: maximumFile }], { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([{ path: "excessive", kind: "file", data: new Uint8Array(PORTABLE_TREE_LIMITS.maximumFileBytes + 1) }], { kind: "tree-root" }).ok).toBe(false);
    expect(validatePluginTree([
      { path: "one", kind: "file", data: maximumFile },
      { path: "two", kind: "file", data: maximumFile },
    ], { kind: "tree-root" }).ok).toBe(true);
    expect(validatePluginTree([
      { path: "one", kind: "file", data: maximumFile },
      { path: "two", kind: "file", data: maximumFile },
      { path: "three", kind: "file", data: new Uint8Array(1) },
    ], { kind: "tree-root" }).ok).toBe(false);
  });

  it("selects only validated directory roots from exact inert requests", () => {
    expect(validatePluginTree([file("packages/a/plugin.json")], {
      kind: "relative-subtree",
      path: "packages/a",
    }).ok).toBe(true);
    expect(validatePluginTree([file("packages/a/plugin.json")], {
      kind: "relative-subtree",
      path: "packages/missing",
    }).ok).toBe(false);
    expect(validatePluginTree([file("packages/a/plugin.json")], {
      kind: "relative-subtree",
      path: "packages/a/plugin.json",
    }).ok).toBe(false);
    expect(validatePluginTree([file("plugin.json")], {
      kind: "tree-root",
      extra: true,
    } as never).ok).toBe(false);
    let accesses = 0;
    const accessorRoot = { get kind() { accesses += 1; return "tree-root" as const; } };
    expect(validatePluginTree([file("plugin.json")], accessorRoot).ok).toBe(false);
    expect(accesses).toBe(0);
    expect(validatePluginTree([file("plugin.json")], Object.assign(Object.create({}), { kind: "tree-root" }) as never).ok).toBe(false);
    expect(validatePluginTree([file("plugin.json")], { kind: "tree-root", [Symbol("hostile")]: true } as never).ok).toBe(false);
  });
});

describe("canonical artifact identity", () => {
  it("is deterministic across input order and preserves executable identity", async () => {
    const parent = privateParent();
    const left = await materializePluginTree(validated([file("b", "two"), file("a", "one")]), parent);
    const right = await materializePluginTree(validated([file("a", "one"), file("b", "two")]), parent);
    const executable = await materializePluginTree(validated([file("a", "one", true), file("b", "two")]), parent);
    expect(left.ok && right.ok && executable.ok).toBe(true);
    if (!left.ok || !right.ok || !executable.ok) return;
    expect(left.value.treeDigest).toBe(right.value.treeDigest);
    expect(left.value.rootDigest).toBe(right.value.rootDigest);
    expect(executable.value.rootDigest).not.toBe(left.value.rootDigest);
  });

  it("makes tree and root digests content-sensitive", async () => {
    const parent = privateParent();
    const left = await materializePluginTree(validated([file("payload", "left")]), parent);
    const right = await materializePluginTree(validated([file("payload", "right")]), parent);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.value.treeDigest).not.toBe(right.value.treeDigest);
    expect(left.value.rootDigest).not.toBe(right.value.rootDigest);
    expect(left.value.rootSelection).toEqual({ requested: "tree-root", path: "", usedSingleWrapper: false });
    expect(left.value.pluginRoot).toBe(left.value.stagingDirectory);
  });

  it("exposes exact relative-subtree evidence only after materialization", async () => {
    const parent = privateParent();
    const subtreePlan = validated([file("packages/a/payload", "same"), file("outside", "ignored")], {
      kind: "relative-subtree", path: "packages/a",
    });
    const standalonePlan = validated([file("payload", "same")]);
    expect(Reflect.ownKeys(subtreePlan)).toEqual([]);
    expect(JSON.stringify(subtreePlan)).toBe("{}");
    const subtree = await materializePluginTree(subtreePlan, parent);
    const standalone = await materializePluginTree(standalonePlan, parent);
    expect(subtree.ok && standalone.ok).toBe(true);
    if (!subtree.ok || !standalone.ok) return;
    expect(subtree.value.pluginRoot).toBe(path.join(subtree.value.stagingDirectory, "packages", "a"));
    expect(subtree.value.rootSelection).toEqual({ requested: "relative-subtree", path: "packages/a", usedSingleWrapper: false });
    expect(subtree.value.rootDigest).toBe(standalone.value.rootDigest);
    expect(subtree.value.treeDigest).not.toBe(subtree.value.rootDigest);
  });

  it("applies the exact ZIP root-or-single-wrapper marker rule", async () => {
    const parent = privateParent();
    const unwrapped = await materializePluginTree(validated([
      file(".claude-plugin/plugin.json", "{}"), file("commands/hello.md", "hello"),
    ], { kind: "root-or-single-wrapper" }), parent);
    const wrapped = await materializePluginTree(validated([
      file("package/.claude-plugin/plugin.json", "{}"), file("package/commands/hello.md", "hello"),
    ], { kind: "root-or-single-wrapper" }), parent);
    expect(unwrapped.ok && wrapped.ok).toBe(true);
    if (!unwrapped.ok || !wrapped.ok) return;
    expect(unwrapped.value.rootSelection).toEqual({ requested: "root-or-single-wrapper", path: "", usedSingleWrapper: false });
    expect(wrapped.value.rootSelection).toEqual({ requested: "root-or-single-wrapper", path: "package", usedSingleWrapper: true });
    expect(unwrapped.value.rootDigest).toBe(wrapped.value.rootDigest);
    expect(unwrapped.value.treeDigest).not.toBe(wrapped.value.treeDigest);

    expect(validatePluginTree([
      file("package/.claude-plugin/plugin.json"), file("sibling.txt"),
    ], { kind: "root-or-single-wrapper" }).ok).toBe(false);
    expect(validatePluginTree([file("package/plugin.json")], { kind: "root-or-single-wrapper" }).ok).toBe(false);
    expect(validatePluginTree([file("outer/package/.claude-plugin/plugin.json")], { kind: "root-or-single-wrapper" }).ok).toBe(false);
  });
});

describe("private staging materialization", () => {
  it("writes only cloned validated bytes into a fresh inactive staging child", async () => {
    const parent = privateParent();
    const source = bytes("original");
    const plan = validated([{ path: "bin/run", kind: "file", data: source, executable: true }]);
    source.fill(0);
    const result = await materializePluginTree(plan, parent);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(path.dirname(result.value.stagingDirectory)).toBe(path.resolve(parent));
    expect(path.basename(result.value.stagingDirectory)).toMatch(/^\.picc-staging-/);
    expect(fs.readFileSync(path.join(result.value.pluginRoot, "bin", "run"), "utf8")).toBe("original");
  });

  it("rejects forged plans, arbitrary strings, and forged staging capabilities", async () => {
    const parent = privateParent();
    const capability = await testCapability(parent);
    expect((await materializeWithCapability({} as ValidatedPluginTree, capability)).ok).toBe(false);
    expect((await materializeWithCapability(validated([file("safe")]), parent as never)).ok).toBe(false);
    expect((await materializeWithCapability(validated([file("safe")]), {} as PrivateStagingParent)).ok).toBe(false);
    expect(fs.readdirSync(parent).filter((name) => name.startsWith(".picc-staging-"))).toEqual([]);
  });

  it("binds canonical identity without claiming the binder verifies privacy", async () => {
    const parent = privateParent();
    const ordinary = path.join(parent, "ordinary");
    fs.mkdirSync(ordinary, { mode: 0o777 });
    if (process.platform !== "win32") fs.chmodSync(ordinary, 0o777);
    expect((await bindPrivateStagingParentForTrustedCode(ordinary)).ok).toBe(true);
    expect((await bindPrivateStagingParentForTrustedCode(path.join(parent, "missing"))).ok).toBe(false);
  });

  it("revalidates the bound canonical filesystem identity before writing", async () => {
    const parent = privateParent();
    const bound = path.join(parent, "bound");
    fs.mkdirSync(bound);
    const capability = await testCapability(bound);
    fs.renameSync(bound, `${bound}.old`);
    fs.mkdirSync(bound);
    expect((await materializeWithCapability(validated([file("payload")]), capability)).ok).toBe(false);
    expect(fs.readdirSync(bound)).toEqual([]);
  });

  it.skipIf(!nativeLinks.directoryAlias)("rejects an aliased private staging parent", async () => {
    const parent = privateParent();
    const realParent = path.join(parent, "real-private");
    const aliasParent = path.join(parent, "alias-private");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    expect((await bindPrivateStagingParentForTrustedCode(aliasParent)).ok).toBe(false);
  });

  it.skipIf(!nativeLinks.directoryAlias)("rejects a statically injected destination symlink without touching its outside canary or retaining staging", async () => {
    const parent = privateParent();
    const outside = path.join(parent, "outside");
    fs.mkdirSync(outside);
    const canary = path.join(outside, "canary");
    fs.writeFileSync(canary, "untouched");
    const originalMkdir = fs.promises.mkdir.bind(fs.promises);
    vi.spyOn(fs.promises, "mkdir").mockImplementation(async (directory, options) => {
      const result = await originalMkdir(directory, options);
      if (path.basename(String(directory)) === "alias") {
        fs.rmdirSync(String(directory));
        fs.symlinkSync(outside, String(directory), process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    });
    const result = await materializePluginTree(validated([file("alias/canary", "changed")]), parent);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(canary, "utf8")).toBe("untouched");
    expect(fs.readdirSync(parent).filter((name) => name.startsWith(".picc-staging-"))).toEqual([]);
  });

  it.skipIf(!nativeLinks.hardlink)("rejects an injected destination hardlink before an exclusive write and preserves the canary", async () => {
    const parent = privateParent();
    const canary = path.join(parent, "canary");
    fs.writeFileSync(canary, "untouched");
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (destination, flags, mode) => {
      fs.linkSync(canary, String(destination));
      return originalOpen(destination, flags, mode);
    });
    const result = await materializePluginTree(validated([file("payload", "changed")]), parent);
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(canary, "utf8")).toBe("untouched");
    expect(fs.readdirSync(parent).filter((name) => name.startsWith(".picc-staging-"))).toEqual([]);
  });

  it("discards only the exact issued materialized staging identity", async () => {
    const parent = privateParent();
    const issued = await materializePluginTree(validated([file("payload")]), parent);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(await discardMaterializedPluginTree(issued.value)).toEqual({ removed: true, inactive: true, uncertain: false });
    expect(fs.existsSync(issued.value.stagingDirectory)).toBe(false);
    expect(await discardMaterializedPluginTree(issued.value)).toEqual({ removed: false, inactive: true, uncertain: true });
  });

  it("retains replacement content when discard identity is uncertain", async () => {
    const parent = privateParent();
    const issued = await materializePluginTree(validated([file("payload")]), parent);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    fs.renameSync(issued.value.stagingDirectory, `${issued.value.stagingDirectory}.old`);
    fs.mkdirSync(issued.value.stagingDirectory);
    const canary = path.join(issued.value.stagingDirectory, "replacement");
    fs.writeFileSync(canary, "untouched");
    expect(await discardMaterializedPluginTree(issued.value)).toEqual({ removed: false, inactive: true, uncertain: true });
    expect(fs.readFileSync(canary, "utf8")).toBe("untouched");
  });

  it("removes staging after an ordinary materialization failure", async () => {
    const parent = privateParent();
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation(async (destination, flags, mode) => {
      if (String(destination).includes(".picc-staging-")) throw new Error("injected ordinary failure");
      return originalOpen(destination, flags, mode);
    });
    expect((await materializePluginTree(validated([file("payload")]), parent)).ok).toBe(false);
    expect(fs.readdirSync(parent).filter((name) => name.startsWith(".picc-staging-"))).toEqual([]);
  });

  it("fails boundedly and leaves an inactive quarantine when staging identity changes", async () => {
    const parent = privateParent();
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    let replacement = "";
    vi.spyOn(fs.promises, "readdir").mockImplementation((async (directory: fs.PathLike, options?: unknown) => {
      const staging = String(directory);
      if (replacement.length === 0 && path.basename(staging).startsWith(".picc-staging-")) {
        fs.renameSync(staging, `${staging}.old`);
        fs.mkdirSync(staging, { mode: 0o700 });
        replacement = staging;
      }
      return originalReaddir(directory, options as never);
    }) as never);
    const result = await materializePluginTree(validated([file("payload")]), parent);
    expect(result.ok).toBe(false);
    expect(replacement).not.toBe("");
    expect(fs.existsSync(replacement)).toBe(true);
  });
});
