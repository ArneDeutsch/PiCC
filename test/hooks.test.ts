import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadAgents } from "../src/claude/agents.js";
import { mergeHookConfigs, parseHookConfig } from "../src/claude/hooks.js";
import { HookRunner, effectiveTimeoutSeconds } from "../src/engine/hook-runner.js";
import { createGuardExtension } from "../src/runtime/guard.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import type { HookConfig, HookHandler, HookPayload, PluginRuntimeContext, ToolCallDescriptor } from "../src/types.js";
import { waitUntil } from "./helpers/async.js";
import { createHookProcessFixture } from "./helpers/hook-process.js";
import {
  NotebookSessionState,
  normalizeNotebookPath,
  resolveNotebookTarget,
} from "../src/runtime/notebook-session.js";
import { createNotebookEditTool } from "../src/runtime/tools/notebook-edit.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcx-hooks-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** bash-friendly (forward-slash) form of a path, for use inside hook commands/env. */
function bashPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function makeRunner(
  rawHooks: unknown,
  overrides: {
    projectDir?: string;
    sessionId?: string;
    env?: Record<string, string>;
    disableAllHooks?: boolean;
    trustedPluginId?: string;
    pluginContexts?: ReadonlyMap<string, PluginRuntimeContext>;
    ensurePluginDataDir?: (context: PluginRuntimeContext, component: string) => { ok: true } | { ok: false; message: string };
    onRuntimeFinding?: (message: string) => void;
    transcriptPath?: () => string | undefined;
    config?: HookConfig;
    onSpawnForTest?: (child: ChildProcess) => void;
  } = {},
): { runner: HookRunner; projectDir: string } {
  const projectDir = overrides.projectDir ?? makeTempDir();
  const config = overrides.config ?? parseHookConfig(
    rawHooks,
    "<test>",
    overrides.trustedPluginId ? { pluginId: overrides.trustedPluginId } : undefined,
  ).config;
  const runner = new HookRunner({
    config,
    projectDir,
    sessionId: overrides.sessionId ?? "sess-test-1",
    env: overrides.env ?? {},
    disableAllHooks: overrides.disableAllHooks ?? false,
    ...(overrides.pluginContexts ? { pluginContexts: overrides.pluginContexts } : {}),
    ...(overrides.pluginContexts
      ? { ensurePluginDataDir: overrides.ensurePluginDataDir ?? (() => ({ ok: true as const })) }
      : {}),
    ...(overrides.onRuntimeFinding ? { onRuntimeFinding: overrides.onRuntimeFinding } : {}),
    ...(overrides.transcriptPath ? { transcriptPath: overrides.transcriptPath } : {}),
    ...(overrides.onSpawnForTest ? { onSpawnForTest: overrides.onSpawnForTest } : {}),
  });
  return { runner, projectDir };
}

function runtimeContext(
  pluginId: string,
  root: string,
  dataDir = makeTempDir(),
  projectDir = makeTempDir(),
): PluginRuntimeContext {
  return { pluginId, pluginName: pluginId.split("@")[0]!, root, dataDir, projectDir };
}

const bashCall: ToolCallDescriptor = {
  tool: "Bash",
  input: { command: "git status" },
  cwd: process.cwd(),
};

// ---------------------------------------------------------------------------
// parseHookConfig
// ---------------------------------------------------------------------------

describe("parseHookConfig", () => {
  it("normalizes the standard shape and the string shorthand", () => {
    const { config, diagnostics } = parseHookConfig(
      {
        PreToolUse: [
          {
            matcher: "Bash",
            if: "Bash(git *)",
            hooks: [
              { type: "command", command: "echo hi", args: ["a"], timeout: 5, once: true },
              "echo shorthand",
            ],
          },
        ],
      },
      "/x/settings.json",
    );
    const entry = config["PreToolUse"]![0]!;
    expect(entry.matcher).toBe("Bash");
    expect(entry.if).toBe("Bash(git *)");
    expect(entry.hooks).toHaveLength(2);
    expect(entry.hooks[0]).toMatchObject({
      type: "command",
      command: "echo hi",
      args: ["a"],
      timeout: 5,
      once: true,
    });
    expect(entry.hooks[1]).toMatchObject({ type: "command", command: "echo shorthand" });
    expect(diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  });

  it("stamps only explicit trusted plugin provenance outside raw handler data", () => {
    const pluginId = "safe@market-a";
    const { config } = parseHookConfig(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo ok", pluginId: "forged@evil", __pluginName: "evil" }, "echo short"] }] },
      "<plugin-hook>",
      { pluginId },
    );
    expect(config["UserPromptSubmit"]![0]!.hooks.map((handler) => handler.pluginId)).toEqual([
      pluginId,
      pluginId,
    ]);
    expect(config["UserPromptSubmit"]![0]!.hooks[0]!.raw).toMatchObject({
      pluginId: "forged@evil",
      __pluginName: "evil",
    });
  });

  it("keeps unknown event names with an info diagnostic", () => {
    const { config, diagnostics } = parseHookConfig(
      { TeammateIdle: [{ hooks: ["echo idle"] }] },
      "/x/settings.json",
    );
    expect(config["TeammateIdle"]).toHaveLength(1);
    expect(config["TeammateIdle"]![0]!.hooks[0]).toMatchObject({
      type: "command",
      command: "echo idle",
    });
    expect(
      diagnostics.some((d) => d.severity === "info" && d.message.includes("TeammateIdle")),
    ).toBe(true);
  });

  it("keeps non-command handler types with raw and a degradation diagnostic", () => {
    const { config, diagnostics } = parseHookConfig(
      { Stop: [{ hooks: [{ type: "prompt", prompt: "Did you run tests?" }] }] },
      "/x/settings.json",
    );
    const handler = config["Stop"]![0]!.hooks[0]!;
    expect(handler.type).toBe("prompt");
    expect(handler.raw).toMatchObject({ type: "prompt", prompt: "Did you run tests?" });
    expect(
      diagnostics.some((d) => d.message.includes('"prompt"') && /no-op|degrad/i.test(d.message)),
    ).toBe(true);
  });

  it("never throws on garbage input", () => {
    for (const garbage of [42, "nope", null, undefined, [1, 2], { PreToolUse: "x" }, { PreToolUse: [null, 7, { hooks: [null, 12] }] }]) {
      expect(() => parseHookConfig(garbage, "<garbage>")).not.toThrow();
    }
    const { config } = parseHookConfig({ PreToolUse: [null, { hooks: [12] }] }, "<g>");
    expect(config["PreToolUse"]).toHaveLength(1);
    expect(config["PreToolUse"]![0]!.hooks).toHaveLength(0);
  });
});

describe("agent frontmatter hook normalization", () => {
  it("preserves handler execution fields (async/once/timeout/shell/args) and entry if:", () => {
    const agentsDir = path.join(makeTempDir(), "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "notifier.md"),
      [
        "---",
        "name: notifier",
        "description: test agent",
        "hooks:",
        "  SubagentStop:",
        "    - if: Bash(git *)",
        "      hooks:",
        "        - type: command",
        "          command: notify.sh",
        "          args: [done]",
        "          shell: powershell",
        "          timeout: 9",
        "          once: true",
        "          async: true",
        "---",
        "Body.",
        "",
      ].join("\n"),
      "utf8",
    );
    const { agents } = loadAgents([{ dir: agentsDir, scope: "project" }]);
    const entry = agents[0]?.hooks?.["SubagentStop"]?.[0];
    expect(entry?.if).toBe("Bash(git *)");
    expect(entry?.hooks[0]).toMatchObject({
      type: "command",
      command: "notify.sh",
      args: ["done"],
      shell: "powershell",
      timeout: 9,
      once: true,
      async: true,
    });
  });
});

describe("mergeHookConfigs", () => {
  it("concatenates entries per event", () => {
    const a = parseHookConfig({ PreToolUse: [{ hooks: ["echo a"] }], Stop: [{ hooks: ["echo s"] }] }, "a").config;
    const b = parseHookConfig({ PreToolUse: [{ hooks: ["echo b"] }] }, "b").config;
    const merged = mergeHookConfigs(a, b);
    expect(merged["PreToolUse"]).toHaveLength(2);
    expect(merged["PreToolUse"]![0]!.hooks[0]!.command).toBe("echo a");
    expect(merged["PreToolUse"]![1]!.hooks[0]!.command).toBe("echo b");
    expect(merged["Stop"]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// HookRunner — selection
// ---------------------------------------------------------------------------

describe("HookRunner selection", () => {
  it("applies matcher regex/alternation against tool_name", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "Edit|Write", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );

    await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } });
    expect(fs.existsSync(marker)).toBe(false);

    await runner.fire("PreToolUse", { tool_name: "Write", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "Edit", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("full-matches the matcher against tool_name — no superstring matches", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "Task", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );

    // Claude semantics: "Task" matches ONLY the Task tool, not TaskCreate etc.
    await runner.fire("PreToolUse", { tool_name: "TaskCreate", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "TaskUpdate", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "TaskList", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);

    await runner.fire("PreToolUse", { tool_name: "Task", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("full-matches each alternation branch (Edit|Write does not fire for NotebookEdit)", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "Edit|Write", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "NotebookEdit", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "WriteFile", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);
    await runner.fire("PreToolUse", { tool_name: "Edit", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('splits plain-name matchers on "," as well as "|" (exact per part)', async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "Edit, Write", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "NotebookEdit", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "WriteFile", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);
    await runner.fire("PreToolUse", { tool_name: "Edit", tool_input: {} });
    await runner.fire("PreToolUse", { tool_name: "Write", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("treats matchers with regex metacharacters as UNANCHORED (substring) JS regexes", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        PreToolUse: [
          { matcher: "mcp__.*", hooks: [`echo mcp >> "$MARKER"`] },
          { matcher: "Edit.*", hooks: [`echo edit-re >> "$MARKER"`] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "mcp__server__list", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["mcp"]);

    // Unanchored: the regex "Edit.*" matches ANY subject containing "Edit" —
    // NotebookEdit included (this is Claude's substring-regex behavior).
    await runner.fire("PreToolUse", { tool_name: "NotebookEdit", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["mcp", "edit-re"]);
  });

  it("honors explicit anchors in regex matchers (^Edit$)", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "^Edit$", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "NotebookEdit", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);
    await runner.fire("PreToolUse", { tool_name: "Edit", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("plain-name matching is case-sensitive", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "edit", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "Edit", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("degrades an invalid matcher regex to a skipped entry with a warning (never throws)", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ matcher: "(unclosed", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(fs.existsSync(marker)).toBe(false);
    expect(outcome.block).toBe(false);
    expect(
      outcome.diagnostics.some((d) => d.severity === "warning" && /not a valid regex/.test(d.message)),
    ).toBe(true);
  });

  it("matches SessionStart entries against the payload source", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        SessionStart: [
          { matcher: "startup", hooks: [`echo startup-only >> "$MARKER"`] },
          { matcher: "startup|resume", hooks: [`echo either >> "$MARKER"`] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );

    await runner.fire("SessionStart", { source: "resume" });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["either"]);

    await runner.fire("SessionStart", { source: "startup" });
    // Matching hooks execute in parallel, so the append order of the
    // second fire is nondeterministic — assert membership and counts instead.
    const lines = fs.readFileSync(marker, "utf8").trim().split(/\r?\n/).sort();
    expect(lines).toEqual(["either", "either", "startup-only"]);
  });

  it("matches PreCompact entries against trigger, accepting reason as fallback key", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreCompact: [{ matcher: "manual", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );

    await runner.fire("PreCompact", { trigger: "auto" });
    await runner.fire("PreCompact", { reason: "auto" });
    expect(fs.existsSync(marker)).toBe(false);

    await runner.fire("PreCompact", { trigger: "manual" });
    // PiCC's extension fires PreCompact with `reason` — the fallback key.
    await runner.fire("PreCompact", { reason: "manual" });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(2);
  });

  it("matches SubagentStop entries against the agent type, exactly", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { SubagentStop: [{ matcher: "db-agent", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("SubagentStop", { subagent_type: "db-agent-writer" });
    expect(fs.existsSync(marker)).toBe(false);
    await runner.fire("SubagentStop", { subagent_type: "db-agent" });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("ignores matcher on events without a documented matcher subject (Stop)", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { Stop: [{ matcher: "whatever", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("Stop", {});
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("does not match when the event's matcher subject is missing from the payload", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        SessionStart: [
          { matcher: "startup", hooks: [`echo specific >> "$MARKER"`] },
          { matcher: ".*", hooks: [`echo wildcard >> "$MARKER"`] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("SessionStart", {}); // no `source`
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["wildcard"]);
  });

  it('matches all tools for ".*", "*", and no matcher', async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        PreToolUse: [
          { matcher: ".*", hooks: [`echo a >> "$MARKER"`] },
          { matcher: "*", hooks: [`echo b >> "$MARKER"`] },
          { hooks: [`echo c >> "$MARKER"`] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("PreToolUse", { tool_name: "Whatever", tool_input: {} });
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(3);
  });

  it("skips entries with if: when no tool call is available, runs them when it is", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PostToolUse: [{ if: "Bash(git *)", hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );

    await runner.fire("PostToolUse", { tool_name: "Bash", tool_input: { command: "git status" } });
    expect(fs.existsSync(marker)).toBe(false); // no toolCall → skipped

    await runner.fire(
      "PostToolUse",
      { tool_name: "Bash", tool_input: { command: "git status" } },
      bashCall,
    );
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });

  it("is a no-op when disableAllHooks is set or the event has no entries", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      { PreToolUse: [{ hooks: [`echo fired >> "$MARKER"`] }] },
      { projectDir: dir, env: { MARKER: bashPath(marker) }, disableAllHooks: true },
    );
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome).toEqual({ block: false, askDowngraded: false, diagnostics: [] });
    expect(fs.existsSync(marker)).toBe(false);

    const { runner: runner2 } = makeRunner({ PreToolUse: [{ hooks: ["exit 2"] }] });
    const outcome2 = await runner2.fire("Stop", {});
    expect(outcome2.block).toBe(false);
    expect(outcome2.diagnostics).toHaveLength(0);
  });

  it("hasHooks is a cheap config probe honoring disableAllHooks", () => {
    const { runner } = makeRunner({ PreToolUse: [{ hooks: ["echo hi"] }] });
    expect(runner.hasHooks("PreToolUse")).toBe(true);
    expect(runner.hasHooks("PostToolUse")).toBe(false);

    const { runner: disabled } = makeRunner(
      { PreToolUse: [{ hooks: ["echo hi"] }] },
      { disableAllHooks: true },
    );
    expect(disabled.hasHooks("PreToolUse")).toBe(false);
  });

  it("fires once: true handlers at most once per runner instance", async () => {
    const dir = makeTempDir();
    const marker = path.join(dir, "marker.txt");
    const { runner } = makeRunner(
      {
        SessionStart: [
          { hooks: [{ type: "command", command: `echo seeded >> "$MARKER"`, once: true }] },
        ],
      },
      { projectDir: dir, env: { MARKER: bashPath(marker) } },
    );
    await runner.fire("SessionStart", {});
    await runner.fire("SessionStart", {});
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// HookRunner — exit-code / stdout contract
// ---------------------------------------------------------------------------

describe("HookRunner output contract", () => {
  it("blocks on exit code 2 with the stderr reason", async () => {
    const { runner } = makeRunner({
      PreToolUse: [{ hooks: ["echo blocked-by-guard >&2; exit 2"] }],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(true);
    expect(outcome.blockReason).toBe("blocked-by-guard");
  });

  it("treats permissionDecision deny as a block with its reason", async () => {
    const json =
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"nope"}}';
    const { runner } = makeRunner({ PreToolUse: [{ hooks: [`echo '${json}'`] }] });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(true);
    expect(outcome.blockReason).toBe("nope");
  });

  it("downgrades permissionDecision ask to askDowngraded (allowed)", async () => {
    const json = '{"hookSpecificOutput":{"permissionDecision":"ask"}}';
    const { runner } = makeRunner({ PreToolUse: [{ hooks: [`echo '${json}'`] }] });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(false);
    expect(outcome.askDowngraded).toBe(true);
  });

  it("proceeds on permissionDecision allow", async () => {
    const json = '{"hookSpecificOutput":{"permissionDecision":"allow"}}';
    const { runner } = makeRunner({ PreToolUse: [{ hooks: [`echo '${json}'`] }] });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(false);
    expect(outcome.askDowngraded).toBe(false);
  });

  it("aggregates additionalContext across handlers (hookSpecificOutput + top-level)", async () => {
    const first = '{"hookSpecificOutput":{"additionalContext":"ctx-one"}}';
    const second = '{"additionalContext":"ctx-two"}';
    const { runner } = makeRunner({
      PreToolUse: [{ hooks: [`echo '${first}'`, `echo '${second}'`] }],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.additionalContext).toBe("ctx-one\nctx-two");
    expect(outcome.block).toBe(false);
  });

  it("passes updatedInput through (and merges across handlers)", async () => {
    const first = '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"npm run lint"}}}';
    const second = '{"updatedInput":{"description":"lint"}}';
    const { runner } = makeRunner({
      PreToolUse: [{ hooks: [`echo '${first}'`, `echo '${second}'`] }],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.updatedInput).toEqual({ command: "npm run lint", description: "lint" });
  });

  it("keeps event-specific block separate from universal continue:false", async () => {
    const stopJson = '{"decision":"block","reason":"tests not run"}';
    const { runner } = makeRunner({ Stop: [{ hooks: [`echo '${stopJson}'`] }] });
    const outcome = await runner.fire("Stop", {});
    expect(outcome.block).toBe(true);
    expect(outcome.blockReason).toBe("tests not run");

    const contJson = '{"continue":false,"stopReason":"build failed"}';
    const { runner: runner2 } = makeRunner({ Stop: [{ hooks: [`echo '${contJson}'`] }] });
    const outcome2 = await runner2.fire("Stop", {});
    expect(outcome2.block).toBe(false);
    expect(outcome2.blockReason).toBeUndefined();
    expect(outcome2.stop).toBe(true);
    expect(outcome2.stopReason).toBe("build failed");

    const { runner: compactRunner } = makeRunner({
      PostCompact: [{ hooks: [`echo '${stopJson}'`, `echo '${contJson}'`] }],
    });
    const compact = await compactRunner.fire("PostCompact", { trigger: "auto" });
    expect(compact.block).toBe(false);
    expect(compact.stop).toBe(true);
  });

  it("captures plain stdout for UserPromptSubmit but ignores it for PreToolUse", async () => {
    const { runner } = makeRunner({
      UserPromptSubmit: [{ hooks: ["echo remember-the-style-guide"] }],
      PreToolUse: [{ hooks: ["echo should-be-ignored"] }],
    });
    const prompt = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(prompt.stdout).toBe("remember-the-style-guide");
    const pre = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(pre.stdout).toBeUndefined();
    expect(pre.block).toBe(false);
  });

  it("reports other nonzero exit codes as non-blocking diagnostics", async () => {
    const { runner } = makeRunner({
      PostToolUse: [{ hooks: ["echo warn-text >&2; exit 3"] }],
    });
    const outcome = await runner.fire("PostToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(false);
    expect(
      outcome.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("3") && d.message.includes("warn-text"),
      ),
    ).toBe(true);
  });

  it("collects top-level systemMessage into outcome.systemMessages (fields still honored)", async () => {
    const json = '{"systemMessage":"sys-note","additionalContext":"ctx-x"}';
    const second = '{"systemMessage":"other-note"}';
    const { runner } = makeRunner({
      UserPromptSubmit: [{ hooks: [`echo '${json}'`, `echo '${second}'`] }],
    });
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(outcome.systemMessages).toEqual(["sys-note", "other-note"]);
    expect(outcome.additionalContext).toBe("ctx-x");
  });

  it("suppressOutput: JSON stdout is never injected as plain context; JSON fields still honored", async () => {
    const json = '{"suppressOutput":true,"systemMessage":"quiet","additionalContext":"still-here"}';
    const { runner } = makeRunner({ UserPromptSubmit: [{ hooks: [`echo '${json}'`] }] });
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.additionalContext).toBe("still-here");
    expect(outcome.systemMessages).toEqual(["quiet"]);
    expect(outcome.block).toBe(false);
  });

  it("scopes exit-2 blocking: SessionStart exit 2 degrades to a warning, not a block", async () => {
    const { runner } = makeRunner({
      SessionStart: [{ hooks: ["echo not-blockable-here >&2; exit 2"] }],
      SubagentStart: [{ hooks: ["echo subagent-start-not-blockable >&2; exit 2"] }],
      Stop: [{ hooks: ["echo stop-me >&2; exit 2"] }],
    });
    const start = await runner.fire("SessionStart", { source: "startup" });
    expect(start.block).toBe(false);
    expect(
      start.diagnostics.some(
        (d) =>
          d.severity === "warning" &&
          d.message.includes("not blockable") &&
          d.message.includes("not-blockable-here"),
      ),
    ).toBe(true);

    const subagentStart = await runner.fire("SubagentStart", { agent_type: "plugin:reviewer" });
    expect(subagentStart.block).toBe(false);
    expect(subagentStart.diagnostics.some((d) => d.message.includes("subagent-start-not-blockable"))).toBe(true);

    // Blockable events keep the exit-2 block contract.
    const stop = await runner.fire("Stop", {});
    expect(stop.block).toBe(true);
    expect(stop.blockReason).toBe("stop-me");
  });

  it("truncates each collected context value to 10,000 chars with a truncation suffix", async () => {
    const { runner } = makeRunner({
      UserPromptSubmit: [
        {
          hooks: [
            `printf 'a%.0s' {1..12000}`,
            `printf '{"additionalContext":"%s"}' "$(printf 'b%.0s' {1..12000})"`,
          ],
        },
      ],
    });
    const outcome = await runner.fire("UserPromptSubmit", { prompt: "hi" });
    expect(outcome.stdout?.length).toBe(10_000 + "…[truncated]".length);
    expect(outcome.stdout?.endsWith("…[truncated]")).toBe(true);
    expect(outcome.stdout?.startsWith("aaa")).toBe(true);
    expect(outcome.additionalContext?.length).toBe(10_000 + "…[truncated]".length);
    expect(outcome.additionalContext?.endsWith("…[truncated]")).toBe(true);
  }, 20000);

  it("warns when hookSpecificOutput.hookEventName mismatches the firing event (fields honored)", async () => {
    const json =
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"kept-anyway"}}';
    const { runner } = makeRunner({ PreToolUse: [{ hooks: [`echo '${json}'`] }] });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(
      outcome.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes('"PostToolUse"'),
      ),
    ).toBe(true);
    expect(outcome.additionalContext).toBe("kept-anyway");

    // A matching hookEventName produces no warning.
    const good = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"x"}}`;
    const { runner: runner2 } = makeRunner({ PreToolUse: [{ hooks: [`echo '${good}'`] }] });
    const outcome2 = await runner2.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome2.diagnostics.filter((d) => d.severity === "warning")).toHaveLength(0);
  });

  it("kills the immediate timed-out hook process and continues with a diagnostic", async () => {
    const parent = makeTempDir();
    const child = createHookProcessFixture(parent);
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command", command: child.command, args: ["timeout", "timeout"], timeout: 1,
      }] }] },
      { projectDir: parent, env: child.env, onSpawnForTest: child.onSpawnForTest },
    );
    let observedPids: { pid: number; ppid: number } | undefined;
    const firing = runner.fire("UserPromptSubmit", {});
    try {
      await child.waitFor(["timeout.entered"], "timed hook to publish pid evidence");
      observedPids = JSON.parse(child.read("timeout.entered")) as { pid: number; ppid: number };
      const outcome = await firing;
      expect(outcome.block).toBe(false);
      expect(outcome.diagnostics.some((d) => /timed out/i.test(d.message))).toBe(true);

      const immediate = child.spawnedChildren();
      expect(immediate).toHaveLength(1);
      const immediatePid = immediate[0]!.pid;
      if (process.platform === "win32") {
        // The immediate process is the shell, not the exec'd helper, and some
        // Git Bash/MSYS layerings (e.g. windows-latest CI) insert an extra
        // process so the helper's ppid is not necessarily the immediate tracked
        // child. The authoritative kill proof is the immediate ChildProcess
        // close (below) plus the helper tree-death (below), not an exact ppid
        // identity; just require a real tracked pid here.
        expect(typeof immediatePid).toBe("number");
        expect(immediatePid).toBeGreaterThan(0);
      } else {
        // POSIX `exec` replaces the shell, so the helper IS the immediate process.
        expect(immediatePid).toBe(observedPids.pid);
      }
      // The observed ChildProcess close event, rather than helper publication,
      // is the authoritative proof that HookRunner's immediate process died.
      await child.waitForAllClosed("timed-out immediate hook process to close");
      expect(child.isClosed(immediate[0]!)).toBe(true);

      if (process.platform === "win32") {
        // Keep the protocol-level tree-kill assertion for the native Node child.
        await waitUntil({
          description: `timed-out helper process ${observedPids.pid} to die`,
          predicate: () => !processIsAlive(observedPids!.pid),
          describeObserved: () => child.describe(),
          timeoutMs: 5_000,
        });
      }
      // A HookRunner timeout kill is externally imposed: the helper must not
      // have reached either cooperative completion or its much-later watchdog.
      expect(child.exists("timeout.done")).toBe(false);
      expect(child.exists("timeout.watchdog-expired")).toBe(false);
      expect(child.exists("post-timeout-side-effect")).toBe(false);
    } finally {
      // The spawn observer exists before helper startup, so cleanup remains
      // complete even if timeout.entered was never published.
      await child.cleanup("timeout");
      await firing;
      if (process.platform === "win32" && observedPids) {
        await waitUntil({
          description: "timeout helper cleanup",
          predicate: () => !processIsAlive(observedPids!.pid),
          describeObserved: () => `helperPid=${observedPids!.pid}`,
          timeoutMs: 5_000,
        });
      }
    }
  }, 20000);

  it("degrades prompt/agent/mcp_tool handlers to no-ops with a diagnostic", async () => {
    const { runner } = makeRunner({
      Stop: [{ hooks: [{ type: "prompt", prompt: "check work" }, { type: "agent", agent: "reviewer" }] }],
    });
    const outcome = await runner.fire("Stop", {});
    expect(outcome.block).toBe(false);
    expect(outcome.diagnostics.filter((d) => /no-op/.test(d.message))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// HookRunner — placeholders, env, args
// ---------------------------------------------------------------------------

describe("HookRunner placeholders and environment", () => {
  it("expands ${CLAUDE_PROJECT_DIR} and unbraced $CLAUDE_PROJECT_DIR before spawn", async () => {
    // Single quotes prevent bash env expansion — only a pre-spawn textual
    // replacement can produce the real path here.
    const { runner, projectDir } = makeRunner({
      UserPromptSubmit: [
        { hooks: [`printf '%s' '\${CLAUDE_PROJECT_DIR}'`, `printf '%s' '$CLAUDE_PROJECT_DIR'`] },
      ],
    });
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${projectDir}\n${projectDir}`);
  });

  it("exposes CLAUDE/settings env while stripping inherited launcher context", async () => {
    const previous = {
      PICC_LAUNCHER_PID: process.env.PICC_LAUNCHER_PID,
      PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
    };
    process.env.PICC_LAUNCHER_PID = "99";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    try {
      const { runner } = makeRunner(
        {
          UserPromptSubmit: [
            { hooks: [`printf '%s|%s|%s|%s|%s' "$CLAUDE_HOOK_EVENT" "$CLAUDE_SESSION_ID" "$MY_SETTING" "$PICC_LAUNCHER_PID" "$PI_SKIP_VERSION_CHECK"`] },
          ],
        },
        { sessionId: "sess-42", env: { MY_SETTING: "from-settings" } },
      );
      const outcome = await runner.fire("UserPromptSubmit", {});
      expect(outcome.stdout).toBe("UserPromptSubmit|sess-42|from-settings||");
    } finally {
      if (previous.PICC_LAUNCHER_PID === undefined) delete process.env.PICC_LAUNCHER_PID;
      else process.env.PICC_LAUNCHER_PID = previous.PICC_LAUNCHER_PID;
      if (previous.PI_SKIP_VERSION_CHECK === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = previous.PI_SKIP_VERSION_CHECK;
    }
  });

  it("sanitizes a SessionStart hook before first user admission", async () => {
    const previous = {
      PICC_VERSION: process.env.PICC_VERSION,
      PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
    };
    process.env.PICC_VERSION = "1.2.3";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    try {
      const { runner } = makeRunner({
        SessionStart: [{ hooks: [`printf '%s|%s' "$PICC_VERSION" "$PI_SKIP_VERSION_CHECK"`] }],
      });
      const outcome = await runner.fire("SessionStart", { source: "startup" });
      expect(outcome.stdout).toBe("|");
    } finally {
      if (previous.PICC_VERSION === undefined) delete process.env.PICC_VERSION;
      else process.env.PICC_VERSION = previous.PICC_VERSION;
      if (previous.PI_SKIP_VERSION_CHECK === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = previous.PI_SKIP_VERSION_CHECK;
    }
  });

  it("expands plugin variables only from trusted qualified parser context", async () => {
    const pluginRoot = makeTempDir();
    const pluginId = "my-plugin@market-a";
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: `printf '%s' '\${CLAUDE_PLUGIN_ROOT}'`,
          __pluginName: "forged-plugin",
        }] }],
      },
      {
        trustedPluginId: pluginId,
        pluginContexts: new Map([[pluginId, runtimeContext(pluginId, pluginRoot)]]),
      },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(pluginRoot);
  });

  it("appends args to the command", async () => {
    const { runner } = makeRunner({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: `printf '%s'`, args: ["hello world"] }] },
      ],
    });
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe("hello world");
  });

  it("expands ${CLAUDE_PROJECT_DIR} in args (quoting blocks runtime env expansion)", async () => {
    // Args are single-quoted for bash, so only a pre-spawn textual expansion
    // can produce the real path here.
    const { runner, projectDir } = makeRunner({
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: `printf '%s'`, args: ["${CLAUDE_PROJECT_DIR}/src"] },
          ],
        },
      ],
    });
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${projectDir}/src`);
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} in args for a qualified plugin handler", async () => {
    const pluginRoot = makeTempDir();
    const pluginId = "my-plugin@market-a";
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s'`, args: ["${CLAUDE_PLUGIN_ROOT}/bin"] }] }] },
      {
        trustedPluginId: pluginId,
        pluginContexts: new Map([[pluginId, runtimeContext(pluginId, pluginRoot)]]),
      },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${pluginRoot}/bin`);
  });

  it("expands ${CLAUDE_PLUGIN_DATA} in commands and args for plugin-contributed handlers", async () => {
    const pluginRoot = makeTempDir();
    const pluginData = makeTempDir();
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s|%s'`,
                args: ["${CLAUDE_PLUGIN_DATA}/state.json", "${CLAUDE_PLUGIN_ROOT}/bin"],
                __pluginName: "my-plugin",
              },
            ],
          },
        ],
      },
      {
        trustedPluginId: "my-plugin@market-a",
        pluginContexts: new Map([
          ["my-plugin@market-a", runtimeContext("my-plugin@market-a", pluginRoot, pluginData)],
        ]),
      },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${pluginData}/state.json|${pluginRoot}/bin`);
  });

  it("keeps project and qualified contexts distinct while same-context duplicates dedupe", async () => {
    const context = runtimeContext("same@market-a", makeTempDir());
    const projectConfig = parseHookConfig(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "printf x" }] }] },
      "<project>",
    ).config;
    const pluginConfig = parseHookConfig(
      { UserPromptSubmit: [{ hooks: [
        { type: "command", command: "printf x" },
        { type: "command", command: "printf x" },
      ] }] },
      "<plugin>",
      { pluginId: context.pluginId },
    ).config;
    const { runner } = makeRunner(undefined, {
      config: mergeHookConfigs(projectConfig, pluginConfig),
      pluginContexts: new Map([[context.pluginId, context]]),
    });
    expect((await runner.fire("UserPromptSubmit", {})).stdout).toBe("x\nx");
  });

  it("keeps qualified hook contexts distinct for dedup and exports non-overridable env", async () => {
    const first = runtimeContext("same@market-a", makeTempDir(), makeTempDir(), makeTempDir());
    const second = runtimeContext("same@market-b", makeTempDir(), makeTempDir(), makeTempDir());
    const firstConfig = parseHookConfig(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s|%s|%s' "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA" "$CLAUDE_PROJECT_DIR"` }] }] },
      "<first>",
      { pluginId: first.pluginId },
    ).config;
    const secondConfig = parseHookConfig(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s|%s|%s' "$CLAUDE_PLUGIN_ROOT" "$CLAUDE_PLUGIN_DATA" "$CLAUDE_PROJECT_DIR"` }] }] },
      "<second>",
      { pluginId: second.pluginId },
    ).config;
    const previous = {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
      CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    };
    process.env.CLAUDE_PLUGIN_ROOT = "ambient-root";
    process.env.CLAUDE_PLUGIN_DATA = "ambient-data";
    process.env.CLAUDE_PROJECT_DIR = "ambient-project";
    const { runner } = makeRunner(undefined, {
      config: mergeHookConfigs(firstConfig, secondConfig),
      env: {
        CLAUDE_PLUGIN_ROOT: "attacker-root",
        CLAUDE_PLUGIN_DATA: "attacker-data",
        CLAUDE_PROJECT_DIR: "attacker-project",
      },
      pluginContexts: new Map([[first.pluginId, first], [second.pluginId, second]]),
    });
    try {
      const outcome = await runner.fire("UserPromptSubmit", {});
      expect(outcome.stdout).toBe(
        `${first.root}|${first.dataDir}|${first.projectDir}\n${second.root}|${second.dataDir}|${second.projectDir}`,
      );
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reports data creation failure immediately and retains it without spawning", async () => {
    const context = runtimeContext("broken@market-a", makeTempDir());
    const retained: string[] = [];
    let spawned = false;
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo must-not-run" }] }] },
      {
        trustedPluginId: context.pluginId,
        pluginContexts: new Map([[context.pluginId, context]]),
        ensurePluginDataDir: () => ({ ok: false, message: "qualified data mkdir failed; command not spawned" }),
        onRuntimeFinding: (message) => retained.push(message),
        onSpawnForTest: () => { spawned = true; },
      },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(spawned).toBe(false);
    expect(outcome.diagnostics.map((diagnostic) => diagnostic.message)).toContain("qualified data mkdir failed; command not spawned");
    expect(retained).toEqual(["qualified data mkdir failed; command not spawned"]);
  });

  it("contains a throwing runtime-finding observer when plugin context is unavailable", async () => {
    const pluginId = "missing-context@market";
    const message = `hook (UserPromptSubmit) for plugin "${pluginId}": trusted runtime context is unavailable; command not spawned`;
    let spawned = false;
    let observerCalls = 0;
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo must-not-run" }] }] },
      {
        trustedPluginId: pluginId,
        onRuntimeFinding: () => { observerCalls += 1; throw new Error("observer failed"); },
        onSpawnForTest: () => { spawned = true; },
      },
    );

    const outcome = await runner.fire("UserPromptSubmit", {});

    expect(spawned).toBe(false);
    expect(observerCalls).toBe(1);
    expect(outcome.diagnostics).toEqual([{ severity: "warning", message }]);
  });

  it("contains a throwing runtime-finding observer when plugin data preparation fails", async () => {
    const context = runtimeContext("broken-observer@market", makeTempDir());
    const message = "qualified data mkdir failed; command not spawned";
    let spawned = false;
    let observerCalls = 0;
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo must-not-run" }] }] },
      {
        trustedPluginId: context.pluginId,
        pluginContexts: new Map([[context.pluginId, context]]),
        ensurePluginDataDir: () => ({ ok: false, message }),
        onRuntimeFinding: () => { observerCalls += 1; throw new Error("observer failed"); },
        onSpawnForTest: () => { spawned = true; },
      },
    );

    const outcome = await runner.fire("UserPromptSubmit", {});

    expect(spawned).toBe(false);
    expect(observerCalls).toBe(1);
    expect(outcome.diagnostics).toEqual([{ severity: "warning", message }]);
  });

  it("leaves ${CLAUDE_PLUGIN_DATA} unexpanded with a warning when no data dir is known", async () => {
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [{ hooks: [{
          type: "command",
          command: `printf '%s' '\${CLAUDE_PLUGIN_DATA}'`,
          __pluginName: "my-plugin",
        }] }],
      },
      { trustedPluginId: "my-plugin@market-a" },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBeUndefined();
    expect(
      outcome.diagnostics.some(
        (d) => d.severity === "warning" && d.message.includes("trusted runtime context is unavailable"),
      ),
    ).toBe(true);
  });

  it.runIf(process.platform === "win32")("runs powershell hooks with structural plugin variables", async () => {
    const context = runtimeContext("powershell@market", makeTempDir(), makeTempDir(), makeTempDir());
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [{
        type: "command",
        command: "Write-Output \"$env:CLAUDE_PLUGIN_ROOT|$env:CLAUDE_PLUGIN_DATA|$env:CLAUDE_PROJECT_DIR\"",
        shell: "powershell",
      }] }] },
      {
        trustedPluginId: context.pluginId,
        pluginContexts: new Map([[context.pluginId, context]]),
      },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${context.root}|${context.dataDir}|${context.projectDir}`);
  }, 20000);
});

// ---------------------------------------------------------------------------
// HookRunner — stdin payload
// ---------------------------------------------------------------------------

describe("HookRunner stdin payload", () => {
  it("delivers the full JSON payload on stdin with native Windows paths intact", async () => {
    const dir = makeTempDir();
    const outFile = path.join(dir, "payload.json");
    const filePath = "C:\\Users\\Arne\\some file.txt";
    const { runner, projectDir } = makeRunner(
      { PreToolUse: [{ matcher: "Edit", hooks: [`cat > "$OUT_FILE"`] }] },
      { projectDir: dir, sessionId: "sess-stdin", env: { OUT_FILE: bashPath(outFile) } },
    );
    await runner.fire("PreToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: filePath, old_string: "a", new_string: "b" },
    });
    const payload = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect(payload["session_id"]).toBe("sess-stdin");
    expect(payload["cwd"]).toBe(projectDir);
    expect(payload["hook_event_name"]).toBe("PreToolUse");
    expect(payload["tool_name"]).toBe("Edit");
    expect((payload["tool_input"] as Record<string, unknown>)["file_path"]).toBe(filePath);
    // Constant posture field (Claude common schema).
    expect(payload["permission_mode"]).toBe("default");
    // No transcript getter wired here → the field is absent, not null/empty.
    expect("transcript_path" in payload).toBe(false);
  });

  it("includes transcript_path when the deps getter returns a value (and tolerates a throwing getter)", async () => {
    const dir = makeTempDir();
    const outFile = path.join(dir, "payload.json");
    const { runner } = makeRunner(
      { UserPromptSubmit: [{ hooks: [`cat > "$OUT_FILE"`] }] },
      {
        projectDir: dir,
        env: { OUT_FILE: bashPath(outFile) },
        transcriptPath: () => "C:\\sessions\\abc.jsonl",
      },
    );
    await runner.fire("UserPromptSubmit", { prompt: "hi" });
    const payload = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect(payload["transcript_path"]).toBe("C:\\sessions\\abc.jsonl");

    // Degrade-safe: a throwing getter must not break fire().
    const { runner: runner2 } = makeRunner(
      { UserPromptSubmit: [{ hooks: [`cat > "$OUT_FILE"`] }] },
      {
        projectDir: dir,
        env: { OUT_FILE: bashPath(outFile) },
        transcriptPath: () => {
          throw new Error("no session yet");
        },
      },
    );
    const outcome = await runner2.fire("UserPromptSubmit", { prompt: "hi" });
    expect(outcome.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    const payload2 = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect("transcript_path" in payload2).toBe(false);
  });

  it("SubagentStop with NO transcript_path in the payload gets the runner's default (main) — subagent parity", async () => {
    // PiCC fires SubagentStop inside a dispatch WITHOUT a
    // payload transcript_path, so the HookRunner's own default getter (the MAIN
    // session transcript) is what reaches the hook — never the subagent's file.
    const dir = makeTempDir();
    const outFile = path.join(dir, "payload.json");
    const mainTranscript = "C:\\sessions\\main-session.jsonl";
    const { runner } = makeRunner(
      { SubagentStop: [{ hooks: [`cat > "$OUT_FILE"`] }] },
      {
        projectDir: dir,
        env: { OUT_FILE: bashPath(outFile) },
        transcriptPath: () => mainTranscript,
      },
    );
    // Payload as PiCC's fireSubagentStop now sends it: identity fields, no
    // transcript_path.
    await runner.fire("SubagentStop", {
      subagent_type: "reviewer",
      agent_id: "agent-aabbccddeeff",
      agent_type: "reviewer",
    });
    const payload = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect(payload["transcript_path"]).toBe(mainTranscript);
    expect(payload["agent_id"]).toBe("agent-aabbccddeeff");
    expect(payload["agent_type"]).toBe("reviewer");
  });

  it("delivers structured tool_response and tool_use_id verbatim (PostToolUse)", async () => {
    const dir = makeTempDir();
    const outFile = path.join(dir, "payload.json");
    const { runner } = makeRunner(
      { PostToolUse: [{ hooks: [`cat > "$OUT_FILE"`] }] },
      { projectDir: dir, env: { OUT_FILE: bashPath(outFile) } },
    );
    await runner.fire("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: [{ type: "text", text: "file-a\nfile-b" }],
      tool_use_id: "call_123",
    });
    const payload = JSON.parse(fs.readFileSync(outFile, "utf8")) as Record<string, unknown>;
    expect(payload["tool_response"]).toEqual([{ type: "text", text: "file-a\nfile-b" }]);
    expect(payload["tool_use_id"]).toBe("call_123");
  });
});

// ---------------------------------------------------------------------------
// Guard wiring — Pre/PostToolUse payload fields
// ---------------------------------------------------------------------------

describe("guard hook payloads", () => {
  function makeGuard(
    opts: { hasHooks?: (event: string) => boolean; clipMaxTokens?: number } = {},
  ) {
    const fired: Array<{ event: string; payload: Partial<HookPayload> }> = [];
    const hooks = {
      fire: async (event: string, payload: Partial<HookPayload>) => {
        fired.push({ event, payload });
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
      ...(opts.hasHooks ? { hasHooks: opts.hasHooks } : {}),
    } as unknown as HookRunner;
    const engine = new PermissionEngine(
      { allow: [], deny: [], ask: [], additionalDirectories: [] },
      { cwd: process.cwd() },
    );
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      on: (event: string, handler: (event: any, ctx: any) => unknown) =>
        handlers.set(event, handler),
      sendMessage: () => undefined,
    };
    createGuardExtension({
      engine,
      hooks,
      getCwd: () => process.cwd(),
      ...(opts.clipMaxTokens !== undefined ? { clipMaxTokens: opts.clipMaxTokens } : {}),
    })(pi as never);
    return { fired, handlers };
  }

  it("drives canonical NotebookEdit success and failure through the guard lifecycle", async () => {
    const cwd = makeTempDir();
    const nested = path.join(cwd, "nested");
    fs.mkdirSync(nested);
    const notebook = (source: string) => JSON.stringify({
      cells: [{ cell_type: "code", id: "cell-a", metadata: {}, source, execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    });
    const callerPath = path.join(cwd, "caller.ipynb");
    const rewrittenPath = path.join(nested, "book.ipynb");
    fs.writeFileSync(callerPath, notebook("caller-old"));
    fs.writeFileSync(rewrittenPath, notebook("target-old"));

    const state = new NotebookSessionState();
    for (const filePath of [callerPath, rewrittenPath]) {
      state.recordRead(await resolveNotebookTarget(filePath), fs.readFileSync(filePath));
    }
    const tool = createNotebookEditTool(() => cwd, state);
    const fired: Array<{ event: string; payload: Partial<HookPayload> }> = [];
    const touched: string[] = [];
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    let rewrite = "nested/book.ipynb";
    const pi = {
      on: (event: string, handler: (event: any, ctx: any) => unknown) => handlers.set(event, handler),
      sendMessage: () => undefined,
    };
    createGuardExtension({
      engine: new PermissionEngine(
        { allow: [], deny: [], ask: [], additionalDirectories: [] },
        { cwd },
      ),
      hooks: {
        async fire(event: string, payload: Partial<HookPayload>) {
          fired.push({ event, payload });
          return {
            block: false,
            askDowngraded: false,
            diagnostics: [],
            ...(event === "PreToolUse" ? { updatedInput: { notebook_path: rewrite } } : {}),
          };
        },
      } as unknown as HookRunner,
      getCwd: () => cwd,
      contextForTouchedFile: (filePath) => {
        touched.push(filePath);
        return "nested context";
      },
    })(pi as never);

    const validInput = { notebook_path: "caller.ipynb", new_source: "target-new", cell_id: "cell-a" };
    await handlers.get("tool_call")!({ toolName: "NotebookEdit", input: validInput }, {});
    expect(fired[0]).toMatchObject({
      event: "PreToolUse",
      payload: { tool_name: "NotebookEdit", tool_input: { notebook_path: "caller.ipynb" } },
    });
    expect(validInput.notebook_path).toBe("nested/book.ipynb");
    expect(touched).toEqual([normalizeNotebookPath(validInput.notebook_path, cwd)]);
    const success = await tool.execute("valid", validInput, undefined, undefined, {} as never) as {
      content: unknown[]; isError?: boolean;
    };
    await handlers.get("tool_result")!({
      toolName: "NotebookEdit", input: validInput, content: success.content, isError: success.isError === true,
    }, {});
    expect(JSON.parse(fs.readFileSync(callerPath, "utf8")).cells[0].source).toBe("caller-old");
    expect(JSON.parse(fs.readFileSync(rewrittenPath, "utf8")).cells[0].source).toBe("target-new");
    expect(fired.at(-1)).toEqual({
      event: "PostToolUse",
      payload: expect.objectContaining({
        tool_name: "NotebookEdit",
        tool_input: validInput,
        tool_response: success.content,
      }),
    });

    const invalidRewrites = process.platform === "win32"
      ? ["/rooted/book.ipynb", "\\\\?\\C:\\device\\book.ipynb", "/foreign/book.ipynb"]
      : ["C:\\foreign\\book.ipynb", "\\\\?\\C:\\device\\book.ipynb", "\\rooted\\book.ipynb"];
    for (const [index, invalid] of invalidRewrites.entries()) {
      rewrite = invalid;
      const input = { notebook_path: "caller.ipynb", new_source: `invalid-${index}`, cell_id: "cell-a" };
      const touchedBefore = touched.length;
      await handlers.get("tool_call")!({ toolName: "NotebookEdit", input }, {});
      expect(touched).toHaveLength(touchedBefore);
      const failure = await tool.execute(
        `invalid-${index}`, input, undefined, undefined, {} as never,
      ) as { content: unknown[]; isError?: boolean };
      expect(failure.isError).toBe(true);
      await handlers.get("tool_result")!({
        toolName: "NotebookEdit", input, content: failure.content, isError: true,
      }, {});
      expect(fired.at(-1)).toEqual({
        event: "PostToolUseFailure",
        payload: expect.objectContaining({
          tool_name: "NotebookEdit",
          tool_input: input,
          tool_response: failure.content,
        }),
      });
      expect(JSON.parse(fs.readFileSync(callerPath, "utf8")).cells[0].source).toBe("caller-old");
      expect(JSON.parse(fs.readFileSync(rewrittenPath, "utf8")).cells[0].source).toBe("target-new");
    }
  });

  it("passes tool_use_id from the Pi toolCallId on PreToolUse", async () => {
    const { fired, handlers } = makeGuard();
    await handlers.get("tool_call")!(
      { toolName: "bash", toolCallId: "call_pre_1", input: { command: "git status" } },
      {},
    );
    expect(fired[0]?.event).toBe("PreToolUse");
    expect(fired[0]?.payload.tool_use_id).toBe("call_pre_1");
  });

  it("passes the STRUCTURED tool result content as tool_response on PostToolUse", async () => {
    const { fired, handlers } = makeGuard();
    const content = [
      { type: "text", text: "line-1" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ];
    await handlers.get("tool_result")!(
      { toolName: "bash", toolCallId: "call_post_1", input: { command: "ls" }, content, isError: false },
      {},
    );
    expect(fired[0]?.event).toBe("PostToolUse");
    expect(fired[0]?.payload.tool_response).toEqual(content);
    expect(fired[0]?.payload.tool_use_id).toBe("call_post_1");
  });

  it("falls back to flattened text when the result content is not JSON-serializable", async () => {
    const { fired, handlers } = makeGuard();
    const circular: any = { type: "text", text: "only-text" };
    circular.self = circular;
    await handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "ls" }, content: [circular], isError: false },
      {},
    );
    expect(fired[0]?.payload.tool_response).toBe("only-text");
    expect(fired[0]?.payload.tool_use_id).toBeUndefined();
  });

  it("fires no hook and builds no hook payload when hasHooks reports no PostToolUse hooks", async () => {
    const probed: string[] = [];
    // Configure the clip so its (legitimate) pre-gate `.text` read happens — the
    // guard reads the result text to size the clip BEFORE the hasHooks gate. The
    // invariant is no longer "zero .text reads"; it is that with no PostToolUse
    // hooks the handler fires NO hook and builds NO JSON hook payload.
    const { fired, handlers } = makeGuard({
      clipMaxTokens: 20_000,
      hasHooks: (event) => {
        probed.push(event);
        return false;
      },
    });
    // A small, below-budget result is left untouched, so the handler is a no-op.
    const content = [{ type: "text", text: "x" }];
    const result = await handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "ls" }, content, isError: false },
      {},
    );
    expect(result).toBeUndefined();
    expect(probed).toEqual(["PostToolUse"]);
    // The clip path must not call deps.hooks.fire when no hooks are configured.
    expect(fired).toHaveLength(0);
  });

  it("still fires when hasHooks reports true, and asks per failure event", async () => {
    const probed: string[] = [];
    const { fired, handlers } = makeGuard({
      hasHooks: (event) => {
        probed.push(event);
        return true;
      },
    });
    await handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "ls" }, content: [{ type: "text", text: "x" }], isError: true },
      {},
    );
    expect(probed).toEqual(["PostToolUseFailure"]);
    expect(fired[0]?.event).toBe("PostToolUseFailure");
  });

  it("caps the structured tool_response at 50k serialized chars with a truncation envelope", async () => {
    const { fired, handlers } = makeGuard();
    const content = [{ type: "text", text: "x".repeat(60_000) }];
    await handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "ls" }, content, isError: false },
      {},
    );
    const json = JSON.stringify(content);
    const response = fired[0]?.payload.tool_response as {
      truncated: boolean;
      note: string;
      head: string;
    };
    expect(response.truncated).toBe(true);
    expect(response.note).toBe(`tool_response truncated by picc (${json.length} chars)`);
    expect(response.head).toBe(json.slice(0, 50_000));

    // At or under the cap the structured value passes through verbatim.
    const small = [{ type: "text", text: "small" }];
    await handlers.get("tool_result")!(
      { toolName: "bash", input: { command: "ls" }, content: small, isError: false },
      {},
    );
    expect(fired[1]?.payload.tool_response).toEqual(small);
  });
});

// ---------------------------------------------------------------------------
// Timeout defaults
// ---------------------------------------------------------------------------

describe("effectiveTimeoutSeconds", () => {
  const handler = (timeout?: number): HookHandler => ({
    type: "command",
    command: "echo hi",
    ...(timeout !== undefined ? { timeout } : {}),
    raw: {},
  });

  it("defaults to 60s; per-hook timeout wins; UserPromptSubmit is hard-capped at 30s", () => {
    expect(effectiveTimeoutSeconds(handler(), "PreToolUse")).toBe(60);
    expect(effectiveTimeoutSeconds(handler(), "Stop")).toBe(60);
    expect(effectiveTimeoutSeconds(handler(), "UserPromptSubmit")).toBe(30);
    expect(effectiveTimeoutSeconds(handler(5), "PreToolUse")).toBe(5);
    expect(effectiveTimeoutSeconds(handler(90), "PreToolUse")).toBe(90);
    // 30 s is a CEILING for UserPromptSubmit: lower per-hook values win,
    // higher ones clamp (Claude caps these hooks at 30 s).
    expect(effectiveTimeoutSeconds(handler(10), "UserPromptSubmit")).toBe(10);
    expect(effectiveTimeoutSeconds(handler(90), "UserPromptSubmit")).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// HookRunner — http handlers
// ---------------------------------------------------------------------------

describe("HookRunner http handlers", () => {
  it("POSTs the payload and treats the JSON response like command stdout", async () => {
    let received: Record<string, unknown> | undefined;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        received = JSON.parse(body) as Record<string, unknown>;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            hookSpecificOutput: {
              permissionDecision: "deny",
              permissionDecisionReason: "http-nope",
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const { runner } = makeRunner({
        PreToolUse: [{ hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook` }] }],
      });
      const outcome = await runner.fire("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      });
      expect(outcome.block).toBe(true);
      expect(outcome.blockReason).toBe("http-nope");
      expect(received?.["hook_event_name"]).toBe("PreToolUse");
      expect(received?.["tool_name"]).toBe("Bash");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("continues with a diagnostic on network errors", async () => {
    // Grab a free port, then close it so the request is refused.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const { runner } = makeRunner({
      PreToolUse: [{ hooks: [{ type: "http", url: `http://127.0.0.1:${port}/hook` }] }],
    });
    const outcome = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: {} });
    expect(outcome.block).toBe(false);
    expect(outcome.diagnostics.some((d) => d.severity === "warning" && /http/.test(d.message))).toBe(
      true,
    );
  });
});
