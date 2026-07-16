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

  it("trailing space-star is a word boundary: bare prefix matches, merged words do not", () => {
    expect(matchesRule("Bash(git *)", bash("git status"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git push"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git"))).toBe(true); // space-or-end boundary
    expect(matchesRule("Bash(git *)", bash("gitk"))).toBe(false);
    expect(matchesRule("Bash(ls *)", bash("ls -la"))).toBe(true);
    expect(matchesRule("Bash(ls *)", bash("ls"))).toBe(true);
    expect(matchesRule("Bash(ls *)", bash("lsof"))).toBe(false);
    expect(matchesRule("Bash(ls*)", bash("lsof"))).toBe(true); // no space, no boundary
  });

  it("legacy Bash(git:*) is identical to Bash(git *)", () => {
    expect(matchesRule("Bash(git:*)", bash("git push origin"))).toBe(true);
    expect(matchesRule("Bash(git:*)", bash("git"))).toBe(true);
    expect(matchesRule("Bash(git:*)", bash("gitk"))).toBe(false);
  });

  it("glob chars elsewhere match the whole command", () => {
    expect(matchesRule("Bash(npm run *:ci)", bash("npm run test:ci"))).toBe(true);
    expect(matchesRule("Bash(git * --dry-run)", bash("git push --dry-run"))).toBe(true);
    expect(matchesRule("Bash(git * --dry-run)", bash("git push"))).toBe(false);
  });

  it("interior space-star keeps mandatory-space semantics (no boundary broadening)", () => {
    expect(matchesRule("Bash(git * main)", bash("git push origin main"))).toBe(true);
    expect(matchesRule("Bash(git * main)", bash("git main"))).toBe(false);
    // The boundary applies only to the trailing star, not the interior one:
    // the interior `*` still needs surrounding spaces to be real.
    expect(matchesRule("Bash(git * --dry-run *)", bash("git push --dry-run"))).toBe(true);
    expect(matchesRule("Bash(git * --dry-run *)", bash("git --dry-run"))).toBe(false);
  });

  it("chained commands only match when every segment matches", () => {
    expect(matchesRule("Bash(git *)", bash("git status && rm -rf /"))).toBe(false);
    expect(matchesRule("Bash(git *)", bash("git status && git push"))).toBe(true);
    expect(matchesRule("Bash(git *)", bash("git status && git"))).toBe(true); // boundary in chains
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

  it("a Read bare-filename rule gates read-family calls at any depth (F26)", () => {
    // The Read family expansion (Grep/NotebookRead) inherits the any-depth
    // bare-filename semantics via the shared path matcher.
    expect(matchesRule("Read(.env)", call("Grep", { path: "a/b/.env" }))).toBe(true);
    expect(
      matchesRule("Read(.env)", call("NotebookRead", { notebook_path: "a/b/.env" })),
    ).toBe(true);
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

describe("matchesRule — Windows path normalization (D2, platform-independent)", () => {
  // Drive-lettered inputs/patterns take the normalized `/c/…` code path on
  // every platform, so these run identically on POSIX and win32 runners.
  it("//c/** drive patterns match drive-lettered inputs in any flavor", () => {
    expect(matchesRule("Read(//c/**/.env)", call("Read", { file_path: "C:\\proj\\.env" }))).toBe(true);
    expect(matchesRule("Read(//c/**/.env)", call("Read", { file_path: "C:/proj/.env" }))).toBe(true);
    expect(matchesRule("Read(//c/**/.env)", call("Read", { file_path: "D:\\proj\\.env" }))).toBe(false);
    expect(matchesRule("Read(//c/**/.env)", call("Read", { file_path: "C:\\proj\\.envrc" }))).toBe(false);
  });

  it("a Read drive-letter rule gates a read-family call in any flavor (F26)", () => {
    // The Read → read-family expansion inherits D2 drive normalization: a
    // //c/** rule covers a Grep whose path is a drive-lettered input.
    expect(matchesRule("Read(//c/**/.env)", call("Grep", { path: "C:\\proj\\.env" }))).toBe(true);
    expect(matchesRule("Read(//c/**/.env)", call("Grep", { path: "D:\\proj\\.env" }))).toBe(false);
  });

  it("forward-slash drive rules match backslash inputs (and vice versa)", () => {
    expect(matchesRule("Read(C:/proj/**)", call("Read", { file_path: "C:\\proj\\x.txt" }))).toBe(true);
    expect(matchesRule("Read(C:\\proj\\**)", call("Read", { file_path: "C:/proj/x.txt" }))).toBe(true);
    expect(matchesRule("Read(C:/proj/**)", call("Read", { file_path: "D:\\proj\\x.txt" }))).toBe(false);
  });

  it("drive-lettered matching is case-insensitive (Windows filesystem semantics)", () => {
    expect(matchesRule("Read(//c/**/.env)", call("Read", { file_path: "C:\\PROJ\\.ENV" }))).toBe(true);
    expect(matchesRule("Read(c:/proj/**)", call("Read", { file_path: "C:\\Proj\\X.TXT" }))).toBe(true);
  });

  it("//**/pattern matches any absolute path", () => {
    expect(matchesRule("Read(//**/.env)", call("Read", { file_path: "C:\\proj\\.env" }))).toBe(true);
    expect(matchesRule("Read(//**/.env)", call("Read", { file_path: "/srv/app/.env" }))).toBe(true);
    expect(matchesRule("Read(//**/.env)", call("Read", { file_path: "a/b/.envrc" }))).toBe(false);
  });

  it("drive patterns anchor to the drive root, never to a relative dir of that name", () => {
    // `q` rather than `c` so the negative holds even on runners whose cwd
    // lives on C: (where /x/q/y resolves to /c/x/q/y — still not under /q).
    expect(matchesRule("Read(//q/**)", call("Read", { file_path: "/x/q/y" }))).toBe(false);
    expect(matchesRule("Read(//q/**)", call("Read", { file_path: "q/y" }))).toBe(false);
  });

  it("deny direction: engine blocks drive-lettered reads via //c rules", () => {
    const engine = new PermissionEngine(rules({ deny: ["Read(//c/**/.env)"] }), { cwd: CWD });
    expect(engine.evaluate(call("Read", { file_path: "C:\\anywhere\\deep\\.env" }))).toEqual({
      decision: "deny",
      rule: "Read(//c/**/.env)",
    });
    expect(engine.evaluate(call("Read", { file_path: "C:\\anywhere\\deep\\ok.txt" })).decision).toBe(
      "default",
    );
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

describe("PermissionEngine — MCP allow-rule glob validation (D4)", () => {
  const mcpCall = call("mcp__github__create_issue");

  it("an unanchored mcp__* allow rule is ignored and reported as a warning", () => {
    const engine = new PermissionEngine(rules({ allow: ["mcp__*"] }), { cwd: CWD });
    expect(engine.evaluate(mcpCall).decision).toBe("default");
    expect(engine.diagnostics).toHaveLength(1);
    expect(engine.diagnostics[0]).toMatchObject({ severity: "warning" });
    expect(engine.diagnostics[0]?.message).toContain('"mcp__*"');
  });

  it("mcp__foo* (wildcard before the __ tool separator) is also unanchored", () => {
    const engine = new PermissionEngine(rules({ allow: ["mcp__git*"] }), { cwd: CWD });
    expect(engine.evaluate(mcpCall).decision).toBe("default");
    expect(engine.diagnostics).toHaveLength(1);
  });

  it("anchored MCP globs stay valid allow rules (no diagnostics)", () => {
    const engine = new PermissionEngine(
      rules({ allow: ["mcp__github__*", "mcp__github__create_*"] }),
      { cwd: CWD },
    );
    expect(engine.evaluate(mcpCall).decision).toBe("allow");
    expect(engine.diagnostics).toEqual([]);
  });

  it("bare mcp__server (no glob) remains a valid allow rule", () => {
    const engine = new PermissionEngine(rules({ allow: ["mcp__github"] }), { cwd: CWD });
    expect(engine.evaluate(mcpCall).decision).toBe("allow");
    expect(engine.diagnostics).toEqual([]);
  });

  it("deny and ask directions keep accepting unanchored globs", () => {
    const denyEngine = new PermissionEngine(rules({ deny: ["mcp__*"] }), { cwd: CWD });
    expect(denyEngine.evaluate(mcpCall).decision).toBe("deny");
    expect(denyEngine.diagnostics).toEqual([]);
    const askEngine = new PermissionEngine(rules({ ask: ["mcp__*"] }), { cwd: CWD });
    expect(askEngine.evaluate(mcpCall)).toMatchObject({ decision: "allow", askDowngraded: true });
    expect(askEngine.diagnostics).toEqual([]);
  });

  it("a wildcard inside the server segment is unanchored too", () => {
    const engine = new PermissionEngine(rules({ allow: ["mcp__git*__create_issue"] }), { cwd: CWD });
    expect(engine.evaluate(mcpCall).decision).toBe("default");
    expect(engine.diagnostics).toHaveLength(1);
  });

  it("non-MCP wildcard rules are unaffected", () => {
    const engine = new PermissionEngine(rules({ allow: ["Bash(git *)", "*"] }), { cwd: CWD });
    expect(engine.diagnostics).toEqual([]);
    expect(engine.evaluate(bash("git status")).decision).toBe("allow");
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
