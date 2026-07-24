import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/claude/agents.js";
import { loadSettings } from "../src/discovery/settings.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import type { PermissionRules, ToolCallDescriptor } from "../src/types.js";
import {
  expectShippedSkillContract,
  resolveMarkdownLinks,
  shippedArtifactPaths,
} from "./helpers/shipped-artifact-contract.js";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const paths = shippedArtifactPaths(DEFAULT_ROOT);
const implementFile = (name: string): string => path.join(paths.implementFeature, "references", name);
const compact = (file: string): string => fs.readFileSync(file, "utf8").toLowerCase().replace(/\s+/g, " ");
const ordered = (body: string, markers: readonly string[]): void => {
  let cursor = -1;
  for (const marker of markers) {
    const next = body.indexOf(marker.toLowerCase(), cursor + 1);
    expect(next, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
};
const contains = (body: string, markers: readonly string[]): void => {
  for (const marker of markers) expect(body).toContain(marker.toLowerCase());
};

let evaluateRouter = "";
let implementRouter = "";
let loadedAgents: ReturnType<typeof loadAgents>;

beforeAll(() => {
  evaluateRouter = expectShippedSkillContract(paths, "evaluate").toLowerCase().replace(/\s+/g, " ");
  implementRouter = expectShippedSkillContract(paths, "implement-feature", {
    approvedExternalFiles: [path.join(paths.root, "doc", "documentation-guide.md")],
    representativeArguments: "#173 compact security contracts",
  }).toLowerCase().replace(/\s+/g, " ");
  loadedAgents = loadAgents([{ dir: paths.agents, scope: "project" }]);
});

describe("shipped skill and agent structure", () => {
  it("loads both closed prompt graphs and rejects a symlinked repository root", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc-artifact-root-"));
    const alias = path.join(parent, "alias");
    try {
      fs.symlinkSync(paths.root, alias, process.platform === "win32" ? "junction" : "dir");
      const aliasPaths = {
        ...paths,
        root: alias,
        skills: path.join(alias, ".claude", "skills"),
        evaluate: path.join(alias, ".claude", "skills", "evaluate"),
        implementFeature: path.join(alias, ".claude", "skills", "implement-feature"),
        agents: path.join(alias, ".claude", "agents"),
      };
      expect(() => expectShippedSkillContract(aliasPaths, "evaluate")).toThrow(/must not be a symlink/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("keeps the exact declared and effective workflow-agent capability sets", () => {
    expect(loadedAgents.diagnostics).toEqual([]);
    const engine = new PermissionEngine({ allow: [], deny: [], ask: [], additionalDirectories: [] }, { cwd: paths.root });
    const known = [
      "Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch", "WebFetch", "Agent", "Task",
      "TaskOutput", "TaskStop", "SendMessage", "Skill", "EnterWorktree", "ExitWorktree", "TodoWrite",
    ];
    const expected = {
      evaluator: ["Read", "Grep", "Glob"],
      implementer: ["Read", "Grep", "Glob", "Bash", "Edit", "Write"],
      generalist: ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"],
    } as const;
    for (const [name, tools] of Object.entries(expected)) {
      const agent = loadedAgents.agents.find((candidate) => candidate.name === name);
      expect(agent, `${name} must load`).toBeDefined();
      expect(agent!.diagnostics).toEqual([]);
      expect(agent!.tools).toEqual(tools);
      expect(engine.gateTools(agent!.tools, agent!.disallowedTools, known)).toEqual(tools);
    }
    const generalist = loadedAgents.agents.find((candidate) => candidate.name === "generalist")!;
    const generalistBody = generalist.body.toLowerCase();
    expect(generalistBody).toContain("never modify the repository");
    expect(generalistBody).toContain("run only non-mutating commands");
  });

  it("keeps Phase 0–9 linked to their unique procedure owners", () => {
    const phases = [...implementRouter.matchAll(/## phase (\d+)\b([\s\S]*?)(?= ## phase \d+\b|(?![\s\S]))/g)];
    const owners = [
      "phase-0-ticket-preflight.md", "phase-1-direction.md", "phase-2-workspace.md",
      "phase-3-feature-spec.md", "phase-4-how-investigation.md", "phase-5-task-breakdown.md",
      "phase-6-plan-review.md", "phase-7-implementation.md", "phase-8-close-review.md", "phase-9-handoff.md",
    ];
    expect(phases.map((phase) => Number(phase[1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    phases.forEach((phase, index) => expect(phase[0]).toContain(`references/${owners[index]}`));
  });
});

describe("small stable prompt security kernels", () => {
  it("retains evaluate's resident and canonical write/egress floor", () => {
    contains(evaluateRouter, ["confirms with the human before any public write", "if it cannot be read, refuse all public writes"]);
    const discipline = compact(path.join(paths.evaluate, "references", "write-discipline.md"));
    contains(discipline, [
      "explicit confirmation", "--body-file", "never `--body \"...\"`", "never merge",
      "no tokens, env, credentials", "raw command output/diffs", "absolute local paths",
      "attribution trailer", "idempotent on resume", "`<n>` must match `^[0-9]+$`", "trusted, already-resolved `target`",
    ]);
    const engine = compact(path.join(paths.evaluate, "references", "evaluation-engine.md"));
    contains(engine, ["same four-part bounded shape", "bounded, repo-relative evidence anchors (0–5)", "never over 5"]);
  });

  it("retains implement-feature's canonical write floor", () => {
    const discipline = compact(implementFile("ticket-integration.md"));
    contains(discipline, [
      "explicit, per-item, user-approved", "--body-file <path>", "never `--body \"...\"`", "resolved `target`",
      "never merge", "no tokens", "no env", "no credential", "raw command/test output or diffs",
      "avoid absolute local paths", "attribution", "idempotent on resume", "`#n` comes from the user's invocation only",
      "single positive integer", "refuse all public writes",
    ]);
  });

  it("retains the review loop's trust-boundary kernel", () => {
    const dispatch = compact(implementFile("dispatch-discipline.md"));
    const implementation = compact(implementFile("phase-7-implementation.md"));
    contains(dispatch, [
      "git --no-pager diff --no-ext-diff --no-textconv ...",
      "must prohibit the full repository test suite",
      "both the command and its execution path are benign",
      "coordinator-owned full green gates",
    ]);
    contains(implementation, [
      "`security` whenever execution/permissions/paths are involved",
      "coordinator must not add the unforeseen path to implementer writable authority",
      "git --no-pager --literal-pathspecs diff --no-ext-diff --no-textconv head -- <exact-path>",
      "before any subsequent project-controlled command or check",
      "any failed check or mismatch stops with no push or further project-controlled execution",
      "reject absolute paths", "traversal", "`.git` internals", "secret or credential paths or content",
      "symlinks or aliases", "broad globs", "unresolved path safety",
      "reject executable fixtures", "command-bearing content",
    ]);
  });

  it("keeps the compact untrusted-ticket order and structured preflight", () => {
    const queryStart = implementRouter.indexOf("gh api repos/<issue-host>/issues/<n>");
    const queryEnd = implementRouter.indexOf("}'", queryStart);
    const query = implementRouter.slice(queryStart, queryEnd + 2);
    expect(queryStart).toBeGreaterThanOrEqual(0);
    for (const freeText of ["title", "body", "comments"]) expect(query).not.toContain(freeText);
    ordered(implementRouter, [
      "title,body,comments > <tempfile>", "shell-free **`evaluator`**", "explicit approval",
      "approval caches `title`/`body`/`comments` **post-approval**",
    ]);
    contains(compact(implementFile("ticket-integration.md")), ["--repo <target>", "never directly copy, interpolate, slugify, or mechanically transform raw ticket text"]);
  });
});

const EXPECTED_GITHUB_DENY = [
  "Bash(gh pr merge *)", "Bash(gh pr close *)", "Bash(gh pr reopen *)", "Bash(gh pr edit *)", "Bash(gh pr review *)",
  "Bash(gh issue edit *)", "Bash(gh issue delete *)", "Bash(gh issue lock *)", "Bash(gh issue reopen *)",
  "Bash(gh repo delete *)", "Bash(gh repo rename *)", "Bash(gh repo archive *)",
  "Bash(gh label create *)", "Bash(gh label delete *)", "Bash(gh label edit *)",
  "Bash(gh api * --method *)", "Bash(gh api * -X *)", "Bash(gh api * -f *)", "Bash(gh api * -F *)", "Bash(gh api graphql *)",
  "Bash(gh api -X *)", "Bash(gh api --method *)", "Bash(gh api -f *)", "Bash(gh api -F *)",
  "Bash(gh api --field *)", "Bash(gh api --raw-field *)", "Bash(gh api --input *)",
  "Bash(gh api * --field *)", "Bash(gh api * --raw-field *)", "Bash(gh api * --input *)",
  "Bash(gh api *--method=*)", "Bash(gh api *--field=*)", "Bash(gh api *--raw-field=*)",
] as const;
const DENY_COMMANDS = [
  "gh pr merge 5", "gh pr close 5", "gh pr reopen 5", "gh pr edit 5 --title x", "gh pr review 5 --approve",
  "gh issue edit 5 --title x", "gh issue delete 5", "gh issue lock 5", "gh issue reopen 5",
  "gh repo delete o/r", "gh repo rename next", "gh repo archive o/r", "gh label create bug", "gh label delete bug",
  "gh label edit bug --name fixed", "gh api repos/o/r --method PATCH", "gh api repos/o/r -X DELETE",
  "gh api repos/o/r -f name=x", "gh api repos/o/r -F count=2", "gh api graphql", "gh api -X PUT repos/o/r",
  "gh api --method PATCH repos/o/r", "gh api -f name=x repos/o/r", "gh api -F count=2 repos/o/r",
  "gh api --field name=x repos/o/r", "gh api --raw-field body=x repos/o/r", "gh api --input payload.json repos/o/r",
  "gh api repos/o/r --field name=x", "gh api repos/o/r --raw-field body=x", "gh api repos/o/r --input payload.json",
  "gh api repos/o/r --method=PATCH", "gh api repos/o/r --field=name=x", "gh api repos/o/r --raw-field=body=x",
] as const;

describe("shipped settings capability floor", () => {
  let fixture = "";
  let settings: ReturnType<typeof loadSettings>;
  let permission: PermissionEngine;
  const call = (command: string): ToolCallDescriptor => ({ tool: "Bash", input: { command }, cwd: fixture });
  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "picc-shipped-settings-"));
    fs.mkdirSync(path.join(fixture, ".claude"));
    fs.mkdirSync(path.join(fixture, "empty-user"));
    fs.copyFileSync(paths.settings, path.join(fixture, ".claude", "settings.json"));
    settings = loadSettings({ cwd: fixture, projectRoot: fixture, userDir: path.join(fixture, "empty-user"), managedPaths: [] });
    permission = new PermissionEngine(settings.permissions, { cwd: fixture });
  });
  afterAll(() => fs.rmSync(fixture, { recursive: true, force: true }));

  it("keeps the exact plugin and destructive-command floors", () => {
    expect(settings.diagnostics).toEqual([]);
    expect(settings.enabledPlugins).toEqual({ "skill-creator@claude-plugins-official": true });
    expect(settings.permissions.deny).toEqual(EXPECTED_GITHUB_DENY);
  });
  it.each(EXPECTED_GITHUB_DENY.map((rule, index) => [rule, DENY_COMMANDS[index]!] as const))
    ("enforces %s through the real permission engine", (rule, command) => {
      expect(permission.evaluate(call(command)).decision).toBe("deny");
      const isolated: PermissionRules = { allow: [], deny: [rule], ask: [], additionalDirectories: [] };
      expect(new PermissionEngine(isolated, { cwd: fixture }).evaluate(call(command)).decision).toBe("deny");
    });
  it.each([
    "gh repo view owner/repo --json name", "gh api repos/o/r/issues/5 --jq '.state'",
    "gh issue list --repo owner/repo --state all", "gh issue view 5", "gh pr view 5", "gh pr diff 5",
    "gh issue comment 5 --body-file /tmp/body.md", "gh pr comment 5 --body-file /tmp/body.md",
    // Create and close are consent-gated controls; delete is the representative destructive issue action.
    "gh issue create --title x --body-file /tmp/body.md", "gh issue close 5 --reason 'not planned'",
  ])("does not deny legitimate control: %s", (command) => {
    expect(permission.evaluate(call(command)).decision).not.toBe("deny");
  });
});

type Classification = "read-only" | "non-executing-pointer" | "canonical-owner" | "actual-write-site" | "indirect-write-site";
const CORPUS_POLICY = new Map<string, Classification>([
  ["SKILL.md", "actual-write-site"], ["references/dispatch-discipline.md", "read-only"],
  ["references/fork.md", "read-only"], ["references/phase-0-ticket-preflight.md", "read-only"],
  ["references/phase-1-direction.md", "read-only"], ["references/phase-1-fork-disclosure.md", "read-only"],
  ["references/phase-1-ticket-scope.md", "non-executing-pointer"], ["references/phase-2-workspace.md", "read-only"],
  ["references/phase-3-feature-spec.md", "indirect-write-site"], ["references/phase-3-ticket-file.md", "actual-write-site"],
  ["references/phase-4-how-investigation.md", "read-only"], ["references/phase-5-task-breakdown.md", "read-only"],
  ["references/phase-6-plan-review.md", "read-only"], ["references/phase-7-implementation.md", "read-only"],
  ["references/phase-8-close-review.md", "read-only"], ["references/phase-8-file-finding.md", "actual-write-site"],
  ["references/phase-8-ticket-close.md", "non-executing-pointer"], ["references/phase-9-fork-handoff.md", "actual-write-site"],
  ["references/phase-9-handoff.md", "actual-write-site"], ["references/resume-and-aborting.md", "read-only"],
  ["references/review-triage.md", "read-only"], ["references/templates.md", "read-only"],
  ["references/ticket-creation.md", "indirect-write-site"], ["references/ticket-integration.md", "canonical-owner"],
]);

describe("implement-feature Markdown policy classification", () => {
  it("classifies every recursive Markdown file and links each known write site fail-closed", () => {
    const found: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) found.push(file);
      }
    };
    visit(paths.implementFeature);
    const names = found.map((file) => path.relative(paths.implementFeature, file).replace(/\\/g, "/")).sort();
    expect(names).toEqual([...CORPUS_POLICY.keys()].sort());
    const canonicalOwner = fs.realpathSync(implementFile("ticket-integration.md"));
    for (const name of names) {
      const classification = CORPUS_POLICY.get(name)!;
      if (classification !== "actual-write-site" && classification !== "indirect-write-site") continue;
      const file = path.join(paths.implementFeature, name);
      expect(resolveMarkdownLinks(file).some((link) => link.realPath === canonicalOwner), `${name}: canonical owner link`).toBe(true);
      const body = fs.readFileSync(file, "utf8");
      expect(body, `${name}: local unreadable floor`).toMatch(/(?:cannot|can't|can’t)\s+be\s+read|unreadable/i);
      expect(body, `${name}: local refusal floor`).toMatch(/\brefuse\b/i);
    }
  });
});

// Narrative intent is not mechanically interpreted; universal prompt discipline and human review own it.
