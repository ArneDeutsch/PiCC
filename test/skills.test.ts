import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadSkillBody,
  loadSkills,
  renderSkillListing,
  substituteArguments,
  substituteVariables,
} from "../src/claude/skills.js";
import {
  preprocessShellInjection,
  resolveGitBashPath,
  resolveShellBinary,
  shellNamespaceDiffersFromNative,
} from "../src/engine/shell-inject.js";
import type { ClaudeSkill } from "../src/types.js";

const SENTINEL = "PD_SENTINEL_BODY_2c8f71";

let root: string;
let skillsDir: string;
let commandsDir: string;

function write(rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
  return full;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-skills-"));
  skillsDir = path.join(root, ".claude", "skills");
  commandsDir = path.join(root, ".claude", "commands");

  write(
    ".claude/skills/full-skill/SKILL.md",
    `---
name: full-skill
description: Does everything for testing
when_to_use: When exercising the full frontmatter set
user-invocable: false
disable-model-invocation: true
argument-hint: "[file] [format]"
arguments:
  - name: file
    description: target file
    required: true
  - name: format
    default: json
allowed-tools: Read, Grep
disallowed-tools:
  - Write
model: gpt-5
effort: high
context: fork
agent: reviewer
shell: powershell
paths:
  - "src/**"
hooks:
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: echo hi
metadata:
  team: core
custom-key: 42
---
${SENTINEL}
Body of full-skill uses $ARGUMENTS somewhere.
`,
  );

  // Nested skill (recursive discovery) with minimal frontmatter → defaults.
  write(
    ".claude/skills/group/nested-skill/SKILL.md",
    `---
description: A nested skill relying on defaults
---
Nested body.
`,
  );

  // Skill without description → skipped with a warning.
  write(
    ".claude/skills/no-desc/SKILL.md",
    `---
name: no-desc
---
Body without description.
`,
  );

  // String-form lists (Claude Code convention: comma-separated single string);
  // commas inside () / {} must NOT split.
  write(
    ".claude/skills/list-forms/SKILL.md",
    `---
name: list-forms
description: Exercises string-form tool and path lists
allowed-tools: Bash(git add:*), Bash(echo a,b), mcp__srv__tool
disallowed-tools: Write, Edit
paths: "src/**/*.{ts,tsx}, test/**"
model: sonnet
effort: low
---
Body.
`,
  );

  // Colliding nested skill (same leaf dir name as group/nested-skill) →
  // registered under the colon-qualified name "other:nested-skill".
  write(
    ".claude/skills/other/nested-skill/SKILL.md",
    `---
description: Colliding nested skill (qualified)
---
Other nested body.
`,
  );

  // Informational frontmatter keys (v2.1.186): known, no unknown-key warnings.
  write(
    ".claude/skills/meta-rich/SKILL.md",
    `---
name: meta-rich
description: Has informational keys
license: MIT
display-name: Meta Rich
default-enabled: true
fallback: unused fallback
---
Body.
`,
  );

  // No description, but a fallback: → loads with the fallback as description.
  write(
    ".claude/skills/fallback-desc/SKILL.md",
    `---
name: fallback-desc
fallback: Description from fallback key
---
Body of fallback-desc.
`,
  );

  // Broken strict YAML (unclosed flow sequence) → lenient parse; fallback still
  // provides the description so the skill loads with its body.
  write(
    ".claude/skills/broken-yaml/SKILL.md",
    `---
fallback: Recovered description via fallback
weird: [unclosed
---
Body of broken-yaml skill.
`,
  );

  // Legacy commands.
  write(
    ".claude/commands/deploy.md",
    `---
description: Deploy the app
argument-hint: "[env]"
allowed-tools: Bash(npm run deploy:*), Read
---
Deploy to $ARGUMENTS now.
`,
  );
  // Nested command colliding with the top-level deploy.md → "frontend:deploy".
  write(
    ".claude/commands/frontend/deploy.md",
    `---
description: Frontend deploy (nested)
---
Nested frontend deploy body.
`,
  );
  // Nested command without a collision → keeps its plain stem.
  write(
    ".claude/commands/ops/status.md",
    `---
description: Ops status (nested, no collision)
---
Status body.
`,
  );
  write(
    ".claude/commands/headless.md",
    `
# Run Headless Checks

Do the checks.
`,
  );
  // Clashes with the real skill "full-skill" → the skill must win.
  write(
    ".claude/commands/full-skill.md",
    `---
description: Legacy shadow that must lose
---
Shadowed body.
`,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function load() {
  return loadSkills(
    [{ dir: skillsDir, scope: "project" }],
    [{ dir: commandsDir, scope: "project" }],
  );
}

// ---------------------------------------------------------------------------
// loadSkills
// ---------------------------------------------------------------------------

describe("loadSkills", () => {
  it("parses the full frontmatter set", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "full-skill")!;
    expect(s).toBeDefined();
    expect(s.description).toBe("Does everything for testing");
    expect(s.whenToUse).toBe("When exercising the full frontmatter set");
    expect(s.userInvocable).toBe(false);
    expect(s.disableModelInvocation).toBe(true);
    expect(s.argumentHint).toBe("[file] [format]");
    expect(s.arguments).toEqual([
      { name: "file", description: "target file", required: true },
      { name: "format", default: "json" },
    ]);
    expect(s.allowedTools).toEqual(["Read", "Grep"]);
    expect(s.disallowedTools).toEqual(["Write"]);
    expect(s.model).toBe("gpt-5");
    expect(s.effort).toBe("high");
    expect(s.contextFork).toBe(true);
    expect(s.forkAgentType).toBe("reviewer");
    expect(s.shell).toBe("powershell");
    expect(s.paths).toEqual(["src/**"]);
    expect(s.hooks).toBeDefined();
    expect(s.hooks!["PreToolUse"]).toHaveLength(1);
    expect(s.metadata).toEqual({ team: "core" });
    expect(s.unknownKeys).toEqual(["custom-key"]);
    expect(s.legacyCommand).toBe(false);
    expect(s.baseDir).toBe(path.join(skillsDir, "full-skill"));
    expect(s.source.scope).toBe("project");
  });

  it("parses string-form tool/path lists (comma-separated) without splitting inside () or {}", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "list-forms")!;
    expect(s).toBeDefined();
    expect(s.allowedTools).toEqual(["Bash(git add:*)", "Bash(echo a,b)", "mcp__srv__tool"]);
    expect(s.disallowedTools).toEqual(["Write", "Edit"]);
    expect(s.paths).toEqual(["src/**/*.{ts,tsx}", "test/**"]);
    expect(s.model).toBe("sonnet");
    expect(s.effort).toBe("low");
  });

  it("discovers nested skills recursively and applies defaults", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "nested-skill")!;
    expect(s).toBeDefined(); // name defaults to the directory name
    expect(s.userInvocable).toBe(true);
    expect(s.disableModelInvocation).toBe(false);
    expect(s.contextFork).toBe(false);
    expect(s.shell).toBe("bash");
    expect(s.metadata).toEqual({});
    expect(s.unknownKeys).toEqual([]);
  });

  it("skips description-less skills with a warning diagnostic", () => {
    const { skills, diagnostics } = load();
    expect(skills.find((x) => x.name === "no-desc")).toBeUndefined();
    const warn = diagnostics.find(
      (d) => d.severity === "warning" && d.message.includes("no-desc") && d.message.includes("description"),
    );
    expect(warn).toBeDefined();
  });

  it("progressive disclosure: bodies are absent until loadSkillBody", () => {
    const result = load();
    for (const s of result.skills) expect(s.body).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SENTINEL);

    const s = result.skills.find((x) => x.name === "full-skill")!;
    const body = loadSkillBody(s);
    expect(body).toContain(SENTINEL);
    expect(s.body).toContain(SENTINEL);
    expect(JSON.stringify(result)).toContain(SENTINEL);
  });

  it("loadSkillBody returns '' for a missing file and never throws", () => {
    const result = load();
    const s = { ...result.skills[0]!, source: { path: path.join(root, "gone", "SKILL.md"), scope: "project" as const } };
    expect(loadSkillBody(s)).toBe("");
  });

  it("loads legacy commands with description fallback to first heading", () => {
    const { skills } = load();
    const deploy = skills.find((x) => x.name === "deploy")!;
    expect(deploy.legacyCommand).toBe(true);
    expect(deploy.userInvocable).toBe(true);
    expect(deploy.description).toBe("Deploy the app");
    expect(deploy.argumentHint).toBe("[env]");
    expect(deploy.allowedTools).toEqual(["Bash(npm run deploy:*)", "Read"]);
    expect(deploy.baseDir).toBe(commandsDir);
    expect(deploy.body).toBeUndefined();
    expect(loadSkillBody(deploy)).toContain("Deploy to $ARGUMENTS now.");

    const headless = skills.find((x) => x.name === "headless")!;
    expect(headless.legacyCommand).toBe(true);
    expect(headless.description).toBe("Run Headless Checks");
  });

  it("dedupes name clashes: skill wins over legacy command", () => {
    const { skills, diagnostics } = load();
    const matches = skills.filter((x) => x.name === "full-skill");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.legacyCommand).toBe(false);
    expect(matches[0]!.description).toBe("Does everything for testing");
    const shadow = diagnostics.find((d) => d.message.includes("shadowed"));
    expect(shadow).toBeDefined();
  });

  it("discovers legacy commands recursively; nested non-colliding stems stay plain", () => {
    const { skills } = load();
    const status = skills.find((x) => x.name === "status")!;
    expect(status).toBeDefined();
    expect(status.legacyCommand).toBe(true);
    expect(status.description).toBe("Ops status (nested, no collision)");
    expect(status.baseDir).toBe(path.join(commandsDir, "ops"));
  });

  it("ALWAYS registers a qualified alias for nested entries, not only on collision", () => {
    const { skills, diagnostics } = load();
    // Non-colliding nested command: plain stem AND colon-qualified alias.
    const alias = skills.find((x) => x.name === "ops:status")!;
    expect(alias).toBeDefined();
    expect(alias.description).toBe("Ops status (nested, no collision)");
    expect(alias.legacyCommand).toBe(true);
    expect(alias.userInvocable).toBe(true); // still a slash command
    expect(alias.disableModelInvocation).toBe(true); // hidden from the listing — the plain stem lists
    // Non-colliding nested skill gets one too.
    const skillAlias = skills.find((x) => x.name === "group:nested-skill")!;
    expect(skillAlias).toBeDefined();
    expect(skillAlias.description).toBe("A nested skill relying on defaults");
    // No collision diagnostic for the always-on alias registrations.
    expect(
      diagnostics.some((d) => d.message.includes(`"ops:status"`) || d.message.includes(`"group:nested-skill"`)),
    ).toBe(false);
  });

  it("qualifies a colliding nested command as <subdir>:<stem> instead of dropping it", () => {
    const { skills, diagnostics } = load();
    // Top-level deploy.md wins the plain name.
    const deploy = skills.find((x) => x.name === "deploy")!;
    expect(deploy.description).toBe("Deploy the app");
    // Nested collision is registered under the colon-qualified name.
    const qualified = skills.find((x) => x.name === "frontend:deploy")!;
    expect(qualified).toBeDefined();
    expect(qualified.legacyCommand).toBe(true);
    expect(qualified.description).toBe("Frontend deploy (nested)");
    const info = diagnostics.find(
      (d) => d.severity === "info" && d.message.includes(`registered as "frontend:deploy"`),
    );
    expect(info).toBeDefined();
  });

  it("qualifies a colliding nested skill as <group>:<name>; first occurrence keeps the plain name", () => {
    const { skills, diagnostics } = load();
    const plain = skills.find((x) => x.name === "nested-skill")!;
    expect(plain.description).toBe("A nested skill relying on defaults");
    const qualified = skills.find((x) => x.name === "other:nested-skill")!;
    expect(qualified).toBeDefined();
    expect(qualified.description).toBe("Colliding nested skill (qualified)");
    const info = diagnostics.find(
      (d) => d.severity === "info" && d.message.includes(`registered as "other:nested-skill"`),
    );
    expect(info).toBeDefined();
  });

  it("recognizes license/display-name/default-enabled/fallback keys (no unknown-key warnings)", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "meta-rich")!;
    expect(s).toBeDefined();
    expect(s.unknownKeys).toEqual([]);
    expect(s.metadata["license"]).toBe("MIT");
    expect(s.metadata["display-name"]).toBe("Meta Rich");
    // description present → fallback unused
    expect(s.description).toBe("Has informational keys");
  });

  it("uses fallback: as the description default before the description-required skip", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "fallback-desc")!;
    expect(s).toBeDefined();
    expect(s.description).toBe("Description from fallback key");
    expect(loadSkillBody(s)).toContain("Body of fallback-desc.");
  });

  it("loads a skill with broken strict YAML via the lenient parser + fallback description", () => {
    const { skills } = load();
    const s = skills.find((x) => x.name === "broken-yaml")!;
    expect(s).toBeDefined();
    expect(s.description).toBe("Recovered description via fallback");
    expect(s.diagnostics.some((d) => d.message.includes("leniently"))).toBe(true);
    expect(loadSkillBody(s)).toContain("Body of broken-yaml skill.");
  });
});

// ---------------------------------------------------------------------------
// renderSkillListing
// ---------------------------------------------------------------------------

function mkSkill(name: string, description: string, extra: Partial<ClaudeSkill> = {}): ClaudeSkill {
  return {
    name,
    description,
    userInvocable: true,
    disableModelInvocation: false,
    contextFork: false,
    shell: "bash",
    metadata: {},
    baseDir: "/x",
    source: { path: "/x/SKILL.md", scope: "project" },
    legacyCommand: false,
    unknownKeys: [],
    diagnostics: [],
    ...extra,
  };
}

describe("renderSkillListing", () => {
  it("lists skills with trimmed descriptions and when_to_use", () => {
    const listing = renderSkillListing(
      [
        mkSkill("alpha", "A".repeat(300)),
        mkSkill("beta", "Short desc", { whenToUse: "Use when testing beta" }),
      ],
      { maxDescChars: 50 },
    );
    const lines = listing.split("\n");
    expect(lines[0]).toBe(`- alpha: ${"A".repeat(49)}…`);
    expect(lines[1]).toBe("- beta: Short desc (when: Use when testing beta)");
  });

  it("hides disable-model-invocation skills", () => {
    const listing = renderSkillListing(
      [mkSkill("visible", "yes"), mkSkill("hidden", "no", { disableModelInvocation: true })],
      {},
    );
    expect(listing).toContain("- visible: yes");
    expect(listing).not.toContain("hidden");
  });

  it("degrades in tiers over budget instead of omitting skills", () => {
    const skills = [
      mkSkill("one", "first description", { whenToUse: "when one" }),
      mkSkill("two", "second description", { whenToUse: "when two" }),
      mkSkill("three", "third description", { whenToUse: "when three" }),
    ];
    // Budget forces the names-only tier — every skill still appears.
    const listing = renderSkillListing(skills, { budgetChars: 25 });
    expect(listing.split("\n")).toEqual(["- one", "- two", "- three"]);
    expect(listing).not.toContain("+2 more skills");
  });
});

// ---------------------------------------------------------------------------
// substituteArguments
// ---------------------------------------------------------------------------

describe("substituteArguments", () => {
  it("replaces $ARGUMENTS with the full args string", () => {
    const { text, diagnostics } = substituteArguments("Fix issue $ARGUMENTS please", "123 now");
    expect(text).toBe("Fix issue 123 now please");
    expect(diagnostics).toHaveLength(0);
  });

  it("replaces 0-based positional $0/$1 and $ARGUMENTS[0] with quoted-token support", () => {
    const { text } = substituteArguments(
      "first=$ARGUMENTS[0] second=$1 also-first=$0",
      `"two words" 'single quoted'`,
    );
    expect(text).toBe("first=two words second=single quoted also-first=two words");
  });

  it("resolves $name from --name value flags", () => {
    const { text } = substituteArguments(
      "file=$file format=$format",
      "--file report.txt --format=yaml",
      [{ name: "file" }, { name: "format" }],
    );
    expect(text).toBe("file=report.txt format=yaml");
  });

  it("resolves $name from name=value pairs", () => {
    const { text } = substituteArguments("file=$file", "file=data.csv", [{ name: "file" }]);
    expect(text).toBe("file=data.csv");
  });

  it("resolves $name positionally by spec order and via defaults", () => {
    const { text } = substituteArguments(
      "file=$file format=$format mode=$mode",
      "a.txt xml",
      [{ name: "file" }, { name: "format" }, { name: "mode", default: "fast" }],
    );
    expect(text).toBe("file=a.txt format=xml mode=fast");
  });

  it("escapes tokens with a single backslash (\\$N stays literal)", () => {
    const { text, diagnostics } = substituteArguments("Literal \\$0 and arg $0", "ten");
    expect(text).toBe("Literal $0 and arg ten");
    expect(diagnostics).toHaveLength(0);
  });

  it("substitutes empty string + info diagnostic for unmatched markers", () => {
    const { text, diagnostics } = substituteArguments(
      "a=[$3] b=[$missing]",
      "only-one",
      [{ name: "present" }, { name: "missing" }],
    );
    expect(text).toBe("a=[] b=[]");
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((d) => d.severity === "info")).toBe(true);
  });

  it("leaves non-argument $names verbatim", () => {
    const { text } = substituteArguments("Check $PATH and $HOME", "x", [{ name: "file" }]);
    expect(text).toContain("$PATH");
    expect(text).toContain("$HOME");
  });

  it("appends ARGUMENTS when args given but body has no marker; nothing when empty", () => {
    const withArgs = substituteArguments("Body without markers.", "extra input");
    expect(withArgs.text).toBe("Body without markers.\n\nARGUMENTS: extra input");

    const noArgs = substituteArguments("Body without markers.", "");
    expect(noArgs.text).toBe("Body without markers.");

    const markerAndArgs = substituteArguments("Use $ARGUMENTS here.", "abc");
    expect(markerAndArgs.text).toBe("Use abc here.");
    expect(markerAndArgs.text).not.toContain("ARGUMENTS:");
  });
});

// ---------------------------------------------------------------------------
// substituteVariables
// ---------------------------------------------------------------------------

describe("substituteVariables", () => {
  it("replaces known CLAUDE_* variables and leaves unknown ones verbatim", () => {
    const text =
      "dir=${CLAUDE_SKILL_DIR} proj=${CLAUDE_PROJECT_DIR} sid=${CLAUDE_SESSION_ID} " +
      "eff=${CLAUDE_EFFORT} root=${CLAUDE_PLUGIN_ROOT} unknown=${CLAUDE_NOT_A_THING} undef=${CLAUDE_UNDEF}";
    const out = substituteVariables(text, {
      CLAUDE_SKILL_DIR: "C:/skills/x",
      CLAUDE_PROJECT_DIR: "C:/proj",
      CLAUDE_SESSION_ID: "sess-1",
      CLAUDE_EFFORT: "high",
      CLAUDE_PLUGIN_ROOT: "C:/plug",
      CLAUDE_UNDEF: undefined,
    });
    expect(out).toBe(
      "dir=C:/skills/x proj=C:/proj sid=sess-1 eff=high root=C:/plug " +
        "unknown=${CLAUDE_NOT_A_THING} undef=${CLAUDE_UNDEF}",
    );
  });

  it("does not touch non-CLAUDE ${...} forms", () => {
    expect(substituteVariables("${HOME} stays", { CLAUDE_SKILL_DIR: "x" })).toBe("${HOME} stays");
  });
});

// ---------------------------------------------------------------------------
// shell injection
// ---------------------------------------------------------------------------

function binAvailable(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout: 20_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// Lazy, memoized shell probes: evaluated the first time a `runIf` guard needs
// them (during collection of the describe below) rather than at module import,
// so a host without the shell doesn't pay two capped `execFileSync` calls just
// to load this file. Each probe still runs at most once.
let bashProbe: boolean | undefined;
function hasBash(): boolean {
  return (bashProbe ??= binAvailable(resolveShellBinary("bash"), ["-c", "exit 0"]));
}
let powershellProbe: boolean | undefined;
function hasPowershell(): boolean {
  return (powershellProbe ??= binAvailable(resolveShellBinary("powershell"), [
    "-NoProfile",
    "-Command",
    "exit 0",
  ]));
}

describe("preprocessShellInjection", () => {
  // env is only the Claude-specific OVERLAY — the spawned shell must inherit
  // process.env (PATH, HOME, SystemRoot, …) on its own. Passing a full env here
  // would mask a missing inheritance merge (regression: skill subprocesses ran
  // without PATH when settings.env was empty).
  const baseOpts = { cwd: process.cwd(), env: {}, disabled: false } as const;

  it.runIf(hasBash())("replaces inline !`cmd` with stdout (bash)", async () => {
    const { text, diagnostics } = await preprocessShellInjection(
      "Version: !`echo inline-out` end",
      { ...baseOpts, shell: "bash" },
    );
    expect(text).toBe("Version: inline-out end");
    expect(diagnostics).toHaveLength(0);
  });

  it.runIf(hasBash())("replaces ```! fenced blocks with the script's stdout", async () => {
    const body = "Before\n```!\necho fenced-out\n```\nAfter";
    const { text } = await preprocessShellInjection(body, { ...baseOpts, shell: "bash" });
    expect(text).toBe("Before\nfenced-out\nAfter");
  });

  it("substitutes a disabled note when execution is disabled", async () => {
    const { text, diagnostics } = await preprocessShellInjection("Run !`echo nope` now", {
      ...baseOpts,
      shell: "bash",
      disabled: true,
    });
    expect(text).toBe("Run [shell execution disabled: echo nope] now");
    expect(diagnostics).toHaveLength(1);
  });

  it.runIf(hasBash())("preserves the literal text of a failing command + diagnostic (never throws)", async () => {
    const body = "Status: !`echo boom >&2; exit 3`";
    const { text, diagnostics } = await preprocessShellInjection(body, {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe(body); // Claude behavior: the literal placeholder stays
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
    expect(diagnostics[0]!.message).toContain("exit 3");
    expect(diagnostics[0]!.message).toContain("boom");
  });

  it.runIf(hasBash())("preserves a failing ```! fenced block verbatim", async () => {
    const body = "Before\n```!\necho fen >&2\nexit 7\n```\nAfter";
    const { text, diagnostics } = await preprocessShellInjection(body, {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe(body);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
  });

  it.runIf(hasBash())("mixes preserved failures with successful injections single-pass", async () => {
    const { text } = await preprocessShellInjection(
      "ok: !`echo fine` bad: !`exit 2`",
      { ...baseOpts, shell: "bash" },
    );
    expect(text).toBe("ok: fine bad: !`exit 2`");
  });

  it.runIf(hasPowershell())("runs powershell when shell: powershell", async () => {
    const { text } = await preprocessShellInjection("PS: !`Write-Output ps-out`", {
      ...baseOpts,
      shell: "powershell",
    });
    expect(text).toBe("PS: ps-out");
  });

  it("does not trigger inside inline code spans", async () => {
    const body = "Docs: use `` !`echo nope` `` to inject.";
    const { text, diagnostics } = await preprocessShellInjection(body, {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe(body);
    expect(diagnostics).toHaveLength(0);
  });

  it("does not trigger inside non-! fenced code blocks", async () => {
    const body = "Example:\n```bash\n!`echo nope`\n```\ndone";
    const { text, diagnostics } = await preprocessShellInjection(body, {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe(body);
    expect(diagnostics).toHaveLength(0);
  });

  it.runIf(hasBash())("still injects after a code span on the same line", async () => {
    const { text } = await preprocessShellInjection("See `docs` then !`echo after-span`", {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe("See `docs` then after-span");
  });
});

// ---------------------------------------------------------------------------
// env inheritance: commands see process.env with the overlay layered on top
// ---------------------------------------------------------------------------

describe("shell injection env inheritance", () => {
  const baseOpts = { cwd: process.cwd(), disabled: false } as const;

  it.runIf(hasBash())("inherits process.env vars absent from the overlay (bash)", async () => {
    process.env.PICC_TEST_INHERIT = "inherited-ok";
    try {
      const { text, diagnostics } = await preprocessShellInjection(
        'V: !`echo "$PICC_TEST_INHERIT"`',
        { ...baseOpts, env: {}, shell: "bash" },
      );
      expect(diagnostics).toHaveLength(0);
      expect(text).toBe("V: inherited-ok");
    } finally {
      delete process.env.PICC_TEST_INHERIT;
    }
  });

  it.runIf(hasBash())("strips launcher inheritance while preserving an explicit skill-shell value", async () => {
    process.env.PICC_LAUNCHER_PID = "99";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    try {
      const { text } = await preprocessShellInjection(
        'V: !`printf "%s|%s|%s" "$PICC_LAUNCHER_PID" "$PI_SKIP_VERSION_CHECK" "$SKILL_SETTING"`',
        { ...baseOpts, env: { SKILL_SETTING: "kept" }, shell: "bash" },
      );
      expect(text).toBe("V: ||kept");
    } finally {
      delete process.env.PICC_LAUNCHER_PID;
      delete process.env.PI_SKIP_VERSION_CHECK;
    }
  });

  it.runIf(hasBash())("overlay vars win over inherited process.env", async () => {
    process.env.PICC_TEST_LAYER = "from-process";
    try {
      const { text } = await preprocessShellInjection('V: !`echo "$PICC_TEST_LAYER"`', {
        ...baseOpts,
        env: { PICC_TEST_LAYER: "from-overlay" },
        shell: "bash",
      });
      expect(text).toBe("V: from-overlay");
    } finally {
      delete process.env.PICC_TEST_LAYER;
    }
  });

  it.runIf(hasPowershell())("inherits process.env vars under powershell too", async () => {
    process.env.PICC_TEST_INHERIT_PS = "ps-inherited";
    try {
      const { text } = await preprocessShellInjection(
        "V: !`Write-Output $env:PICC_TEST_INHERIT_PS`",
        { ...baseOpts, env: {}, shell: "powershell" },
      );
      expect(text).toBe("V: ps-inherited");
    } finally {
      delete process.env.PICC_TEST_INHERIT_PS;
    }
  });
});

// ---------------------------------------------------------------------------
// resolveShellBinary: powershell → pwsh first, Windows PowerShell fallback
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// shellNamespaceDiffersFromNative: injectable platform, exact predicate
// ---------------------------------------------------------------------------

describe("shellNamespaceDiffersFromNative", () => {
  it("is false on non-win32 platforms regardless of Git Bash presence", () => {
    expect(shellNamespaceDiffersFromNative("linux")).toBe(false);
    expect(shellNamespaceDiffersFromNative("darwin")).toBe(false);
  });

  it("on win32 equals whether a real Git Bash is pinned (never bare-bash/WSL)", () => {
    // Structural equality holds on any host: off-Windows resolveGitBashPath() is
    // undefined (so false); on Windows with Git Bash it is the exact conjunction.
    expect(shellNamespaceDiffersFromNative("win32")).toBe(resolveGitBashPath() !== undefined);
  });

  it("defaults to the real platform (no note off-Windows)", () => {
    expect(shellNamespaceDiffersFromNative()).toBe(
      process.platform === "win32" && resolveGitBashPath() !== undefined,
    );
    if (process.platform !== "win32") {
      expect(shellNamespaceDiffersFromNative()).toBe(false);
    }
  });
});

describe("resolveShellBinary: powershell", () => {
  const pwshName = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  let binRoot: string;

  beforeAll(() => {
    binRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc-psbin-"));
  });
  afterAll(() => {
    fs.rmSync(binRoot, { recursive: true, force: true });
  });

  /** Fresh dir with the given (empty) marker binaries, plus env pinning all probe roots to it. */
  function fakeInstall(name: string, files: string[]): { dir: string; env: Record<string, string> } {
    const dir = path.join(binRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), "");
    const nowhere = path.join(binRoot, name + "-nowhere");
    return {
      dir,
      env: { PATH: dir, ProgramFiles: nowhere, "ProgramFiles(x86)": nowhere, SystemRoot: nowhere },
    };
  }

  it("prefers pwsh (PowerShell Core) from PATH", () => {
    const { dir, env } = fakeInstall("both", [pwshName, "powershell.exe"]);
    expect(resolveShellBinary("powershell", env)).toBe(path.join(dir, pwshName));
  });

  it.runIf(process.platform === "win32")(
    "falls back to powershell.exe on Windows when pwsh is absent",
    () => {
      const { dir, env } = fakeInstall("winps-only", ["powershell.exe"]);
      expect(resolveShellBinary("powershell", env)).toBe(path.join(dir, "powershell.exe"));
    },
  );

  it("degrades to a bare name when no PowerShell exists (never throws)", () => {
    const { env } = fakeInstall("none", []);
    expect(resolveShellBinary("powershell", env)).toBe(
      process.platform === "win32" ? "powershell" : "pwsh",
    );
  });

  it("degrades a missing PowerShell to preserved literal text + a clear diagnostic", async () => {
    const { env } = fakeInstall("none-run", []);
    const body = "PS: !`Write-Output x`";
    const { text, diagnostics } = await preprocessShellInjection(body, {
      cwd: process.cwd(),
      env,
      disabled: false,
      shell: "powershell",
    });
    expect(text).toBe(body); // literal preserved on spawn failure
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
    expect(diagnostics[0]!.message).toContain("PowerShell not found");
  });
});
