import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PermissionEngine, matchesRule } from "../src/engine/permissions.js";
import type { PermissionRules, ToolCallDescriptor } from "../src/types.js";

/**
 * Regression tests for the permissions review findings (research 02 §7):
 * - Edit rules gate ALL file-modification tools (Write/MultiEdit/NotebookEdit),
 * - path-rule anchoring is stable (settings root, not the drifting session cwd),
 * - process-wrapper stripping for Bash deny prefix rules,
 * - parameter-matching rule forms (Agent(model:opus), Bash(run_in_background:true)),
 * - bare-tool deny removes the tool in gateTools,
 * - symlink resolution for deny path rules,
 * - ~/ and // anchor forms + portable backslash coverage.
 */

const ROOT = path.resolve("proj");
const isWindows = process.platform === "win32";

function call(
  tool: string,
  input: Record<string, unknown> = {},
  cwd: string = ROOT,
): ToolCallDescriptor {
  return { tool, input, cwd };
}

function bash(command: string, extra: Record<string, unknown> = {}): ToolCallDescriptor {
  return call("Bash", { command, ...extra });
}

function rules(partial: Partial<PermissionRules>): PermissionRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], ...partial };
}

function denyEngine(deny: string[], opts: { cwd?: string; root?: string } = {}): PermissionEngine {
  return new PermissionEngine(rules({ deny }), { cwd: opts.cwd ?? ROOT, ...opts });
}

// ---------------------------------------------------------------------------
// 1. Edit rules gate all file-modification tools
// ---------------------------------------------------------------------------

describe("Edit rules gate all file-modification tools", () => {
  const engine = denyEngine(["Edit(secrets/**)"]);

  it("deny Edit(glob) blocks Write on a matching path", () => {
    expect(engine.evaluate(call("Write", { file_path: "secrets/creds.json" }))).toEqual({
      decision: "deny",
      rule: "Edit(secrets/**)",
    });
  });

  it("deny Edit(glob) blocks NotebookEdit and MultiEdit on a matching path", () => {
    expect(
      engine.evaluate(call("NotebookEdit", { notebook_path: "secrets/nb.ipynb" })).decision,
    ).toBe("deny");
    expect(engine.evaluate(call("MultiEdit", { file_path: "secrets/a.txt" })).decision).toBe(
      "deny",
    );
  });

  it("deny Edit(glob) does not gate Read, and non-matching paths pass", () => {
    expect(engine.evaluate(call("Read", { file_path: "secrets/creds.json" })).decision).toBe(
      "default",
    );
    expect(engine.evaluate(call("Write", { file_path: "public/x.md" })).decision).toBe("default");
  });

  it("a bare Edit deny blocks Write calls too", () => {
    expect(denyEngine(["Edit"]).evaluate(call("Write", { file_path: "a.txt" })).decision).toBe(
      "deny",
    );
  });

  it("the expansion is one-directional: a Write rule does not gate Edit calls", () => {
    expect(matchesRule("Write(docs/**)", call("Edit", { file_path: "docs/x.md" }))).toBe(false);
    expect(matchesRule("Write(docs/**)", call("Write", { file_path: "docs/x.md" }))).toBe(true);
  });

  it("direct NotebookEdit/MultiEdit rules match as path rules", () => {
    expect(matchesRule("NotebookEdit(nb/**)", call("NotebookEdit", { notebook_path: "nb/a.ipynb" }))).toBe(true);
    expect(matchesRule("MultiEdit(src/**)", call("MultiEdit", { file_path: "src/a.ts" }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Stable path-rule anchoring (no cwd drift)
// ---------------------------------------------------------------------------

describe("path-rule anchoring stays on the settings root when the call cwd drifts", () => {
  const worktree = path.join(ROOT, ".claude", "worktrees", "w1");

  it("deny Read(/secrets/**) still blocks an absolute-path read from a worktree cwd", () => {
    const engine = denyEngine(["Read(/secrets/**)"]);
    const c = call("Read", { file_path: path.join(ROOT, "secrets", "key.pem") }, worktree);
    expect(engine.evaluate(c)).toEqual({ decision: "deny", rule: "Read(/secrets/**)" });
  });

  it("deny Read(secrets/**) (relative form) also survives cwd drift", () => {
    const engine = denyEngine(["Read(secrets/**)"]);
    const c = call("Read", { file_path: path.join(ROOT, "secrets", "key.pem") }, worktree);
    expect(engine.evaluate(c).decision).toBe("deny");
  });

  it("deny direction also covers the drifted cwd itself (relative input in a worktree)", () => {
    const engine = denyEngine(["Read(secrets/**)"]);
    const c = call("Read", { file_path: "secrets/key.pem" }, worktree);
    expect(engine.evaluate(c).decision).toBe("deny");
  });

  it("unrelated paths stay default after drift", () => {
    const engine = denyEngine(["Read(secrets/**)"]);
    expect(engine.evaluate(call("Read", { file_path: "docs/readme.md" }, worktree)).decision).toBe(
      "default",
    );
  });

  it("opts.root anchors rules to the project root when the session launched in a subdir", () => {
    const subdir = path.join(ROOT, "packages", "app");
    const engine = new PermissionEngine(rules({ deny: ["Edit(/dist/**)"] }), {
      cwd: subdir,
      root: ROOT,
    });
    const c = call("Edit", { file_path: path.join(ROOT, "dist", "bundle.js") }, subdir);
    expect(engine.evaluate(c).decision).toBe("deny");
  });

  it("allow/ask rules anchor to the root too", () => {
    const subdir = path.join(ROOT, "packages", "app");
    const engine = new PermissionEngine(rules({ allow: ["Read(/docs/**)"] }), {
      cwd: subdir,
      root: ROOT,
    });
    const c = call("Read", { file_path: path.join(ROOT, "docs", "a.md") }, subdir);
    expect(engine.evaluate(c).decision).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 3. Process-wrapper stripping for Bash rules
// ---------------------------------------------------------------------------

describe("Bash process-wrapper stripping", () => {
  const engine = denyEngine(["Bash(curl *)"]);

  it.each([
    "timeout 5 curl http://evil",
    "timeout -k 3 5s curl http://evil",
    "nohup curl http://evil",
    "nice -n 10 curl http://evil",
    "nice curl http://evil",
    "time curl http://evil",
    "stdbuf -oL curl http://evil",
    "stdbuf -o L curl http://evil",
    "env curl http://evil",
    "env FOO=1 curl http://evil",
    "env -i FOO=1 BAR=2 curl http://evil",
    "xargs curl -s http://evil",
    "nohup timeout 5 curl http://evil",
    "git status && nohup curl http://evil",
  ])("deny Bash(curl *) blocks %j", (command) => {
    expect(engine.evaluate(bash(command)).decision).toBe("deny");
  });

  it("wrappers are only stripped at segment start", () => {
    expect(engine.evaluate(bash("echo nohup curl http://x")).decision).toBe("default");
    expect(engine.evaluate(bash("curlish http://x")).decision).toBe("default");
  });

  it("xargs with options is not treated as a bare wrapper", () => {
    expect(engine.evaluate(bash("xargs -I{} curl {}")).decision).toBe("default");
  });

  it("the raw (unstripped) form still matches wrapper-targeted rules", () => {
    expect(denyEngine(["Bash(timeout *)"]).evaluate(bash("timeout 5 sleep 1")).decision).toBe(
      "deny",
    );
  });

  it("allow direction strips wrappers per segment but stays every-segment", () => {
    expect(matchesRule("Bash(git *)", bash("timeout 5 git status"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("timeout 5 git status && rm -rf /"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Parameter-matching rule forms
// ---------------------------------------------------------------------------

describe("parameter-matching rule forms (Tool(key:value))", () => {
  it("Agent(isolation:worktree) denies worktree-isolated dispatch only", () => {
    const engine = denyEngine(["Agent(isolation:worktree)"]);
    expect(
      engine.evaluate(call("Agent", { subagent_type: "Explore", isolation: "worktree" })).decision,
    ).toBe("deny");
    expect(engine.evaluate(call("Agent", { subagent_type: "Explore" })).decision).toBe("default");
    expect(
      engine.evaluate(call("Agent", { subagent_type: "Explore", isolation: "none" })).decision,
    ).toBe("default");
    // Task is the same tool under its old name.
    expect(engine.evaluate(call("Task", { isolation: "worktree" })).decision).toBe("deny");
  });

  it("Agent(model:opus) matches the model param; * wildcard allowed", () => {
    expect(matchesRule("Agent(model:opus)", call("Agent", { model: "opus" }))).toBe(true);
    expect(matchesRule("Agent(model:opus)", call("Agent", { model: "haiku" }))).toBe(false);
    expect(matchesRule("Agent(model:*)", call("Agent", { model: "haiku" }))).toBe(true);
    expect(matchesRule("Agent(model:*)", call("Agent", { subagent_type: "Explore" }))).toBe(false);
  });

  it("Bash(run_in_background:true) matches the boolean input param", () => {
    const engine = denyEngine(["Bash(run_in_background:true)"]);
    expect(engine.evaluate(bash("sleep 100", { run_in_background: true })).decision).toBe("deny");
    expect(engine.evaluate(bash("sleep 100", { run_in_background: false })).decision).toBe(
      "default",
    );
    expect(engine.evaluate(bash("sleep 100")).decision).toBe("default");
  });

  it("canonical fields are not matchable via the param form", () => {
    // `command` is canonical: this must fall through to (and fail) Bash matching.
    expect(matchesRule("Bash(command:foo)", bash("foo"))).toBe(false);
    // Legacy prefix form is unaffected (`git` is not an input field).
    expect(matchesRule("Bash(git:*)", bash("git push origin"))).toBe(true);
    // WebFetch(domain:...) keeps its own semantics.
    expect(
      matchesRule("WebFetch(domain:example.com)", call("WebFetch", { url: "https://example.com/" })),
    ).toBe(true);
  });

  it("never throws on weird param values", () => {
    expect(() =>
      matchesRule("Agent(model:opus)", call("Agent", { model: { nested: true } })),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. gateTools honors bare-tool deny rules
// ---------------------------------------------------------------------------

describe("gateTools removes bare-tool-denied tools from context", () => {
  const known = ["Bash", "Read", "Edit", "Write", "NotebookEdit", "WebFetch", "mcp__github__create_issue"];

  it("a bare deny removes the tool; a scoped deny leaves it (per-call block instead)", () => {
    const engine = denyEngine(["WebFetch", "Bash(rm *)"]);
    const gated = engine.gateTools(undefined, undefined, known);
    expect(gated).not.toContain("WebFetch");
    expect(gated).toContain("Bash");
  });

  it("a bare Edit deny removes all file-editing tools, matching call-time expansion", () => {
    const gated = denyEngine(["Edit"]).gateTools(undefined, undefined, known);
    expect(gated).not.toContain("Edit");
    expect(gated).not.toContain("Write");
    expect(gated).not.toContain("NotebookEdit");
    expect(gated).toContain("Read");
    expect(gated).toContain("Bash");
  });

  it("a bare mcp__server deny removes the server's tools", () => {
    expect(denyEngine(["mcp__github"]).gateTools(undefined, undefined, known)).not.toContain(
      "mcp__github__create_issue",
    );
  });

  it("no deny rules → unchanged behavior", () => {
    expect(denyEngine([]).gateTools(undefined, undefined, known)).toEqual(known);
  });
});

// ---------------------------------------------------------------------------
// 6. Symlink resolution for deny path rules
// ---------------------------------------------------------------------------

describe("symlink deny semantics", () => {
  let symRoot: string | undefined;
  let canLink = false;
  try {
    symRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picc-perm-")));
    fs.mkdirSync(path.join(symRoot, "secrets"), { recursive: true });
    fs.writeFileSync(path.join(symRoot, "secrets", "key.pem"), "k");
    // "junction" avoids the Windows symlink privilege requirement; the type
    // argument is ignored on other platforms.
    fs.symlinkSync(path.join(symRoot, "secrets"), path.join(symRoot, "aliased"), "junction");
    canLink = true;
  } catch {
    // Environment cannot create symlinks — the gated tests below are skipped.
  }
  afterAll(() => {
    if (symRoot) fs.rmSync(symRoot, { recursive: true, force: true });
  });

  it.runIf(canLink)("a deny path rule fires on a symlinked alias of a denied dir", () => {
    const engine = denyEngine(["Read(secrets/**)"], { cwd: symRoot! });
    const c = call("Read", { file_path: "aliased/key.pem" }, symRoot!);
    expect(engine.evaluate(c)).toEqual({ decision: "deny", rule: "Read(secrets/**)" });
  });

  it.runIf(canLink)("non-deny matching stays literal (no symlink resolution)", () => {
    const c = call("Read", { file_path: "aliased/key.pem" }, symRoot!);
    expect(matchesRule("Read(secrets/**)", c)).toBe(false);
  });

  it("nonexistent paths degrade gracefully to literal matching", () => {
    const engine = denyEngine(["Read(secrets/**)"]);
    expect(
      engine.evaluate(call("Read", { file_path: "secrets/definitely-missing.txt" })).decision,
    ).toBe("deny");
    expect(
      engine.evaluate(call("Read", { file_path: "elsewhere/definitely-missing.txt" })).decision,
    ).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// 7. Anchor forms: ~/, //, drive-absolute, portable backslashes
// ---------------------------------------------------------------------------

describe("anchor forms", () => {
  it("~/ anchors to the home directory", () => {
    const fakeHome = path.join(ROOT, "home");
    const savedHome = process.env["HOME"];
    process.env["HOME"] = fakeHome;
    try {
      const inside = call("Read", { file_path: path.join(fakeHome, "secrets", "k.pem") });
      const outside = call("Read", { file_path: path.join(ROOT, "secrets", "k.pem") });
      expect(matchesRule("Read(~/secrets/**)", inside)).toBe(true);
      expect(matchesRule("Read(~/secrets/**)", outside)).toBe(false);
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
    }
  });

  it.runIf(!isWindows)("// anchors to the filesystem root (true absolute)", () => {
    expect(matchesRule("Edit(//tmp/**)", call("Edit", { file_path: "/tmp/x.txt" }))).toBe(true);
    expect(matchesRule("Edit(//tmp/**)", call("Edit", { file_path: "/var/tmp/x.txt" }))).toBe(
      false,
    );
  });

  it.runIf(isWindows)("drive-absolute patterns anchor to the drive root on Windows", () => {
    const absDir = path.resolve("/picc-abs-test");
    const pattern = absDir.replace(/\\/g, "/");
    const c = call("Edit", { file_path: path.join(absDir, "a.txt") });
    expect(matchesRule(`Edit(${pattern}/**)`, c)).toBe(true);
    expect(matchesRule(`Edit(${pattern}/**)`, call("Edit", { file_path: "a.txt" }))).toBe(false);
  });

  it("a //-anchored pattern never matches a project-relative path", () => {
    expect(matchesRule("Read(//secrets/**)", call("Read", { file_path: "secrets/x" }))).toBe(
      false,
    );
  });

  it("backslash input paths match forward-slash globs on every platform", () => {
    expect(matchesRule("Read(src/**)", call("Read", { file_path: "src\\deep\\y.ts" }))).toBe(true);
    expect(matchesRule("Read(other/**)", call("Read", { file_path: "src\\deep\\y.ts" }))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// Never-throw floor
// ---------------------------------------------------------------------------

describe("engine never throws", () => {
  it("survives malformed inputs and rules", () => {
    const engine = new PermissionEngine(
      rules({ deny: ["Edit(secrets/**", "Agent(model:opus)", "Bash(curl *)"] }),
      { cwd: ROOT },
    );
    expect(() => engine.evaluate(call("Write", { file_path: 123 as unknown as string }))).not.toThrow();
    expect(() => engine.evaluate(bash("", { run_in_background: Symbol("x") as unknown as boolean }))).not.toThrow();
    expect(() =>
      engine.evaluate({ tool: "Read", input: null as unknown as Record<string, unknown>, cwd: "" }),
    ).not.toThrow();
  });
});
