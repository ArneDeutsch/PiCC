import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { mergeHookConfigs, parseHookConfig } from "../src/claude/hooks.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import type { HookConfig, ToolCallDescriptor } from "../src/types.js";

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

function makeRunner(
  rawHooks: unknown,
  overrides: {
    projectDir?: string;
    sessionId?: string;
    env?: Record<string, string>;
    disableAllHooks?: boolean;
    pluginRoots?: Record<string, string>;
    config?: HookConfig;
  } = {},
): { runner: HookRunner; projectDir: string } {
  const projectDir = overrides.projectDir ?? makeTempDir();
  const config = overrides.config ?? parseHookConfig(rawHooks, "<test>").config;
  const runner = new HookRunner({
    config,
    projectDir,
    sessionId: overrides.sessionId ?? "sess-test-1",
    env: overrides.env ?? {},
    disableAllHooks: overrides.disableAllHooks ?? false,
    ...(overrides.pluginRoots ? { pluginRoots: overrides.pluginRoots } : {}),
  });
  return { runner, projectDir };
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
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual([
      "either",
      "startup-only",
      "either",
    ]);
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

  it("blocks on Stop-hook style top-level decision/reason and continue:false", async () => {
    const stopJson = '{"decision":"block","reason":"tests not run"}';
    const { runner } = makeRunner({ Stop: [{ hooks: [`echo '${stopJson}'`] }] });
    const outcome = await runner.fire("Stop", {});
    expect(outcome.block).toBe(true);
    expect(outcome.blockReason).toBe("tests not run");

    const contJson = '{"continue":false,"stopReason":"build failed"}';
    const { runner: runner2 } = makeRunner({ Stop: [{ hooks: [`echo '${contJson}'`] }] });
    const outcome2 = await runner2.fire("Stop", {});
    expect(outcome2.block).toBe(true);
    expect(outcome2.blockReason).toBe("build failed");
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

  it("kills timed-out hooks and continues with a diagnostic", async () => {
    const { runner } = makeRunner({
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "sleep 5", timeout: 1 }] }],
    });
    const start = Date.now();
    const outcome = await runner.fire("UserPromptSubmit", {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(4500);
    expect(outcome.block).toBe(false);
    expect(outcome.diagnostics.some((d) => /timed out/i.test(d.message))).toBe(true);
  }, 15000);

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

  it("exposes CLAUDE_* env vars and settings env to the hook process", async () => {
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          { hooks: [`printf '%s|%s|%s' "$CLAUDE_HOOK_EVENT" "$CLAUDE_SESSION_ID" "$MY_SETTING"`] },
        ],
      },
      { sessionId: "sess-42", env: { MY_SETTING: "from-settings" } },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe("UserPromptSubmit|sess-42|from-settings");
  });

  it("expands ${CLAUDE_PLUGIN_ROOT} for plugin-contributed handlers", async () => {
    const pluginRoot = makeTempDir();
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s' '\${CLAUDE_PLUGIN_ROOT}'`,
                __pluginName: "my-plugin",
              },
            ],
          },
        ],
      },
      { pluginRoots: { "my-plugin": pluginRoot } },
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

  it("expands ${CLAUDE_PLUGIN_ROOT} in args for plugin-contributed handlers", async () => {
    const pluginRoot = makeTempDir();
    const { runner } = makeRunner(
      {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: `printf '%s'`,
                args: ["${CLAUDE_PLUGIN_ROOT}/bin"],
                __pluginName: "my-plugin",
              },
            ],
          },
        ],
      },
      { pluginRoots: { "my-plugin": pluginRoot } },
    );
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe(`${pluginRoot}/bin`);
  });

  it.runIf(process.platform === "win32")("runs powershell hooks when shell is powershell", async () => {
    const { runner } = makeRunner({
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: "Write-Output 'ps-out'", shell: "powershell" }] },
      ],
    });
    const outcome = await runner.fire("UserPromptSubmit", {});
    expect(outcome.stdout).toBe("ps-out");
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
