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
import { preprocessShellInjection, resolveShellBinary } from "../src/engine/shell-inject.js";
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "piclaudex-skills-"));
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

  // Legacy commands.
  write(
    ".claude/commands/deploy.md",
    `---
description: Deploy the app
argument-hint: "[env]"
---
Deploy to $ARGUMENTS now.
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

  it("honors the character budget and appends (+N more skills)", () => {
    const skills = [
      mkSkill("one", "first description"),
      mkSkill("two", "second description"),
      mkSkill("three", "third description"),
    ];
    const firstLine = "- one: first description";
    const listing = renderSkillListing(skills, { budgetChars: firstLine.length + 3 });
    expect(listing.split("\n")[0]).toBe(firstLine);
    expect(listing).toContain("… (+2 more skills)");
    expect(listing).not.toContain("second");
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

  it("replaces positional $1 and $ARGUMENTS[0] with quoted-token support", () => {
    const { text } = substituteArguments(
      "first=$ARGUMENTS[0] second=$2 also-first=$1",
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

  it("escapes $$ to a literal dollar", () => {
    const { text } = substituteArguments("Costs $$5 and arg $1", "ten");
    expect(text).toBe("Costs $5 and arg ten");
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

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  return env;
}

function binAvailable(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout: 20_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasBash = binAvailable(resolveShellBinary("bash"), ["-c", "exit 0"]);
const hasPowershell = binAvailable(resolveShellBinary("powershell"), [
  "-NoProfile",
  "-Command",
  "exit 0",
]);

describe("preprocessShellInjection", () => {
  const baseOpts = { cwd: process.cwd(), env: shellEnv(), disabled: false } as const;

  it.runIf(hasBash)("replaces inline !`cmd` with stdout (bash)", async () => {
    const { text, diagnostics } = await preprocessShellInjection(
      "Version: !`echo inline-out` end",
      { ...baseOpts, shell: "bash" },
    );
    expect(text).toBe("Version: inline-out end");
    expect(diagnostics).toHaveLength(0);
  });

  it.runIf(hasBash)("replaces ```! fenced blocks with the script's stdout", async () => {
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

  it.runIf(hasBash)("degrades a failing command to a note + diagnostic (never throws)", async () => {
    const { text, diagnostics } = await preprocessShellInjection(
      "Status: !`echo boom >&2; exit 3`",
      { ...baseOpts, shell: "bash" },
    );
    expect(text).toBe("Status: [command failed (exit 3): boom]");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("warning");
  });

  it.runIf(hasPowershell)("runs powershell when shell: powershell", async () => {
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

  it.runIf(hasBash)("still injects after a code span on the same line", async () => {
    const { text } = await preprocessShellInjection("See `docs` then !`echo after-span`", {
      ...baseOpts,
      shell: "bash",
    });
    expect(text).toBe("See `docs` then after-span");
  });
});
