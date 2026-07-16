import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Parent-only guard (tester NIT-2): the last test boots the REAL picc harness
// with only the Pi SDK's session creation faked, so it can dispatch a real
// subagent and inspect the tool list that subagent's session actually receives.
// This file has no static import of the Pi module, so this mock cleanly
// intercepts subagents.ts's dynamic `loadRealSdk` import (unlike sendmessage.test,
// whose top-level SessionManager import defeats interception).
const rcMock = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  // t05: capture DefaultResourceLoader options so a dispatch's systemPromptOverride
  // (which carries the subagent system prompt) is inspectable — it is threaded via
  // the loader, not createAgentSession.
  loaderOptions: [] as Array<Record<string, unknown>>,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const { fakeSdk: makeFakeSdk } = await import("./helpers/fake-sdk.js");
  const { sdk } = makeFakeSdk({ replies: ["rc-nit2-done"], created: rcMock.created });
  const BaseLoader = sdk.DefaultResourceLoader as new (o: Record<string, unknown>) => unknown;
  return {
    ...real,
    createAgentSession: (options: Record<string, unknown>) => sdk.createAgentSession(options),
    DefaultResourceLoader: class extends (BaseLoader as new (o: Record<string, unknown>) => object) {
      constructor(o: Record<string, unknown>) {
        super(o);
        rcMock.loaderOptions.push(o);
      }
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    getAgentDir: () => "/fake-agent-dir",
  };
});
import piccExtension from "../src/index.js";
import { fakePi } from "./helpers/fake-pi.js";
import { CwdState } from "../src/runtime/cwd-state.js";
import {
  applyUpdatedInput,
  claudeToolsToPiBuiltins,
  toClaudeCall,
  toClaudeToolName,
  touchedFilePath,
} from "../src/runtime/tool-map.js";
import {
  buildSystemPromptSuffix,
  contextForTouchedFile,
  newSessionContextState,
  resetInjectionState,
  COLLABORATIVE_PLANNING_GUIDANCE,
  COLLABORATIVE_PLANNING_MAX_WORDS,
} from "../src/runtime/context-assembly.js";
import { mapEffort, steeringForModel, type PiCCConfig } from "../src/runtime/steering.js";
import { createAgentToolDefinition, extractText, type SubagentRuntime } from "../src/runtime/subagents.js";
import { visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";
import type { ProgressSnapshot } from "../src/runtime/subagent-progress.js";
import { renderAgentResult } from "../src/runtime/subagent-render.js";
import {
  bgSlotForCtx,
  reframe,
  themedBg,
  wrapForSelfShell,
  type RenderCtx,
} from "../src/runtime/tool-shell.js";
import { agentTrailerFrame } from "../src/util/subagent-transcripts.js";
import {
  fakeSdk,
  makeAgent,
  makeSubagentRuntime,
  type FakeReply,
  type SubagentRuntimeOverrides,
} from "./helpers/fake-sdk.js";
import type { ClaudeAgent, ClaudeSettings } from "../src/types.js";

function baseSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

describe("CwdState", () => {
  it("swaps and restores the effective cwd", () => {
    const s = new CwdState("C:\\base");
    expect(s.get()).toBe("C:\\base");
    s.enterWorktree("C:\\base\\.claude\\worktrees\\x");
    expect(s.get()).toBe("C:\\base\\.claude\\worktrees\\x");
    expect(s.getWorktree()).toBe("C:\\base\\.claude\\worktrees\\x");
    s.exitWorktree();
    expect(s.get()).toBe("C:\\base");
    expect(s.getWorktree()).toBeUndefined();
  });
});

describe("tool-map", () => {
  it("maps pi built-ins to Claude names and passes unknown names through", () => {
    expect(toClaudeToolName("read")).toBe("Read");
    expect(toClaudeToolName("find")).toBe("Glob");
    expect(toClaudeToolName("WebFetch")).toBe("WebFetch");
  });

  it("grants pi builtins from Claude tool lists", () => {
    expect(claudeToolsToPiBuiltins(["Read", "Grep"]).sort()).toEqual(["grep", "read"]);
    expect(claudeToolsToPiBuiltins(["Glob"]).sort()).toEqual(["find", "ls"]);
    expect(claudeToolsToPiBuiltins(["*"])).toContain("bash");
    expect(claudeToolsToPiBuiltins(["WebFetch"])).toEqual([]);
  });

  it("translates path to file_path for matching and back for updatedInput", () => {
    const call = toClaudeCall("read", { path: "src/a.ts" }, "C:\\proj");
    expect(call.tool).toBe("Read");
    expect(call.input.file_path).toBe("src/a.ts");

    const live: Record<string, unknown> = { path: "src/a.ts" };
    applyUpdatedInput("read", live, { file_path: "src/b.ts" });
    expect(live.path).toBe("src/b.ts");

    // F26: a live grep reaches the engine as a matchable Grep call with
    // file_path populated, so a Read(<glob>) deny can gate it by path.
    const grepCall = toClaudeCall("grep", { path: "secrets/x" }, "C:\\proj");
    expect(grepCall.tool).toBe("Grep");
    expect(grepCall.input.file_path).toBe("secrets/x");

    const custom: Record<string, unknown> = { url: "https://x" };
    applyUpdatedInput("WebFetch", custom, { url: "https://y" });
    expect(custom.url).toBe("https://y");
  });

  it("reports touched files only for file tools", () => {
    expect(touchedFilePath("read", { path: "a.ts" })).toBe("a.ts");
    expect(touchedFilePath("edit", { file_path: "b.ts" })).toBe("b.ts");
    expect(touchedFilePath("MultiEdit", { file_path: "x.ts" })).toBe("x.ts");
    expect(touchedFilePath("bash", { command: "cat a.ts" })).toBeUndefined();
  });
});

describe("steering", () => {
  const config: PiCCConfig = {
    steering: { "openai/*": "Be terse.", "*/gpt-5*": "Use locked YAML faithfully." },
    effortMap: { low: "low", medium: "medium", high: "high", max: "max", maximum: "max" },
    diagnostics: [],
  };

  it("concatenates all matching steering patterns", () => {
    expect(steeringForModel(config, "openai/gpt-5.5")).toBe("Be terse.\n\nUse locked YAML faithfully.");
    expect(steeringForModel(config, "anthropic/claude-x")).toBeUndefined();
  });

  it("maps effort values and prose", () => {
    expect(mapEffort(config, "high")).toBe("high");
    expect(mapEffort(config, "apply MAXIMUM reasoning effort")).toBe("max");
    expect(mapEffort(config, undefined)).toBeUndefined();
    expect(mapEffort(config, "unmappable-nonsense")).toBeUndefined();
  });

  it("matches provider-less patterns against the bare model id (regression: silently never matched)", () => {
    const cfg: PiCCConfig = {
      steering: { "*": "ALL-MODELS", "gpt-5*": "GPT-GUIDANCE" },
      effortMap: {},
      diagnostics: [],
    };
    expect(steeringForModel(cfg, "openai/gpt-5.5")).toContain("ALL-MODELS");
    expect(steeringForModel(cfg, "openai/gpt-5.5")).toContain("GPT-GUIDANCE");
    expect(steeringForModel(cfg, "anthropic/claude-x")).toBe("ALL-MODELS");
  });

  it("never throws on a malformed steering pattern", () => {
    const cfg: PiCCConfig = { steering: { "[unclosed": "X" }, effortMap: {}, diagnostics: [] };
    expect(() => steeringForModel(cfg, "openai/gpt-5.5")).not.toThrow();
  });
});

describe("context assembly", () => {
  const claudeMd = [
    {
      path: "C:\\proj\\CLAUDE.md",
      dir: "C:\\proj",
      content: "ROOT-INSTRUCTIONS",
      scope: "project" as const,
      loadAtStart: true,
      diagnostics: [],
    },
  ];

  it("builds a suffix containing instructions, rules, skills, agents and steering", () => {
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [
        { id: "a.md", body: "UNCOND-RULE", source: { path: "x", scope: "project" }, unknownKeys: [], diagnostics: [] },
        { id: "b.md", paths: ["src/**"], body: "PATH-RULE", source: { path: "y", scope: "project" }, unknownKeys: [], diagnostics: [] },
      ],
      skills: [
        {
          name: "sk",
          description: "does things",
          userInvocable: true,
          disableModelInvocation: false,
          contextFork: false,
          shell: "bash" as const,
          metadata: {},
          baseDir: "d",
          source: { path: "p", scope: "project" as const },
          legacyCommand: false,
          unknownKeys: [],
          diagnostics: [],
        },
      ],
      agents: [makeAgent()],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
      steeringText: "STEER-TEXT",
    });
    expect(suffix).toContain("ROOT-INSTRUCTIONS");
    expect(suffix).toContain("UNCOND-RULE");
    expect(suffix).not.toContain("PATH-RULE"); // path-scoped rules only inject on touch
    expect(suffix).toContain("- sk: does things");
    expect(suffix).toContain("reviewer: Reviews things");
    expect(suffix).toContain("STEER-TEXT");
    expect(suffix).toContain("Claude Code compatibility conventions");
    // F15 anti-regression: the highest-leverage nudge — the HARNESS_CONVENTIONS
    // subagent line (emitted every turn to every dispatching context) — must carry
    // the background-by-default framing and the collect-with-TaskOutput directive,
    // so a silent revert to opt-in framing fails here rather than only in prose.
    expect(suffix).toMatch(/background by default/i);
    expect(suffix).toMatch(/collect each result with TaskOutput before you rely on it or finalize/i);
    expect(suffix).toMatch(/eligible uncollected results receive one bounded notice/i);
    expect(suffix).toMatch(/later interactive turn/i);
    expect(suffix).toMatch(/one-shot print mode may end before that turn/i);
    expect(suffix).not.toMatch(/otherwise its result is lost/i);
    // F19 anti-regression: the every-turn conventions block must nudge richer
    // commit messages (match the repo's git-log style; why-not-what body), so a
    // silent drop fails here rather than only in prose. The `--no-verify`
    // prohibition is folded into the same Commits bullet — guard it too so a
    // reword can't silently drop the hook-bypass ban.
    expect(suffix).toMatch(/recent git log/i);
    expect(suffix).toMatch(/why the change was made/i);
    expect(suffix).toMatch(/--no-verify/);
    // F24: the always-on collaborative-planning nudge is rendered as trailing
    // bullets INSIDE the conventions block — after its header and before the next
    // `\n## ` section — so it stays a soft default the later, more-specific
    // sections (CLAUDE.md / skills / steering) can override. A newline-free
    // load-bearing phrase is grepped so CRLF-vs-LF can't split the match.
    const nudgePhrase = "ask only when blocked";
    const nudgeIdx = suffix.indexOf(nudgePhrase);
    expect(nudgeIdx).toBeGreaterThan(-1);
    const conventionsIdx = suffix.indexOf("Claude Code compatibility conventions");
    expect(conventionsIdx).toBeGreaterThan(-1);
    expect(nudgeIdx).toBeGreaterThan(conventionsIdx);
    const nextSectionIdx = suffix.indexOf("\n## ", conventionsIdx + 1);
    expect(nextSectionIdx).toBeGreaterThan(-1);
    expect(nudgeIdx).toBeLessThan(nextSectionIdx);
  });

  it("keeps the collaborative-planning nudge within its word/character budget (F24)", () => {
    const words = COLLABORATIVE_PLANNING_GUIDANCE.trim().split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(60); // guards accidental gutting
    expect(words).toBeLessThanOrEqual(COLLABORATIVE_PLANNING_MAX_WORDS); // = 120, anti-bloat
    expect(COLLABORATIVE_PLANNING_MAX_WORDS).toBe(120); // pins the acceptance criterion
    const chars = COLLABORATIVE_PLANNING_GUIDANCE.replace(/\r\n/g, "\n").length;
    expect(chars).toBeLessThanOrEqual(900); // long words can't dodge the word ceiling
  });

  // Feature 25 / #48: per-session scratchpad injection.
  const SCRATCH = "C:/Users/x/AppData/Local/Temp/picc-scratch-abc123";

  // The Windows note is discriminated by note-specific content ("different namespaces"),
  // NOT by "mktemp -p" — the all-platform body legitimately names mktemp as one recipe.
  const WIN_NOTE_MARK = /different namespaces/;

  it("injects the literal scratch-dir path and Claude's imperative directive on all platforms", () => {
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
      scratchDir: SCRATCH,
    });
    expect(suffix).toContain(SCRATCH);
    expect(suffix).toContain("## Scratchpad directory");
    // Claude-faithful imperative + instead-of-/tmp + escape hatch.
    expect(suffix).toMatch(/IMPORTANT: Always use/);
    expect(suffix).toMatch(/instead of `\/tmp`/);
    expect(suffix).toMatch(/Only use `\/tmp` if the user explicitly requests it/);
    // Narrowed skill-override exception (UX): defer only to a specific literal path.
    expect(suffix).toMatch(/defer to a skill only when it names a specific literal path/);
    // Redirect pattern covered (not just mktemp) — the shape evaluate actually uses.
    expect(suffix).toContain(`> "${SCRATCH}/name"`);
    // No Windows note without the flag.
    expect(suffix).not.toMatch(WIN_NOTE_MARK);
    // Anti-regression: existing conventions block still present.
    expect(suffix).toContain("Claude Code compatibility conventions");
  });

  it("appends the Windows namespace note only when windowsTempNote is true", () => {
    const withNote = buildSystemPromptSuffix({
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
      scratchDir: SCRATCH,
      windowsTempNote: true,
    });
    expect(withNote).toMatch(WIN_NOTE_MARK);
    // Safe addressing: mktemp -p and the redirect form, bound to the scratch dir.
    expect(withNote).toContain(`mktemp -p "${SCRATCH}"`);
    expect(withNote).toContain(`"${SCRATCH}/name"`);
    // The why clause (drive-relative + forward-slash identical).
    expect(withNote).toMatch(/drive-relative/i);
    expect(withNote).toMatch(/forward-slash drive-letter/i);
    // Never $TEMP/$TMP (cygpath mention dropped per UX NIT).
    expect(withNote).toMatch(/never a bare `\/tmp\/\.\.\.`, `\$TEMP`, or `\$TMP`/);

    const withoutNote = buildSystemPromptSuffix({
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
      scratchDir: SCRATCH,
      windowsTempNote: false,
    });
    expect(withoutNote).not.toMatch(WIN_NOTE_MARK);
  });

  it("emits no scratchpad section (and no Windows note) when scratchDir is undefined", () => {
    const inputs = {
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
    } as const;
    const baseline = buildSystemPromptSuffix(inputs);
    // Even with the flag forced on, no scratchDir means no section at all.
    const flagged = buildSystemPromptSuffix({ ...inputs, windowsTempNote: true });
    expect(flagged).toBe(baseline); // byte-for-byte: off-Windows output unchanged
    expect(baseline).not.toContain("## Scratchpad directory");
    expect(baseline).not.toMatch(WIN_NOTE_MARK);
    // Existing sections intact.
    expect(baseline).toContain("Claude Code compatibility conventions");
  });

  it("keeps activated skill bodies resident", () => {
    const state = newSessionContextState(claudeMd);
    state.activeSkills.set("sk", "ACTIVE-SKILL-BODY");
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state,
    });
    expect(suffix).toContain("ACTIVE-SKILL-BODY");
  });

  it("injects nested CLAUDE.md and path rules once per session on file touch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-ctx-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "CLAUDE.md"), "NESTED-SRC");
      fs.writeFileSync(path.join(dir, "src", "a.rs"), "fn main(){}");
      const state = newSessionContextState([]);
      const rules = [
        {
          id: "rust.md",
          paths: ["src/**/*.rs"],
          body: "RUST-RULE",
          source: { path: "r", scope: "project" as const },
          unknownKeys: [],
          diagnostics: [],
        },
      ];
      const first = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state,
      });
      expect(first).toContain("NESTED-SRC");
      expect(first).toContain("RUST-RULE");
      const second = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state,
      });
      expect(second).toBeUndefined();

      // Plan §9: after compaction the once-only markers reset, so the next
      // relevant access re-injects (regression: markers were never cleared).
      resetInjectionState(state, []);
      const afterCompact = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state,
      });
      expect(afterCompact).toContain("NESTED-SRC");
      expect(afterCompact).toContain("RUST-RULE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same-named rules from different scopes BOTH inject (regression: id collision suppressed one)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-ctx-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "a.ts"), "x");
      const rules = [
        {
          id: "style.md",
          paths: ["src/**"],
          body: "PROJECT-STYLE",
          source: { path: path.join(dir, ".claude", "rules", "style.md"), scope: "project" as const },
          unknownKeys: [],
          diagnostics: [],
        },
        {
          id: "style.md",
          paths: ["src/**"],
          body: "USER-STYLE",
          source: { path: path.join(os.homedir(), ".claude", "rules", "style.md"), scope: "user" as const },
          unknownKeys: [],
          diagnostics: [],
        },
      ];
      const injected = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.ts"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state: newSessionContextState([]),
      });
      expect(injected).toContain("PROJECT-STYLE");
      expect(injected).toContain("USER-STYLE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("path-scoped rules fire inside worktree checkouts (regression: never matched there)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-ctx-"));
    try {
      const wtSrc = path.join(dir, ".claude", "worktrees", "wt1", "src");
      fs.mkdirSync(wtSrc, { recursive: true });
      fs.writeFileSync(path.join(wtSrc, "main.rs"), "fn main(){}");
      const rules = [
        {
          id: "rust.md",
          paths: ["src/**/*.rs"],
          body: "RUST-RULE",
          source: { path: "r", scope: "project" as const },
          unknownKeys: [],
          diagnostics: [],
        },
      ];
      const worktreeCwd = path.join(dir, ".claude", "worktrees", "wt1");
      const injected = contextForTouchedFile({
        filePath: path.join(wtSrc, "main.rs"), // absolute, the normal post-EnterWorktree case
        cwd: worktreeCwd,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state: newSessionContextState([]),
      });
      expect(injected).toContain("RUST-RULE");

      // Relative paths resolve against the session cwd, not the project root.
      const relative = contextForTouchedFile({
        filePath: path.join("src", "main.rs"),
        cwd: worktreeCwd,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state: newSessionContextState([]),
      });
      expect(relative).toContain("RUST-RULE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces paths:-scoped skills once when a matching file is touched (plan §4.1 paths:)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-ctx-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "a.rs"), "x");
      const skills = [
        {
          name: "rust-helper",
          description: "Helps with Rust",
          paths: ["src/**/*.rs"],
          userInvocable: true,
          disableModelInvocation: false,
          contextFork: false,
          shell: "bash" as const,
          metadata: {},
          baseDir: "d",
          source: { path: "p", scope: "project" as const },
          legacyCommand: false,
          unknownKeys: [],
          diagnostics: [],
        },
      ];
      const state = newSessionContextState([]);
      const first = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules: [],
        settings: baseSettings(),
        state,
        skills,
      });
      expect(first).toContain("rust-helper");
      const second = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules: [],
        settings: baseSettings(),
        state,
        skills,
      });
      expect(second).toBeUndefined(); // suggested once
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SubagentRuntime (fake SDK)", () => {
  function makeRuntime(
    agents: ClaudeAgent[],
    replies: Array<string | FakeReply>,
    overrides: SubagentRuntimeOverrides = {},
  ) {
    const { sdk, created } = fakeSdk({ replies });
    const runtime = makeSubagentRuntime(agents, sdk, overrides);
    return { runtime, created };
  }

  it("returns the final assistant message verbatim", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["```yaml\nverdict: approve\n```"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("```yaml\nverdict: approve\n```");
  });

  it("unknown subagent_type falls back to general-purpose with a visible note (H1)", async () => {
    const startPrompts: string[] = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        if (event === "SubagentStart") startPrompts.push(String(payload.prompt ?? ""));
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const { runtime, created } = makeRuntime([makeAgent()], ["fallback-done"], { hookRunner });
    const result = await runtime.dispatch({ subagentType: "nope", prompt: "real task", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.agentName).toBe("general-purpose");
    expect(result.finalMessage).toBe("fallback-done");
    expect(created).toHaveLength(1);
    // Visible degrade: diagnostic note AND a notice line prepended to the prompt.
    expect(
      result.diagnostics.some((d) =>
        d.message.includes('unknown subagent_type "nope"; ran as general-purpose'),
      ),
    ).toBe(true);
    expect(
      startPrompts[0]?.startsWith(
        '(You were dispatched as subagent type "nope", which is not defined in this project; you are running as a general-purpose agent.)',
      ),
    ).toBe(true);
    expect(startPrompts[0]).toContain("real task");
  });

  it("enforces the depth cap", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["x"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("depth");
    expect(result.error).toContain("subagents.maxDepth");
    expect(result.error).toContain("2..5");
  });

  it('subagent_type "fork" is RESERVED — it never hits the generic unknown-type fallback (F16)', async () => {
    // makeRuntime wires no getMainSessionFile → a fork degrades (no transcript),
    // but it must NEVER surface the generic unknown-type warning: the interception
    // always sets `resolved`, so the fork-specific notice fires instead.
    const prev = process.env.CLAUDE_CODE_FORK_SUBAGENT;
    delete process.env.CLAUDE_CODE_FORK_SUBAGENT; // unset ⇒ enabled
    try {
      const { runtime } = makeRuntime([makeAgent()], ["fresh-fork-run"]);
      const result = await runtime.dispatch({ subagentType: "fork", prompt: "task", depth: 1 });
      expect(result.ok).toBe(true);
      expect(result.isFork).toBeFalsy(); // degraded (no parent transcript here)
      expect(result.agentName).toBe("general-purpose");
      expect(
        result.diagnostics.some((d) => d.message.includes('unknown subagent_type "fork"')),
      ).toBe(false);
      expect(
        result.diagnostics.some((d) => d.message.startsWith("fork ran with fresh context:")),
      ).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_FORK_SUBAGENT;
      else process.env.CLAUDE_CODE_FORK_SUBAGENT = prev;
    }
  });

  it("gates tools per agent (read-only agent gets no write/edit/bash builtins)", async () => {
    const { runtime, created } = makeRuntime(
      [makeAgent({ tools: ["Read", "Grep", "Glob"] })],
      ["ok"],
    );
    await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const tools = created[0]?.tools as string[];
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("bash");
  });

  it("retries once on an empty reply", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["", "second answer"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("second answer");
    expect(result.diagnostics.some((d) => d.message.includes("retried"))).toBe(true);
  });

  it("runs dispatches in parallel under the concurrency cap", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["a"]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("case-insensitive agent resolution", async () => {
    const { runtime } = makeRuntime([makeAgent({ name: "Reviewer" })], ["ok"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
  });

  it("Agent tool definition dispatches at depth+1 and throws on failure", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["fine"]);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    };
    const res = await tool.execute("t1", { subagent_type: "reviewer", prompt: "go" });
    expect(res.content[0]?.text).toBe("fine");
    // Unknown types fall back to general-purpose (H1) rather than throwing.
    const fallback = await tool.execute("t2", { subagent_type: "ghost", prompt: "go" });
    expect(fallback.details.agent).toBe("general-purpose");
    // Genuine failures (depth cap) still throw.
    const deep = createAgentToolDefinition(runtime, { depth: 5 }) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(deep.execute("t3", { subagent_type: "reviewer", prompt: "go" })).rejects.toThrow(/depth/);
  });

  it("extractText joins text blocks only", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }])).toBe("ab");
    expect(extractText("plain")).toBe("plain");
  });

  it("returns the final message VERBATIM with run_in_background (note goes to details only)", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["```yaml\nlocked: true\n```"]);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    };
    const res = await tool.execute("t1", {
      subagent_type: "reviewer",
      prompt: "go",
      run_in_background: true,
    });
    expect(res.content[0]?.text).toBe("```yaml\nlocked: true\n```");
    expect(String(res.details.note ?? "")).toContain("run_in_background");
  });

  it("depth-2 nested dispatch completes at concurrency 1 (regression: semaphore deadlock)", async () => {
    const agents = [makeAgent({ name: "outer" }), makeAgent({ name: "inner" })];
    // A fake model: the outer session "calls" the nested Agent tool, the inner replies.
    const { sdk } = fakeSdk({
      onPrompt: async (text, session) => {
        const agentTool = session.customTools.find((t) => t.name === "Agent");
        if (agentTool && text.includes("delegate")) {
          const res = await agentTool.execute("id", { subagent_type: "inner", prompt: "leaf work" });
          return `nested:${res.content[0].text}`;
        }
        return "leaf-done";
      },
    });
    const runtime: SubagentRuntime = makeSubagentRuntime(agents, sdk, {
      customToolsFor: (_a: ClaudeAgent, _g: string[], depth: number) =>
        depth + 1 <= 2 ? [createAgentToolDefinition(runtime, { depth, name: "Agent" })] : [],
      allKnownToolNames: () => ["Read"],
      concurrency: 1, // old code: guaranteed deadlock for ANY depth-2 nesting
    });
    const result = await runtime.dispatch({ subagentType: "outer", prompt: "please delegate", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("nested:leaf-done");
  }, 10_000);

  it("isolation: worktree runs the subagent in its own worktree cwd and keeps it on exit", async () => {
    const enters: Array<Record<string, unknown>> = [];
    const exits: Array<Record<string, unknown>> = [];
    const worktrees = {
      async enter(opts: Record<string, unknown>) {
        enters.push(opts);
        return {
          ok: true,
          worktreePath: `C:\\proj\\.claude\\worktrees\\${opts.name}`,
          branch: "b",
          diagnostics: [],
        };
      },
      async exit(opts: Record<string, unknown>) {
        exits.push(opts);
        return {};
      },
    };
    const { runtime, created } = makeRuntime([makeAgent({ isolation: "worktree" })], ["done"], {
      worktrees,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.worktreePath).toContain("worktrees");
    expect(created[0]?.cwd).toBe(result.worktreePath);
    expect(exits[0]).toEqual({ worktreePath: result.worktreePath, action: "keep" });
  });

  it("parallel fan-out of one isolation: worktree agent gets DISTINCT worktree names (regression: Date.now collision)", async () => {
    const names: string[] = [];
    const worktrees = {
      async enter(opts: Record<string, unknown>) {
        names.push(String(opts.name));
        return { ok: true, worktreePath: `C:\\p\\.claude\\worktrees\\${opts.name}`, diagnostics: [] };
      },
      async exit() {
        return {};
      },
    };
    const { runtime } = makeRuntime([makeAgent({ isolation: "worktree" })], ["ok"], { worktrees });
    await Promise.all(
      Array.from({ length: 4 }, () => runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 })),
    );
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
  });

  it("worktree entry failure degrades to the shared cwd with a warning", async () => {
    const worktrees = {
      async enter() {
        return { ok: false, error: "boom", diagnostics: [] };
      },
      async exit() {
        return {};
      },
    };
    const { runtime, created } = makeRuntime([makeAgent({ isolation: "worktree" })], ["ok"], { worktrees });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes("entry failed"))).toBe(true);
    expect(created[0]?.cwd).toBe(process.cwd());
  });

  it("SubagentStop block re-prompts the subagent and returns the revised answer", async () => {
    let stops = 0;
    const hookRunner = {
      fire: async (event: string) => {
        if (event === "SubagentStop" && stops++ === 0) {
          return { block: true, blockReason: "tests not run", askDowngraded: false, diagnostics: [] };
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const { runtime } = makeRuntime([makeAgent()], ["first answer", "validated answer"], { hookRunner });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("validated answer");
    expect(stops).toBeGreaterThanOrEqual(2);
  });

  it("SubagentStart block aborts the dispatch before any session is created", async () => {
    const hookRunner = {
      fire: async (event: string) => {
        if (event === "SubagentStart") {
          return { block: true, blockReason: "not allowed here", askDowngraded: false, diagnostics: [] };
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const { runtime, created } = makeRuntime([makeAgent()], ["never"], { hookRunner });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed here");
    expect(created).toHaveLength(0);
  });

  it("unresolvable agent model inherits the session model with a warning diagnostic", async () => {
    const inherited = { provider: "openai", id: "session-model" };
    const { runtime, created } = makeRuntime([makeAgent({ model: "ghost-model-9000" })], ["ok"], {
      resolveModel: (spec: string | undefined) => (spec === undefined ? inherited : undefined),
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((d) => d.message.includes("ghost-model-9000"))).toBe(true);
    expect(created[0]?.model).toBe(inherited);
  });

  it("maxTurns registers an enforcement extension that blocks tool calls past the cap", async () => {
    const { runtime, created } = makeRuntime([makeAgent({ maxTurns: 2 })], ["ok"]);
    await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const loader = created[0]?.resourceLoader as { options: Record<string, unknown> };
    const factories = loader.options.extensionFactories as Array<{ name: string; factory: (pi: unknown) => unknown }>;
    const maxTurnsFactory = factories.find((f) => f.name.includes("maxturns"));
    expect(maxTurnsFactory, "expected a maxTurns enforcement extension").toBeDefined();

    // Drive the extension directly: 3 turns exceed the cap of 2 → tool calls block.
    const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
    maxTurnsFactory!.factory({
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
    });
    const fire = (event: string) => handlers.get(event)?.map((h) => h({}, {}));
    fire("turn_start");
    fire("turn_start");
    expect(fire("tool_call")?.[0]).toBeUndefined(); // within cap
    fire("turn_start");
    const blocked = fire("tool_call")?.[0] as { block?: boolean; reason?: string };
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("maxTurns");
  });

  // -------------------------------------------------------------------------
  // Built-in agent types (audit E1/E2)
  // -------------------------------------------------------------------------

  it("empty subagent_type defaults to the built-in general-purpose agent (E2)", async () => {
    const seen: ClaudeAgent[] = [];
    // customToolsFor sees the RESOLVED agent on every dispatch (the fake loader
    // never calls the lazy systemPromptOverride).
    const { runtime } = makeRuntime([makeAgent()], ["gp-done"], {
      customToolsFor: (a: ClaudeAgent) => {
        seen.push(a);
        return [];
      },
    });
    const result = await runtime.dispatch({ subagentType: "", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.agentName).toBe("general-purpose");
    expect(result.finalMessage).toBe("gp-done");
    expect(seen[0]?.builtin).toBe(true);
  });

  it("built-ins resolve AFTER project agents: a project Explore overrides the built-in (E1)", async () => {
    const seen: ClaudeAgent[] = [];
    const capture = {
      customToolsFor: (a: ClaudeAgent) => {
        seen.push(a);
        return [];
      },
    };
    const { runtime } = makeRuntime(
      [makeAgent({ name: "Explore", description: "project explorer" })],
      ["ok"],
      capture,
    );
    await runtime.dispatch({ subagentType: "Explore", prompt: "p", depth: 1 });
    expect(seen[0]?.source.scope).toBe("project");

    // Without a project override, the built-in resolves.
    seen.length = 0;
    const { runtime: rt2 } = makeRuntime([makeAgent()], ["ok"], capture);
    const result = await rt2.dispatch({ subagentType: "Plan", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(seen[0]?.builtin).toBe(true);
    expect(seen[0]?.name).toBe("Plan");
  });

  it("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS removes Explore/Plan from dispatch (H1: they fall back to general-purpose); general-purpose stays", async () => {
    const prev = process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS;
    process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = "1";
    try {
      const { runtime } = makeRuntime([makeAgent()], ["ok"]);
      const explore = await runtime.dispatch({ subagentType: "Explore", prompt: "p", depth: 1 });
      expect(explore.ok).toBe(true);
      expect(explore.agentName).toBe("general-purpose");
      expect(
        explore.diagnostics.some((d) =>
          d.message.includes('unknown subagent_type "Explore"; ran as general-purpose'),
        ),
      ).toBe(true);
      const gp = await runtime.dispatch({ subagentType: "general-purpose", prompt: "p", depth: 1 });
      expect(gp.ok).toBe(true);
      expect(gp.diagnostics.some((d) => d.message.includes("unknown subagent_type"))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS;
      else process.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS = prev;
    }
  });

  // -------------------------------------------------------------------------
  // Model resolution order (audit E5): env > param > frontmatter > session
  // -------------------------------------------------------------------------

  it("CLAUDE_CODE_SUBAGENT_MODEL beats the model param, which beats frontmatter, which beats session", async () => {
    const specs: Array<string | undefined> = [];
    const { runtime } = makeRuntime([makeAgent({ model: "fm-model" })], ["ok"], {
      resolveModel: (spec: string | undefined) => {
        specs.push(spec);
        return { spec };
      },
    });
    const prev = process.env.CLAUDE_CODE_SUBAGENT_MODEL;
    try {
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = "env-model";
      await runtime.dispatch({ subagentType: "reviewer", prompt: "p", model: "param-model", depth: 1 });
      expect(specs).toEqual(["env-model"]);

      // "inherit" (and empty) mean the env var is unset → the param wins.
      specs.length = 0;
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = "inherit";
      await runtime.dispatch({ subagentType: "reviewer", prompt: "p", model: "param-model", depth: 1 });
      expect(specs).toEqual(["param-model"]);

      specs.length = 0;
      process.env.CLAUDE_CODE_SUBAGENT_MODEL = "";
      await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
      expect(specs).toEqual(["fm-model"]);

      // No env, no param, no frontmatter → session model (undefined spec).
      specs.length = 0;
      delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      const { runtime: plain } = makeRuntime([makeAgent()], ["ok"], {
        resolveModel: (spec: string | undefined) => {
          specs.push(spec);
          return undefined;
        },
      });
      await plain.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
      expect(specs).toEqual([undefined]);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
      else process.env.CLAUDE_CODE_SUBAGENT_MODEL = prev;
    }
  });

  // -------------------------------------------------------------------------
  // Agent-scoped hooks (audit C10)
  // -------------------------------------------------------------------------

  it("agent frontmatter hooks dispatch scoped to the subagent: guard wiring + Stop→SubagentStop mapping", async () => {
    const scopedEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const scopedConfigs: Array<Record<string, unknown>> = [];
    const makeScopedHookRunner = (config: Record<string, unknown>) => {
      scopedConfigs.push(config);
      return {
        fire: async (event: string, payload: Record<string, unknown>) => {
          scopedEvents.push({ event, payload });
          return { block: false, askDowngraded: false, diagnostics: [] };
        },
      };
    };
    const agent = makeAgent({
      hooks: {
        PreToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "echo pre", raw: {} }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "echo stop", raw: {} }] }],
      },
    });
    const { runtime, created } = makeRuntime([agent], ["ok"], { makeScopedHookRunner });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);

    // parseHookConfig ran on the frontmatter and the scoped runner announces itself.
    expect(Object.keys(scopedConfigs[0] ?? {})).toEqual(["PreToolUse", "Stop"]);
    expect(
      result.diagnostics.some((d) => d.severity === "info" && d.message.includes("agent-scoped hooks")),
    ).toBe(true);

    // The multiplexed runner fired the Subagent* lifecycle for the scoped runner
    // and mapped the agent's Stop hooks to SubagentStop time.
    const events = scopedEvents.map((e) => e.event);
    expect(events).toContain("SubagentStart");
    expect(events).toContain("SubagentStop");
    expect(events).toContain("Stop");

    // Guard wiring: this dispatch's tool events reach the scoped runner too.
    const loader = created[0]?.resourceLoader as { options: Record<string, unknown> };
    const factories = loader.options.extensionFactories as Array<{
      name: string;
      factory: (pi: unknown) => unknown;
    }>;
    const guardFactory = factories.find((f) => f.name.includes("guard"));
    expect(guardFactory).toBeDefined();
    const handlers = new Map<string, (e: unknown, c: unknown) => unknown>();
    guardFactory!.factory({
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => handlers.set(event, handler),
      sendMessage: () => undefined,
    });
    scopedEvents.length = 0;
    await handlers.get("tool_call")!({ toolName: "read", toolCallId: "t", input: { path: "a.ts" } }, {});
    expect(scopedEvents.map((e) => e.event)).toContain("PreToolUse");
  });

  it("a blocking agent Stop hook re-prompts the subagent at SubagentStop time", async () => {
    let stops = 0;
    const makeScopedHookRunner = () => ({
      fire: async (event: string) => {
        if (event === "Stop" && stops++ === 0) {
          return {
            block: true,
            blockReason: "agent stop hook says continue",
            askDowngraded: false,
            diagnostics: [],
          };
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    });
    const agent = makeAgent({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check", raw: {} }] }] },
    });
    const { runtime } = makeRuntime([agent], ["first answer", "revised answer"], {
      makeScopedHookRunner,
    });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("revised answer");
  });

  it("agent hook systemMessages surface in the dispatch diagnostics, once per distinct message (H4)", async () => {
    const makeScopedHookRunner = () => ({
      fire: async () => ({
        block: false,
        askDowngraded: false,
        diagnostics: [],
        systemMessages: ["deploy checklist incomplete"],
      }),
    });
    const agent = makeAgent({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "check", raw: {} }] }] },
    });
    const { runtime } = makeRuntime([agent], ["ok"], { makeScopedHookRunner });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    const surfaced = result.diagnostics.filter((d) =>
      d.message.includes("deploy checklist incomplete"),
    );
    expect(surfaced).toHaveLength(1); // every fire returned it; surfaced once
    expect(surfaced[0]?.message).toContain("systemMessage");
  });

  it("an agent without hooks never constructs a scoped runner", async () => {
    let calls = 0;
    const makeScopedHookRunner = () => {
      calls++;
      return { fire: async () => ({ block: false, askDowngraded: false, diagnostics: [] }) };
    };
    const { runtime } = makeRuntime([makeAgent()], ["ok"], { makeScopedHookRunner });
    await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(calls).toBe(0);
  });
});

describe("Subagent live progress (t03)", () => {
  const streamReply = {
    text: "done",
    events: [
      { type: "turn_start", turnIndex: 0 },
      { type: "tool_execution_start", toolName: "Grep", args: { pattern: "foo" } },
      { type: "tool_execution_end", toolName: "Grep", result: "match", isError: false },
      {
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "final line" }] },
      },
    ],
  };

  it("dispatch streams condensed progress when the session supports subscribe", async () => {
    const { sdk } = fakeSdk({ replies: [streamReply] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const snapshots: ProgressSnapshot[] = [];
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      onProgress: (s) => snapshots.push(s),
    });
    expect(result.ok).toBe(true);
    // Progress is display-only: the verbatim final message is untouched.
    expect(result.finalMessage).toBe("done");
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.some((s) => s.activity === "running Grep…")).toBe(true);
    expect(snapshots.some((s) => s.tail.some((l) => l.includes("Grep")))).toBe(true);
  });

  it("dispatch works unchanged when the session lacks subscribe", async () => {
    const { sdk } = fakeSdk({ replies: ["ok"], noSubscribe: true });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const snapshots: ProgressSnapshot[] = [];
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      onProgress: (s) => snapshots.push(s),
    });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("ok");
    expect(snapshots.length).toBe(0);
  });

  it("Agent tool forwards live progress through onUpdate with the expected shape", async () => {
    const { sdk } = fakeSdk({
      replies: [
        {
          text: "ok",
          events: [{ type: "tool_execution_start", toolName: "Read", args: { file_path: "a.ts" } }],
        },
      ],
    });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: (u: {
          content: Array<{ type: string; text: string }>;
          details?: Record<string, unknown>;
        }) => void,
      ) => Promise<{ content: Array<{ text: string }> }>;
    };
    const updates: Array<{
      content: Array<{ type: string; text: string }>;
      details?: Record<string, unknown>;
    }> = [];
    const res = await tool.execute(
      "t1",
      { subagent_type: "reviewer", prompt: "go" },
      undefined,
      (u) => updates.push(u),
    );
    expect(res.content[0]?.text).toBe("ok"); // verbatim, unaffected by progress
    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]!;
    expect(last.content[0]?.type).toBe("text");
    expect(typeof last.content[0]?.text).toBe("string");
    expect((last.details?.subagentProgress as ProgressSnapshot | undefined)?.activity).toContain(
      "Read",
    );
    expect(last.details?.live).toBe(true);
  });

  it("renderCall shows the agent type and description / prompt head", () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      renderCall: (
        args: Record<string, unknown>,
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
    const withDesc = tool
      .renderCall({ subagent_type: "reviewer", description: "Review auth" }, undefined)
      .render(80)
      .join("\n");
    expect(withDesc).toContain("Agent(reviewer)");
    expect(withDesc).toContain("Review auth");

    const withPrompt = tool
      .renderCall({ subagent_type: "reviewer", prompt: "Do the thing please" }, undefined)
      .render(80)
      .join("\n");
    expect(withPrompt).toContain("Do the thing");

    const empty = tool.renderCall({}, undefined).render(80).join("\n");
    expect(empty).toContain("Agent(general-purpose)");
  });

  it("renderResult renders outcome, transcript, usage slot, and degrades on missing fields", () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      renderResult: (
        r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
        o: { isPartial?: boolean; expanded?: boolean },
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
    const render = (
      r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
      isPartial = false,
    ) => tool.renderResult(r, { isPartial }, undefined).render(120).join("\n");

    // Final, completed + resumable + transcript, no usage yet (t06).
    const completed = render({
      content: [{ type: "text", text: "the answer" }],
      details: {
        outcome: "completed",
        agent: "reviewer",
        transcriptPath: "/x/agent-abc.jsonl",
        resumable: true,
      },
    });
    expect(completed).toContain("completed");
    expect(completed).toContain("the answer");
    expect(completed).toContain("/x/agent-abc.jsonl");
    expect(completed).toContain("resumable");
    expect(completed).not.toContain("usage:");

    // Usage slot renders defensively when t06's field is present.
    const withUsage = render({
      content: [{ type: "text", text: "x" }],
      details: { outcome: "completed", usage: { totalTokens: 1200, costUsd: 0.03 } },
    });
    expect(withUsage).toContain("usage:");
    expect(withUsage).toContain("1200 tokens");

    // Failed-with-partial shows a failed badge and preserves the partial body.
    const failed = render({
      content: [{ type: "text", text: "partial work" }],
      details: { outcome: "failed", cutOff: true, agent: "reviewer" },
    });
    expect(failed).toContain("failed");
    expect(failed).toContain("partial work");

    // Partial/streaming shows the live tail + activity.
    const partial = render(
      {
        content: [],
        details: {
          subagentProgress: { tail: ["> Grep"], activity: "running Grep…" },
          agent: "reviewer",
          live: true,
        },
      },
      true,
    );
    expect(partial).toContain("running Grep…");
    expect(partial).toContain("Grep");

    // Empty details: never throws, falls back to the content text.
    const bare = render({ content: [{ type: "text", text: "hi" }], details: {} });
    expect(bare).toContain("hi");
  });

  it("render never emits a line wider than the terminal — no overflow (crash regression)", () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      renderCall: (a: Record<string, unknown>, theme: unknown) => { render: (w: number) => string[] };
      renderResult: (
        r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
        o: { isPartial?: boolean },
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
    // A theme whose fg/bold wrap text in real ANSI, so the escape-aware truncation
    // path is actually exercised (undefined theme emits plain text — no escapes).
    // E/B built from code points to keep this source file pure-ASCII (convention).
    const E = String.fromCharCode(27);
    const B = String.fromCharCode(7);
    const theme = {
      fg: (_c: string, s: string) => `${E}[31m${s}${E}[0m`,
      bold: (s: string) => `${E}[1m${s}${E}[22m`,
    };
    // Measure with pi-tui's OWN column width — the exact function pi-tui throws on
    // (grapheme + East-Asian-width + tabs=3). A code-unit count would falsely pass.
    const noOverflow = (lines: string[], width: number) => {
      for (const l of lines) expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width);
    };

    // Wide/tab/emoji content: pi-tui counts CJK/emoji as 2 cols and tabs as 3, so
    // these overflow the terminal at code-unit lengths that look "safe". Use escaped
    // code points to keep this source file pure-ASCII (project convention).
    const cjk = "字".repeat(60); // 字×60 = 120 columns
    const tabs = "\t".repeat(60); // 60 tabs = 180 columns
    const emoji = "\u{1F600}".repeat(40); // 😀×40 = 80 columns

    for (const width of [1, 2, 3, 20, 40, 138]) {
      // 1) Partial (crash #1 surface): long activity + wide tail + long agent name.
      const partial = tool
        .renderResult(
          {
            content: [],
            details: {
              subagentProgress: {
                tail: ["Read-only scouting covered the feature skill, ".repeat(4).trim(), cjk, emoji],
                activity: `${cjk} ${tabs}`,
              },
              agent: "Explore".repeat(20), // pathologically long → title backstop
              live: true,
            },
          },
          { isPartial: true },
          theme,
        )
        .render(width);
      noOverflow(partial, width);

      // 2) Final (crash #2 surface): outcome badge + tabbed body + long transcript footer.
      const longPath =
        "C:\\Users\\Arne\\.pi\\agent\\sessions\\--F--Arne-Projekte-picc--\\" +
        "2026-07-13T09-07-52-253Z_019f5abb.subagents\\agent-3b7caeaf8448.jsonl";
      const final = tool
        .renderResult(
          {
            content: [{ type: "text", text: `line1\n${tabs}tabbed body\n${cjk}` }],
            details: {
              outcome: "completed",
              agent: "docs",
              transcriptPath: longPath,
              resumable: true,
              agentId: "agent-3b7caeaf8448",
            },
          },
          { isPartial: false },
          theme,
        )
        .render(width);
      noOverflow(final, width);

      // 3) Background branch + dispatch-time call, both with overflowing content.
      const bg = tool
        .renderResult(
          { content: [{ type: "text", text: cjk }], details: { background: true, agent: "x" } },
          { isPartial: false },
          theme,
        )
        .render(width);
      noOverflow(bg, width);

      const call = tool
        .renderCall({ subagent_type: "x".repeat(200), description: cjk }, theme)
        .render(width);
      noOverflow(call, width);
    }

    // Footer UX: at a narrow width the transcript degrades to a basename (not the
    // unreadable wrapped full path); at a wide width the full path is shown intact.
    const longPath =
      "C:\\Users\\Arne\\.pi\\agent\\sessions\\--F--Arne-Projekte-picc--\\" +
      "2026-07-13T09-07-52-253Z_019f5abb.subagents\\agent-3b7caeaf8448.jsonl";
    const narrow = tool
      .renderResult(
        { content: [], details: { outcome: "completed", agent: "docs", transcriptPath: longPath } },
        { isPartial: false },
        undefined,
      )
      .render(40)
      .join("\n");
    expect(narrow).toContain("agent-3b7caeaf8448.jsonl"); // basename kept
    expect(narrow).not.toContain(longPath); // full path not wrapped in
    const wide = tool
      .renderResult(
        { content: [], details: { outcome: "completed", agent: "docs", transcriptPath: longPath } },
        { isPartial: false },
        undefined,
      )
      .render(200)
      .join("\n");
    expect(wide).toContain(longPath); // full path shown when it fits

    // Security: model-/file-supplied agent name with escapes never reaches the
    // terminal raw — the OSC title-set and CSI payload are stripped before display.
    const evil = `${E}]0;pwned${B}${E}[31mreviewer`;
    const badge = tool
      .renderResult(
        { content: [], details: { outcome: "completed", agent: evil } },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(badge).not.toContain(`${E}]0;`); // no OSC injected
    expect(badge).toContain("reviewer"); // sanitized name still shown
  });

  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);

  const renderTool = () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    return createAgentToolDefinition(runtime, { depth: 0 }) as {
      renderCall: (args: Record<string, unknown>, theme: unknown) => { render: (w: number) => string[] };
      renderResult: (
        r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
        o: { isPartial?: boolean; expanded?: boolean },
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
  };

  it("sanitizes model-supplied text in renderCall and renderResult display (SEC-2)", () => {
    const tool = renderTool();
    const call = tool
      .renderCall(
        { subagent_type: `${ESC}[31mreviewer${ESC}[0m`, description: `${ESC}]0;pwned${BEL}Review auth` },
        undefined,
      )
      .render(80)
      .join("\n");
    expect(call.includes(ESC)).toBe(false);
    expect(call.includes(BEL)).toBe(false);
    expect(call).toContain("reviewer");
    expect(call).toContain("Review auth");

    const result = tool
      .renderResult(
        {
          content: [{ type: "text", text: `${ESC}[2Jclean body${BEL}` }],
          details: { outcome: "completed", agent: "reviewer" },
        },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(result.includes(ESC)).toBe(false);
    expect(result.includes(BEL)).toBe(false);
    expect(result).toContain("clean body");
  });

  it("strips the t02 trailer frame from the human view, one resumable hint with the id (UX-2)", () => {
    const tool = renderTool();
    const agentId = "agent-0123456789ab";
    const rendered = tool
      .renderResult(
        {
          content: [
            { type: "text", text: `the answer${agentTrailerFrame(agentId, { completed: true })}` },
          ],
          details: {
            outcome: "completed",
            agent: "reviewer",
            resumable: true,
            agentId,
            transcriptPath: "/x/agent.jsonl",
          },
        },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(rendered).toContain("the answer");
    // The raw model-plumbing frame is gone from the human view.
    expect(rendered).not.toContain("---");
    expect(rendered).not.toMatch(/\[agent /);
    // "resumable via SendMessage" appears exactly once and carries the id.
    expect(rendered.match(/resumable via SendMessage/g)?.length).toBe(1);
    expect(rendered).toContain(agentId);
  });

  it("renders the (truncated) badge for a turn-capped (length-stop) success (UX-3)", async () => {
    const { sdk } = fakeSdk({ replies: [{ text: "partial answer", stopReason: "length" }] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ) => Promise<{
        content: Array<{ type: string; text: string }>;
        details?: Record<string, unknown>;
      }>;
      renderResult: (
        r: { content?: Array<{ type: string; text: string }>; details?: Record<string, unknown> },
        o: { isPartial?: boolean },
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "go" }, undefined);
    // UX-3 wiring: the truncated success marks cutOff so the badge can differ.
    expect(res.details?.cutOff).toBe(true);
    const rendered = tool.renderResult(res, { isPartial: false }, undefined).render(120).join("\n");
    expect(rendered).toContain("completed (truncated)");
  });

  it("renders the ■ aborted badge when details.outcome is aborted (UX-1)", () => {
    const tool = renderTool();
    const rendered = tool
      .renderResult(
        { content: [{ type: "text", text: "" }], details: { outcome: "aborted", agent: "reviewer" } },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(rendered).toContain("■");
    expect(rendered).toContain("aborted");
  });

  it("renderCall flags background and renderResult shows the background header (FIX-B)", () => {
    const tool = renderTool();
    const call = tool
      .renderCall({ subagent_type: "reviewer", run_in_background: true }, undefined)
      .render(80)
      .join("\n");
    expect(call).toContain("[background]");
    const result = tool
      .renderResult(
        {
          content: [{ type: "text", text: "Background task task-1 started" }],
          details: { background: true, agent: "reviewer" },
        },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(result).toContain("Agent → background");
    expect(result).toContain("Background task task-1 started");
  });

  it("unsubscribes from the session event stream after dispatch settles (FIX-B)", async () => {
    // Success path: finally runs on the normal return.
    const ok = fakeSdk({
      replies: [
        { text: "done", events: [{ type: "tool_execution_start", toolName: "Grep", args: {} }] },
      ],
    });
    const okRuntime = makeSubagentRuntime([makeAgent()], ok.sdk);
    const okResult = await okRuntime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      onProgress: () => {},
    });
    expect(okResult.ok).toBe(true);
    expect(ok.sessions[0]!.listenerCount()).toBe(0);

    // Throwing path: prompt() throws → dispatch catch-all → finally still unsubscribes.
    const boom = fakeSdk({
      onPrompt: () => {
        throw new Error("boom");
      },
    });
    const boomRuntime = makeSubagentRuntime([makeAgent()], boom.sdk);
    const boomResult = await boomRuntime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      onProgress: () => {},
    });
    expect(boomResult.ok).toBe(false);
    expect(boom.sessions[0]!.listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// TaskOutput background-identity render (F04 t03) — the taskId-gated additions
// to the SHARED renderAgentResult: identity header + agent-<id> subline at every
// surface, badge chips on all outcomes, poll frame, start-block, placeholders,
// and the width-clamp/sanitize guarantees. Pure renderer unit tests.
// ---------------------------------------------------------------------------

describe("TaskOutput identity render (F04 t03)", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const render = (
    details: Record<string, unknown>,
    text = "",
    isPartial = false,
    width = 120,
    theme: unknown = undefined,
  ) =>
    renderAgentResult(
      { content: [{ type: "text", text }], details },
      { isPartial },
      theme,
    )
      .render(width)
      .join("\n");

  it("completed / failed / aborted badges each carry the Task chip + agent-<id> subline", () => {
    const agentId = "agent-aabbccddeeff";
    const completed = render({
      taskId: "task-3",
      status: "completed",
      outcome: "completed",
      agent: "coder",
      agentId,
      transcriptPath: "/x/agent-aabbccddeeff.jsonl",
      resumable: true,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    }, "the answer");
    expect(completed).toContain("Task(task-3)");
    expect(completed).toContain("Agent(coder)");
    expect(completed).toContain("completed");
    expect(completed).toContain(agentId); // identity subline
    expect(completed).toContain("the answer");
    expect(completed).toContain("usage:");
    expect(completed).toContain("resumable via SendMessage");

    const failed = render({
      taskId: "task-4",
      status: "failed",
      outcome: "failed",
      agent: "coder",
      agentId,
    }, "partial");
    expect(failed).toContain("Task(task-4)");
    expect(failed).toMatch(/✗|failed/);
    expect(failed).toContain(agentId);

    const aborted = render({
      taskId: "task-5",
      status: "stopped",
      outcome: "aborted",
      agent: "coder",
      agentId,
    });
    expect(aborted).toContain("Task(task-5)");
    expect(aborted).toContain("aborted");
    expect(aborted).toContain(agentId);
  });

  it("a non-resumable builtin still shows agent-<id> as identity WITHOUT the SendMessage invite", () => {
    const agentId = "agent-001122334455";
    const out = render({
      taskId: "task-7",
      status: "completed",
      outcome: "completed",
      agent: "Explore",
      agentId,
      resumable: false,
    }, "scouted");
    expect(out).toContain(agentId); // identity present…
    expect(out).not.toContain("resumable via SendMessage"); // …but no false invite
  });

  it("the background start block is self-identifying: task-N + agent type + agent-<id>", () => {
    const out = render({
      background: true,
      taskId: "task-2",
      agent: "reviewer",
      agentId: "agent-0123456789ab",
    }, "Background task task-2 started");
    expect(out).toContain("Agent(reviewer) → background as task-2");
    expect(out).toContain("agent-0123456789ab");
    expect(out).toContain('TaskOutput(task_id "task-2")');
  });

  it("a live partial with an absent/empty snapshot renders the … starting… placeholder (not a bare header)", () => {
    const bare = render(
      { taskId: "task-8", agent: "coder", agentId: "agent-aabbccddeeff", live: true },
      "",
      true,
    );
    expect(bare).toContain("Task(task-8)");
    expect(bare).toContain("… starting…");

    const emptySnap = render(
      {
        taskId: "task-8",
        agent: "coder",
        agentId: "agent-aabbccddeeff",
        subagentProgress: { tail: [], activity: "" },
        live: true,
      },
      "",
      true,
    );
    expect(emptySnap).toContain("… starting…");
  });

  it("a live partial with a snapshot is self-identifying (task id + type + agent-<id> + tail + activity)", () => {
    const out = render(
      {
        taskId: "task-1",
        agent: "coder",
        agentId: "agent-aabbccddeeff",
        subagentProgress: { tail: ["> Grep (x)"], activity: "running Grep…" },
        live: true,
      },
      "> Grep (x)\n… running Grep…",
      true,
    );
    expect(out).toContain("Task(task-1)");
    expect(out).toContain("Agent(coder)");
    expect(out).toContain("agent-aabbccddeeff");
    expect(out).toContain("> Grep (x)");
    expect(out).toContain("running Grep…");
  });

  it("a wait:false poll renders the identity frame + last activity (not a bare chip); … starting… when idle", () => {
    const active = render({
      taskId: "task-6",
      status: "running",
      agent: "coder",
      agentId: "agent-aabbccddeeff",
      lastActivity: "running Grep…",
    }, "Background task task-6 (coder) is still running — running Grep…");
    expect(active).toContain("Task(task-6)");
    expect(active).toContain("Agent(coder)");
    expect(active).toContain("agent-aabbccddeeff");
    expect(active).toContain("running Grep…");

    const idle = render({
      taskId: "task-6",
      status: "running",
      agent: "coder",
      agentId: "agent-aabbccddeeff",
    });
    expect(idle).toContain("Task(task-6)");
    expect(idle).toContain("… starting…");
  });

  it("two same-type concurrent tasks render DISTINCT Task(task-N) + agent-<id> frames", () => {
    const a = render({
      taskId: "task-1",
      status: "running",
      agent: "coder",
      agentId: "agent-aaaa1111bbbb",
      lastActivity: "running Grep…",
    });
    const b = render({
      taskId: "task-2",
      status: "running",
      agent: "coder",
      agentId: "agent-cccc2222dddd",
      lastActivity: "running Read…",
    });
    expect(a).toContain("Task(task-1)");
    expect(a).toContain("agent-aaaa1111bbbb");
    expect(b).toContain("Task(task-2)");
    expect(b).toContain("agent-cccc2222dddd");
    expect(a).not.toContain("task-2");
    expect(b).not.toContain("task-1");
  });

  it("width + sanitize: partial, poll, and final gated lines never overflow, and agent-<id> survives at usable widths", () => {
    const theme = {
      fg: (_c: string, s: string) => `${ESC}[31m${s}${ESC}[0m`,
      bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
    };
    const noOverflow = (lines: string[], width: number) => {
      for (const l of lines) expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width);
    };
    const cjk = "字".repeat(60); // 120 columns
    const tabs = "\t".repeat(60); // 180 columns
    const emoji = "\u{1F600}".repeat(40); // 80 columns
    // A control-byte-laden agent type / activity — sanitized in the renderer.
    const evilType = `${ESC}[31mco${BEL}der${ESC}]0;pwned${BEL}`;
    const agentId = "agent-3b7caeaf8448";

    for (const width of [1, 2, 3, 20, 40, 138]) {
      const partial = renderAgentResult(
        {
          content: [],
          details: {
            taskId: "task-9",
            agent: evilType,
            agentId,
            subagentProgress: { tail: [cjk, emoji, "line"], activity: `${cjk} ${tabs}` },
            live: true,
          },
        },
        { isPartial: true },
        theme,
      ).render(width);
      noOverflow(partial, width);

      const poll = renderAgentResult(
        {
          content: [],
          details: {
            taskId: "task-9",
            status: "running",
            agent: evilType,
            agentId,
            lastActivity: `${cjk} ${tabs}`,
          },
        },
        { isPartial: false },
        theme,
      ).render(width);
      noOverflow(poll, width);

      const final = renderAgentResult(
        {
          content: [{ type: "text", text: `${cjk}\n${tabs}body` }],
          details: {
            taskId: "task-9",
            status: "completed",
            outcome: "completed",
            agent: evilType,
            agentId,
            transcriptPath: "/x/agent-3b7caeaf8448.jsonl",
            // Non-resumable: the standalone agent-<id> subline is present (a
            // resumable result suppresses it in favour of the footer's "— agent
            // <id>"), so the id lives on its OWN line and survives the clamp.
            resumable: false,
            usage: { inputTokens: 1, costUsd: 0.01 },
          },
        },
        { isPartial: false },
        theme,
      ).render(width);
      noOverflow(final, width);

      // The agent-<id> is on its own line (identity subline / poll subline), so at
      // any width wide enough to hold it (>= its 18 columns) it is never the
      // truncated element.
      if (width >= 20) {
        expect(final.join("\n")).toContain(agentId);
        expect(poll.join("\n")).toContain(agentId);
      }
    }

    // No control bytes reach the terminal via the identity header (sanitized type).
    const settled = renderAgentResult(
      {
        content: [{ type: "text", text: "done" }],
        details: { taskId: "task-9", status: "completed", outcome: "completed", agent: evilType, agentId },
      },
      { isPartial: false },
      undefined,
    )
      .render(120)
      .join("\n");
    expect(settled.includes(ESC)).toBe(false);
    expect(settled.includes(BEL)).toBe(false);
    expect(settled).toContain("coder");
  });

  it("FOREGROUND (no taskId): a completed body ending in a usage: line is KEPT — no background usage-strip (MUST-FIX 1)", () => {
    // renderAgentResult is SHARED; the usage-line strip must be gated on taskId so
    // a foreground agent whose final message legitimately ends in "usage: …" is
    // never mutilated (details.usage IS set on foreground completed dispatches).
    const out = renderAgentResult(
      {
        content: [{ type: "text", text: "Here is the result.\nusage: see the attached breakdown" }],
        details: { outcome: "completed", agent: "reviewer", usage: { totalTokens: 5 } },
      },
      { isPartial: false },
      undefined,
    )
      .render(120)
      .join("\n");
    expect(out).toContain("usage: see the attached breakdown"); // the body line survives
    expect(out).toContain("Here is the result.");
  });

  it("settled resumable SUPPRESSES the standalone agent-<id> subline; non-resumable keeps it (SHOULD-FIX 4)", () => {
    const agentId = "agent-aabbccddeeff";
    const settled = (resumable: boolean) =>
      renderAgentResult(
        {
          content: [{ type: "text", text: "done" }],
          details: {
            taskId: "task-1",
            status: "completed",
            outcome: "completed",
            agent: "coder",
            agentId,
            resumable,
          },
        },
        { isPartial: false },
        undefined,
      ).render(120);
    // Resumable: the footer already prints "— agent <id>", so the standalone
    // subline (a line that is EXACTLY the id) is suppressed — id shown once.
    const res = settled(true);
    expect(res.filter((l) => l.trim() === agentId)).toHaveLength(0);
    expect(res.join("\n")).toContain(`resumable via SendMessage — agent ${agentId}`);
    // Non-resumable: the standalone identity subline is its ONLY occurrence — kept.
    const nonres = settled(false);
    expect(nonres.filter((l) => l.trim() === agentId)).toHaveLength(1);
    expect(nonres.join("\n")).not.toContain("resumable via SendMessage");
  });

  it("cross-platform: the transcript footer basename is derived for both \\\\ and / separators", () => {
    const win = render({
      taskId: "task-1",
      status: "completed",
      outcome: "completed",
      agent: "coder",
      transcriptPath:
        "C:\\Users\\a\\.pi\\sessions\\x.subagents\\agent-3b7caeaf8448.jsonl",
    }, "x", false, 40);
    expect(win).toContain("agent-3b7caeaf8448.jsonl");
    const posix = render({
      taskId: "task-1",
      status: "completed",
      outcome: "completed",
      agent: "coder",
      transcriptPath: "/home/a/.pi/sessions/x.subagents/agent-3b7caeaf8448.jsonl",
    }, "x", false, 40);
    expect(posix).toContain("agent-3b7caeaf8448.jsonl");
  });
});

// ---------------------------------------------------------------------------
// Parent-only guard (tester NIT-2) — SendMessage never reaches a subagent
// ---------------------------------------------------------------------------

describe("SendMessage parent-only guard through the real harness (tester NIT-2)", () => {
  it("a subagent's constructed toolset EXCLUDES SendMessage even under inherit-all", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-rc-nit2-"));
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "nit2-project\n");
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const originalCwd = process.cwd();
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    try {
      const pi = fakePi();
      piccExtension(pi.api as never);
      // Boot is async (project/agents load); give it a beat to register tools.
      await new Promise((r) => setTimeout(r, 200));
      const agentTool = pi.tools.get("Agent") as {
        execute: (
          id: string,
          params: Record<string, unknown>,
        ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
      };
      expect(agentTool, "Agent tool must be registered").toBeDefined();

      // general-purpose inherits ALL tools (tools: undefined) → gateTools grants
      // every known Claude name INCLUDING SendMessage. The subagent's session must
      // still never receive a SendMessage tool: the one-line guard in index.ts's
      // customToolsFor must hold under inherit-all (and claudeToolsToPiBuiltins
      // never maps SendMessage to a Pi builtin).
      const before = rcMock.created.length;
      // F15: pin run_in_background: false so the dispatch runs foreground and the
      // subagent session is created synchronously within execute() — this test
      // inspects the constructed toolset, background-vs-foreground is incidental.
      await agentTool.execute("t", {
        subagent_type: "general-purpose",
        prompt: "go",
        run_in_background: false,
      });
      expect(rcMock.created.length).toBeGreaterThan(before);
      const options = rcMock.created[rcMock.created.length - 1]!;
      const toolNames = (options.tools as string[]) ?? [];
      const customToolNames = ((options.customTools as Array<{ name: string }>) ?? []).map(
        (t) => t.name,
      );
      expect(toolNames).not.toContain("SendMessage");
      expect(customToolNames).not.toContain("SendMessage");
    } finally {
      process.chdir(originalCwd);
      if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* OS reaps temp dirs eventually */
      }
    }
  });
});

// Wiring-seam revert-catcher (t05): the scratchpad path is computed in index.ts's
// activation and threaded into BOTH the main-session before_agent_start suffix AND
// buildSubagentSystemPrompt's suffix. Boots the REAL harness (same pattern as the
// parent-guard test above) so a dropped call-site arg on either path ships RED.
// (The realpath→transform ORDER + CLAUDE_CODE_TMPDIR honoring are locked by the pure
// computeSessionScratchDir unit tests in test/subprocess-env.test.ts — the win32-only
// slash transform is a no-op on this Linux CI host, so it cannot be caught by a
// booted assertion here.)
describe("scratchpad injection wiring through the real harness (t05)", () => {
  it("injects the SAME literal scratch path into both the main suffix and the subagent prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-rc-scratch-"));
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "scratch-project\n");
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const originalCwd = process.cwd();
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    try {
      const pi = fakePi();
      piccExtension(pi.api as never);
      // Boot is async (project/agents load + eager scratch-dir creation); give it a beat.
      await new Promise((r) => setTimeout(r, 200));

      // Main-session suffix via before_agent_start. RED if the main call-site arg (~:1042)
      // is dropped.
      const mainResult = (await pi.fire("before_agent_start", {
        systemPrompt: "BASE-PROMPT",
      })) as { systemPrompt?: string } | undefined;
      const mainSuffix = mainResult?.systemPrompt ?? "";
      expect(mainSuffix, "before_agent_start must return an assembled prompt").toContain(
        "## Scratchpad directory",
      );
      // Extract the literal scratch path the harness computed and injected.
      const match = mainSuffix.match(/`([^`]*picc-scratch-[^`]*)`/);
      expect(match, "main suffix must name a literal picc-scratch- path").not.toBeNull();
      const scratchPath = match![1]!;

      // Subagent system prompt via a real foreground dispatch. RED if the subagent
      // call-site arg (buildSubagentSystemPrompt, ~:623) is dropped (the SHOULD-1 gap).
      const agentTool = pi.tools.get("Agent") as {
        execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
      };
      expect(agentTool, "Agent tool must be registered").toBeDefined();
      const before = rcMock.loaderOptions.length;
      await agentTool.execute("t", {
        subagent_type: "general-purpose",
        prompt: "go",
        run_in_background: false,
      });
      expect(rcMock.loaderOptions.length).toBeGreaterThan(before);
      const options = rcMock.loaderOptions[rcMock.loaderOptions.length - 1]!;
      const override = options.systemPromptOverride as (() => string) | undefined;
      expect(override, "subagent loader must carry a systemPromptOverride").toBeTypeOf(
        "function",
      );
      const subagentPrompt = override!();
      expect(subagentPrompt).toContain("## Scratchpad directory");
      // Same literal path — reuse the one eager scratchDir, no per-subagent dir.
      expect(subagentPrompt).toContain(scratchPath);
    } finally {
      process.chdir(originalCwd);
      if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* OS reaps temp dirs eventually */
      }
    }
  });
});

describe("self-shell wrapper (concise-tool-rows t01)", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const SLOTS = ["toolPendingBg", "toolErrorBg", "toolSuccessBg"] as const;

  // A slot-ENCODING fake theme. Its `bg` frames text with an OSC slot marker
  // (`ESC ] <slot> BEL`) plus a trailing `ESC[49m` reset — BOTH zero-width under
  // pi-tui's visibleWidth, exactly like a real `theme.bg` pair — so reframe's
  // width math (and its no-op (d) net) behaves precisely as in production.
  //
  // NOTE (deviation): the spec suggested `bg: (slot, text) => ESC + slot + "|" +
  // text`, but pi-tui's visibleWidth does NOT treat that as an escape — it counts
  // the slot name as visible columns, which would spuriously trip reframe's final
  // width clamp and truncate the painted row. The OSC-framed marker below keeps
  // the slot encoded (the binding requirement) while being genuinely zero-width.
  const slotMarker = (slot: string) => `${ESC}]${slot}${BEL}`;
  const slotTheme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s,
    bg: (slot: string, text: string) => `${slotMarker(slot)}${text}${ESC}[49m`,
  };

  const ownTool = () => ({
    name: "Demo",
    renderCall: () => ({ render: () => ["call-line"] }),
    renderResult: () => ({ render: () => ["result-line"] }),
  });

  // The real Agent tool (own renderers) — reused for the "content survives" and
  // wrapper width-sweep cases.
  const agentTool = () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk);
    return createAgentToolDefinition(runtime, { depth: 0 }) as unknown as Record<string, unknown>;
  };

  it("bgSlotForCtx maps state to the pinned single tone (partial > error > success)", () => {
    expect(bgSlotForCtx({ isPartial: true })).toBe("toolPendingBg");
    expect(bgSlotForCtx({ isPartial: true, isError: true })).toBe("toolPendingBg");
    expect(bgSlotForCtx({ isError: true })).toBe("toolErrorBg");
    expect(bgSlotForCtx({})).toBe("toolSuccessBg");
    expect(bgSlotForCtx(undefined)).toBe("toolSuccessBg");
  });

  it("themedBg is throw-guarded: unknown slot / absent theme degrade to plain text", () => {
    const throwing = {
      bg: () => {
        throw new Error("Unknown theme background color");
      },
    };
    expect(themedBg(throwing, "toolSuccessBg", "x")).toBe("x");
    expect(themedBg(undefined, "toolSuccessBg", "x")).toBe("x");
    expect(themedBg({}, "toolSuccessBg", "x")).toBe("x");
    expect(themedBg(slotTheme, "toolSuccessBg", "x")).toContain("x");
  });

  it("single-tone background: call and result carry the SAME, state-correct slot", () => {
    const wrapped = wrapForSelfShell(ownTool());
    const cases: Array<[RenderCtx, string]> = [
      [{ isPartial: true }, "toolPendingBg"],
      [{ isPartial: false, isError: true }, "toolErrorBg"],
      [{ isPartial: false, isError: false }, "toolSuccessBg"],
    ];
    for (const [ctx, slot] of cases) {
      const callLines = (
        wrapped.renderCall as (a: unknown, t: unknown, c: RenderCtx) => { render: (w: number) => string[] }
      )({}, slotTheme, ctx).render(40);
      const resLines = (
        wrapped.renderResult as (
          r: unknown,
          o: unknown,
          t: unknown,
          c: RenderCtx,
        ) => { render: (w: number) => string[] }
      )({ content: [] }, {}, slotTheme, ctx).render(40);
      expect(callLines.length).toBeGreaterThan(0);
      expect(resLines.length).toBeGreaterThan(0);
      for (const l of [...callLines, ...resLines]) {
        expect(l).toContain(slotMarker(slot)); // correct tone
        for (const other of SLOTS.filter((s) => s !== slot)) {
          expect(l).not.toContain(slotMarker(other)); // no other tone
        }
      }
    }
  });

  it("reframe strips leading/trailing blanks, keeps interior, paints each line, keeps the 1-col gutter", () => {
    const out = reframe(["", "alpha", "", "beta", ""], 20, slotTheme, "toolSuccessBg");
    expect(out.length).toBe(3); // alpha, interior blank, beta
    for (const l of out) {
      expect(l).toContain(slotMarker("toolSuccessBg")); // per-line bg
      expect(tuiVisibleWidth(l)).toBe(20); // padded to exactly width
      expect(l.startsWith(`${slotMarker("toolSuccessBg")} `)).toBe(true); // 1-col gutter
    }
    // No blank line at the first or last position (measured after marker strip).
    expect(tuiVisibleWidth(out[0]!)).toBe(20);
    expect(tuiVisibleWidth(out[out.length - 1]!)).toBe(20);
    const joined = out.join("\n");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
  });

  it("a maximally-wide inner line is NOT ellipsized and keeps Pi's right-hand bg margin", () => {
    // A tool whose inner renderer FILLS exactly the width it is handed — like Pi's
    // own Box-laid-out content. Before the fix the wrapper handed it the full
    // terminal width, but reframe preserved only width-GUTTER, so the last content
    // column was truncated to a trailing "…" (a real "content changed" regression)
    // and the row could touch the right edge where Pi keeps a >=1-col bg margin.
    let seenWidth = -1;
    const tool = {
      name: "Fill",
      renderResult: () => ({
        render: (w: number) => {
          seenWidth = w;
          return ["x".repeat(w)]; // exactly `w` visible columns — fills its width
        },
      }),
    };
    const wrapped = wrapForSelfShell(tool);
    const width = 40;
    const out = (
      wrapped.renderResult as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: RenderCtx,
      ) => { render: (w: number) => string[] }
    )({ content: [] }, {}, slotTheme, { isPartial: false }).render(width);
    expect(out.length).toBe(1);
    const line = out[0]!;

    // Inner content is laid out at width - 2 (paddingX=1 on BOTH sides), not full width.
    expect(seenWidth).toBe(width - 2);

    // Strip the zero-width bg framing to inspect the visible payload.
    const marker = slotMarker("toolSuccessBg");
    const inner = line.replace(marker, "").replace(`${ESC}[49m`, "");

    // (a) No column was dropped to an ellipsis: every inner 'x' survives.
    expect(inner.includes("…")).toBe(false);
    expect((inner.match(/x/g) ?? []).length).toBe(width - 2);

    // (b) Full-width row: painted to EXACTLY width, ending within the terminal, and
    // carrying the background to the right edge with Pi's >=1-col margin. The last
    // visible column is a background space (the fill), not content; the first is the
    // 1-col gutter.
    expect(tuiVisibleWidth(line)).toBe(width);
    expect(inner.startsWith(" ")).toBe(true); // leading 1-col gutter
    expect(inner.endsWith(" ")).toBe(true); // right-hand bg margin (>=1 col)
    expect(line).toContain(marker); // still painted with the state tone
  });

  it("reframe returns [] when only blank lines remain (empty result collapses the row)", () => {
    expect(reframe([], 20, slotTheme, "toolSuccessBg")).toEqual([]);
    expect(reframe(["", "", ""], 20, slotTheme, "toolSuccessBg")).toEqual([]);
  });

  it("no-theme / headless: plain content, no bg marker, no throw", () => {
    const out = reframe(["hello"], 20, undefined, "toolSuccessBg");
    expect(out.length).toBe(1);
    expect(out[0]).toContain("hello");
    expect(out[0]!.includes(ESC)).toBe(false); // no escape / bg marker at all
  });

  it("width sweep THROUGH the wrapper (bg added): no overflow, includes over-width content", () => {
    const wrapped = wrapForSelfShell(agentTool());
    const wide = "字".repeat(60); // 60 CJK = 120 columns (over width)
    const ctx: RenderCtx = { isPartial: false, isError: false };
    const renderRes = wrapped.renderResult as (
      r: unknown,
      o: unknown,
      t: unknown,
      c: RenderCtx,
    ) => { render: (w: number) => string[] };
    const renderCall = wrapped.renderCall as (
      a: unknown,
      t: unknown,
      c: RenderCtx,
    ) => { render: (w: number) => string[] };
    for (const width of [1, 2, 3, 20, 40, 138]) {
      const res = renderRes(
        {
          content: [{ type: "text", text: `line1\n${wide}` }],
          details: { outcome: "completed", agent: "docs" },
        },
        { isPartial: false },
        slotTheme,
        ctx,
      ).render(width);
      for (const l of res) {
        expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width); // no RangeError, no overflow
        expect(l).toContain(slotMarker("toolSuccessBg"));
      }
      const call = renderCall(
        { subagent_type: "x".repeat(200), description: wide },
        slotTheme,
        ctx,
      ).render(width);
      for (const l of call) expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width);
    }
  });

  it("content survives the wrapper: Agent badge + body still present", () => {
    const wrapped = wrapForSelfShell(agentTool());
    const out = (
      wrapped.renderResult as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: RenderCtx,
      ) => { render: (w: number) => string[] }
    )(
      {
        content: [{ type: "text", text: "the body text" }],
        details: { outcome: "completed", agent: "reviewer" },
      },
      { isPartial: false },
      slotTheme,
      { isPartial: false },
    )
      .render(120)
      .join("\n");
    expect(out).toContain("reviewer");
    expect(out).toContain("the body text");
  });

  it("generic renderer: renderer-less tool shows bold title + text output; CRLF stripped; image indicator appended", () => {
    const wrapped = wrapForSelfShell({ name: "TodoWrite" });
    expect(wrapped.renderShell).toBe("self");
    const ctx: RenderCtx = { isPartial: false, isError: false };
    const call = (
      wrapped.renderCall as (a: unknown, t: unknown, c: RenderCtx) => { render: (w: number) => string[] }
    )({}, slotTheme, ctx)
      .render(40)
      .join("\n");
    expect(call).toContain("TodoWrite"); // Pi createCallFallback parity (bold title)

    const renderRes = wrapped.renderResult as (
      r: unknown,
      o: unknown,
      t: unknown,
      c: RenderCtx,
    ) => { render: (w: number) => string[] };

    // CRLF payload: getTextOutput parity removes EVERY \r (not sanitizeProgressText,
    // which keeps it) so a bare \r can't return the cursor to col 0 and corrupt the row.
    const crlf = renderRes(
      { content: [{ type: "text", text: "line-a\r\nline-b\rTAIL" }] },
      {},
      slotTheme,
      ctx,
    )
      .render(80)
      .join("\n");
    expect(crlf).toContain("line-a");
    expect(crlf).toContain("line-b");
    expect(crlf.includes("\r")).toBe(false);

    // Image block with no text → the [image …] fallback indicator is appended
    // (a naive text-parts join would emit nothing).
    const img = renderRes(
      { content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }] },
      {},
      slotTheme,
      ctx,
    )
      .render(80)
      .join("\n");
    expect(img).toContain("Image");
  });

  it("TaskStop (renderer-less, new block): self-shell flag, generic title, bg applied, no blank first/last, execute passthrough", () => {
    const execute = async () => ({ content: [] });
    const tool = { name: "TaskStop", execute };
    const wrapped = wrapForSelfShell(tool);
    expect(wrapped.renderShell).toBe("self");
    expect(wrapped.execute).toBe(execute); // execute passes through untouched
    const ctx: RenderCtx = { isPartial: false, isError: false };
    const call = (
      wrapped.renderCall as (a: unknown, t: unknown, c: RenderCtx) => { render: (w: number) => string[] }
    )({}, slotTheme, ctx).render(40);
    expect(call.length).toBe(1);
    expect(call[0]).toContain("TaskStop");
    expect(call[0]).toContain(slotMarker("toolSuccessBg"));
    expect(tuiVisibleWidth(call[0]!)).toBe(40); // padded — not a blank line
  });

  // --- concise-tool-rows t02: ctx.lastComponent threading for the built-ins ---

  it("threads ctx.lastComponent: the inner renderer receives the PREVIOUS INNER component, not the wrapper", () => {
    // Non-vacuous: an instrumented fake inner ToolDefinition RECORDS the
    // lastComponent it is handed. We render once, capture the returned WRAPPER,
    // feed it back as ctx.lastComponent (exactly what ToolExecutionComponent does),
    // and assert the inner got the previous INNER — the thing edit.js's
    // `instanceof Box` reuse depends on. A wrapper leaking through here would
    // silently drop the built-ins' incremental state.
    const seenResult: Array<unknown> = [];
    const innerResults: Array<{ render: (w: number) => string[] }> = [];
    const seenCall: Array<unknown> = [];
    const innerCalls: Array<{ render: (w: number) => string[] }> = [];
    const tool = {
      name: "Incr",
      renderCall: (_a: unknown, _t: unknown, ctx: RenderCtx) => {
        seenCall.push(ctx.lastComponent);
        const comp = { render: () => ["call-line"] };
        innerCalls.push(comp);
        return comp;
      },
      renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: RenderCtx) => {
        seenResult.push(ctx.lastComponent);
        const comp = { render: () => ["diff-line"] };
        innerResults.push(comp);
        return comp;
      },
    };
    const wrapped = wrapForSelfShell(tool);
    const rr = wrapped.renderResult as (
      r: unknown,
      o: unknown,
      t: unknown,
      c: RenderCtx,
    ) => { render: (w: number) => string[] };
    const rc = wrapped.renderCall as (
      a: unknown,
      t: unknown,
      c: RenderCtx,
    ) => { render: (w: number) => string[] };

    // renderResult: first render has no prior component.
    const firstRes = rr({ content: [] }, {}, slotTheme, { isPartial: false });
    firstRes.render(40);
    // Feed the returned WRAPPER back as ctx.lastComponent, the exact hazard.
    const secondRes = rr({ content: [] }, {}, slotTheme, {
      isPartial: false,
      lastComponent: firstRes,
    });
    secondRes.render(40);
    expect(seenResult[0]).toBeUndefined(); // no prior inner on first render
    expect(seenResult[1]).toBe(innerResults[0]); // previous INNER, not the wrapper
    expect(seenResult[1]).not.toBe(firstRes); // definitely not the wrapper

    // Same threading for renderCall (Pi caches call + result components separately).
    const firstCall = rc({}, slotTheme, { isPartial: false });
    firstCall.render(40);
    const secondCall = rc({}, slotTheme, { isPartial: false, lastComponent: firstCall });
    secondCall.render(40);
    expect(seenCall[0]).toBeUndefined();
    expect(seenCall[1]).toBe(innerCalls[0]);
    expect(seenCall[1]).not.toBe(firstCall);
  });

  it("no-theme built-in render: plain content, no bg marker, no throw", () => {
    // A built-in-shaped tool (own renderResult, like the create*ToolDefinition
    // renderers) rendered with theme undefined degrades to plain text — headless /
    // no-theme must never paint a bg sentinel nor throw.
    const tool = {
      name: "read",
      renderResult: () => ({ render: () => ["file contents here"] }),
    };
    const wrapped = wrapForSelfShell(tool);
    const out = (
      wrapped.renderResult as (
        r: unknown,
        o: unknown,
        t: unknown,
        c: RenderCtx,
      ) => { render: (w: number) => string[] }
    )({ content: [] }, {}, undefined, { isPartial: false }).render(40);
    const joined = out.join("\n");
    expect(joined).toContain("file contents here");
    expect(joined.includes(ESC)).toBe(false); // no escape / bg marker at all
  });
});
