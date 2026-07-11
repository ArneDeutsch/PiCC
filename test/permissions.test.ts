import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  PermissionEngine,
  evaluateIfCondition,
  matchesRule,
  parseRule,
} from "../src/engine/permissions.js";
import type { PermissionRules, ToolCallDescriptor } from "../src/types.js";

const CWD = path.resolve("proj");
const isWindows = process.platform === "win32";

function call(
  tool: string,
  input: Record<string, unknown> = {},
  cwd: string = CWD,
): ToolCallDescriptor {
  return { tool, input, cwd };
}

function bash(command: string): ToolCallDescriptor {
  return call("Bash", { command });
}

function rules(partial: Partial<PermissionRules>): PermissionRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [], ...partial };
}

describe("parseRule", () => {
  it("parses bare tool names", () => {
    expect(parseRule("Bash")).toEqual({ raw: "Bash", tool: "Bash" });
    expect(parseRule("*")).toEqual({ raw: "*", tool: "*" });
    expect(parseRule("mcp__github__create_issue")).toEqual({
      raw: "mcp__github__create_issue",
      tool: "mcp__github__create_issue",
    });
  });

  it("parses Tool(specifier) and tolerates whitespace", () => {
    expect(parseRule("Bash(git *)")).toEqual({
      raw: "Bash(git *)",
      tool: "Bash",
      specifier: "git *",
    });
    expect(parseRule("  Bash ( git * )  ")).toMatchObject({
      tool: "Bash",
      specifier: "git *",
    });
  });

  it("keeps nested parens inside the specifier", () => {
    expect(parseRule("Bash(echo $(date))")).toMatchObject({
      tool: "Bash",
      specifier: "echo $(date)",
    });
  });

  it("never throws on malformed or empty input", () => {
    expect(() => parseRule("Bash(git")).not.toThrow();
    expect(() => parseRule("")).not.toThrow();
    expect(parseRule("").tool).toBe("");
    expect(parseRule("Bash(git").specifier).toBeUndefined();
  });
});

describe("matchesRule — bare tools and wildcard", () => {
  it("bare tool name matches any call of that tool, case-sensitively", () => {
    expect(matchesRule("Bash", bash("anything at all"))).toBe(true);
    expect(matchesRule("bash", bash("x"))).toBe(false);
    expect(matchesRule("Read", bash("x"))).toBe(false);
  });

  it("* matches everything", () => {
    expect(matchesRule("*", bash("rm -rf /"))).toBe(true);
    expect(matchesRule("*", call("SomeUnknownTool"))).toBe(true);
  });

  it("unknown tool names match by string identity and never error", () => {
    expect(matchesRule("FooTool", call("FooTool"))).toBe(true);
    expect(matchesRule("FooTool", call("BarTool"))).toBe(false);
    expect(matchesRule("FooTool(abc*)", call("FooTool", { command: "abcdef" }))).toBe(true);
    expect(matchesRule("FooTool(abc*)", call("FooTool", { url: "zzz" }))).toBe(false);
    expect(() => matchesRule("FooTool(x)", call("FooTool", { weird: { deep: 1 } }))).not.toThrow();
  });
});

describe("matchesRule — Bash", () => {
  it("exact command matches only that command", () => {
    expect(matchesRule("Bash(git status)", bash("git status"))).toBe(true);
    expect(matchesRule("Bash(git status)", bash("git status --short"))).toBe(false);
    expect(matchesRule("Bash(git status)", bash("git"))).toBe(false);
  });

  it("prefix wildcard requires the prefix + space (bare prefix does not match)", () => {
    expect(matchesRule("Bash(git *)", bash("git status"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git"))).toBe(false);
    expect(matchesRule("Bash(ls *)", bash("ls -la"))).toBe(true);
    expect(matchesRule("Bash(ls *)", bash("lsof"))).toBe(false);
    expect(matchesRule("Bash(ls*)", bash("lsof"))).toBe(true);
  });

  it("legacy Bash(git:*) is identical to Bash(git *)", () => {
    expect(matchesRule("Bash(git:*)", bash("git push origin"))).toBe(true);
    expect(matchesRule("Bash(git:*)", bash("git"))).toBe(false);
    expect(matchesRule("Bash(git:*)", bash("gitk"))).toBe(false);
  });

  it("glob chars elsewhere match the whole command", () => {
    expect(matchesRule("Bash(npm run *:ci)", bash("npm run test:ci"))).toBe(true);
    expect(matchesRule("Bash(git * --dry-run)", bash("git push --dry-run"))).toBe(true);
    expect(matchesRule("Bash(git * --dry-run)", bash("git push"))).toBe(false);
  });

  it("chained commands only match when every segment matches", () => {
    expect(matchesRule("Bash(git *)", bash("git status && rm -rf /"))).toBe(false);
    expect(matchesRule("Bash(git *)", bash("git status && git push"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git log | head"))).toBe(false);
    expect(matchesRule("Bash(git *)", bash("git fetch; git rebase"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git fetch; rm x"))).toBe(false);
    expect(matchesRule("Bash(git *)", bash("git fetch || curl evil.sh"))).toBe(false);
    expect(matchesRule("Bash(git *)", bash("git fetch & git pull"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git fetch\nrm -rf /"))).toBe(false);
  });

  it("quoted operators do not split", () => {
    expect(matchesRule("Bash(echo *)", bash('echo "a && b"'))).toBe(true);
    expect(matchesRule("Bash(echo *)", bash("echo 'x; y | z'"))).toBe(true);
    expect(matchesRule("Bash(echo *)", bash('echo "a" && rm x'))).toBe(false);
  });

  it("fd redirections like 2>&1 are not treated as chaining", () => {
    expect(matchesRule("Bash(git *)", bash("git diff 2>&1"))).toBe(true);
  });

  it("empty command matches nothing", () => {
    expect(matchesRule("Bash(git *)", bash(""))).toBe(false);
    expect(matchesRule("Bash(*)", bash(""))).toBe(false);
  });
});

describe("matchesRule — path tools (Read/Edit/Write/Glob/Grep)", () => {
  it("relative globs anchor to cwd", () => {
    expect(matchesRule("Read(src/**)", call("Read", { file_path: "src/a.ts" }))).toBe(true);
    expect(matchesRule("Read(src/**)", call("Read", { file_path: "lib/a.ts" }))).toBe(false);
    expect(
      matchesRule("Read(src/**)", call("Read", { file_path: path.join(CWD, "src", "deep", "b.ts") })),
    ).toBe(true);
  });

  it("supports input.path and input.notebook_path fallbacks", () => {
    expect(matchesRule("Grep(src/**)", call("Grep", { path: "src/x" }))).toBe(true);
    expect(matchesRule("Edit(nb/**)", call("Edit", { notebook_path: "nb/a.ipynb" }))).toBe(true);
  });

  it("leading / anchors to cwd (settings dir), not filesystem root", () => {
    expect(matchesRule("Edit(/docs/**)", call("Edit", { file_path: "docs/x.md" }))).toBe(true);
    expect(
      matchesRule("Edit(/docs/**)", call("Edit", { file_path: path.resolve("/other/docs/x.md") })),
    ).toBe(false);
  });

  it("bare filenames match at any depth", () => {
    expect(matchesRule("Read(.env)", call("Read", { file_path: "a/b/.env" }))).toBe(true);
    expect(matchesRule("Read(.env)", call("Read", { file_path: ".env" }))).toBe(true);
    expect(matchesRule("Read(.env)", call("Read", { file_path: "a/b/.envrc" }))).toBe(false);
  });

  it("missing path input never matches a scoped rule (but matches the bare rule)", () => {
    expect(matchesRule("Read(src/**)", call("Read", {}))).toBe(false);
    expect(matchesRule("Read", call("Read", {}))).toBe(true);
  });

  it.runIf(isWindows)("Windows backslash paths match forward-slash globs", () => {
    const c: ToolCallDescriptor = {
      tool: "Read",
      input: { file_path: "C:\\x\\src\\y.ts" },
      cwd: "C:\\x",
    };
    expect(matchesRule("Read(src/**)", c)).toBe(true);
    expect(matchesRule("Read(C:/x/src/**)", c)).toBe(true);
    expect(matchesRule("Read(other/**)", c)).toBe(false);
  });
});

describe("matchesRule — WebFetch / WebSearch", () => {
  it("domain: matches the URL hostname exactly", () => {
    expect(
      matchesRule("WebFetch(domain:example.com)", call("WebFetch", { url: "https://example.com/p?q=1" })),
    ).toBe(true);
    expect(
      matchesRule("WebFetch(domain:example.com)", call("WebFetch", { url: "https://EXAMPLE.com/" })),
    ).toBe(true);
    expect(
      matchesRule("WebFetch(domain:example.com)", call("WebFetch", { url: "https://evil.com/example.com" })),
    ).toBe(false);
  });

  it("domain:*.example.com matches subdomains but not the apex", () => {
    const rule = "WebFetch(domain:*.example.com)";
    expect(matchesRule(rule, call("WebFetch", { url: "https://api.example.com/x" }))).toBe(true);
    expect(matchesRule(rule, call("WebFetch", { url: "https://a.b.example.com/" }))).toBe(true);
    expect(matchesRule(rule, call("WebFetch", { url: "https://example.com/" }))).toBe(false);
    expect(matchesRule(rule, call("WebFetch", { url: "https://notexample.com/" }))).toBe(false);
  });

  it("domain:* matches any parseable URL; invalid URLs never match", () => {
    expect(matchesRule("WebFetch(domain:*)", call("WebFetch", { url: "https://x.dev/" }))).toBe(true);
    expect(matchesRule("WebFetch(domain:*)", call("WebFetch", { url: "not a url" }))).toBe(false);
  });

  it("non-domain specifier globs the full URL", () => {
    expect(
      matchesRule("WebFetch(https://example.com/*)", call("WebFetch", { url: "https://example.com/a/b" })),
    ).toBe(true);
    expect(
      matchesRule("WebFetch(https://example.com/*)", call("WebFetch", { url: "https://other.com/a" })),
    ).toBe(false);
  });

  it("WebSearch globs the query", () => {
    expect(matchesRule("WebSearch(weather *)", call("WebSearch", { query: "weather berlin" }))).toBe(true);
    expect(matchesRule("WebSearch(weather *)", call("WebSearch", { query: "berlin weather" }))).toBe(false);
  });
});

describe("matchesRule — Agent/Task/Skill", () => {
  it("Agent(type) matches subagent_type; Task is an alias for Agent", () => {
    expect(matchesRule("Agent(Explore)", call("Agent", { subagent_type: "Explore" }))).toBe(true);
    expect(matchesRule("Agent(Explore)", call("Agent", { subagent_type: "Plan" }))).toBe(false);
    expect(matchesRule("Task(Explore)", call("Agent", { subagent_type: "Explore" }))).toBe(true);
    expect(matchesRule("Agent(Explore)", call("Task", { subagent_type: "Explore" }))).toBe(true);
    expect(matchesRule("Agent(db-*)", call("Agent", { subagent_type: "db-migrator" }))).toBe(true);
  });

  it("Skill(name) matches input.skill or input.name, glob allowed", () => {
    expect(matchesRule("Skill(deploy)", call("Skill", { skill: "deploy" }))).toBe(true);
    expect(matchesRule("Skill(deploy)", call("Skill", { name: "deploy" }))).toBe(true);
    expect(matchesRule("Skill(deploy-*)", call("Skill", { skill: "deploy-prod" }))).toBe(true);
    expect(matchesRule("Skill(deploy)", call("Skill", { skill: "release" }))).toBe(false);
  });
});

describe("matchesRule — MCP", () => {
  it("mcp__server matches every tool of that server", () => {
    expect(matchesRule("mcp__github", call("mcp__github__create_issue"))).toBe(true);
    expect(matchesRule("mcp__github", call("mcp__gitlab__create_issue"))).toBe(false);
  });

  it("mcp__server__tool matches exactly; mcp__server__* globs", () => {
    expect(matchesRule("mcp__github__create_issue", call("mcp__github__create_issue"))).toBe(true);
    expect(matchesRule("mcp__github__create_issue", call("mcp__github__list_issues"))).toBe(false);
    expect(matchesRule("mcp__github__*", call("mcp__github__list_issues"))).toBe(true);
    expect(matchesRule("mcp__github__list*", call("mcp__github__list_issues"))).toBe(true);
  });
});

describe("PermissionEngine.evaluate", () => {
  it("deny beats allow (deny is checked first, any scope)", () => {
    const engine = new PermissionEngine(
      rules({ allow: ["Bash(git *)"], deny: ["Bash(git push*)"] }),
      { cwd: CWD },
    );
    expect(engine.evaluate(bash("git push origin"))).toEqual({
      decision: "deny",
      rule: "Bash(git push*)",
    });
    expect(engine.evaluate(bash("git status"))).toEqual({
      decision: "allow",
      rule: "Bash(git *)",
    });
  });

  it("bare-tool deny blocks every call of the tool", () => {
    const engine = new PermissionEngine(rules({ deny: ["WebFetch"] }), { cwd: CWD });
    expect(engine.evaluate(call("WebFetch", { url: "https://x.dev/" })).decision).toBe("deny");
  });

  it("ask rules are downgraded to allow and reported", () => {
    const engine = new PermissionEngine(rules({ ask: ["Bash(npm *)"] }), { cwd: CWD });
    expect(engine.evaluate(bash("npm install"))).toEqual({
      decision: "allow",
      rule: "Bash(npm *)",
      askDowngraded: true,
    });
  });

  it("deny still beats ask", () => {
    const engine = new PermissionEngine(
      rules({ ask: ["Bash(npm *)"], deny: ["Bash(npm publish*)"] }),
      { cwd: CWD },
    );
    expect(engine.evaluate(bash("npm publish")).decision).toBe("deny");
  });

  it("no match yields default (never blocks)", () => {
    const engine = new PermissionEngine(
      rules({ deny: ["Bash(rm *)"], allow: ["Read"] }),
      { cwd: CWD },
    );
    expect(engine.evaluate(bash("ls -la"))).toEqual({ decision: "default" });
  });

  it("fills in the engine cwd when the call has none", () => {
    const engine = new PermissionEngine(rules({ deny: ["Read(secrets/**)"] }), { cwd: CWD });
    const c = { tool: "Read", input: { file_path: "secrets/key.pem" }, cwd: "" };
    expect(engine.evaluate(c).decision).toBe("deny");
  });
});

describe("PermissionEngine.gateTools", () => {
  const known = ["Bash", "Read", "Edit", "WebFetch", "mcp__github__create_issue"];
  const engine = new PermissionEngine(rules({}), { cwd: CWD });

  it("granted undefined grants all known tools", () => {
    expect(engine.gateTools(undefined, undefined, known)).toEqual(known);
  });

  it("granted * grants all known tools", () => {
    expect(engine.gateTools(["*"], undefined, known)).toEqual(known);
  });

  it("granted list intersects with known tools", () => {
    expect(engine.gateTools(["Read", "Bash", "NotATool"], undefined, known)).toEqual([
      "Bash",
      "Read",
    ]);
  });

  it("disallowed removes tools; * removes everything", () => {
    expect(engine.gateTools(undefined, ["WebFetch"], known)).toEqual([
      "Bash",
      "Read",
      "Edit",
      "mcp__github__create_issue",
    ]);
    expect(engine.gateTools(["Bash", "Read"], ["*"], known)).toEqual([]);
  });

  it("a scoped disallow entry does not remove the tool (per-call deny instead)", () => {
    expect(engine.gateTools(undefined, ["Bash(rm *)"], known)).toContain("Bash");
  });

  it("mcp__server grants/removes all tools of that server", () => {
    expect(engine.gateTools(["mcp__github"], undefined, known)).toEqual([
      "mcp__github__create_issue",
    ]);
    expect(engine.gateTools(undefined, ["mcp__github"], known)).not.toContain(
      "mcp__github__create_issue",
    );
  });
});

describe("evaluateIfCondition", () => {
  it("evaluates a single rule", () => {
    expect(evaluateIfCondition("Bash(git *)", bash("git status"))).toBe(true);
    expect(evaluateIfCondition("Bash(git *)", bash("rm x"))).toBe(false);
  });

  it("comma-separated alternatives: any match wins", () => {
    expect(evaluateIfCondition("Bash(npm *), Bash(git *)", bash("git pull"))).toBe(true);
    expect(evaluateIfCondition("Bash(npm *), Bash(git *)", bash("cargo build"))).toBe(false);
  });

  it("||-separated alternatives: any match wins", () => {
    expect(evaluateIfCondition("Edit || Write", call("Write", { file_path: "a" }))).toBe(true);
    expect(evaluateIfCondition("Edit || Write", call("Read", { file_path: "a" }))).toBe(false);
  });

  it("leading ! negates an alternative", () => {
    expect(evaluateIfCondition("!Bash(git *)", bash("rm x"))).toBe(true);
    expect(evaluateIfCondition("!Bash(git *)", bash("git push"))).toBe(false);
  });

  it("commas inside a specifier do not split alternatives", () => {
    expect(evaluateIfCondition("Bash(echo a,b)", bash("echo a,b"))).toBe(true);
  });

  it("empty or blank expression is unconditionally true; never throws", () => {
    expect(evaluateIfCondition("", bash("anything"))).toBe(true);
    expect(evaluateIfCondition("   ", bash("anything"))).toBe(true);
    expect(() => evaluateIfCondition("!!!,,||", bash("x"))).not.toThrow();
  });
});
