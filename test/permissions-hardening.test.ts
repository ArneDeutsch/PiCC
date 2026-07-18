import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PermissionEngine, evaluateIfCondition, matchesRule } from "../src/engine/permissions.js";
import type { PermissionRules, ToolCallDescriptor } from "../src/types.js";

/**
 * Regression tests for the permissions review findings:
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

  it("a path-scoped NotebookRead rule routes through pathSpecifierMatches", () => {
    // The real NotebookRead reader shares Read's trust boundary, so a
    // NotebookRead(<glob>) rule must match on notebook_path (in the glob) and
    // NOT match one outside it — proving the new matchesRule switch case.
    expect(matchesRule("NotebookRead(nb/**)", call("NotebookRead", { notebook_path: "nb/a.ipynb" }))).toBe(true);
    expect(matchesRule("NotebookRead(nb/**)", call("NotebookRead", { notebook_path: "other/a.ipynb" }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1b. Read rules gate all file-read tools (mirrors the Edit family)
// ---------------------------------------------------------------------------

describe("Read rules gate all file-read tools", () => {
  const engine = denyEngine(["Read(secrets/**)"]);

  it("deny Read(glob) blocks Grep on a matching path", () => {
    expect(engine.evaluate(call("Grep", { path: "secrets/x" }))).toEqual({
      decision: "deny",
      rule: "Read(secrets/**)",
    });
  });

  it("deny Read(glob) blocks Glob and NotebookRead on a matching path", () => {
    expect(engine.evaluate(call("Glob", { path: "secrets/sub" })).decision).toBe("deny");
    expect(
      engine.evaluate(call("NotebookRead", { notebook_path: "secrets/nb.ipynb" })).decision,
    ).toBe("deny");
  });

  it("deny Read(glob) does not gate Write/NotebookEdit, and non-matching paths pass", () => {
    // A non-matching Grep path stays default.
    expect(engine.evaluate(call("Grep", { path: "src" })).decision).toBe("default");
    // Whole-file/cell writers stay ungated: Write and NotebookEdit do not read
    // the result back, so a Read deny leaves them untouched (Claude v2.1.208).
    expect(engine.evaluate(call("Write", { file_path: "secrets/creds.json" })).decision).toBe(
      "default",
    );
    expect(
      engine.evaluate(call("NotebookEdit", { notebook_path: "secrets/nb.ipynb" })).decision,
    ).toBe("default");
    // Edit/MultiEdit, by contrast, ARE gated by a path-scoped Read deny — see
    // section 1c below.
  });

  it("the expansion is one-directional: read-family rules do not gate Read", () => {
    expect(matchesRule("Grep(secrets/**)", call("Read", { file_path: "secrets/x" }))).toBe(false);
    // Positive control: the same Grep rule DOES gate a Grep call.
    expect(matchesRule("Grep(secrets/**)", call("Grep", { path: "secrets/x" }))).toBe(true);
    // A Glob / NotebookRead rule likewise does not gate Read.
    expect(matchesRule("Glob(secrets/**)", call("Read", { file_path: "secrets/x" }))).toBe(false);
    expect(
      matchesRule("NotebookRead(secrets/**)", call("Read", { file_path: "secrets/x" })),
    ).toBe(false);
  });

  it("a bare Read deny blocks Grep and Glob calls too (mirrors the Edit-family)", () => {
    // Bare rule = no specifier, so it matches any path; the read-family
    // expansion routes a Grep/Glob call through the Read deny.
    const bare = denyEngine(["Read"]);
    expect(bare.evaluate(call("Grep", { path: "anything" }))).toEqual({
      decision: "deny",
      rule: "Read",
    });
    expect(bare.evaluate(call("Glob", { path: "anywhere" })).decision).toBe("deny");
  });

  it("directory-argument edge: a Glob naming the bare protected dir (pins observed behavior)", () => {
    // Observed behavior (pinned, not assumed): a Glob/Grep whose path is the
    // bare protected directory itself ({path:"secrets"}) under deny
    // Read(secrets/**) IS blocked — the glob engine treats `secrets/**` as
    // covering the directory node too (both directions), so naming the
    // directory to enumerate it is caught.
    expect(engine.evaluate(call("Glob", { path: "secrets" })).decision).toBe("deny");
    expect(engine.evaluate(call("Grep", { path: "secrets" })).decision).toBe("deny");
    expect(matchesRule("Read(secrets/**)", call("Glob", { path: "secrets" }))).toBe(true);

    // The REAL residual gap (basis for the honesty caveat) is a read call
    // that names NO path (or `path:"."`): there is nothing for the path matcher
    // to test, so the rule cannot fire and matching files stay reachable via
    // the tool's results. Only a BARE `deny: Read` forecloses that.
    expect(engine.evaluate(call("Grep", {})).decision).toBe("default");
    expect(engine.evaluate(call("Grep", { path: "." })).decision).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// 1c. Read deny also blocks Edit (v2.1.208 parity, deny-only)
// ---------------------------------------------------------------------------

describe("Read deny also blocks Edit (v2.1.208 parity, deny-only)", () => {
  const engine = denyEngine(["Read(secrets/**)"]);

  it("deny Read(glob) blocks Edit on a matching (new-file) path", () => {
    // ROOT is a nonexistent dir, so realpath fails and this exercises the
    // literal/new-file branch — the "creating a new file there" case.
    expect(engine.evaluate(call("Edit", { file_path: "secrets/creds.json" }))).toEqual({
      decision: "deny",
      rule: "Read(secrets/**)",
    });
  });

  it("deny Read(glob) blocks MultiEdit on a matching path", () => {
    expect(engine.evaluate(call("MultiEdit", { file_path: "secrets/creds.json" }))).toEqual({
      decision: "deny",
      rule: "Read(secrets/**)",
    });
  });

  it("deny Read(glob) does NOT block Write on a matching path", () => {
    expect(engine.evaluate(call("Write", { file_path: "secrets/creds.json" })).decision).toBe(
      "default",
    );
  });

  it("deny Read(glob) does NOT block NotebookEdit on a matching path", () => {
    expect(
      engine.evaluate(call("NotebookEdit", { notebook_path: "secrets/nb.ipynb" })).decision,
    ).toBe("default");
  });

  it("a non-matching Edit path passes", () => {
    expect(engine.evaluate(call("Edit", { file_path: "public/x.md" })).decision).toBe("default");
  });

  it("the cross is one-directional: an Edit rule never gates a read tool", () => {
    expect(matchesRule("Edit(secrets/**)", call("Read", { file_path: "secrets/x" }))).toBe(false);
    expect(matchesRule("Edit(secrets/**)", call("Grep", { path: "secrets/x" }))).toBe(false);
    expect(matchesRule("Edit(secrets/**)", call("Glob", { path: "secrets/x" }))).toBe(false);
    expect(
      matchesRule("Edit(secrets/**)", call("NotebookRead", { notebook_path: "secrets/x.ipynb" })),
    ).toBe(false);
    // Positive control: an Edit rule DOES gate an Edit call.
    expect(matchesRule("Edit(secrets/**)", call("Edit", { file_path: "secrets/x" }))).toBe(true);
  });

  it("the cross is deny-direction only (polarity guards)", () => {
    // Without the deny opt, a Read rule never matches an Edit call.
    expect(matchesRule("Read(secrets/**)", call("Edit", { file_path: "secrets/x" }))).toBe(false);
    // With {deny:true} it does.
    expect(
      matchesRule("Read(secrets/**)", call("Edit", { file_path: "secrets/x" }), { deny: true }),
    ).toBe(true);
    // allow: Read(...) does NOT allow Edit.
    const allowEngine = new PermissionEngine(rules({ allow: ["Read(secrets/**)"] }), { cwd: ROOT });
    expect(allowEngine.evaluate(call("Edit", { file_path: "secrets/x" })).decision).toBe("default");
    // Hook `if: Read(...)` does NOT fire on an Edit call.
    expect(evaluateIfCondition("Read(secrets/**)", call("Edit", { file_path: "secrets/x" }))).toBe(
      false,
    );
    // Positive control: it fires on a Read call.
    expect(evaluateIfCondition("Read(secrets/**)", call("Read", { file_path: "secrets/x" }))).toBe(
      true,
    );
  });

  it("bare deny: Read does NOT block Edit (path-specifier'd only)", () => {
    expect(
      denyEngine(["Read"]).evaluate(call("Edit", { file_path: "secrets/x" })).decision,
    ).toBe("default");
  });

  it("cross-platform: a drive-lettered Read deny blocks a matching Edit", () => {
    expect(
      denyEngine(["Read(//c/**/.env)"]).evaluate(call("Edit", { file_path: "C:\\proj\\.env" }))
        .decision,
    ).toBe("deny");
    expect(
      denyEngine(["Read(//c/**/.env)"]).evaluate(call("Edit", { file_path: "D:\\proj\\.env" }))
        .decision,
    ).toBe("default");
  });
});

// ---------------------------------------------------------------------------
// 1b. Deny-only NotebookRead→Read cross (notebook reading now flows through Read)
// ---------------------------------------------------------------------------

describe("deny NotebookRead(glob) protects the notebook read through Read", () => {
  const engine = denyEngine(["NotebookRead(**/*.ipynb)"]);

  it("deny NotebookRead(glob) blocks a Read call on a matching .ipynb", () => {
    expect(engine.evaluate(call("Read", { file_path: "nb/secret.ipynb" }))).toEqual({
      decision: "deny",
      rule: "NotebookRead(**/*.ipynb)",
    });
  });

  it("deny NotebookRead(glob) does NOT block a Read on a non-matching path", () => {
    expect(engine.evaluate(call("Read", { file_path: "docs/readme.md" })).decision).toBe("default");
  });

  it("a bare deny: NotebookRead does NOT block unrelated Reads (path-specifier'd only)", () => {
    expect(
      denyEngine(["NotebookRead"]).evaluate(call("Read", { file_path: "docs/readme.md" })).decision,
    ).toBe("default");
    // Positive control: a bare NotebookRead deny still gates a NotebookRead call
    // (the name resolves cleanly as a gating token).
    expect(
      denyEngine(["NotebookRead"]).evaluate(call("NotebookRead", { notebook_path: "a.ipynb" }))
        .decision,
    ).toBe("deny");
  });

  it("the cross is deny-direction only (never allow/ask/hook-if:)", () => {
    // Without the deny opt, a NotebookRead rule never matches a Read call.
    expect(
      matchesRule("NotebookRead(**/*.ipynb)", call("Read", { file_path: "nb/secret.ipynb" })),
    ).toBe(false);
    // With {deny:true} it does.
    expect(
      matchesRule("NotebookRead(**/*.ipynb)", call("Read", { file_path: "nb/secret.ipynb" }), {
        deny: true,
      }),
    ).toBe(true);
    // allow: NotebookRead(...) does NOT allow a Read.
    const allowEngine = new PermissionEngine(rules({ allow: ["NotebookRead(**/*.ipynb)"] }), {
      cwd: ROOT,
    });
    expect(allowEngine.evaluate(call("Read", { file_path: "nb/secret.ipynb" })).decision).toBe(
      "default",
    );
    // Hook `if: NotebookRead(...)` does NOT fire on a Read call.
    expect(
      evaluateIfCondition("NotebookRead(**/*.ipynb)", call("Read", { file_path: "nb/secret.ipynb" })),
    ).toBe(false);
  });

  it("cross-platform: a drive-lettered NotebookRead deny blocks a matching Read", () => {
    expect(
      denyEngine(["NotebookRead(//c/**/*.ipynb)"]).evaluate(
        call("Read", { file_path: "C:\\proj\\secret.ipynb" }),
      ).decision,
    ).toBe("deny");
    expect(
      denyEngine(["NotebookRead(//c/**/*.ipynb)"]).evaluate(
        call("Read", { file_path: "D:\\proj\\secret.ipynb" }),
      ).decision,
    ).toBe("default");
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
// 3b. Leading env-assignment stripping (deny direction only, D3)
// ---------------------------------------------------------------------------

describe("Bash leading env-assignment stripping (deny only)", () => {
  it.each([
    "FOO=bar rm -rf /",
    "FOO=bar BAZ=1 rm -rf /",
    "FOO='a b' rm -rf /",
    'FOO="a && b" rm -rf /',
    "EMPTY= rm -rf /",
    "git status && FOO=bar rm -rf /",
  ])("deny Bash(rm *) blocks %j", (command) => {
    expect(denyEngine(["Bash(rm *)"]).evaluate(bash(command)).decision).toBe("deny");
  });

  it("assignments compose with wrapper stripping in either order", () => {
    const engine = denyEngine(["Bash(curl *)"]);
    expect(engine.evaluate(bash("FOO=1 nohup curl http://evil")).decision).toBe("deny");
    expect(engine.evaluate(bash("nohup FOO=1 curl http://evil")).decision).toBe("deny");
  });

  it("allow direction does NOT strip bare assignments", () => {
    expect(matchesRule("Bash(rm *)", bash("FOO=bar rm -rf /"))).toBe(false);
    const engine = new PermissionEngine(rules({ allow: ["Bash(git *)"] }), { cwd: ROOT });
    expect(engine.evaluate(bash("FOO=1 git status")).decision).toBe("default");
    expect(engine.evaluate(bash("git status")).decision).toBe("allow");
  });

  it("a pure assignment (no command) matches nothing", () => {
    expect(denyEngine(["Bash(rm *)"]).evaluate(bash("FOO=bar")).decision).toBe("default");
  });

  it("assignment-shaped text mid-command is left alone", () => {
    expect(denyEngine(["Bash(rm *)"]).evaluate(bash("echo FOO=bar rm -rf /")).decision).toBe(
      "default",
    );
  });

  it("rules that name the assignment still match the raw form", () => {
    expect(denyEngine(["Bash(FOO=*)"]).evaluate(bash("FOO=bar rm -rf /")).decision).toBe("deny");
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
  const known = ["Bash", "Read", "Grep", "Glob", "NotebookRead", "Edit", "Write", "NotebookEdit", "WebFetch", "mcp__github__create_issue"];

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

  it("a bare Read deny removes all file-read tools, matching call-time expansion", () => {
    const gated = denyEngine(["Read"]).gateTools(undefined, undefined, known);
    expect(gated).not.toContain("Read");
    expect(gated).not.toContain("Grep");
    expect(gated).not.toContain("Glob");
    expect(gated).not.toContain("NotebookRead");
    // The edit family and Bash stay in context (families are not unioned).
    expect(gated).toContain("Edit");
    expect(gated).toContain("Write");
    expect(gated).toContain("Bash");
  });

  it("a scoped Read(glob) deny removes NO tools from context (per-call block instead)", () => {
    const gated = denyEngine(["Read(secrets/**)"]).gateTools(undefined, undefined, known);
    expect(gated).toContain("Read");
    expect(gated).toContain("Grep");
    expect(gated).toContain("Glob");
    expect(gated).toContain("NotebookRead");
  });

  it("a bare Grep deny removes ONLY Grep (the read family is not reverse-unioned)", () => {
    // Expansion is one-directional: a Read rule gates the read family, but a
    // Grep-rooted deny must strip ONLY Grep and leave Read/Glob/NotebookRead
    // (and the edit family + Bash) reachable.
    const gated = denyEngine(["Grep"]).gateTools(undefined, undefined, known);
    expect(gated).not.toContain("Grep");
    expect(gated).toContain("Read");
    expect(gated).toContain("Glob");
    expect(gated).toContain("NotebookRead");
    expect(gated).toContain("Edit");
    expect(gated).toContain("Write");
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
// 8. UNC inputs skip realpath (no network-stack stall)
// ---------------------------------------------------------------------------

describe("UNC path inputs", () => {
  // fs.realpathSync on a nonexistent \\host can block for seconds probing the
  // network stack — deny-direction matching must skip it for UNC inputs and
  // stay on the literal form.
  it("deny evaluation skips canonicalization for a \\\\server\\share input", () => {
    const engine = denyEngine(["Read(//no-such-host-9f3a/**)"]);
    const unc = "\\\\no-such-host-9f3a\\share\\secrets\\key.pem";
    const realpath = vi.spyOn(fs, "realpathSync");
    try {
      expect(() => engine.evaluate(call("Read", { file_path: unc }))).not.toThrow();
      expect(engine.evaluate(call("Read", { file_path: unc }))).toEqual({
        decision: "deny",
        rule: "Read(//no-such-host-9f3a/**)",
      });
      expect(realpath).not.toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
    }
  });

  it("forward-slash UNC form skips canonicalization while literal matching remains active", () => {
    const realpath = vi.spyOn(fs, "realpathSync");
    try {
      expect(
        matchesRule(
          "Read(//no-such-host-9f3a/**)",
          call("Read", { file_path: "//no-such-host-9f3a/share/secrets/key.pem" }),
          { deny: true, anySegment: true, anchor: ROOT },
        ),
      ).toBe(true);
      // The `//host` UNC skip is Windows-only: only there does path.resolve
      // preserve `//host/...` as a UNC path the network-stall guard (^//) skips.
      // On POSIX `//host/...` collapses to an ordinary single-slash absolute
      // path, so canonicalization legitimately runs — the load-bearing guarantee
      // is the literal match above, which holds on both platforms.
      if (process.platform === "win32") {
        expect(realpath).not.toHaveBeenCalled();
      }
    } finally {
      realpath.mockRestore();
    }
  });

  it("non-UNC deny evaluation still canonicalizes existing local paths", () => {
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc-perm-realpath-"));
    fs.writeFileSync(path.join(localRoot, "visible.txt"), "fixture");
    const realpath = vi.spyOn(fs, "realpathSync");
    try {
      const engine = denyEngine(["Read(visible.txt)"], { cwd: localRoot });
      expect(engine.evaluate(call("Read", { file_path: "visible.txt" }, localRoot)).decision).toBe(
        "deny",
      );
      expect(realpath).toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
      fs.rmSync(localRoot, { recursive: true, force: true });
    }
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
