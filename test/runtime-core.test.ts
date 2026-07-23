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
  // Capture DefaultResourceLoader options so a dispatch's systemPromptOverride
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
  type AssemblyInputs,
} from "../src/runtime/context-assembly.js";
import {
  mapEffort,
  steeringForModel,
  loadPiCCConfig,
  resolveCompactionConfig,
  DEFAULT_PROACTIVE_COMPACT_PERCENT,
  DEFAULT_CLIP_MAX_TOKENS,
  projectConfigPath,
  type PiCCConfig,
} from "../src/runtime/steering.js";
import {
  createAgentToolDefinition,
  createSendMessageToolDefinition,
  extractText,
  type SubagentRuntime,
} from "../src/runtime/subagents.js";
import { BackgroundTaskRegistry, createTaskOutputTool } from "../src/runtime/background-tasks.js";
import { MainSessionCheckpointGate } from "../src/runtime/mid-run-compaction.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { visibleWidth as tuiVisibleWidth, Text as TuiText } from "@earendil-works/pi-tui";
import type { ProgressSnapshot } from "../src/runtime/subagent-progress.js";
import {
  RECORD_EXPAND_HINT,
  RECORD_FORK_MARKER,
  RECORD_REFERENCE_NOTE,
  renderAgentCall,
  renderAgentResult,
  renderSettlementRecord,
  type SubagentRenderDetails,
} from "../src/runtime/subagent-render.js";
import {
  genericCallComponent,
  genericResultComponent,
  setToolRowOutcome,
  wrapForSelfShell,
  type RenderCtx,
  type ToolRowOutcome,
} from "../src/runtime/tool-shell.js";
import { agentTrailerFrame, FORK_DEGRADE_PREFIX } from "../src/util/subagent-transcripts.js";
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

    // A live grep reaches the engine as a matchable Grep call with
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
    compaction: { proactiveCompactPercent: DEFAULT_PROACTIVE_COMPACT_PERCENT, clipMaxTokens: DEFAULT_CLIP_MAX_TOKENS },
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
      compaction: { proactiveCompactPercent: DEFAULT_PROACTIVE_COMPACT_PERCENT, clipMaxTokens: DEFAULT_CLIP_MAX_TOKENS },
      diagnostics: [],
    };
    expect(steeringForModel(cfg, "openai/gpt-5.5")).toContain("ALL-MODELS");
    expect(steeringForModel(cfg, "openai/gpt-5.5")).toContain("GPT-GUIDANCE");
    expect(steeringForModel(cfg, "anthropic/claude-x")).toBe("ALL-MODELS");
  });

  it("never throws on a malformed steering pattern", () => {
    const cfg: PiCCConfig = {
      steering: { "[unclosed": "X" },
      effortMap: {},
      compaction: { proactiveCompactPercent: DEFAULT_PROACTIVE_COMPACT_PERCENT, clipMaxTokens: DEFAULT_CLIP_MAX_TOKENS },
      diagnostics: [],
    };
    expect(() => steeringForModel(cfg, "openai/gpt-5.5")).not.toThrow();
  });
});

describe("resolveCompactionConfig", () => {
  const baseConfig = (over: Partial<PiCCConfig> = {}): PiCCConfig => ({
    steering: {},
    effortMap: {},
    compaction: { proactiveCompactPercent: DEFAULT_PROACTIVE_COMPACT_PERCENT, clipMaxTokens: DEFAULT_CLIP_MAX_TOKENS },
    diagnostics: [],
    ...over,
  });

  it("applies documented defaults when both knobs are unset (no diagnostic)", () => {
    const cfg = baseConfig();
    const resolved = resolveCompactionConfig(cfg);
    expect(resolved.proactiveCompactPercent).toBe(DEFAULT_PROACTIVE_COMPACT_PERCENT);
    expect(resolved.proactiveCompactPercent).toBe(90);
    expect(resolved.clipMaxTokens).toBe(DEFAULT_CLIP_MAX_TOKENS);
    expect(resolved.clipMaxTokens).toBe(20000);
    expect(cfg.diagnostics).toHaveLength(0);
  });

  it("passes through valid in-range values", () => {
    const cfg = baseConfig({ proactiveCompactPercent: 70, clipMaxTokens: 5000 });
    const resolved = resolveCompactionConfig(cfg);
    expect(resolved.proactiveCompactPercent).toBe(70);
    expect(resolved.clipMaxTokens).toBe(5000);
    expect(cfg.diagnostics).toHaveLength(0);
  });

  it("accepts the exact inclusive boundaries unchanged with no diagnostic", () => {
    const low = baseConfig({ proactiveCompactPercent: 50, clipMaxTokens: 1000 });
    const lowResolved = resolveCompactionConfig(low);
    expect(lowResolved.proactiveCompactPercent).toBe(50);
    expect(lowResolved.clipMaxTokens).toBe(1000);
    expect(low.diagnostics).toHaveLength(0);

    const high = baseConfig({ proactiveCompactPercent: 95 });
    const highResolved = resolveCompactionConfig(high);
    expect(highResolved.proactiveCompactPercent).toBe(95);
    expect(high.diagnostics).toHaveLength(0);
  });

  it("accepts a fractional percent but requires an integer clip budget", () => {
    const cfg = baseConfig({ proactiveCompactPercent: 87.5, clipMaxTokens: 20000.5 });
    const resolved = resolveCompactionConfig(cfg);
    expect(resolved.proactiveCompactPercent).toBe(87.5);
    // non-integer clip budget is rejected -> default, with a diagnostic
    expect(resolved.clipMaxTokens).toBe(DEFAULT_CLIP_MAX_TOKENS);
    expect(
      cfg.diagnostics.some((d) => d.severity === "warning" && d.message.includes("clipMaxTokens")),
    ).toBe(true);
  });

  it("stores proactiveCompactPercent on the 0–100 scale (not a 0–1 fraction)", () => {
    // A fraction like 0.85 is out of range [50,95] and must NOT be silently accepted —
    // it fails closed to the 0–100-scale default so proactive compaction never thrashes.
    const cfg = baseConfig({ proactiveCompactPercent: 0.85 });
    const resolved = resolveCompactionConfig(cfg);
    expect(resolved.proactiveCompactPercent).toBe(90);
    expect(
      cfg.diagnostics.some((d) => d.severity === "warning" && d.message.includes("proactiveCompactPercent")),
    ).toBe(true);
  });

  // Each invalid value falls back to its default, emits a diagnostic, never throws or zeroes.
  const invalidPercent: Array<[string, unknown]> = [
    ["wrong type (boolean)", true],
    ["zero", 0],
    ["negative", -10],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ['"1e999" string', "1e999"],
    ["below range", 40],
    ["above range", 99],
  ];
  for (const [label, value] of invalidPercent) {
    it(`fails closed to the percent default on ${label}`, () => {
      const cfg = baseConfig({ proactiveCompactPercent: value as number });
      let resolved!: ReturnType<typeof resolveCompactionConfig>;
      expect(() => {
        resolved = resolveCompactionConfig(cfg);
      }).not.toThrow();
      expect(resolved.proactiveCompactPercent).toBe(DEFAULT_PROACTIVE_COMPACT_PERCENT);
      expect(
        cfg.diagnostics.some((d) => d.severity === "warning" && d.message.includes("proactiveCompactPercent")),
      ).toBe(true);
    });
  }

  const invalidClip: Array<[string, unknown]> = [
    ["wrong type (boolean)", true],
    ["zero", 0],
    ["negative", -5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ['"1e999" string', "1e999"],
    ["below floor", 500],
  ];
  for (const [label, value] of invalidClip) {
    it(`fails closed to the clip default on ${label}`, () => {
      const cfg = baseConfig({ clipMaxTokens: value as number });
      let resolved!: ReturnType<typeof resolveCompactionConfig>;
      expect(() => {
        resolved = resolveCompactionConfig(cfg);
      }).not.toThrow();
      expect(resolved.clipMaxTokens).toBe(DEFAULT_CLIP_MAX_TOKENS);
      expect(resolved.clipMaxTokens).toBeGreaterThan(0);
      expect(
        cfg.diagnostics.some((d) => d.severity === "warning" && d.message.includes("clipMaxTokens")),
      ).toBe(true);
    });
  }

  it("accepts numeric strings from a config file (asFiniteNumber tolerance)", () => {
    const cfg = baseConfig({
      proactiveCompactPercent: "80" as unknown as number,
      clipMaxTokens: "12000" as unknown as number,
    });
    const resolved = resolveCompactionConfig(cfg);
    expect(resolved.proactiveCompactPercent).toBe(80);
    expect(resolved.clipMaxTokens).toBe(12000);
    expect(cfg.diagnostics).toHaveLength(0);
  });
});

describe("loadPiCCConfig compaction knobs (real file)", () => {
  it("resolves valid knobs once at load and project overrides user", () => {
    // Materialize a real user config by pointing homedir at a temp dir (userConfigPath
    // is derived from os.homedir()), then a project config that overrides it key-wise.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "picc-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-cfg-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const userFile = path.join(home, ".picc", "config.json");
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(
        userFile,
        JSON.stringify({ proactiveCompactPercent: 60, clipMaxTokens: 5000 }),
        "utf8",
      );
      const file = projectConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ proactiveCompactPercent: 75, clipMaxTokens: 30000 }),
        "utf8",
      );
      const config = loadPiCCConfig(dir);
      // Production read path: resolved once at load, stored on config.compaction.
      expect(config.compaction.proactiveCompactPercent).toBe(75);
      expect(config.compaction.clipMaxTokens).toBe(30000);
      // Both scopes were valid, so no validation diagnostics — and exactly none, proving
      // the resolver ran a single time (a double-resolve would still be zero here, so the
      // count is pinned harder on the malformed cases below).
      expect(config.diagnostics).toHaveLength(0);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores the removed suppressCompatNotice key without retaining or diagnosing it", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "picc-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-cfg-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      const file = projectConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ suppressCompatNotice: true }), "utf8");
      const config = loadPiCCConfig(dir);
      expect("suppressCompatNotice" in config).toBe(false);
      expect(config.diagnostics.some((d) => d.message.includes("suppressCompatNotice"))).toBe(false);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves only once at load (no double diagnostics) on a malformed value in the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-cfg-"));
    try {
      const file = projectConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        JSON.stringify({ proactiveCompactPercent: "not-a-number", clipMaxTokens: 999 }),
        "utf8",
      );
      const config = loadPiCCConfig(dir);
      // Read the resolve-once field, not a fresh resolve.
      expect(config.compaction.proactiveCompactPercent).toBe(DEFAULT_PROACTIVE_COMPACT_PERCENT);
      expect(config.compaction.clipMaxTokens).toBe(DEFAULT_CLIP_MAX_TOKENS);
      // Exactly one warning per invalid knob (two total). A per-turn re-resolve would
      // have doubled these — this pins the single-resolve-at-load contract.
      expect(config.diagnostics.filter((d) => d.severity === "warning" && d.message.includes("proactiveCompactPercent"))).toHaveLength(1);
      expect(config.diagnostics.filter((d) => d.severity === "warning" && d.message.includes("clipMaxTokens"))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a validation diagnostic on stderr at harness startup (not just on config.diagnostics)", async () => {
    // A silently-reverted knob is the bug: the harness must ECHO the diagnostic, the same way
    // it surfaces permission-engine findings. Boot the real extension over a project whose
    // config carries an out-of-range value and assert the drain reached console.error.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "picc-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-boot-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const originalCwd = process.cwd();
    try {
      fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Boot project\n");
      const userDir = path.join(dir, ".claude-user");
      fs.mkdirSync(userDir, { recursive: true });
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      const file = projectConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // clipMaxTokens=500 is below the 1000 floor → reverts to default WITH a diagnostic.
      fs.writeFileSync(file, JSON.stringify({ clipMaxTokens: 500 }), "utf8");
      process.chdir(dir);

      const pi = fakePi();
      piccExtension(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      await pi.waitForInitialization();

      const surfaced = errSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith("PiCC config:") && m.includes("clipMaxTokens"));
      expect(surfaced.length, "a config validation diagnostic must reach stderr").toBeGreaterThan(0);
    } finally {
      process.chdir(originalCwd);
      if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
      errSpy.mockRestore();
      homeSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an invalid project value defaults the knob and does not keep a valid user value", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "picc-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-cfg-"));
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      // Valid user value...
      const userFile = path.join(home, ".picc", "config.json");
      fs.mkdirSync(path.dirname(userFile), { recursive: true });
      fs.writeFileSync(userFile, JSON.stringify({ proactiveCompactPercent: 60 }), "utf8");
      // ...clobbered by a malformed project value (project overrides user key-wise).
      const file = projectConfigPath(dir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ proactiveCompactPercent: "bad" }), "utf8");

      const config = loadPiCCConfig(dir);
      // The safe default is used — NOT the valid user value 60.
      expect(config.compaction.proactiveCompactPercent).toBe(DEFAULT_PROACTIVE_COMPACT_PERCENT);
      expect(config.compaction.proactiveCompactPercent).not.toBe(60);
      expect(
        config.diagnostics.some((d) => d.severity === "warning" && d.message.includes("proactiveCompactPercent")),
      ).toBe(true);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
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
      includeInteractionPosture: true,
    });
    expect(suffix).toContain("ROOT-INSTRUCTIONS");
    expect(suffix).toContain("UNCOND-RULE");
    expect(suffix).not.toContain("PATH-RULE"); // path-scoped rules only inject on touch
    expect(suffix).toContain("- sk: does things");
    expect(suffix).toContain("reviewer: Reviews things");
    expect(suffix).toContain("STEER-TEXT");
    expect(suffix).toContain("Claude Code compatibility conventions");
    // Anti-regression: the highest-leverage nudge — the HARNESS_CONVENTIONS
    // subagent line (emitted every turn to every dispatching context) — must carry
    // the background-by-default framing and the collect-with-TaskOutput directive,
    // so a silent revert to opt-in framing fails here rather than only in prose.
    expect(suffix).toMatch(/background by default/i);
    expect(suffix).toMatch(/collect each result with TaskOutput before you rely on it or finalize/i);
    expect(suffix).toMatch(/eligible uncollected results receive one bounded notice/i);
    expect(suffix).toMatch(/later interactive turn/i);
    expect(suffix).toMatch(/one-shot print mode may end before that turn/i);
    expect(suffix).not.toMatch(/otherwise its result is lost/i);
    // Anti-regression: the every-turn conventions block must nudge richer
    // commit messages (match the repo's git-log style; why-not-what body), so a
    // silent drop fails here rather than only in prose. The `--no-verify`
    // prohibition is folded into the same Commits bullet — guard it too so a
    // reword can't silently drop the hook-bypass ban.
    expect(suffix).toMatch(/recent git log/i);
    expect(suffix).toMatch(/why the change was made/i);
    expect(suffix).toMatch(/--no-verify/);
    // The interaction posture is a standalone `## Working with the user`
    // section (not trailing bullets of the conventions block). It is a soft default
    // emitted AFTER the mechanical conventions but BEFORE CLAUDE.md/skills/steering,
    // so those more-specific sections still get the last word. The header is grepped
    // with a leading `\n` as a CRLF-safe structural anchor; both body phrases are
    // grepped so a reword can't silently gut the posture.
    expect(suffix).toContain("\n## Working with the user");
    expect(suffix).toMatch(/Ground first/);
    expect(suffix).toMatch(/invite the user to steer/);
    const postureIdx = suffix.indexOf("## Working with the user");
    const conventionsIdx = suffix.indexOf("Claude Code compatibility conventions");
    expect(postureIdx).toBeGreaterThan(-1);
    expect(conventionsIdx).toBeGreaterThan(-1);
    expect(postureIdx).toBeGreaterThan(conventionsIdx);
    // Pin the soft-default ordering (load-bearing — the `steering` override and the
    // "CLAUDE.md gets the last word" property depend on it): the posture must precede
    // BOTH the CLAUDE.md body (ROOT-INSTRUCTIONS) and the steering text (STEER-TEXT).
    // Without this, a regression moving the section to the end of `sections` would
    // still pass every other assertion.
    expect(postureIdx).toBeLessThan(suffix.indexOf("ROOT-INSTRUCTIONS"));
    expect(postureIdx).toBeLessThan(suffix.indexOf("STEER-TEXT"));
  });

  it("gates the interaction posture on includeInteractionPosture", () => {
    const base: AssemblyInputs = {
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
    };
    // Flag omitted (the subagent default): posture absent, conventions still present.
    const omitted = buildSystemPromptSuffix(base);
    expect(omitted).not.toContain("Working with the user");
    expect(omitted).toContain("Claude Code compatibility conventions");
    // The delegation nudge is part of the gated posture — absent when the flag is
    // omitted. Keyed on /delegat/i, the sole stem unique to the new bullet (`subagent`
    // pre-exists in HARNESS_CONVENTIONS + the Verify bullet, so it would false-fail here).
    expect(omitted).not.toMatch(/delegat/i);
    // Flag true (the main session): posture present, including the delegation nudge.
    const included = buildSystemPromptSuffix({ ...base, includeInteractionPosture: true });
    expect(included).toContain("## Working with the user");
    expect(included).toMatch(/delegat/i);
  });

  // Per-session scratchpad injection.
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

  it("assembles sections with clean boundaries — no triple-newline gap, stable override ordering", () => {
    // Guards the two seams the posture rewrite exposed in buildSystemPromptSuffix:
    // (1) a section string ending in a stray newline joins to `\n\n\n` under
    //     sections.join("\n\n") — the trailing-`\n` trap from deleting the old
    //     `${COLLABORATIVE_PLANNING_GUIDANCE}` interpolation; and
    // (2) override precedence — a soft-default section (the posture) must stay AHEAD
    //     of the sections meant to override it (CLAUDE.md, steering).
    // Controlled inputs only (no arbitrary skill/CLAUDE.md content with internal blank
    // lines), so the invariant is about the ASSEMBLY, not user content.
    const state = newSessionContextState(claudeMd);
    state.activeSkills.set("act", "ACTIVE-SKILL-BODY");
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [
        { id: "a.md", body: "UNCOND-RULE", source: { path: "x", scope: "project" }, unknownKeys: [], diagnostics: [] },
      ],
      skills: [],
      agents: [makeAgent()],
      settings: baseSettings(),
      state,
      steeringText: "STEER-TEXT",
      scratchDir: SCRATCH,
      includeInteractionPosture: true,
    });
    // (1) No triple-newline gap anywhere in the assembled suffix.
    expect(suffix).not.toContain("\n\n\n");
    // (2) Section order is stable and keeps every soft default ahead of what overrides it.
    const order = [
      "Claude Code compatibility conventions", // mechanical conventions
      "## Working with the user", // interaction posture (soft default)
      "ROOT-INSTRUCTIONS", // CLAUDE.md — gets the last word over the posture
      "UNCOND-RULE", // project rules
      "ACTIVE-SKILL-BODY", // active skills
      "STEER-TEXT", // steering — also overrides the posture
      "## Scratchpad directory", // scratchpad (last)
    ].map((marker) => suffix.indexOf(marker));
    for (const idx of order) expect(idx).toBeGreaterThan(-1); // no vacuous pass
    expect(order).toEqual([...order].sort((a, b) => a - b)); // monotonic == in-order
  });

  it("emits no scratchpad section (and no Windows note) when scratchDir is undefined", () => {
    const inputs: AssemblyInputs = {
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
    };
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

      // After compaction the once-only markers reset, so the next
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

  it("surfaces paths:-scoped skills once when a matching file is touched", () => {
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

  it("unknown subagent_type falls back to general-purpose with a visible note", async () => {
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
    expect(result.error).toContain("larger positive integer");
    expect(result.error).not.toContain("2..5");
  });

  it('subagent_type "fork" is RESERVED — it never hits the generic unknown-type fallback', async () => {
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
    // Assert on `customTools` (the FACTORY-built built-in implementations), not
    // `tools`/`toolNames`: after the shared-factory rewire, `toolNames` still
    // carries every granted allowlist name, so an assertion there would stay green
    // even if the factory over-produced a `write` implementation for a read-only
    // agent. The factory-side filter (membership in claudeToolsToPiBuiltins) is what
    // this test now pins — a read-only agent's constructed built-ins exclude
    // write/edit/bash.
    const customToolNames = ((created[0]?.customTools as Array<{ name: string }>) ?? []).map(
      (t) => t.name,
    );
    expect(customToolNames).toContain("read");
    expect(customToolNames).toContain("grep");
    // Glob → [find, ls] fan-out reaches the read-only agent too.
    expect(customToolNames).toContain("find");
    expect(customToolNames).toContain("ls");
    expect(customToolNames).not.toContain("write");
    expect(customToolNames).not.toContain("edit");
    expect(customToolNames).not.toContain("bash");
  });

  it("subagent built-ins re-resolve to the new cwd after its own EnterWorktree, in lockstep with the guard (BUG 2)", async () => {
    // The dispatch builds the factory built-ins, the guard (getCwd), and the
    // custom tools ALL against ONE dispatch-local `subCwd` instance. `customToolsFor`
    // receives that same instance as its 6th arg — capture it, and hand the subagent
    // a fake worktree-entering tool that mutates it. Driving the subagent's OWN
    // factory `read` (from the session's customTools) before and after that mutation
    // proves the per-execute rebind against the shared instance.
    let capturedSubCwd: CwdState | undefined;
    const observed: string[] = [];
    const { sdk } = fakeSdk({
      onPrompt: async (_text, session) => {
        const read = session.customTools.find((t) => t.name === "read");
        const enter = session.customTools.find((t) => t.name === "EnterFake");
        const before = await read!.execute("a", { path: "." });
        observed.push(String(before.details?.cwd));
        await enter!.execute("b", {});
        const after = await read!.execute("c", { path: "." });
        observed.push(String(after.details?.cwd));
        return "done";
      },
    });
    const runtime = makeSubagentRuntime([makeAgent({ tools: ["Read", "Bash"] })], sdk, {
      customToolsFor: (_a: ClaudeAgent, _g: string[], _d: number, _o: string, _f: boolean, subCwd) => {
        capturedSubCwd = subCwd;
        return [
          {
            name: "EnterFake",
            async execute() {
              subCwd!.enterWorktree("/wt-new");
              return { content: [] };
            },
          },
        ];
      },
      settingsEnv: {},
      projectRoot: "/proj",
    });
    await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    // The instance the guard reads (`getCwd: () => subCwd.get()`) and the one the
    // worktree tool mutates are the SAME dispatch-local CwdState the factory built
    // against — the read echoes it live.
    expect(capturedSubCwd).toBeInstanceOf(CwdState);
    expect(observed[0]).not.toBe("/wt-new"); // dispatch base cwd (process.cwd())
    expect(observed[1]).toBe("/wt-new"); // re-resolved after EnterWorktree
    // Lockstep proof at the guard level: the same instance now reads the swapped cwd.
    expect(capturedSubCwd!.get()).toBe("/wt-new");
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

  it("emits waiting only on actual FIFO queueing and restores admitted before startup", async () => {
    const releases = new Map<string, () => void>();
    const entered: string[] = [];
    const waitForEntry = new Map<string, () => void>();
    const enteredPromises = new Map(
      ["holder", "A", "B"].map((name) => [
        name,
        new Promise<void>((resolve) => waitForEntry.set(name, resolve)),
      ]),
    );
    const { sdk } = fakeSdk({
      onPrompt: async (text) => {
        entered.push(text);
        waitForEntry.get(text)?.();
        await new Promise<void>((resolve) => releases.set(text, resolve));
        if (text === "holder") throw new Error("predecessor failed");
        return `${text}-done`;
      },
    });
    const registry = new SubagentRegistry();
    let healthyNotifications = 0;
    registry.onChange(() => { throw new Error("hostile presentation listener"); });
    registry.onChange(() => healthyNotifications++);
    const runtime = makeSubagentRuntime([makeAgent()], sdk, {
      concurrency: 1,
      subagentRegistry: registry,
    });
    const phases = new Map<string, string[]>();
    const dispatch = (name: string, agentId: string) => runtime.dispatch({
      subagentType: "reviewer",
      prompt: name,
      depth: 1,
      agentId,
      onAdmission: (phase) => phases.set(name, [...(phases.get(name) ?? []), phase]),
    });

    const holder = dispatch("holder", "agent-000000000001");
    await enteredPromises.get("holder");
    const a = dispatch("A", "agent-000000000002");
    const b = dispatch("B", "agent-000000000003");
    expect(phases.get("holder")).toEqual(["admitted"]);
    expect(phases.get("A")).toEqual(["waiting"]);
    expect(phases.get("B")).toEqual(["waiting"]);
    expect(registry.get("agent-000000000002")?.admission).toBe("waiting");

    releases.get("holder")!();
    await enteredPromises.get("A");
    expect(entered).toEqual(["holder", "A"]);
    expect(phases.get("A")).toEqual(["waiting", "admitted"]);
    releases.get("A")!();
    await enteredPromises.get("B");
    expect(entered).toEqual(["holder", "A", "B"]);
    expect(phases.get("B")).toEqual(["waiting", "admitted"]);
    releases.get("B")!();
    const [holderResult, aResult, bResult] = await Promise.all([holder, a, b]);
    expect(holderResult.outcome).toBe("failed");
    expect(aResult.outcome).toBe("completed");
    expect(bResult.outcome).toBe("completed");
    expect(healthyNotifications).toBeGreaterThan(0);
  });

  it("preserves FIFO when a synchronous waiting observer reentrantly queues another dispatch", async () => {
    const releases = new Map<string, () => void>();
    const entered: string[] = [];
    const enteredGates = new Map<string, () => void>();
    const enteredPromises = new Map(
      ["holder", "A", "B"].map((name) => [
        name,
        new Promise<void>((resolve) => enteredGates.set(name, resolve)),
      ]),
    );
    const { sdk } = fakeSdk({
      onPrompt: async (text) => {
        entered.push(text);
        enteredGates.get(text)?.();
        await new Promise<void>((resolve) => releases.set(text, resolve));
        return `${text}-done`;
      },
    });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { concurrency: 1 });
    const holder = runtime.dispatch({ subagentType: "reviewer", prompt: "holder", depth: 1 });
    await enteredPromises.get("holder");
    let b: ReturnType<typeof runtime.dispatch> | undefined;
    const a = runtime.dispatch({
      subagentType: "reviewer",
      prompt: "A",
      depth: 1,
      onAdmission: (phase) => {
        if (phase === "waiting" && !b) {
          b = runtime.dispatch({ subagentType: "reviewer", prompt: "B", depth: 1 });
        }
      },
    });
    expect(b).toBeDefined();

    releases.get("holder")!();
    await enteredPromises.get("A");
    expect(entered).toEqual(["holder", "A"]);
    releases.get("A")!();
    await enteredPromises.get("B");
    expect(entered).toEqual(["holder", "A", "B"]);
    releases.get("B")!();
    expect((await Promise.all([holder, a, b!])).every((result) => result.ok)).toBe(true);
  });

  it("foreground nested bypass reports admitted without queueing", async () => {
    const phases: string[] = [];
    const { runtime } = makeRuntime([makeAgent()], ["done"], { concurrency: 1 });
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "nested",
      depth: 2,
      onAdmission: (phase) => phases.push(phase),
    });
    expect(result.ok).toBe(true);
    expect(phases).toEqual(["admitted"]);
  });

  it("case-insensitive agent resolution", async () => {
    const { runtime } = makeRuntime([makeAgent({ name: "Reviewer" })], ["ok"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
  });

  it("foreground success and failed-partial results preserve exact content and one-clock metadata", async () => {
    const cases = [
      {
        reply: { text: "done" },
        content: "done",
        outcome: "completed" as const,
      },
      {
        reply: { text: "partial", stopReason: "error" as const, errorMessage: "provider failed" },
        content:
          "partial\n\n---\n[subagent cut off] Agent terminated early due to an API error: provider failed",
        outcome: "failed" as const,
      },
    ];
    for (const testCase of cases) {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000);
        const { sdk } = fakeSdk({
          onPrompt: () => {
            vi.setSystemTime(1_450);
            return testCase.reply;
          },
        });
        const runtime = makeSubagentRuntime([makeAgent()], sdk);
        const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
          execute: (
            id: string,
            params: Record<string, unknown>,
          ) => Promise<{ content: Array<{ type: string; text: string }>; details: SubagentRenderDetails }>;
        };
        const output = await tool.execute("t", {
          subagent_type: "reviewer",
          prompt: "go",
          description: "Review authentication",
          run_in_background: false,
        });
        expect(output.content).toEqual([{ type: "text", text: testCase.content }]);
        expect(output.details).toMatchObject({
          description: "Review authentication",
          outcome: testCase.outcome,
          settledAt: 1_450,
          durationMs: 450,
        });
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("foreground timing omits a finite-clock subtraction that overflows", async () => {
    let now = -Number.MAX_VALUE;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { sdk } = fakeSdk({
        onPrompt: () => {
          now = Number.MAX_VALUE;
          return { text: "done" };
        },
      });
      const tool = createAgentToolDefinition(makeSubagentRuntime([makeAgent()], sdk), { depth: 0 }) as {
        execute: (
          id: string,
          params: Record<string, unknown>,
        ) => Promise<{ content: Array<{ type: string; text: string }>; details: SubagentRenderDetails }>;
      };
      const output = await tool.execute("t", {
        subagent_type: "reviewer",
        prompt: "go",
        run_in_background: false,
      });
      expect(output.content).toEqual([{ type: "text", text: "done" }]);
      expect(output.details.durationMs).toBeUndefined();
      expect(output.details.settledAt).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("SendMessage resume keeps the original sanitized description in start and terminal details", async () => {
    const registry = new SubagentRegistry();
    const backgroundTasks = new BackgroundTaskRegistry();
    const agentId = "agent-aabbccddeeff";
    registry.register({
      agentId,
      agentName: "reviewer",
      depth: 1,
      cwd: process.cwd(),
      resumable: true,
      oneShot: false,
      transcriptPath: "/x/sessions/agent-aabbccddeeff.jsonl",
      description: `Review${String.fromCharCode(27)}[31m auth`,
    });
    registry.markSettled(agentId, { outcome: "completed" });
    const runtime = {
      dispatch: vi.fn().mockResolvedValue({
        ok: true,
        outcome: "completed",
        finalMessage: "resumed report",
        agentId,
        agentName: "reviewer",
        diagnostics: [],
      }),
    } as unknown as SubagentRuntime;
    const sendMessage = createSendMessageToolDefinition(runtime, { registry, backgroundTasks }) as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: SubagentRenderDetails }>;
    };

    const started = await sendMessage.execute("sm", { to: agentId, message: "continue" });
    expect(started.details.description).toBe("Review auth");
    const taskId = started.details.taskId!;
    expect(backgroundTasks.get(taskId)?.description).toBe("Review auth");
    await backgroundTasks.wait(taskId);
    const taskOutput = createTaskOutputTool(backgroundTasks) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details: SubagentRenderDetails }>;
    };
    const completed = await taskOutput.execute("out", { task_id: taskId });
    expect(completed.content).toEqual([{ type: "text", text: "resumed report" }]);
    expect(completed.details.description).toBe("Review auth");
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
    // Unknown types fall back to general-purpose rather than throwing.
    const fallback = await tool.execute("t2", { subagent_type: "ghost", prompt: "go" });
    expect(fallback.details.agent).toBe("general-purpose");
    // Genuine failures (depth cap) still throw.
    const deep = createAgentToolDefinition(runtime, { depth: 5 }) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(deep.execute("t3", { subagent_type: "reviewer", prompt: "go" })).rejects.toThrow(/depth/);
  });

  it.each(["SubagentStart", "SubagentStop"])(
    "%s universal stop propagates through the Agent tool to its dispatching gate",
    async (stopEvent) => {
      const hookRunner = {
        async fire(event: string) {
          return event === stopEvent
            ? { stop: true, stopReason: `${event} stopped`, block: false, askDowngraded: false, diagnostics: [] }
            : { block: false, askDowngraded: false, diagnostics: [] };
        },
      };
      const { runtime } = makeRuntime([makeAgent()], ["done"], { hookRunner });
      let captures = 0;
      let stops = 0;
      let aborts = 0;
      const tool = createAgentToolDefinition(runtime, {
        depth: 0,
        captureUniversalStop: () => {
          captures += 1;
          return () => { stops += 1; return true; };
        },
      }) as { execute(...args: unknown[]): Promise<unknown> };
      await expect(tool.execute(
        "t", { subagent_type: "reviewer", prompt: "go", run_in_background: false },
        undefined, undefined, { abort: () => { aborts += 1; } },
      )).rejects.toThrow(/stopped/);
      expect({ captures, stops, aborts }).toEqual({ captures: 1, stops: 1, aborts: 1 });
    },
  );

  it.each([
    { scope: "root", depth: 0, lifecycleEvent: "SubagentStart" },
    { scope: "root", depth: 0, lifecycleEvent: "SubagentStop" },
  ] as const)("ignores a late $scope background $lifecycleEvent after its parent settles and a new run begins", async ({ scope, depth, lifecycleEvent }) => {
    let releaseStop!: () => void;
    const stopEntered = new Promise<void>((resolveEntered) => {
      releaseStop = () => resolveEntered();
    });
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const hookRunner = {
      async fire(event: string) {
        if (event !== lifecycleEvent) {
          return { block: false, askDowngraded: false, diagnostics: [] };
        }
        enteredResolve();
        await stopEntered;
        return { stop: true, stopReason: `late ${lifecycleEvent}`, block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const { runtime } = makeRuntime([makeAgent()], ["done"], { hookRunner });
    const gate = new MainSessionCheckpointGate(`parent-${scope}`, 90);
    const backgroundTasks = new BackgroundTaskRegistry();
    let aborts = 0;
    const tool = createAgentToolDefinition(runtime, {
      depth,
      backgroundTasks,
      captureUniversalStop: () => gate.captureLogicalRunStop(),
    }) as { execute(...args: unknown[]): Promise<{ details: { taskId: string } }> };

    const started = await tool.execute(
      "t", { subagent_type: "reviewer", prompt: "go", run_in_background: true },
      undefined, undefined, { abort: () => { aborts += 1; } },
    );
    await entered;
    gate.logicalRunSettled();
    gate.acceptedLogicalRun();
    releaseStop();
    await backgroundTasks.wait(started.details.taskId);
    expect(aborts).toBe(0);
    expect(gate.isLogicalRunStopped()).toBe(false);
  });

  it("production-wired nested Agent/Task cannot stop its parent after true settlement", async () => {
    const nestedTasks = new BackgroundTaskRegistry();
    let releaseNestedStop!: () => void;
    let nestedStopEntered!: () => void;
    const stopRelease = new Promise<void>((resolve) => { releaseNestedStop = resolve; });
    const stopEntered = new Promise<void>((resolve) => { nestedStopEntered = resolve; });
    let parentAborts = 0;
    let nestedTaskId: string | undefined;
    const agents = [makeAgent({ name: "parent" }), makeAgent({ name: "leaf" })];
    const { sdk } = fakeSdk({
      onPrompt: async (text, session) => {
        if (text === "dispatch nested") {
          const agent = session.customTools.find((tool) => tool.name === "Agent")!;
          const started = await (agent.execute as (...args: any[]) => Promise<any>)(
            "nested", { subagent_type: "leaf", prompt: "leaf work", run_in_background: true },
            undefined, undefined, { abort: () => { parentAborts += 1; } },
          );
          nestedTaskId = String(started.details.taskId);
          return "parent settled";
        }
        return text === "later parent run" ? "later settled" : "leaf settled";
      },
    });
    const hookRunner = {
      async fire(event: string, payload: Record<string, unknown>) {
        if (event === "SubagentStop" && payload.subagent_type === "leaf") {
          nestedStopEntered();
          await stopRelease;
          return { stop: true, stopReason: "late nested stop", block: false, askDowngraded: false, diagnostics: [] };
        }
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    let runtime!: SubagentRuntime;
    runtime = makeSubagentRuntime(agents, sdk, {
      hookRunner,
      maxDepth: 2,
      allKnownToolNames: () => ["Agent", "Task"],
      customToolsFor: (_agent, _granted, depth, ownerAgentId, dispatcherIsFork, _cwd, _activation, captureUniversalStop) =>
        depth === 1
          ? [
              createAgentToolDefinition(runtime, {
                depth, name: "Agent", backgroundTasks: nestedTasks, ownerAgentId,
                dispatcherIsFork, captureUniversalStop,
              }),
              createAgentToolDefinition(runtime, {
                depth, name: "Task", backgroundTasks: nestedTasks, ownerAgentId,
                dispatcherIsFork, captureUniversalStop,
              }),
            ]
          : [],
    });

    const parent = await runtime.dispatch({ subagentType: "parent", prompt: "dispatch nested", depth: 1 });
    await stopEntered;
    expect(parent.outcome).toBe("completed");
    expect(nestedTaskId).toBeTruthy();
    const later = await runtime.dispatch({ subagentType: "parent", prompt: "later parent run", depth: 1 });
    expect(later.outcome).toBe("completed");

    releaseNestedStop();
    await nestedTasks.wait(nestedTaskId!);
    expect(parentAborts).toBe(0);
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
          return `nested:${res.content[0]?.text}`;
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

  it("a nested child starts in the parent subagent's worktree cwd, not the orchestrator's", async () => {
    // A worktree-resident parent must extend its isolation to the children it
    // spawns: the nested dispatch begins at the parent's cwd (its subCwd), never
    // at the orchestrator's process.cwd().
    const worktreePath = "C:\\proj\\.claude\\worktrees\\parent-wt";
    const worktrees = {
      async enter() {
        return { ok: true, worktreePath, branch: "b", diagnostics: [] };
      },
      async exit() {
        return {};
      },
    };
    const { sdk, created } = fakeSdk({
      onPrompt: async (text, session) => {
        const agentTool = session.customTools.find((t) => t.name === "Agent");
        if (agentTool && text.includes("delegate")) {
          const res = await agentTool.execute("id", { subagent_type: "inner", prompt: "leaf work" });
          return `nested:${res.content[0]?.text}`;
        }
        return "leaf-done";
      },
    });
    const agents = [
      makeAgent({ name: "outer", isolation: "worktree" }),
      makeAgent({ name: "inner" }),
    ];
    const runtime: SubagentRuntime = makeSubagentRuntime(agents, sdk, {
      worktrees,
      // subagentMaxDepth: allow one level of nesting so the parent can spawn a child.
      maxDepth: 2,
      // Mirror index.ts's real wiring: the dispatching subagent's Agent tool carries
      // dispatchCwd sourced from its own dispatch-local subCwd.
      customToolsFor: (_a: ClaudeAgent, _g: string[], depth: number, _o: string, _f: boolean, subCwd?: CwdState) =>
        depth + 1 <= 2 && subCwd
          ? [createAgentToolDefinition(runtime, { depth, name: "Agent", dispatchCwd: () => subCwd.get() })]
          : [],
    });
    const result = await runtime.dispatch({ subagentType: "outer", prompt: "please delegate", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("nested:leaf-done");
    // created[0] = parent session (in its worktree); created[1] = nested child.
    // The child must be constructed at the parent's worktree cwd, not the orchestrator's.
    expect(created).toHaveLength(2);
    expect(created[1]?.cwd).toBe(worktreePath);
    expect(created[1]?.cwd).not.toBe(process.cwd());
  }, 10_000);

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

  it("uses canonical plugin identity for subagent lifecycle payloads without renaming dispatch", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const hookRunner = {
      fire: async (event: string, payload: Record<string, unknown>) => {
        if (event === "SubagentStart" || event === "SubagentStop") payloads.push(payload);
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const agent = makeAgent({ name: "quality:reviewer" });
    agent.source = { ...agent.source, pluginName: "quality" };
    const { runtime } = makeRuntime([agent], ["done"], { hookRunner });
    const result = await runtime.dispatch({ subagentType: "quality:reviewer", prompt: "p", depth: 1 });
    expect(result.agentName).toBe("quality:reviewer");
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.agent_type === "quality:reviewer")).toBe(true);
    expect(payloads.some((payload) => payload.agent_type === "quality:quality:reviewer")).toBe(false);
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
  // Built-in agent types
  // -------------------------------------------------------------------------

  it("empty subagent_type defaults to the built-in general-purpose agent", async () => {
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

  it("built-ins resolve AFTER project agents: a project Explore overrides the built-in", async () => {
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
  // Model resolution order: env > param > frontmatter > session
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
  // Agent-scoped hooks
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

  it("agent hook systemMessages surface in the dispatch diagnostics, once per distinct message", async () => {
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

describe("Subagent live progress", () => {
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

  it("mirrors a detail-only event without emitting another model-facing progress snapshot", async () => {
    const sub = new SubagentRegistry();
    const { sdk } = fakeSdk({
      replies: [
        {
          text: "done",
          events: [
            { type: "tool_execution_end", toolName: "Read", result: "", isError: false },
            { type: "tool_execution_end", toolName: "Write", result: "", isError: false },
          ],
        },
      ],
    });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { subagentRegistry: sub });
    const snapshots: ProgressSnapshot[] = [];
    const result = await runtime.dispatch({
      subagentType: "reviewer",
      prompt: "p",
      depth: 1,
      onProgress: (snapshot) => snapshots.push(snapshot),
    });
    expect(snapshots).toHaveLength(1);
    expect(sub.get(result.agentId)?.detailLog).toEqual([
      { kind: "tool-outcome", tool: "Read", failed: false },
      { kind: "tool-outcome", tool: "Write", failed: false },
    ]);
  });

  it("a foreground dispatch with NO onProgress sink still mirrors live progress onto the registry record", async () => {
    // The panel's single-live-data-source contract: the registry mirror rides
    // dispatch's own condenser subscription, not the tool's onUpdate wiring.
    const sub = new SubagentRegistry();
    const { sdk } = fakeSdk({ replies: [streamReply] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { subagentRegistry: sub });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    const rec = sub.get(result.agentId)!;
    expect(rec.progress?.tail.some((l) => l.includes("Grep"))).toBe(true);
    expect(rec.progress?.tail).toContain("final line");
    expect(rec.detailLog?.some((entry) => entry.kind === "tool-call" && entry.tool === "Grep")).toBe(true);
  });

  it("deduplicates a long truncated terminal turn against its raw pre-decoration identity", async () => {
    const rawFinal = `TRUNCATED_FINAL_${"x".repeat(500)}`;
    const sub = new SubagentRegistry();
    const { sdk } = fakeSdk({
      replies: [{
        text: rawFinal,
        stopReason: "length",
        events: [{
          type: "turn_end",
          message: { role: "assistant", content: [{ type: "text", text: rawFinal }] },
        }],
      }],
    });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { subagentRegistry: sub });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const record = sub.get(result.agentId)!;
    expect(result.truncated).toBe(true);
    expect(record.finalText).toContain("[subagent cut off]");
    expect(record.detailLog).toEqual([]);
  });

  it("a nested (depth 2) dispatch mirrors live progress onto its registry record too", async () => {
    const sub = new SubagentRegistry();
    const { sdk } = fakeSdk({ replies: [streamReply] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { subagentRegistry: sub });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 2 });
    expect(result.ok).toBe(true);
    const rec = sub.get(result.agentId)!;
    expect(rec.depth).toBe(2);
    expect(rec.progress?.tail.some((l) => l.includes("Grep"))).toBe(true);
    expect(rec.detailLog?.some((entry) => entry.kind === "tool-call" && entry.tool === "Grep")).toBe(true);
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

  it("renderCall shows one mode-neutral pending line with type and optional description", () => {
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
    expect(withDesc).toContain("reviewer");
    expect(withDesc).toContain("Review auth");

    const withPrompt = tool
      .renderCall({ subagent_type: "reviewer", prompt: "Do the thing please" }, undefined)
      .render(80)
      .join("\n");
    expect(withPrompt).toBe("reviewer");

    const explicitForeground = tool
      .renderCall({ subagent_type: "reviewer", run_in_background: false }, undefined)
      .render(80)
      .join("\n");
    const explicitBackground = tool
      .renderCall({ subagent_type: "reviewer", run_in_background: true }, undefined)
      .render(80)
      .join("\n");
    expect(explicitForeground).toBe("reviewer");
    expect(explicitBackground).toBe("reviewer");

    const empty = tool.renderCall({}, undefined).render(80).join("\n");
    expect(empty).toContain("general-purpose");
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

    // Final, completed + resumable + transcript, no usage yet.
    const completed = render({
      content: [{ type: "text", text: "the answer" }],
      details: {
        outcome: "completed",
        taskId: "task-passive-completed",
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
    expect(completed.split("\n")[0]).not.toContain("task-passive-completed");

    // Usage slot renders defensively when the field is present.
    const withUsage = render({
      content: [{ type: "text", text: "x" }],
      details: { outcome: "completed", usage: { totalTokens: 1200, costUsd: 0.03 } },
    });
    expect(withUsage).toContain("usage:");
    expect(withUsage).toContain("1200 tokens");

    // Failed-with-partial shows a failed badge and preserves the partial body.
    const failed = render({
      content: [{ type: "text", text: "partial work" }],
      details: { outcome: "failed", cutOff: true, agent: "reviewer", taskId: "task-passive-failed" },
    });
    expect(failed).toContain("failed");
    expect(failed).toContain("partial work");
    expect(failed.split("\n")[0]).not.toContain("task-passive-failed");

    // Partial/streaming shows only stable identity/state; live activity stays in detail.
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
    expect(partial).toBe("reviewer [running]");
    expect(partial).not.toContain("Grep");

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

  it("strips the trailer frame from the human view, one resumable hint with the id", () => {
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

  it("renders the (truncated) badge for a turn-capped (length-stop) success", async () => {
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
        o: { isPartial?: boolean; expanded?: boolean },
        theme: unknown,
      ) => { render: (w: number) => string[] };
    };
    const res = await tool.execute("t", { subagent_type: "reviewer", prompt: "go" }, undefined);
    // The truncated success marks cutOff so the compact badge remains truthful.
    expect(res.details?.cutOff).toBe(true);
    const rendered = tool
      .renderResult(res, { isPartial: false, expanded: false }, undefined)
      .render(120)
      .join("\n");
    expect(rendered).toContain("completed (truncated)");
  });

  it("renders the ■ aborted badge when details.outcome is aborted", () => {
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

  it("renderCall stays mode-neutral and a background result owns one compact row", () => {
    const tool = renderTool();
    const call = tool
      .renderCall({ subagent_type: "reviewer", run_in_background: true }, undefined)
      .render(80)
      .join("\n");
    expect(call).toBe("reviewer");
    const result = tool
      .renderResult(
        {
          content: [{ type: "text", text: "Background task task-1 accepted" }],
          details: { background: true, taskId: "task-1", agent: "reviewer", description: "Review auth" },
        },
        { isPartial: false },
        undefined,
      )
      .render(120)
      .join("\n");
    expect(result).toBe("reviewer [background] - Review auth");
    expect(result).not.toContain("Background task task-1 started");
  });

  it("neutralizes Unicode format controls and separators at every human lifecycle boundary only", () => {
    const canonical = {
      content: [{ type: "text", text: "body\u200Bhidden\u2028next\u2029last" }],
      details: {
        outcome: "completed", agent: "rev\u200Biewer\u2028spoof", agentId: "agent-aabbccddeeff",
        transcriptPath: "/tmp/path\u200Bpart\u2028second", note: "foot\u2029note",
      },
    };
    const before = structuredClone(canonical);
    const rendered = renderAgentResult(canonical, { isPartial: false, expanded: true }, undefined).render(80).join("\n");
    expect(rendered).not.toMatch(/[\p{Cf}\u2028\u2029]/u);
    expect(rendered).toContain("reviewer spoof");
    expect(rendered).toContain("bodyhidden");
    expect(rendered).toContain("next");
    expect(rendered).toContain("last");
    expect(canonical).toEqual(before);
  });

  it("retains passive state, cues, warnings, and elastic descriptions at usable narrow widths", () => {
    const pending = renderAgentCall({ subagent_type: "very-long-reviewer-identity", description: "Review authentication boundaries" }, undefined)
      .render(30).join("");
    expect(pending).toMatch(/^.+ - .+$/u);
    const running = renderAgentResult({ content: [{ type: "text", text: "" }], details: {
      agent: "very-long-reviewer-identity", live: true, durationMs: 999_999, usage: { inputTokens: 99999, outputTokens: 88888 },
    } }, { isPartial: true }, undefined).render(30).join("");
    expect(running).toContain("[running]");
    const failed = renderAgentResult({ content: [{ type: "text", text: "partial" }], details: {
      agent: "very-long-reviewer-identity", outcome: "failed", error: "required error",
    } }, { isPartial: false, expanded: false }, undefined).render(70).join("");
    expect(failed).toContain("[failed]");
    expect(failed).toContain("required error");
    expect(failed).toContain(RECORD_EXPAND_HINT);
  });

  it("degrades hostile lifecycle themes to exact readable text while preserving semantic role calls", () => {
    const roles: string[] = [];
    const spyTheme = { fg(slot: string, text: string) { roles.push(slot); return `\u001b[36m${text}\u001b[39m`; }, bold: (text: string) => text };
    const styled = renderAgentResult({ content: [{ type: "text", text: "" }], details: { agent: "reviewer", outcome: "completed" } },
      { isPartial: false, expanded: false }, spyTheme).render(100).join("");
    expect(styled).toContain("reviewer");
    expect(roles).toContain("text");
    expect(roles).toContain("muted");
    for (const hostile of [
      { fg: () => "altered" },
      { fg: (_slot: string, text: string) => `\u001b]0;pwn\u0007${text}` },
      { fg: (_slot: string, text: string) => `\u001b[31m${text}` },
    ]) {
      const plain = renderAgentResult({ content: [{ type: "text", text: "" }], details: { agent: "reviewer", outcome: "completed" } },
        { isPartial: false, expanded: false }, hostile).render(100).join("");
      expect(plain).toContain("reviewer [completed]");
      expect(plain).not.toContain("altered");
      expect(plain).not.toContain("\u001b");
    }
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
// TaskOutput background-identity render — the taskId-gated additions
// to the SHARED renderAgentResult: identity header + agent-<id> subline at every
// surface, badge chips on all outcomes, poll frame, start-block, placeholders,
// and the width-clamp/sanitize guarantees. Pure renderer unit tests.
// ---------------------------------------------------------------------------

describe("TaskOutput identity render", () => {
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
    expect(completed).toContain("task output task-3");
    expect(completed).toContain("coder");
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
    expect(failed).toContain("task output task-4");
    expect(failed).toMatch(/✗|failed/);
    expect(failed).toContain(agentId);

    const aborted = render({
      taskId: "task-5",
      status: "stopped",
      outcome: "aborted",
      agent: "coder",
      agentId,
    });
    expect(aborted).toContain("task output task-5");
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

  it("the background start block is one compact task-targeted line", () => {
    const out = render({
      background: true,
      taskId: "task-2",
      agent: "reviewer",
      agentId: "agent-0123456789ab",
    }, "Background task task-2 started");
    expect(out).toBe("reviewer [background]");
    expect(out).not.toContain("agent-0123456789ab");
    expect(out).not.toContain("TaskOutput");
  });

  it("a live partial with an absent/empty snapshot renders only identity and running state", () => {
    const bare = render(
      { taskId: "task-8", agent: "coder", agentId: "agent-aabbccddeeff", live: true },
      "",
      true,
    );
    expect(bare).toContain("task output task-8");
    expect(bare).toBe("task output task-8 - coder [running]");

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
    expect(emptySnap).toBe("task output task-8 - coder [running]");
  });

  it("a live partial collapses to one identity/state line without activity; detail owns the tail", () => {
    const lines = renderAgentResult(
      {
        content: [{ type: "text", text: "> Grep (x)\n… running Grep…" }],
        details: {
          taskId: "task-1",
          agent: "coder",
          agentId: "agent-aabbccddeeff",
          subagentProgress: { tail: ["> Grep (x)"], activity: "running Grep…" },
          live: true,
        },
      },
      { isPartial: true },
      undefined,
    ).render(120);
    expect(lines).toHaveLength(1); // single status line — no rolling tail in chat
    const out = lines.join("\n");
    expect(out).toContain("task output task-1");
    expect(out).toContain("coder");
    expect(out).toContain("running");
    expect(out).not.toContain("Grep");
    expect(out).not.toContain("> Grep (x)"); // the tail lives in the panel/drill-down
  });

  it("a wait:false poll renders one identity/state line without live activity", () => {
    const active = render({
      taskId: "task-6",
      status: "running",
      agent: "coder",
      agentId: "agent-aabbccddeeff",
      lastActivity: "running Grep…",
    }, "Background task task-6 (coder) is still running — running Grep…");
    expect(active).toContain("task output task-6");
    expect(active).toContain("coder");
    expect(active).toContain("running");
    expect(active).not.toContain("Grep");

    const idle = render({
      taskId: "task-6",
      status: "running",
      agent: "coder",
      agentId: "agent-aabbccddeeff",
    });
    expect(idle).toContain("task output task-6");
    expect(idle).toContain("running");
  });

  it("two same-type concurrent tasks render DISTINCT Task(task-N) status lines", () => {
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
    expect(a).toContain("task output task-1");
    expect(a).toContain("running");
    expect(a).not.toContain("Grep");
    expect(b).toContain("task output task-2");
    expect(b).toContain("running");
    expect(b).not.toContain("Read");
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

      // The agent-<id> is on its own line (identity subline) in the FULL record
      // (no `expanded` option → the legacy full render), so at any width wide
      // enough to hold it (>= its 18 columns) it is never the truncated element.
      // The poll is now a single status line — its identity lives in the spawn
      // record and the expanded completion record instead.
      if (width >= 20) {
        expect(final.join("\n")).toContain(agentId);
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

  it("FOREGROUND (no taskId): a completed body ending in a usage: line is KEPT — no background usage-strip", () => {
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

  it("settled resumable SUPPRESSES the standalone agent-<id> subline; non-resumable keeps it", () => {
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
// Condensed completion records — the collapsed-by-default final render
// (identity + duration + usage + local time + expand affordance), the Ctrl+O
// expanded full body, the exactly-once reference line, and the \r line-break
// discipline. Pure renderer unit tests over renderAgentResult.
// ---------------------------------------------------------------------------

describe("condensed completion records", () => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  const AGENT_ID = "agent-aabbccddeeff";
  const completedDetails = {
    taskId: "task-3",
    status: "completed",
    outcome: "completed",
    agent: "coder",
    agentId: AGENT_ID,
    transcriptPath: `/x/sessions/${AGENT_ID}.jsonl`,
    resumable: true,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
    durationMs: 242_000,
    settledAt: new Date(2026, 0, 2, 7, 5).getTime(),
  };
  const renderLines = (
    details: Record<string, unknown>,
    text: string,
    expanded: boolean | undefined,
    width = 200,
  ) =>
    renderAgentResult(
      { content: [{ type: "text", text }], details },
      expanded === undefined ? { isPartial: false } : { isPartial: false, expanded },
      undefined,
    ).render(width);

  it("collapsed success is one Agent-to-Task completion line with metadata, local time, and expand affordance", () => {
    const lines = renderLines(completedDetails, "the answer", false);
    expect(lines).toHaveLength(1);
    const out = lines[0]!;
    expect(out).toContain("task output task-3 - coder [completed]");
    expect(out).toContain("4m02s");
    expect(out).toContain("in 10");
    expect(out).toContain("07:05");
    expect(out).not.toContain(".jsonl");
    expect(out).not.toContain("/x/sessions/");
    expect(out).toContain(RECORD_EXPAND_HINT);
    expect(out).not.toContain("the answer");
    const order = ["4m02s", "in 10", "07:05", RECORD_EXPAND_HINT].map((s) => out.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("wraps complete explicit TaskOutput targets while keeping lifecycle text readable", () => {
    const longAgent = "project-security-reviewer-with-an-extra-long-name";
    for (const width of [8, 20, 60, 80]) {
      const lines = renderLines({ ...completedDetails, agent: longAgent }, "answer", false, width);
      const plain = lines.join("");
      expect(plain).toContain("task-3");
      expect(plain).toContain("[completed]");
      for (const line of lines) expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("keeps failed, aborted, user-stopped, and reference states textual", () => {
    const cases = [
      { taskId: "task-4", status: "failed", outcome: "failed", agent: "coder", state: "[failed]" },
      { taskId: "task-5", status: "stopped", outcome: "aborted", agent: "coder", state: "[aborted]" },
      { taskId: "task-6", status: "stopped", outcome: "aborted", agent: "coder", userStopped: true, state: "[stopped by user]" },
    ];
    for (const details of cases) {
      const collapsed = renderLines(details, "partial output", false).join("\n");
      expect(collapsed).toContain(`task output ${details.taskId} - coder ${details.state}`);
      expect(collapsed).toContain(RECORD_EXPAND_HINT);
      const reference = renderLines({ ...details, alreadyReported: true }, "partial output", false).join("\n");
      expect(reference).toContain(details.state);
      expect(reference).toContain(RECORD_REFERENCE_NOTE);
    }
  });

  it("foreground success uses the same grammar without a Task target", () => {
    const lines = renderLines(
      { ...completedDetails, taskId: undefined, transcriptPath: "/x/foreground.jsonl" },
      "foreground answer",
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("coder [completed]");
    expect(lines[0]).not.toContain("Task(");
    expect(lines[0]).not.toContain(".jsonl");
    expect(lines[0]).not.toContain("foreground answer");
    expect(lines[0]).toContain(RECORD_EXPAND_HINT);
  });

  it("omits task IDs from passive Agent collapsed, expanded, and reference headers", () => {
    const details = { ...completedDetails, taskId: "task-passive-secret" };
    for (const [expanded, alreadyReported] of [[false, false], [true, false], [false, true]] as const) {
      const lines = renderAgentResult(
        { content: [{ type: "text", text: "answer" }], details: { ...details, alreadyReported } },
        { isPartial: false, expanded }, undefined, undefined, { surface: "agent" },
      ).render(200);
      expect(lines[0]).toContain("coder [completed]");
      expect(lines[0]).not.toContain("task-passive-secret");
    }
  });

  it("tints only passive agent identity with each validated palette color", () => {
    const colors = ["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"];
    for (const color of colors) {
      const rendered = renderAgentResult(
        { content: [{ type: "text", text: "answer" }], details: { outcome: "completed", agent: "coder" } },
        { isPartial: false, expanded: false },
        undefined,
        undefined,
        { surface: "agent", resolveAgentColor: () => color },
      ).render(120)[0]!;
      expect(rendered).toMatch(/^\u001b\[[0-9;]+mcoder\u001b\[39m \[completed\]/u);
      expect(rendered.replace(/\u001b\[[0-9;]*m/gu, "")).toContain("coder [completed]");
    }
    const unknown = renderAgentResult(
      { content: [], details: { outcome: "completed", agent: "coder" } },
      { isPartial: false, expanded: false }, undefined, undefined,
      { surface: "agent", resolveAgentColor: () => "chartreuse" },
    ).render(120)[0]!;
    expect(unknown).not.toContain("\u001b");
  });

  it("collapsed tokens are in/out (+cost) ONLY — cache read/write counts live exclusively in the expanded usage: footer", () => {
    const details = {
      ...completedDetails,
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2048,
        cacheWriteTokens: 1024,
        costUsd: 0.25,
      },
    };
    const collapsed = renderLines(details, "the answer", false);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("in 10");
    expect(collapsed[0]).toContain("out 5");
    expect(collapsed[0]).toContain("$0.25");
    expect(collapsed[0]).not.toContain("cache read");
    expect(collapsed[0]).not.toContain("cache write");
    // At an ordinary 120-column terminal the sole expand cue survives optional metadata.
    const at120 = renderLines(details, "the answer", false, 120);
    expect(at120).toHaveLength(1);
    expect(at120[0]).not.toContain(".jsonl");
    expect(at120[0]).toContain(RECORD_EXPAND_HINT);
    // Nothing is lost: the expanded usage: footer keeps the full compact line.
    const expanded = renderLines(details, "the answer", true).join("\n");
    expect(expanded).toContain("usage: in 10 · out 5 · cache read 2048 · cache write 1024 · $0.25");
  });

  it("compact success omits transcript filenames for both path separator styles", () => {
    const lines = renderLines(
      {
        ...completedDetails,
        transcriptPath: `C:\\Users\\a\\.pi\\sessions\\x.subagents\\${AGENT_ID}.jsonl`,
      },
      "the answer",
      false,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(".jsonl");
    expect(lines[0]).not.toContain("C:\\Users");
    const posix = renderLines(
      { ...completedDetails, transcriptPath: `/home/a/${AGENT_ID}.jsonl` },
      "the answer",
      false,
    );
    expect(posix[0]).not.toContain(".jsonl");
  });

  it("expanded (Ctrl+O) shows the full record: body, transcript path, duration, usage, resumable hint", () => {
    const out = renderLines(completedDetails, "the answer", true).join("\n");
    expect(out).toContain("the answer");
    expect(out).toContain("transcript: /x/sessions/");
    expect(out).toContain("duration: 4m02s");
    expect(out).toContain("usage:");
    expect(out).toContain(`resumable via SendMessage — agent ${AGENT_ID}`);
    expect(out).not.toContain(RECORD_EXPAND_HINT);
  });

  it("formats only Date-TimeClip-valid settlement timestamps as local HH:MM", () => {
    const hhmm = (value: number) => {
      const date = new Date(value);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    };
    const valid = [
      0,
      -1,
      new Date(2026, 0, 2, 7, 5).getTime(),
      new Date(2026, 0, 2, 23, 59).getTime(),
      -8.64e15,
      8.64e15,
    ];
    for (const settledAt of valid) {
      const out = renderLines({ ...completedDetails, settledAt }, "answer", false, 300).join("\n");
      expect(out).toContain(hhmm(settledAt));
    }

    for (const settledAt of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -8.64e15 - 1, 8.64e15 + 1]) {
      const details = { ...completedDetails, settledAt };
      const out = renderLines(details, "answer", false, 300).join("\n");
      expect(out).not.toMatch(/ · \d{2}:\d{2} · ctrl\+o to expand$/);
    }
  });

  it("uses settlement time rather than render time", () => {
    const settledAt = new Date(2024, 4, 6, 7, 5).getTime();
    const before = renderLines({ ...completedDetails, settledAt }, "answer", false).join("\n");
    const now = vi.spyOn(Date, "now").mockReturnValue(new Date(2035, 0, 1, 23, 59).getTime());
    const later = renderLines({ ...completedDetails, settledAt }, "answer", false).join("\n");
    now.mockRestore();
    expect(before).toBe(later);
    expect(later).toContain("07:05");
  });

  it("a structural caller that OMITS the expanded option gets the full record (Pi always passes a boolean)", () => {
    const out = renderLines(completedDetails, "the answer", undefined).join("\n");
    expect(out).toContain("the answer");
    expect(out).toContain("transcript:");
  });

  it("reserves lifecycle state, actionable markers, and cues before long summaries and telemetry", () => {
    const longError = `provider failure ${"x".repeat(400)}`;
    const diagnostics = [
      { severity: "warning" as const, source: "hook", message: `degraded ${"y".repeat(300)}` },
    ];
    const cases = [
      { outcome: "completed", state: "completed" },
      { outcome: "failed", status: "failed", error: longError, state: "failed" },
      { outcome: "aborted", status: "stopped", state: "aborted" },
      { outcome: "aborted", status: "stopped", userStopped: true, state: "stopped by user" },
      { outcome: "failed", status: "failed", error: longError, alreadyReported: true, state: "failed", cue: RECORD_REFERENCE_NOTE },
    ];
    for (const width of [72, 88, 104, 120]) {
      for (const scenario of cases) {
        const lines = renderLines({
          ...completedDetails,
          ...scenario,
          agent: "long-project-security-reviewer-identity",
          diagnostics,
          durationMs: 123_000,
          usage: { inputTokens: 99_999, outputTokens: 88_888, costUsd: 123.45 },
        }, "body", false, width);
        const text = lines.join("");
        expect(text).toContain(`[${scenario.state}]`);
        expect(text).toContain("⚠ diagnostic warning");
        expect(text).toContain(scenario.cue ?? RECORD_EXPAND_HINT);
        expect(text).toContain("task-3");
        for (const line of lines) expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(width);
        if (width === 72) {
          expect(text).not.toContain("in 99999");
          expect(text).not.toContain("2m03s");
        }
      }
    }
  });

  it("preserves bounded diagnostics in expanded detail without duplicating fork degradation", () => {
    const fork = `${FORK_DEGRADE_PREFIX} SDK unavailable`;
    const details = {
      ...completedDetails,
      diagnostics: [
        { severity: "info", source: "resolver", message: "used fallback metadata" },
        { severity: "warning", source: "hook", message: "hook output degraded" },
        { severity: "warning", message: fork },
        { severity: "error", source: "runtime", message: "transcript incomplete" },
      ],
    };
    const expanded = renderLines(details, "answer", true, 80).join("\n");
    expect(expanded).toContain("diagnostic [info] · resolver: used fallback metadata");
    expect(expanded).toContain("diagnostic [warning] · hook: hook output degraded");
    expect(expanded).toContain("diagnostic [error] · runtime: transcript incomplete");
    expect(expanded.match(new RegExp(FORK_DEGRADE_PREFIX, "gu"))).toHaveLength(1);
    const collapsed = renderLines(details, "answer", false, 120).join("\n");
    expect(collapsed).toContain(RECORD_FORK_MARKER);
    expect(collapsed).toContain("⚠ diagnostic error");
    expect(collapsed).not.toContain("used fallback metadata");
  });

  it("keeps the requested TaskOutput target across foreign, malformed, and future result shapes", () => {
    const tool = wrapForSelfShell(createTaskOutputTool(new BackgroundTaskRegistry())) as any;
    const requested = "task-requested-target-123456789";
    const results = [
      { content: [{ type: "text", text: "unknown task" }] },
      { content: [{ type: "text", text: "foreign task" }], details: { taskId: "task-foreign", status: "running", agent: "worker" } },
      { content: [{ type: "text", text: "future result" }], details: { taskId: 42, status: "future" } },
      { content: "malformed", details: new Date() },
    ];
    for (const width of [16, 24, 40]) {
      for (const result of results) {
        const context = { state: {}, args: { task_id: requested }, isError: true };
        const call = tool.renderCall(context.args, undefined, context);
        const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, context);
        expect(call.render(width)).toEqual([]);
        const lines = rendered.render(width) as string[];
        expect(lines.join("").replace(/\s/gu, "")).toContain(requested);
        expect(lines.join("\n").match(/task output/gu)).toHaveLength(1);
        expect(lines.join("\n").match(/[○●✗■]/gu)).toHaveLength(1);
        for (const line of lines) expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps one complete requested TaskOutput target when foreign details are background-shaped", () => {
    const tool = wrapForSelfShell(createTaskOutputTool(new BackgroundTaskRegistry())) as any;
    const requested = "task-requested-target-123456789";
    const result = {
      content: [{ type: "text", text: "foreign background-shaped result" }],
      details: { background: true, taskId: "task-foreign", agent: "worker", future: "field" },
    };
    const canonical = structuredClone(result);
    for (const width of [16, 80]) {
      const context = { state: {}, args: { task_id: requested }, isError: true };
      const call = tool.renderCall(context.args, undefined, context);
      const rendered = tool.renderResult(result, { expanded: false, isPartial: false }, undefined, context);
      expect(call.render(width)).toEqual([]);
      const lines = rendered.render(width) as string[];
      const compact = lines.join("").replace(/\s/gu, "");
      expect(compact.split(requested)).toHaveLength(2);
      expect(lines.join("\n").match(/task output/gu)).toHaveLength(1);
      expect(lines.join("\n").match(/[○●✗■]/gu)).toHaveLength(1);
      for (const line of lines) expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(width);
      expect(result).toEqual(canonical);
    }
  });

  it("collapsed FAILED carries the capped error summary on the line", () => {
    const longError = `connection reset ${"x".repeat(200)}`;
    const lines = renderLines(
      {
        taskId: "task-4",
        status: "failed",
        outcome: "failed",
        agent: "coder",
        error: longError,
        transcriptPath: "/x/failure.jsonl",
      },
      "partial work",
      false,
    );
    expect(lines).toHaveLength(1);
    const out = lines[0]!;
    expect(out).toContain("✗ task output task-4 - coder [failed]");
    expect(out).toContain("connection reset");
    expect(out).toContain("…"); // capped, not the full 200-char error
    expect(out).not.toContain("x".repeat(100));
    expect(out).not.toContain("partial work"); // partial output behind expand
    expect(out).not.toContain(".jsonl");
    expect(renderLines(
      { taskId: "task-4", status: "failed", outcome: "failed", agent: "coder", error: longError },
      "partial work",
      true,
    ).join("\n")).toContain("partial work");
  });

  it("a user-stopped task renders ■ … stopped by user, collapsed AND expanded", () => {
    const details = {
      taskId: "task-5",
      status: "stopped",
      outcome: "aborted",
      agent: "coder",
      userStopped: true,
    };
    const collapsed = renderLines(details, "", false);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toContain("■ task output task-5 - coder [stopped by user]");
    expect(renderLines(details, "", true).join("\n")).toContain("stopped by user");
    // A plain model stop keeps the "aborted" wording.
    const modelStop = renderLines(
      { taskId: "task-5", status: "stopped", outcome: "aborted", agent: "coder" },
      "",
      false,
    );
    expect(modelStop[0]).toContain("aborted");
    expect(modelStop[0]).not.toContain("stopped by user");
  });

  it("exactly-once: alreadyReported renders ONLY the reference line — collapsed AND expanded, never a second record", () => {
    const details = { ...completedDetails, alreadyReported: true };
    for (const expanded of [false, true]) {
      const lines = renderLines(details, "the answer", expanded);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("task output task-3 - coder [completed]");
      expect(lines[0]).toContain(RECORD_REFERENCE_NOTE);
      expect(lines[0]).not.toContain(".jsonl");
      expect(lines[0]).not.toContain("/x/sessions/");
      expect(lines[0]).not.toContain("the answer");
      expect(lines[0]).not.toContain(RECORD_EXPAND_HINT);
    }
    // A missing transcript path has no effect on the compact reference.
    const { transcriptPath: _tp, ...noPath } = details;
    const bare = renderLines(noPath, "the answer", false);
    expect(bare).toHaveLength(1);
    expect(bare[0]).toContain(RECORD_REFERENCE_NOTE);
    expect(bare[0]).not.toContain(".jsonl");
  });

  it.each([
    ["scalar", `${ESC}]0;pwn${BEL}SAFE${ESC}[31m RED\rOVER${String.fromCharCode(1)}`],
    ["text field", { text: `${ESC}]0;pwn${BEL}SAFE${ESC}[31m RED\rOVER${String.fromCharCode(1)}` }],
  ])("sanitizes hostile textual usage in collapsed, running, and expanded rendering (%s)", (_label, usage) => {
    const collapsed = renderLines({ ...completedDetails, usage }, "answer", false, 200).join("\n");
    const running = renderAgentResult(
      {
        content: [{ type: "text", text: "activity" }],
        details: { taskId: "task-3", status: "running", agent: "coder", usage },
      },
      { isPartial: true, expanded: false },
      undefined,
    ).render(200).join("\n");
    const expanded = renderLines({ ...completedDetails, usage }, "answer", true, 80).join("\n");
    for (const output of [collapsed, running, expanded]) {
      expect(output).toContain("SAFE RED OVER");
      expect(output).not.toContain(ESC);
      expect(output).not.toContain(BEL);
      expect(output).not.toContain("\r");
      expect(output).not.toContain(String.fromCharCode(1));
      for (const line of output.split("\n")) expect(tuiVisibleWidth(line)).toBeLessThanOrEqual(200);
    }
  });

  it("settlement diagnostics skip null and malformed entries instead of throwing", () => {
    const renderer = renderSettlementRecord(
      {
        record: "subagent-completion",
        outcome: "completed",
        agent: "coder",
        finalText: "answer",
        diagnostics: [
          null,
          {},
          { severity: null, message: null },
          { severity: "bogus", message: "wrong severity" },
          { severity: "warning", message: 42 },
          { severity: "warning", message: `${FORK_DEGRADE_PREFIX}: unavailable` },
        ],
      },
      { expanded: true },
      undefined,
    );
    expect(() => renderer?.render(80)).not.toThrow();
    expect(renderer?.render(80).join("\n")).toContain(FORK_DEGRADE_PREFIX);
    expect(() =>
      renderAgentResult(
        { content: [], details: { outcome: "completed", diagnostics: [null] } as never },
        { expanded: true },
        undefined,
      ).render(80),
    ).not.toThrow();
  });

  it("normalizes direct and settlement details totally and within fixed inspection budgets", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() =>
      renderAgentResult(
        { content: [{ type: "text", text: "body" }], details: revoked.proxy as never },
        { expanded: true },
        undefined,
      ).render(80),
    ).not.toThrow();
    expect(() => renderSettlementRecord(revoked.proxy, { expanded: true }, undefined)).not.toThrow();
    const throwingFields = new Proxy({}, {
      get(): never {
        throw new Error("detail getter");
      },
    });
    expect(() => renderSettlementRecord(throwingFields, { expanded: true }, undefined)).not.toThrow();

    let diagnosticReads = 0;
    const diagnostics = new Proxy(new Array(10_000), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) diagnosticReads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const hostileUsage = Object.defineProperty({}, "inputTokens", {
      get(): never {
        throw new Error("usage getter");
      },
    });
    let tailReads = 0;
    const oversizedTail = new Proxy(new Array(10_000), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) tailReads++;
        return typeof key === "string" && /^\d+$/u.test(key)
          ? "tail".repeat(1_000)
          : Reflect.get(target, key, receiver);
      },
    });
    const hostileProgress = { activity: "working".repeat(10_000), tail: oversizedTail };
    const oversized = {
      outcome: "completed",
      diagnostics,
      usage: hostileUsage,
      subagentProgress: hostileProgress,
    };
    expect(() =>
      renderAgentResult(
        { content: [{ type: "text", text: "safe body" }], details: oversized },
        { expanded: true },
        undefined,
      ).render(80),
    ).not.toThrow();
    expect(() => renderSettlementRecord(oversized, { expanded: true }, undefined)?.render(80)).not.toThrow();
    expect(diagnosticReads).toBeLessThanOrEqual(200);
    expect(tailReads).toBeLessThanOrEqual(24);

    const scalarSafe = renderSettlementRecord(
      { record: "subagent-completion", outcome: "completed", agent: `a\uD800😀\uDC00z`, finalText: `f\uD800😀\uDC00z` },
      { expanded: true },
      undefined,
    )!.render(200).join("\n");
    expect(scalarSafe).toContain("a😀z");
    expect(scalarSafe).toContain("f😀z");
    expect(scalarSafe).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("keeps compact paths content-inert and bounds primitive-only expanded extraction", () => {
    for (const details of [
      { background: true, taskId: "task-1", agent: "coder" },
      { taskId: "task-1", status: "running", agent: "coder" },
      { taskId: "task-1", outcome: "completed", alreadyReported: true, agent: "coder" },
      { taskId: "task-1", outcome: "completed", agent: "coder" },
    ]) {
      let contentReads = 0;
      const result = Object.defineProperty({ details }, "content", {
        get() {
          contentReads++;
          return [{ type: "text", text: "must stay unread" }];
        },
      });
      renderAgentResult(
        result,
        { isPartial: details.status === "running", expanded: false },
        undefined,
      ).render(120);
      expect(contentReads).toBe(0);
    }

    let slots = 0;
    const blocks = new Proxy(new Array(10_000), {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/u.test(key)) slots++;
        if (key === "0") return { type: "text", text: "safe body" };
        if (key === "1") return { type: "text", text: { toString: () => { throw new Error("coerced"); } } };
        if (key === "9999") return { type: "text", text: "late sentinel" };
        return Reflect.get(target, key, receiver);
      },
    });
    const expanded = renderAgentResult(
      { content: blocks, details: { outcome: "completed", agent: "coder" } },
      { expanded: true },
      undefined,
    ).render(120).join("\n");
    expect(expanded).toContain("safe body");
    expect(expanded).not.toContain("late sentinel");
    expect(slots).toBeLessThanOrEqual(256);

    const bodyLimit = 1_048_576;
    for (const content of [
      [{ type: "text", text: `${"r".repeat(bodyLimit - 1)}😀RAW-SENTINEL` }],
      [
        { type: "text", text: "t".repeat(bodyLimit - 2) },
        { type: "text", text: `😀TEXT-SENTINEL` },
      ],
    ]) {
      const rendered = renderAgentResult(
        { content, details: { outcome: "completed", agent: "coder" } },
        { expanded: true },
        undefined,
      ).render(bodyLimit * 2).join("\n");
      expect(rendered).not.toContain("SENTINEL");
      expect(rendered).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });

  it("hostile fields: the collapsed line never leaks control bytes and never overflows any width", () => {
    const theme = {
      fg: (_c: string, s: string) => `${ESC}[31m${s}${ESC}[0m`,
      bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
    };
    const evil = `${ESC}]0;pwned${BEL}co${ESC}[31mder`;
    const details = {
      taskId: "task-6",
      status: "failed",
      outcome: "failed",
      agent: evil,
      error: `boom${BEL}${ESC}[2J`,
      transcriptPath: `/x/${ESC}[31m/agent-3b7caeaf8448.jsonl`,
      usage: { inputTokens: 1 },
      durationMs: 1000,
    } as const;
    const plain = renderAgentResult(
      { content: [{ type: "text", text: "b" }], details },
      { isPartial: false, expanded: false },
      undefined,
    ).render(400).join("\n");
    expect(plain.includes(ESC)).toBe(false);
    expect(plain.includes(BEL)).toBe(false);
    expect(plain).toContain("coder");
    expect(plain).toContain("boom");
    for (const width of [1, 2, 3, 20, 40, 138]) {
      for (const expanded of [false, true]) {
        const lines = renderAgentResult(
          { content: [{ type: "text", text: "字".repeat(60) }], details },
          { isPartial: false, expanded },
          theme,
        ).render(width);
        for (const l of lines) expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("malformed durationMs (NaN / negative / non-number) never renders and never throws", () => {
    for (const durationMs of [Number.NaN, -5, Number.POSITIVE_INFINITY, "soon", null, {}]) {
      const lines = renderLines({ ...completedDetails, durationMs }, "the answer", false);
      expect(lines).toHaveLength(1);
      // The duration segment is dropped whole — no "NaN"/garbage segment — and
      // the expand affordance remains intact.
      expect(lines[0]).not.toContain("NaN");
      expect(lines[0]).not.toContain("soon");
      expect(lines[0]).not.toContain(".jsonl");
      expect(lines[0]).toContain(RECORD_EXPAND_HINT);
      // Same width/no-throw discipline as the hostile matrix above.
      for (const width of [1, 3, 20, 138]) {
        for (const l of renderLines({ ...completedDetails, durationMs }, "x", false, width)) {
          expect(tuiVisibleWidth(l)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("a model-controlled \\r breaks the line like \\n — no same-line display spoofing in the expanded body", () => {
    const CR = String.fromCharCode(13);
    const lines = renderLines(
      { outcome: "completed", agent: "coder" },
      `SAFE-LINE${CR}SPOOF-LINE${CR}\nTHIRD`,
      true,
    );
    for (const l of lines) expect(l.includes(CR)).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("SAFE-LINE");
    expect(out).toContain("SPOOF-LINE");
    expect(out).toContain("THIRD");
    // The CR-separated fragments land on SEPARATE lines.
    expect(lines.some((l) => l.includes("SAFE-LINE") && l.includes("SPOOF-LINE"))).toBe(false);
  });

  it("a \\r in a model-supplied description cannot overprint the spawn line (renderAgentCall)", () => {
    const CR = String.fromCharCode(13);
    const lines = renderAgentCall(
      { subagent_type: "coder", description: `SAFE${CR}SPOOF` },
      undefined,
    ).render(80);
    for (const l of lines) expect(l.includes(CR)).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("SAFE");
    expect(out).toContain("SPOOF");
    // Compact labels flatten line breaks only after control-byte sanitization.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("SAFE SPOOF");
  });

  it("prompt text is absent from the one-line pending row", () => {
    const CR = String.fromCharCode(13);
    const lines = renderAgentCall(
      { subagent_type: "coder", prompt: `SAFE${CR}SPOOF the rest of the prompt` },
      undefined,
    ).render(80);
    for (const l of lines) expect(l.includes(CR)).toBe(false);
    const out = lines.join("\n");
    // Prompt text is intentionally absent from compact pending rows.
    expect(out).toBe("coder");
  });

  it("keeps the task-id-less background fallback content-inert", () => {
    let contentReads = 0;
    const result = Object.defineProperty({ details: { background: true } }, "content", {
      get() {
        contentReads++;
        return [{ type: "text", text: "SPOOF-LINE" }];
      },
    });
    const lines = renderAgentResult(
      result,
      { isPartial: false, expanded: false },
      undefined,
    ).render(80);
    expect(lines).toEqual(["subagent [background]"]);
    expect(contentReads).toBe(0);
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
      piccExtension(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      await pi.waitForInitialization();
      await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
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
      // Pin run_in_background: false so the dispatch runs foreground and the
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
      const customTools = (options.customTools as Array<{
        name: string;
        renderCall?: unknown;
        renderResult?: unknown;
        renderShell?: unknown;
      }>) ?? [];
      const customToolNames = customTools.map((t) => t.name);
      expect(toolNames).not.toContain("SendMessage");
      expect(customToolNames).not.toContain("SendMessage");
      for (const name of ["Grep", "Glob"]) {
        const search = customTools.find((tool) => tool.name === name);
        expect(search, `subagent missing ${name}`).toBeDefined();
        expect(search?.renderCall, `${name} gained main-TUI renderer`).toBeUndefined();
        expect(search?.renderResult, `${name} gained main-TUI renderer`).toBeUndefined();
        expect(search?.renderShell, `${name} gained main-TUI shell`).toBeUndefined();
      }
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

// Wiring-seam revert-catcher: the scratchpad path is computed in index.ts's
// activation and threaded into BOTH the main-session before_agent_start suffix AND
// buildSubagentSystemPrompt's suffix. Boots the REAL harness (same pattern as the
// parent-guard test above) so a dropped call-site arg on either path ships RED.
// (The realpath→transform ORDER + CLAUDE_CODE_TMPDIR honoring are locked by the pure
// computeSessionScratchDir unit tests in test/subprocess-env.test.ts — the win32-only
// slash transform is a no-op on this Linux CI host, so it cannot be caught by a
// booted assertion here.)
describe("scratchpad injection wiring through the real harness", () => {
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
      piccExtension(pi.api as never, { onInitializationSettled: pi.captureInitialization });
      await pi.waitForInitialization();
      await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);

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

describe("self-shell glyph wrapper", () => {
  const ESC = "\u001b";
  const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/gu, "");
  const theme = {
    fg(slot: string, text: string) {
      const code = slot === "muted" ? "90" : slot === "success" ? "32" : slot === "error" ? "31" : "33";
      return `${ESC}[${code}m${text}${ESC}[39m`;
    },
    bold: (text: string) => text,
  };
  type Renderer = { render(width: number): string[] };
  const call = (tool: Record<string, unknown>, args: Record<string, unknown>, ctx: RenderCtx, styled: unknown = theme) =>
    (tool.renderCall as (a: Record<string, unknown>, t: unknown, c: RenderCtx) => Renderer)(args, styled, ctx);
  const result = (tool: Record<string, unknown>, value: Record<string, unknown>, ctx: RenderCtx, styled: unknown = theme) =>
    (tool.renderResult as (r: Record<string, unknown>, o: Record<string, unknown>, t: unknown, c: RenderCtx) => Renderer)(
      value, { expanded: false, isPartial: ctx.isPartial === true }, styled, ctx,
    );

  it.each([
    [{ isPartial: true }, "○", "muted"],
    [{ isPartial: true, isError: true }, "○", "muted"],
    [{ isPartial: false, isError: true }, "✗", "error"],
    [{ isPartial: false, isError: false }, "●", "success"],
  ] as Array<[RenderCtx, string, string]>)
  ("maps ordinary state precedence to foreground glyphs", (ctx, glyph, slot) => {
    const colors: string[] = [];
    const styled = { fg(color: string, text: string) { colors.push(color); return text; }, bg() { throw new Error("bg forbidden"); } };
    const wrapped = wrapForSelfShell({ name: "Demo", renderCall: () => ({ render: () => ["content"] }) });
    expect(call(wrapped, {}, ctx, styled).render(40)).toEqual([`${glyph} content`]);
    expect(colors).toContain(slot);
  });

  it("arbitrates one marker across call/result visibility and repeated renders", () => {
    const wrapped = wrapForSelfShell({
      name: "Demo",
      renderCall: () => ({ render: () => ["call", "call-more"] }),
      renderResult: () => ({ render: () => ["result", "result-more"] }),
    });
    const ctx: RenderCtx = { state: {}, isPartial: false };
    const callComponent = call(wrapped, {}, ctx);
    const resultComponent = result(wrapped, { content: [] }, ctx);
    for (let pass = 0; pass < 2; pass++) {
      expect(callComponent.render(40).map(stripAnsi)).toEqual(["● call", "  call-more"]);
      expect(resultComponent.render(40).map(stripAnsi)).toEqual(["  result", "  result-more"]);
    }
  });

  it("moves ownership from a hidden settled call and supports marker-only edge states", () => {
    const wrapped = wrapForSelfShell({
      name: "Demo",
      renderCall: () => ({ render: () => [] }),
      renderResult: () => ({ render: () => ["summary"] }),
    });
    const ctx: RenderCtx = { state: {}, isPartial: false };
    const callComponent = call(wrapped, {}, ctx);
    const resultComponent = result(wrapped, { content: [] }, ctx);
    expect(callComponent.render(20)).toEqual([]);
    expect(resultComponent.render(20).map(stripAnsi)).toEqual(["● summary"]);

    const pending = wrapForSelfShell({ name: "Pending", renderCall: () => ({ render: () => [] }) });
    expect(call(pending, {}, { state: {}, isPartial: true }).render(20).map(stripAnsi)).toEqual(["○"]);
    const empty = wrapForSelfShell({ name: "Empty", renderResult: () => ({ render: () => [] }) });
    expect(result(empty, { content: [] }, { state: {}, isPartial: false }).render(20).map(stripAnsi)).toEqual(["●"]);
  });

  it("separates direct-result and later HTML-style phases from rendered calls", () => {
    const retained: RenderCtx[] = [];
    const wrapped = wrapForSelfShell({
      name: "Phase",
      renderCall: (_a: unknown, _t: unknown, ctx: RenderCtx) => { retained.push(ctx); return { render: () => [] }; },
      renderResult: () => ({ render: () => ["detail"] }),
    });
    const ctx: RenderCtx = { state: {}, isPartial: true };
    expect(call(wrapped, {}, ctx).render(80).map(stripAnsi)).toEqual(["○"]);
    ctx.isPartial = false;
    expect(result(wrapped, { content: [] }, ctx).render(80).map(stripAnsi)).toEqual(["● detail"]);
    expect(setToolRowOutcome(retained[0], "failure")).toBe(false);
    expect(result(wrapped, { content: [] }, { state: {}, isPartial: false, isError: true }).render(80).map(stripAnsi)).toEqual(["✗ detail"]);
  });

  it("brands only the exact active derived context and clears overrides", () => {
    const retained: RenderCtx[] = [];
    const accepted: boolean[] = [];
    const wrapped = wrapForSelfShell({
      name: "Special",
      renderCall: (args: Record<string, unknown>, _theme: unknown, ctx: RenderCtx) => {
        retained.push(ctx);
        accepted.push(setToolRowOutcome({ ...ctx }, "stopped"));
        if (args.special) accepted.push(setToolRowOutcome(ctx, "stopped"));
        return { render: () => ["row"] };
      },
    });
    const state = {};
    expect(call(wrapped, { special: true }, { state, isPartial: false }).render(30).map(stripAnsi)).toEqual(["■ row"]);
    expect(accepted).toEqual([false, true]);
    expect(setToolRowOutcome(retained[0], "failure")).toBe(false);
    expect(setToolRowOutcome({}, "invalid" as ToolRowOutcome)).toBe(false);
    const coercionTrap = new Proxy({}, { get() { throw new Error("must not coerce"); } });
    expect(setToolRowOutcome({}, coercionTrap as ToolRowOutcome)).toBe(false);
    expect(call(wrapped, {}, { state, isPartial: false }).render(30).map(stripAnsi)).toEqual(["● row"]);
  });

  it("keeps interleaved, neighboring-generation, and hostile contexts isolated", () => {
    const retained: RenderCtx[] = [];
    const attempts: boolean[] = [];
    const wrapped = wrapForSelfShell({
      name: "Interleaved",
      renderCall: (args: Record<string, unknown>, _theme: unknown, ctx: RenderCtx) => {
        retained.push(ctx);
        attempts.push(setToolRowOutcome({ state: ctx.state }, "stopped"));
        if (args.fail) setToolRowOutcome(ctx, "failure");
        return { render: () => [String(args.name)] };
      },
    });
    const sharedState = {};
    const a = call(wrapped, { name: "a", fail: true }, { state: sharedState, isPartial: false });
    const b = call(wrapped, { name: "b" }, { state: sharedState, isPartial: false });
    expect(setToolRowOutcome(retained[0], "stopped")).toBe(false);
    expect(a.render(20).map(stripAnsi)).toEqual(["✗ a"]);
    expect(b.render(20).map(stripAnsi)).toEqual(["● b"]);
    expect(attempts).toEqual([false, false]);
    expect(setToolRowOutcome({ state: sharedState }, "stopped")).toBe(false);
    expect(setToolRowOutcome(new Proxy({}, { get() { throw new Error("hostile"); } }), "stopped")).toBe(false);
    const hostile = new Proxy({}, { get() { throw new Error("hostile"); }, ownKeys() { throw new Error("hostile"); } });
    expect(call(wrapped, { name: "safe" }, hostile as RenderCtx).render(20).map(stripAnsi)).toEqual(["● safe"]);
    expect(call(wrapped, { name: "after" }, { state: sharedState, isPartial: false }).render(20).map(stripAnsi))
      .toEqual(["● after"]);
  });

  it("accepts only safely reset exact glyph styling and never calls theme.bg", () => {
    let receiverOk = false;
    let backgrounds = 0;
    const safeTheme = {
      fg(this: unknown, _slot: string, text: string) { receiverOk = this === safeTheme; return `${ESC}[31m${text}${ESC}[39m`; },
      bg() { backgrounds++; return "bad"; },
    };
    const wrapped = wrapForSelfShell({ name: "Theme" });
    expect(call(wrapped, {}, { state: {}, isPartial: false }, safeTheme).render(20)[0]).toContain(`${ESC}[31m●${ESC}[39m`);
    expect(receiverOk).toBe(true);
    for (const malicious of [
      `${ESC}]0;owned\u0007●${ESC}[39m`, `${ESC}[2J●${ESC}[39m`,
      `${ESC}[31m●extra${ESC}[39m`, `${ESC}[31m●`,
      `${ESC}[41m●${ESC}[39m`, `${ESC}[5m●${ESC}[39m`, `${ESC}[7m●${ESC}[39m`,
      `${ESC}[8m●${ESC}[39m`, `${ESC}[1m●${ESC}[39m`, `${ESC}[1;31m●${ESC}[39m`,
    ]) {
      expect(call(wrapped, {}, { state: {}, isPartial: false }, { fg: () => malicious, bg: () => backgrounds++ }).render(20)[0]).toBe("● theme");
    }
    for (const hostile of [
      null,
      {},
      { get fg() { throw new Error("getter"); } },
      { fg: "not a function" },
      { fg() { throw new Error("function"); } },
    ]) expect(call(wrapped, {}, { state: {}, isPartial: false }, hostile).render(20)[0]).toBe("● theme");
    expect(backgrounds).toBe(0);
  });

  it("preserves balanced generic foreground/bold styling and rejects leaking attributes", () => {
    const safe = {
      bold: (text: string) => `${ESC}[1m${text}${ESC}[22m`,
      fg: (_slot: string, text: string) => `${ESC}[38;5;42m${text}${ESC}[39m`,
    };
    expect(genericCallComponent("Styled", safe).render(80)).toEqual([
      `${ESC}[38;5;42m${ESC}[1mstyled${ESC}[22m${ESC}[39m`,
    ]);
    expect(genericResultComponent({ content: [{ type: "text", text: "output" }] }, safe, {}).render(80))
      .toEqual([`${ESC}[38;5;42moutput${ESC}[39m`]);

    for (const hostile of [
      { bold: (text: string) => `${ESC}[1m${text}`, fg: (_slot: string, text: string) => text },
      { bold: (text: string) => `${ESC}[3m${text}${ESC}[23m`, fg: (_slot: string, text: string) => text },
      { bold: (text: string) => text, fg: (_slot: string, text: string) => `${ESC}[31m${text}` },
      { bold: (text: string) => text, fg: (_slot: string, text: string) => `${ESC}[41m${text}${ESC}[49m` },
    ]) expect(genericCallComponent("Styled", hostile).render(80)).toEqual(["styled"]);
  });

  it.each([Number.NaN, Infinity, -Infinity, -4, 0])("returns no lines for invalid width %s", (width) => {
    expect(call(wrapForSelfShell({ name: "Width" }), {}, { state: {}, isPartial: false }).render(width)).toEqual([]);
  });

  it("normalizes exact widths and keeps Unicode/tab continuations aligned", () => {
    const wrapped = wrapForSelfShell({ name: "Width" });
    const ctx: RenderCtx = { state: {}, isPartial: false };
    const callComponent = call(wrapped, {}, ctx, undefined);
    const resultComponent = result(wrapped, {
      content: [{ type: "text", text: "界e\u0301🙂\twide\n二列" }],
    }, ctx, undefined);
    const atThree = [...callComponent.render(3), ...resultComponent.render(3)];
    expect([...callComponent.render(3.9), ...resultComponent.render(3.9)]).toEqual(atThree);

    for (const width of [1, 2, 3, 3.9, 20, 200]) {
      const lines = [...callComponent.render(width), ...resultComponent.render(width)].map(stripAnsi);
      expect(lines.every((line) => tuiVisibleWidth(line) <= Math.floor(width))).toBe(true);
      if (width === 1) expect(lines).toEqual(["●"]);
      if (width === 2) expect(lines).toEqual(["● "]);
      if (width >= 20) {
        expect(lines).toEqual(["● width", "  界e\u0301🙂   wide", "  二列"]);
        expect(lines.slice(1).every((line) => line.startsWith("  ") && !line.startsWith("   "))).toBe(true);
      }
    }
  });

  it("preserves trusted ANSI, interior blanks, and continuation alignment", () => {
    const trusted = `${ESC}[35mcolored${ESC}[39m`;
    const wrapped = wrapForSelfShell({ name: "Ansi", renderCall: () => ({ render: () => ["", trusted, "", "tail", ""] }) });
    const lines = call(wrapped, {}, { state: {}, isPartial: false }).render(40);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(trusted);
    expect(stripAnsi(lines[1]!)).toBe("  ");
    expect(stripAnsi(lines[2]!)).toBe("  tail");
  });

  it("restores ordinary call outcome when an override precedes a throw", () => {
    const args = Object.freeze({ secret: Object.freeze({ nested: "arg" }) });
    const wrapped = wrapForSelfShell({
      name: "ThrowingCall",
      renderCall: (_args: unknown, _theme: unknown, ctx: RenderCtx) => {
        expect(setToolRowOutcome(ctx, "failure")).toBe(true);
        throw new Error("call");
      },
    });
    expect(call(wrapped, args, { state: {}, isPartial: false }).render(80).map(stripAnsi))
      .toEqual(["● throwing call"]);
    expect(args).toEqual({ secret: { nested: "arg" } });
  });

  it("uses a local result fallback when its constructor throws without mutating frozen inputs", () => {
    const block = Object.freeze({ type: "text", text: "throw result" });
    const content = Object.freeze([block]);
    const details = Object.freeze({ secret: Object.freeze({ nested: "detail" }) });
    const value = Object.freeze({ content, details });
    const options = Object.freeze({ expanded: false, isPartial: false });
    const wrapped = wrapForSelfShell({
      name: "ThrowingResult",
      renderResult: (receivedValue: unknown, receivedOptions: unknown, _theme: unknown, ctx: RenderCtx) => {
        expect(receivedValue).toBe(value);
        expect(receivedOptions).toBe(options);
        expect(setToolRowOutcome(ctx, "failure")).toBe(true);
        throw new Error("result");
      },
    });
    const component = (wrapped.renderResult as Function)(value, options, theme, { state: {}, isPartial: false }) as Renderer;
    expect(component.render(80).map(stripAnsi)).toEqual(["● throw result"]);
    expect(block).toEqual({ type: "text", text: "throw result" });
    expect(content).toEqual([{ type: "text", text: "throw result" }]);
    expect(details).toEqual({ secret: { nested: "detail" } });
    expect(options).toEqual({ expanded: false, isPartial: false });
    expect(value).toEqual({ content: [{ type: "text", text: "throw result" }], details: { secret: { nested: "detail" } } });
  });

  it("restores ordinary result outcome when an override returns an invalid component", () => {
    const block = Object.freeze({ type: "text", text: "result text" });
    const content = Object.freeze([block]);
    const details = Object.freeze({ secret: Object.freeze({ nested: "detail" }) });
    const value = Object.freeze({ content, details });
    const options = Object.freeze({ expanded: false, isPartial: false });
    const wrapped = wrapForSelfShell({
      name: "InvalidResult",
      renderCall: () => ({ render: () => [] }),
      renderResult: (receivedValue: unknown, received: unknown, _theme: unknown, ctx: RenderCtx) => {
        expect(receivedValue).toBe(value);
        expect(received).toBe(options);
        expect(setToolRowOutcome(ctx, "stopped")).toBe(true);
        return null;
      },
    });
    const state = {};
    call(wrapped, {}, { state, isPartial: false });
    const component = (wrapped.renderResult as Function)(value, options, theme, { state, isPartial: false }) as Renderer;
    expect(component.render(80).map(stripAnsi)).toEqual(["● result text"]);
    expect(block).toEqual({ type: "text", text: "result text" });
    expect(content).toEqual([{ type: "text", text: "result text" }]);
    expect(details).toEqual({ secret: { nested: "detail" } });
    expect(options).toEqual({ expanded: false, isPartial: false });
    expect(value).toEqual({ content: [{ type: "text", text: "result text" }], details: { secret: { nested: "detail" } } });
  });

  it("threads previous inner call/result components independently", () => {
    const seenCall: unknown[] = [], seenResult: unknown[] = [];
    const calls: Renderer[] = [], results: Renderer[] = [];
    const wrapped = wrapForSelfShell({
      name: "Incremental",
      renderCall: (_a: unknown, _t: unknown, ctx: RenderCtx) => { seenCall.push(ctx.lastComponent); const c = { render: () => ["call"] }; calls.push(c); return c; },
      renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: RenderCtx) => { seenResult.push(ctx.lastComponent); const c = { render: () => ["result"] }; results.push(c); return c; },
    });
    const firstCall = call(wrapped, {}, { state: {}, isPartial: true });
    const firstResult = result(wrapped, { content: [] }, { state: {}, isPartial: true });
    call(wrapped, {}, { state: {}, isPartial: true, lastComponent: firstCall });
    result(wrapped, { content: [] }, { state: {}, isPartial: true, lastComponent: firstResult });
    expect(seenCall).toEqual([undefined, calls[0]]);
    expect(seenResult).toEqual([undefined, results[0]]);
  });

  it("renders reused mutable inners before reusing shell framing", () => {
    let text = "one";
    let renders = 0;
    const inner = { render: () => { renders++; return [text]; } };
    const wrapped = wrapForSelfShell({ name: "Cached", renderCall: () => inner });
    const state = {};
    const firstComponent = call(wrapped, {}, { state, isPartial: false });
    const first = firstComponent.render(40);
    expect(firstComponent.render(40)).toBe(first);
    text = "two";
    const reconstructed = call(wrapped, {}, { state, isPartial: false, lastComponent: firstComponent });
    expect(reconstructed.render(40).map(stripAnsi)).toEqual(["● two"]);
    expect(renders).toBe(3);
  });

  it("invalidates shell output for content, outcome, registration, ownership, and width changes", () => {
    let text = "same";
    const inner = { render: () => [text] };
    const wrapped = wrapForSelfShell({
      name: "Matrix",
      renderCall: () => inner,
      renderResult: () => ({ render: () => ["result"] }),
    });
    const state = {};
    const pending = call(wrapped, {}, { state, isPartial: true });
    const pendingOutput = pending.render(20);
    text = "changed";
    expect(pending.render(20)).not.toBe(pendingOutput);
    const settled = call(wrapped, {}, { state, isPartial: false, lastComponent: pending });
    const settledOutput = settled.render(20);
    expect(settledOutput.map(stripAnsi)).toEqual(["● changed"]);
    expect(settled.render(21)).not.toBe(settledOutput);

    const registeredState = {};
    const registeredCall = call(wrapped, {}, { state: registeredState, isPartial: false });
    const registeredResult = result(wrapped, { content: [] }, { state: registeredState, isPartial: false });
    expect(registeredCall.render(20).map(stripAnsi)).toEqual(["● changed"]);
    expect(registeredResult.render(20).map(stripAnsi)).toEqual(["  result"]);
  });

  it("preserves execution and definition identities without mutating canonical inputs", async () => {
    const execute = async () => ({ content: [] });
    const parameters = Object.freeze({ kind: "schema" });
    const metadata = Object.freeze({ arbitrary: Object.freeze({ token: 1 }) });
    const source = { name: "Identity", execute, parameters, metadata, arbitrary: metadata.arbitrary };
    const wrapped = wrapForSelfShell(source);
    expect(wrapped.execute).toBe(execute);
    expect(wrapped.parameters).toBe(parameters);
    expect(wrapped.metadata).toBe(metadata);
    expect(wrapped.arbitrary).toBe(metadata.arbitrary);
    expect(await (wrapped.execute as typeof execute)()).toEqual({ content: [] });
  });

  it("keeps generic tab, CRLF, control, and image fallback behavior", () => {
    const component = genericResultComponent({ content: [
      { type: "text", text: "before\tafter\r\ncontrol\u0000safe" },
      { type: "image", data: "Zm9v", mimeType: "image/png" },
    ] }, undefined, { showImages: false });
    const text = component.render(100).join("\n");
    expect(text).toContain("before   after\ncontrolsafe");
    expect(text).toContain("Image");
    expect(text).not.toContain("\r");
  });
});
