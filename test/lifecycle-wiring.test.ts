import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import { renderMainSessionTool } from "../src/runtime/main-session-tool-render.js";
import { WorktreeManager } from "../src/runtime/worktrees.js";
import { deferred } from "./helpers/async.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";

/**
 * Wired-lifecycle coverage (review finding: zero tests fired after_provider_response,
 * model_select, agent_settled, session_shutdown): quota-header capture, steering
 * re-selection on model switch, the Stop-hook continuation loop incl. its cap,
 * SessionEnd dispatch, PostToolUse block feedback, and compaction state reset.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

function installProjectRootGitCanary(projectRoot: string): string {
  const canary = path.join(projectRoot, process.platform === "win32" ? "git.exe" : "git");
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, canary);
  } else {
    fs.writeFileSync(canary, "#!/bin/sh\nexit 97\n");
    fs.chmodSync(canary, 0o755);
  }
  return canary;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-lw-"));
  const w = (rel: string, content: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  w("CLAUDE.md", "LW-ROOT-INSTRUCTIONS\n");
  w(".claude/rules/uncond.md", "LW-UNCOND-RULE\n");
  w(".claude/rules/scoped.md", "---\npaths:\n  - src/**\n---\nLW-SCOPED-RULE\n");
  w("src/CLAUDE.md", "LW-NESTED-SRC\n");
  w("src/a.ts", "export {};\n");
  w("src/b.ts", "export {};\n");
  w(".githooks/pre-commit", "#!/bin/sh\nexit 0\n");
  w(
    ".claude/settings.json",
    JSON.stringify({
      env: { GIT_DIR: "project-controlled-git-dir", PROJECT_GIT_CANARY: "project-setting" },
      permissions: { ask: ["Bash(git push *)"] },
      hooks: {
        SessionStart: ["startup", "resume", "clear", "fork"].map((source) => ({
          matcher: source,
          hooks: [{
            type: "command",
            command: `echo '${source}' >> "$CLAUDE_PROJECT_DIR/.claude/.session-start-log"`,
          }],
        })),
        Stop: [{ hooks: [{ type: "command", command: "echo 'LW-not-done' >&2; exit 2" }] }],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: 'echo end >> "$CLAUDE_PROJECT_DIR/.claude/.session-end-log"',
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "echo 'LW-LINT-ERRORS' >&2; exit 2" }],
          },
        ],
      },
    }),
  );
  w(
    ".claude/.picc/config.json",
    JSON.stringify({ steering: { "steer-model*": "LW-STEERING-ACTIVE" } }),
  );
  w(
    ".claude/skills/limited/SKILL.md",
    "---\ndescription: A skill that must not fetch the web\ndisallowed-tools: WebFetch\n---\nLW-LIMITED-SKILL-BODY\n",
  );

  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  await pi.waitForInitialization();
  await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lifecycle wiring", () => {
  it("uses one real outer checkpoint wrap for Claude and stock main-session definitions", async () => {
    const wired = fakePi();
    const wrapCounts = new Map<string, number>();
    const actualGateOutputs = new WeakSet<object>();
    picc(wired.api as never, {
      onInitializationSettled: wired.captureInitialization,
      onWired: ({ mainCheckpointGate }) => {
        const realWrap = mainCheckpointGate.wrapTool.bind(mainCheckpointGate);
        mainCheckpointGate.wrapTool = ((definition: Record<string, unknown>) => {
          const name = String(definition.name);
          wrapCounts.set(name, (wrapCounts.get(name) ?? 0) + 1);
          const wrapped = realWrap(definition);
          actualGateOutputs.add(wrapped);
          return wrapped;
        }) as typeof mainCheckpointGate.wrapTool;
      },
    });
    await wired.waitForInitialization();

    for (const name of ["Grep", "WebFetch", "bash", "read", "write", "edit", "grep", "find", "ls"]) {
      expect(wrapCounts.get(name), name).toBe(1);
      expect(actualGateOutputs.has(wired.tools.get(name)), name).toBe(true);
      expect(wired.tools.get(name).renderShell, name).toBe("self");
    }
  });
  it("holds ordinary input until all seven routed replacements are registered", async () => {
    const sdkGate = deferred<any>();
    const gated = fakePi();
    picc(gated.api as never, {
      loadBuiltinSdk: () => sdkGate.promise,
      onInitializationSettled: gated.captureInitialization,
    });

    await expect(gated.fire("input", { text: "/mcp", source: "interactive" }))
      .resolves.toEqual({ action: "handled" });

    let settled = false;
    const input = gated.fire("input", { text: "ordinary task", source: "interactive" })
      .then((result) => {
        for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
          expect(gated.tools.has(name)).toBe(true);
        }
        settled = true;
        return result;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    sdkGate.resolve(await import("@earendil-works/pi-coding-agent"));
    await expect(input).resolves.toMatchObject({ action: expect.stringMatching(/continue|transform/) });
    expect(settled).toBe(true);
  });

  it("prepares import, factory, actual presentation, and actual checkpoint phases before any core registration", async () => {
    const realSdk: any = await import("@earendil-works/pi-coding-agent");
    const scenarios = [
      { label: "import", load: async () => { throw new Error("import fault"); } },
      { label: "factory", load: async () => ({ ...realSdk, createBashTool: () => { throw new Error("factory fault"); } }) },
      { label: "presentation", load: async () => realSdk, failPresentation: true },
      { label: "checkpoint", load: async () => realSdk, failCheckpoint: true },
    ];
    for (const scenario of scenarios) {
      const failed = fakePi();
      let coreRegistrations = 0;
      const register = failed.api.registerTool as (definition: any) => void;
      failed.api.registerTool = (definition: any) => {
        if (["bash", "read", "write", "edit", "grep", "find", "ls"].includes(definition.name)) coreRegistrations += 1;
        register(definition);
      };
      picc(failed.api as never, {
        loadBuiltinSdk: scenario.load,
        onInitializationSettled: failed.captureInitialization,
        ...(scenario.failPresentation ? {
          renderMainSessionTool: ((definition, options) => {
            if (definition.name === "bash") throw new Error("presentation fault");
            return renderMainSessionTool(definition, options);
          }) as typeof renderMainSessionTool,
        } : {}),
        onWired: ({ mainCheckpointGate }) => {
          if (!scenario.failCheckpoint) return;
          const realWrap = mainCheckpointGate.wrapTool.bind(mainCheckpointGate);
          mainCheckpointGate.wrapTool = ((definition: Record<string, unknown>) => {
            if (definition.name === "bash") throw new Error("checkpoint fault");
            return realWrap(definition);
          }) as typeof mainCheckpointGate.wrapTool;
        },
      });
      await failed.waitForInitialization();
      await expect(failed.fire("input", { text: `${scenario.label} task`, source: "interactive" }, failed.tuiCtx()))
        .resolves.toEqual({ action: "handled" });
      expect(coreRegistrations, scenario.label).toBe(0);
    }
  });

  it("reports one bounded detail and every reminder on the mode's real channel", async () => {
    for (const mode of ["tui", "print", "json", "rpc"] as const) {
      const failed = fakePi();
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      try {
        picc(failed.api as never, {
          loadBuiltinSdk: async () => { throw new Error(`sdk unavailable ${"x".repeat(4_000)}\u0007`); },
          onInitializationSettled: failed.captureInitialization,
        });
        await failed.waitForInitialization();
        const ctx = mode === "tui" ? failed.tuiCtx()
          : mode === "print" ? failed.printCtx()
          : mode === "rpc" ? failed.rpcCtx()
          : failed.ctx({ mode: "json", hasUI: false });
        for (const text of ["must stay blocked", "still blocked"]) {
          await expect(failed.fire("input", { text, source: mode === "rpc" ? "rpc" : "interactive" }, ctx))
            .resolves.toEqual({ action: "handled" });
        }
        const reports = mode === "tui"
          ? failed.notifications.map((notice) => notice.text)
          : mode === "print"
            ? errors
            : failed.entries.filter((entry) => entry.customType === "picc-core-readiness")
              .map((entry) => String(entry.data.error));
        expect(reports, mode).toHaveLength(3);
        expect(reports.filter((line) => line.includes("core tool initialization failed")), mode).toHaveLength(1);
        expect(reports.filter((line) => line.includes("core tools are unavailable")), mode).toHaveLength(2);
        const detailed = reports.find((line) => line.includes("core tool initialization failed")) ?? "";
        expect(detailed, mode).toContain("Check or update through the installation owner");
        expect(detailed, mode).toContain("for a direct PiCC launch, /picc-update or picc update --check are examples");
        expect(detailed, mode).toContain("Restart PiCC");
        expect(detailed, mode).toContain("use /doctor and the reported cause if this persists");
        expect(Math.max(...reports.map((line) => line.length)), mode).toBeLessThanOrEqual(2_000);
      } finally {
        console.error = originalError;
      }
    }
  });

  it("bounds malformed Error.message diagnostics and keeps repeated submissions outside hooks", async () => {
    const malformed = [
      () => {
        const error = new Error("placeholder");
        Object.defineProperty(error, "message", { get: () => { throw new Error("getter fault"); } });
        return error;
      },
      () => {
        const error = new Error("placeholder");
        Object.defineProperty(error, "message", {
          value: { toString: () => { throw new Error("conversion fault"); } },
        });
        return error;
      },
    ];
    for (const makeError of malformed) {
      const failed = fakePi();
      const errors: string[] = [];
      let inputHookCalls = 0;
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      try {
        picc(failed.api as never, {
          loadBuiltinSdk: async () => { throw makeError(); },
          onInitializationSettled: failed.captureInitialization,
          onWired: ({ inputHooks }) => {
            const fire = inputHooks.fire.bind(inputHooks);
            inputHooks.fire = async (...args: any[]) => {
              if (args[0] === "UserPromptSubmit") inputHookCalls += 1;
              return fire(...args);
            };
          },
        });
        await failed.waitForInitialization();
        for (const text of ["first malformed task", "repeat malformed task"]) {
          await expect(failed.fire("input", { text, source: "interactive" }, failed.printCtx()))
            .resolves.toEqual({ action: "handled" });
        }
        expect(inputHookCalls).toBe(0);
        expect(errors).toHaveLength(3);
        expect(errors[0]).toContain("Cause: unknown error");
        expect(errors.every((line) => line.length <= 2_000)).toBe(true);
      } finally {
        console.error = originalError;
      }
    }
  });

  it("falls back to bounded stderr and stays handled when each primary reporting transport fails", async () => {
    for (const mode of ["tui", "print", "json", "rpc"] as const) {
      const failed = fakePi();
      failed.api.appendEntry = () => { throw new Error("entry transport exploded"); };
      const ctx = mode === "tui" ? failed.tuiCtx()
        : mode === "print" ? failed.printCtx()
        : mode === "rpc" ? failed.rpcCtx()
        : failed.ctx({ mode: "json", hasUI: false });
      (ctx.ui as any).notify = () => { throw new Error("notify exploded"); };
      const originalError = console.error;
      const originalWrite = process.stderr.write;
      const fallbacks: string[] = [];
      console.error = () => { throw new Error("stderr transport exploded"); };
      process.stderr.write = ((chunk: string | Uint8Array) => {
        fallbacks.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        picc(failed.api as never, {
          loadBuiltinSdk: async () => { throw new Error("sdk unavailable"); },
          onInitializationSettled: failed.captureInitialization,
        });
        await failed.waitForInitialization();
        for (const text of ["must stay blocked", "still blocked"]) {
          await expect(failed.fire("input", { text, source: mode === "rpc" ? "rpc" : "interactive" }, ctx))
            .resolves.toEqual({ action: "handled" });
        }
        expect(fallbacks, mode).toHaveLength(3);
        expect(fallbacks.every((line) => line.length <= 2_001), mode).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
        console.error = originalError;
      }
    }
  });

  it("fails closed before and after registration starts, removes only fixed active names, and diagnoses repeats", async () => {
    const cases = [
      { label: "import", load: async () => { throw new Error("sdk import exploded"); } },
      { label: "registration", load: () => import("@earendil-works/pi-coding-agent") },
    ];
    for (const scenario of cases) {
      const failed = fakePi();
      (failed.api.registerTool as (definition: any) => void)({
        name: "custom-active", description: "custom", parameters: {}, execute: async () => undefined,
      });
      (failed.api.registerTool as (definition: any) => void)({
        name: "custom-inactive", description: "custom", parameters: {}, execute: async () => undefined,
      });
      failed.activeTools.delete("custom-inactive");
      for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls"]) failed.activeTools.add(name);
      if (scenario.label === "registration") {
        const register = failed.api.registerTool as (definition: any) => void;
        let coreRegistrations = 0;
        failed.api.registerTool = (definition: any) => {
          if (["bash", "read", "write", "edit", "grep", "find", "ls"].includes(definition.name) &&
              ++coreRegistrations === 3) throw new Error("third core registration exploded");
          register(definition);
        };
      }
      const errors: string[] = [];
      let inputHookCalls = 0;
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      try {
        picc(failed.api as never, {
          loadBuiltinSdk: scenario.load,
          onInitializationSettled: failed.captureInitialization,
          onWired: ({ inputHooks }) => {
            const fire = inputHooks.fire.bind(inputHooks);
            inputHooks.fire = async (...args: any[]) => {
              if (args[0] === "UserPromptSubmit") inputHookCalls += 1;
              return fire(...args);
            };
          },
        });
        await failed.waitForInitialization();
        await expect(failed.fire("input", { text: "first task", source: "interactive" }, failed.printCtx()))
          .resolves.toEqual({ action: "handled" });
        await expect(failed.fire("input", { text: "second task", source: "interactive" }, failed.printCtx()))
          .resolves.toEqual({ action: "handled" });

        expect(failed.activeTools.has("custom-active")).toBe(true);
        expect(failed.activeTools.has("custom-inactive")).toBe(false);
        for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
          expect(failed.activeTools.has(name)).toBe(false);
        }
        expect(errors.filter((line) => line.includes("core tool initialization failed"))).toHaveLength(1);
        expect(errors.join("\n")).toContain(scenario.label === "registration"
          ? "partial core replacement may have committed"
          : "registration did not begin");
        expect(inputHookCalls).toBe(0);
        if (scenario.label === "registration") {
          expect([...failed.tools.keys()].filter((name) =>
            ["bash", "read", "write", "edit", "grep", "find", "ls"].includes(name)))
            .toEqual(["bash", "read"]);
        }
        expect(errors.filter((line) => line.includes("core tools are unavailable"))).toHaveLength(2);
      } finally {
        console.error = originalError;
      }
    }
  });

  it("keeps input blocked when active-set cleanup throws or fails verification", async () => {
    for (const cleanup of ["throw", "unverified"] as const) {
      const failed = fakePi();
      failed.activeTools.add("read");
      failed.api.setActiveTools = cleanup === "throw"
        ? () => { throw new Error("cleanup denied"); }
        : () => undefined;
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
      try {
        picc(failed.api as never, {
          loadBuiltinSdk: async () => { throw new Error("sdk absent"); },
          onInitializationSettled: failed.captureInitialization,
        });
        await failed.waitForInitialization();
        await expect(failed.fire("input", { text: "task", source: "interactive" }, failed.printCtx()))
          .resolves.toEqual({ action: "handled" });
        expect(errors.join("\n")).toContain(cleanup === "throw"
          ? "active-set cleanup failed"
          : "cleanup verification failed");
        expect(errors.join("\n")).toContain("task not sent");
      } finally {
        console.error = originalError;
      }
    }
  });

  it("captures real extension initialization synchronously and waits for gated orphan reaping", async () => {
    const originalReapOrphans = WorktreeManager.prototype.reapOrphans;
    const reapGate = deferred<void>();
    let initialization: Promise<void> | undefined;

    WorktreeManager.prototype.reapOrphans = function (...args) {
      const genuineReaping = originalReapOrphans.apply(this, args);
      return reapGate.promise.then(() => genuineReaping);
    };

    try {
      const gatedPi = fakePi();
      picc(gatedPi.api as never, {
        onInitializationSettled: (completion) => {
          initialization = completion;
        },
      });

      // The callback is part of synchronous activation, not a later microtask.
      expect(initialization).toBeDefined();
      let settled = false;
      void initialization!.then(() => (settled = true));

      // Built-ins can finish registering while the independently gated reaper
      // keeps the combined observational completion pending.
      await gatedPi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
      expect(settled).toBe(false);

      reapGate.resolve();
      await initialization;
      expect(settled).toBe(true);
    } finally {
      reapGate.resolve();
      WorktreeManager.prototype.reapOrphans = originalReapOrphans;
      await initialization;
    }
  });

  it("keeps direct-launch suppression through extension input, then clears it before admitted input or user Bash", async () => {
    const saved = {
      pid: process.env.PICC_LAUNCHER_PID,
      kind: process.env.PICC_INSTALL_KIND,
      version: process.env.PICC_VERSION,
      skip: process.env.PI_SKIP_VERSION_CHECK,
    };
    const initializeDirect = async () => {
      process.env.PICC_LAUNCHER_PID = String(process.ppid);
      process.env.PICC_INSTALL_KIND = "source";
      process.env.PICC_VERSION = "0.1.0";
      process.env.PI_SKIP_VERSION_CHECK = "1";
      const directPi = fakePi();
      picc(directPi.api as never, { onInitializationSettled: directPi.captureInitialization });
      await directPi.waitForInitialization();
      return directPi;
    };
    try {
      const inputPi = await initializeDirect();
      expect(process.env.PICC_LAUNCHER_PID).toBeUndefined();
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      await inputPi.fire("input", { text: "internal", source: "extension" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      await inputPi.fire("input", { text: "admitted", source: "interactive" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();

      const bashPi = await initializeDirect();
      expect(process.env.PI_SKIP_VERSION_CHECK).toBe("1");
      await bashPi.fire("user_bash", { command: "printf probe" });
      expect(process.env.PI_SKIP_VERSION_CHECK).toBeUndefined();
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore("PICC_LAUNCHER_PID", saved.pid);
      restore("PICC_INSTALL_KIND", saved.kind);
      restore("PICC_VERSION", saved.version);
      restore("PI_SKIP_VERSION_CHECK", saved.skip);
    }
  });

  it("self-heals hooks with real sanitized Git rather than unsupported pi.exec", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "picc-startup-git-"));
    const userDir = path.join(fixture, ".claude-user");
    const redirectedGitDir = path.join(fixture, "redirected.git");
    const previousCwd = process.cwd();
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const savedPid = process.env.PICC_LAUNCHER_PID;
    const savedSkip = process.env.PI_SKIP_VERSION_CHECK;
    try {
      fs.mkdirSync(path.join(fixture, ".claude"), { recursive: true });
      fs.mkdirSync(path.join(fixture, ".githooks"));
      fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(fixture, "README.md"), "fixture\n");
      fs.writeFileSync(path.join(fixture, ".claude", "settings.json"), JSON.stringify({
        env: { GIT_DIR: redirectedGitDir, PROJECT_GIT_CANARY: "must-not-reach-git" },
      }));
      execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "PiCC Test"], { cwd: fixture });
      execFileSync("git", ["add", "."], { cwd: fixture });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: fixture, stdio: "ignore" });
      const projectGitCanary = installProjectRootGitCanary(fixture);

      process.chdir(fixture);
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      const startupPi = fakePi();
      startupPi.api.exec = async () => { throw new Error("Pi's pi.exec env path must not be used"); };
      picc(startupPi.api as never, { onInitializationSettled: startupPi.captureInitialization });
      await startupPi.waitForInitialization();
      process.env.PICC_LAUNCHER_PID = "991";
      process.env.PI_SKIP_VERSION_CHECK = "1";

      await startupPi.fire("session_start", { reason: "startup" }, startupPi.ctx());
      expect(fs.readFileSync(path.join(fixture, ".git", "config"), "utf8")).toMatch(/hooksPath\s*=\s*\.githooks/);
      expect(fs.existsSync(projectGitCanary)).toBe(true);
      expect(fs.existsSync(redirectedGitDir)).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
      if (savedPid === undefined) delete process.env.PICC_LAUNCHER_PID;
      else process.env.PICC_LAUNCHER_PID = savedPid;
      if (savedSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = savedSkip;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("leaves managed directories untouched when production trusted Git is unavailable", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "picc-unavailable-git-"));
    const userDir = path.join(fixture, ".claude-user");
    const managed = path.join(fixture, ".claude", "worktrees", "registered");
    const marker = path.join(managed, "keep.txt");
    const previousCwd = process.cwd();
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    let resolverCalls = 0;
    try {
      fs.mkdirSync(userDir, { recursive: true });
      fs.mkdirSync(path.join(fixture, ".githooks"), { recursive: true });
      fs.mkdirSync(managed, { recursive: true });
      fs.writeFileSync(path.join(fixture, "README.md"), "fixture\n");
      fs.writeFileSync(path.join(managed, ".git"), "gitdir: unavailable\n");
      fs.writeFileSync(marker, "untouched\n");
      execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "PiCC Test"], { cwd: fixture });
      execFileSync("git", ["add", "README.md"], { cwd: fixture });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: fixture, stdio: "ignore" });

      process.chdir(fixture);
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      const unavailablePi = fakePi();
      picc(unavailablePi.api as never, {
        onInitializationSettled: unavailablePi.captureInitialization,
        resolveTrustedGit: async () => {
          resolverCalls += 1;
          throw new Error("admin module evaluation failed");
        },
      });
      await unavailablePi.waitForInitialization();
      await unavailablePi.fire("session_start", { reason: "startup" }, unavailablePi.ctx());

      await expect(
        unavailablePi.tools.get("EnterWorktree").execute("unavailable-git", { path: managed }),
      ).rejects.toThrow(/cannot verify path/);
      expect(fs.readFileSync(marker, "utf8")).toBe("untouched\n");
      expect(fs.existsSync(path.join(managed, ".git"))).toBe(true);
      expect(resolverCalls).toBe(1);
    } finally {
      process.chdir(previousCwd);
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("drives registered EnterWorktree with sanitized production Git composition", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "picc-wired-worktree-"));
    const userDir = path.join(fixture, ".claude-user");
    const hookDir = path.join(fixture, ".githooks");
    const hookOutput = path.join(fixture, "worktree-hook-env.txt");
    const redirectedGitDir = path.join(fixture, "redirected.git");
    const previousCwd = process.cwd();
    const previousUserDir = process.env.PICC_CLAUDE_USER_DIR;
    const savedPid = process.env.PICC_LAUNCHER_PID;
    const savedSkip = process.env.PI_SKIP_VERSION_CHECK;
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    let wiredPi: FakePi | undefined;
    try {
      fs.mkdirSync(path.join(fixture, ".claude"), { recursive: true });
      fs.mkdirSync(hookDir);
      fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(fixture, "README.md"), "fixture\n");
      fs.writeFileSync(path.join(fixture, ".claude", "settings.json"), JSON.stringify({
        env: { GIT_DIR: redirectedGitDir, WORKTREE_SETTING_CANARY: "project-setting" },
      }));
      fs.writeFileSync(
        path.join(hookDir, "post-checkout"),
        `#!/bin/sh\nprintf '%s|%s|%s|%s' "$GIT_DIR" "$WORKTREE_SETTING_CANARY" "$PICC_LAUNCHER_PID" "$PI_SKIP_VERSION_CHECK" > ${shellQuote(hookOutput.replaceAll("\\", "/"))}\n`,
      );
      fs.chmodSync(path.join(hookDir, "post-checkout"), 0o755);
      execFileSync("git", ["init"], { cwd: fixture, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "PiCC Test"], { cwd: fixture });
      execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: fixture });
      execFileSync("git", ["add", "."], { cwd: fixture });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: fixture, stdio: "ignore" });
      const projectGitCanary = installProjectRootGitCanary(fixture);

      process.chdir(fixture);
      process.env.PICC_CLAUDE_USER_DIR = userDir;
      wiredPi = fakePi();
      picc(wiredPi.api as never, { onInitializationSettled: wiredPi.captureInitialization });
      await wiredPi.waitForInitialization();
      process.env.PICC_LAUNCHER_PID = "992";
      process.env.PI_SKIP_VERSION_CHECK = "1";

      const entered = await wiredPi.tools.get("EnterWorktree").execute("wired-env", { name: "wired-env-proof" });
      expect(entered.details.created).toBe(true);
      expect(fs.readFileSync(hookOutput, "utf8")).toBe("|||");
      expect(fs.existsSync(projectGitCanary)).toBe(true);
      expect(fs.existsSync(redirectedGitDir)).toBe(false);

      const exited = await wiredPi.tools.get("ExitWorktree").execute("wired-env-exit", { action: "remove" });
      expect(exited.details.restorePath).toBe(fixture);
      expect(exited.details.removed).toBe(true);
      expect(fs.existsSync(entered.details.worktreePath)).toBe(false);
    } finally {
      process.chdir(previousCwd);
      if (previousUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
      else process.env.PICC_CLAUDE_USER_DIR = previousUserDir;
      if (savedPid === undefined) delete process.env.PICC_LAUNCHER_PID;
      else process.env.PICC_LAUNCHER_PID = savedPid;
      if (savedSkip === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
      else process.env.PI_SKIP_VERSION_CHECK = savedSkip;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("captures quota headers from after_provider_response and reports them in /quota", async () => {
    await pi.fire("after_provider_response", {
      headers: { "x-ratelimit-remaining-tokens": "1234", "content-type": "application/json" },
    });
    pi.entries.length = 0;
    await pi.commands.get("quota").handler("", pi.ctx());
    const out = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("x-ratelimit-remaining-tokens: 1234");
    expect(out).not.toContain("content-type");
  });

  it("re-selects steering text on model_select (provider-less pattern matches the model id)", async () => {
    await pi.fire("model_select", { model: { provider: "openai", id: "steer-model-1" } });
    const withSteering = (await pi.fire("before_agent_start", { systemPrompt: "B" }))
      .systemPrompt as string;
    expect(withSteering).toContain("LW-STEERING-ACTIVE");

    await pi.fire("model_select", { model: { provider: "openai", id: "other-model" } });
    const without = (await pi.fire("before_agent_start", { systemPrompt: "B" }))
      .systemPrompt as string;
    expect(without).not.toContain("LW-STEERING-ACTIVE");
  });

  it("blocking Stop hook re-prompts via sendUserMessage, capped at 8 continuations", async () => {
    pi.userMessages.length = 0;
    for (let i = 0; i < 9; i++) {
      await pi.fire("agent_settled", {}, pi.ctx());
    }
    const continuations = pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]"));
    expect(continuations.length).toBe(8);
    expect(String(continuations[0]?.content)).toContain("LW-not-done");
  });

  it("reports terminal main pending by mode without successful status or Stop continuation", async () => {
    const pendingMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial response must not count as complete" }],
      stopReason: "pending",
    };
    const savedExitCode = process.exitCode;
    const savedConsoleError = console.error;
    try {
      for (const row of [
        { label: "tui", mode: "tui", initialExitCode: undefined, expectedExitCode: undefined, notices: 1, stderr: 0, entries: 0 },
        { label: "print", mode: "print", initialExitCode: undefined, expectedExitCode: 1, notices: 0, stderr: 1, entries: 0 },
        { label: "json", mode: "json", initialExitCode: undefined, expectedExitCode: 1, notices: 0, stderr: 0, entries: 1 },
        { label: "json checkpoint status", mode: "json", initialExitCode: 3, expectedExitCode: 3, notices: 0, stderr: 0, entries: 1 },
        { label: "rpc", mode: "rpc", initialExitCode: undefined, expectedExitCode: undefined, notices: 0, stderr: 0, entries: 1 },
      ] as const) {
        const pendingPi = fakePi();
        picc(pendingPi.api as never, { onInitializationSettled: pendingPi.captureInitialization });
        await pendingPi.waitForInitialization();
        const stderr: string[] = [];
        console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
        process.exitCode = row.initialExitCode;
        const ctx = row.mode === "tui"
          ? pendingPi.tuiCtx()
          : row.mode === "print"
            ? pendingPi.printCtx()
            : row.mode === "rpc"
              ? pendingPi.rpcCtx()
              : pendingPi.ctx({ mode: "json", hasUI: false });
        ctx.sessionManager = { getBranch: () => [{ type: "message", message: pendingMessage }] };

        await pendingPi.fire("agent_settled", {}, ctx);

        expect(pendingPi.userMessages.filter((message) =>
          String(message.content).includes("[Stop hook]")), row.label).toHaveLength(0);
        expect(pendingPi.notifications, row.label).toHaveLength(row.notices);
        if (row.notices) {
          expect(pendingPi.notifications[0]).toMatchObject({
            severity: "warning",
            text: expect.stringContaining("ended incomplete (pending)"),
          });
        }
        expect(stderr, row.label).toHaveLength(row.stderr);
        if (row.stderr) expect(stderr[0]).toContain("ended incomplete (pending)");
        expect(pendingPi.entries.filter((entry) =>
          entry.customType === "picc-main-response-incomplete"), row.label).toHaveLength(row.entries);
        expect(process.exitCode, row.label).toBe(row.expectedExitCode);
      }
    } finally {
      console.error = savedConsoleError;
      process.exitCode = savedExitCode;
    }
  });

  it("resets blocked Stop iteration state when the session is replaced", async () => {
    pi.userMessages.length = 0;
    for (let i = 0; i < 8; i++) await pi.fire("agent_settled", {}, pi.ctx());
    expect(pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]")).length).toBe(8);

    await pi.fire("session_start", { reason: "switch" }, pi.ctx());
    await pi.fire("agent_settled", {}, pi.ctx());
    expect(pi.userMessages.filter((m) => String(m.content).includes("[Stop hook]")).length).toBe(9);
  });

  it("maps Pi session reasons to Claude SessionStart sources", async () => {
    const log = path.join(dir, ".claude", ".session-start-log");
    fs.rmSync(log, { force: true });
    for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
      await pi.fire("session_start", { reason }, pi.ctx());
    }
    expect(fs.readFileSync(log, "utf8").trim().split(/\r?\n/u)).toEqual([
      "startup", "startup", "clear", "resume", "fork",
    ]);
  });

  it("session_shutdown fires the SessionEnd hook", async () => {
    const log = path.join(dir, ".claude", ".session-end-log");
    fs.rmSync(log, { force: true });
    await pi.fire("session_shutdown", { reason: "other" });
    expect(fs.existsSync(log)).toBe(true);
  });

  it("production session_shutdown joins retained child cleanup before worktree release and SessionEnd", async () => {
    const shutdownPi = fakePi();
    type Seam = NonNullable<Parameters<typeof picc>[1]>;
    let internals!: Parameters<NonNullable<Seam["onWired"]>>[0];
    picc(shutdownPi.api as never, {
      onInitializationSettled: shutdownPi.captureInitialization,
      onWired: (value) => { internals = value; },
    });
    await shutdownPi.waitForInitialization();
    const log = path.join(dir, ".claude", ".session-end-log");
    fs.rmSync(log, { force: true });
    const cleanup = deferred<void>();
    let worktreeReleased = false;
    const agentId = "agent-444444444444";
    const taskId = internals.backgroundTasks.start(
      "agent:reviewer",
      Promise.resolve({
        ok: false, outcome: "failed" as const, finalMessage: "", agentId,
        agentName: "reviewer", checkpointPaused: true, error: "paused",
      }),
      async () => {
        await cleanup.promise;
        worktreeReleased = true;
      },
      agentId,
      "reviewer",
    );
    await internals.backgroundTasks.wait(taskId);
    internals.subagentRegistry.register({
      agentId, agentName: "reviewer", depth: 1, cwd: dir, resumable: true, oneShot: false,
      checkpointPaused: true,
      session: {
        recoverCheckpoint: async () => { throw new Error("unused"); },
        stopCheckpoint: async () => cleanup.promise,
      },
    });

    let shutdownSettled = false;
    const shutdown = shutdownPi.fire("session_shutdown", { reason: "other" })
      .then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    expect(worktreeReleased).toBe(false);
    expect(fs.existsSync(log)).toBe(false);
    expect(internals.backgroundTasks.drainSettlementNotices(() => true, () => {})).toEqual([]);

    cleanup.resolve();
    await shutdown;
    expect(worktreeReleased).toBe(true);
    expect(fs.existsSync(log)).toBe(true);
  });

  it("PostToolUse exit-2 feedback reaches the model in the tool result (lint-and-fix loop)", async () => {
    const result = await pi.fire("tool_result", {
      toolName: "edit",
      toolCallId: "c1",
      input: { path: path.join(dir, "src", "a.ts") },
      content: [{ type: "text", text: "edited ok" }],
      isError: false,
    });
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toContain("[hook blocked]");
    expect(text).toContain("LW-LINT-ERRORS");
  });

  it("compaction resets one-shot injection: nested CLAUDE.md + path rules re-inject on next touch", async () => {
    // First touch: nested CLAUDE.md and the scoped rule inject once.
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c2", input: { path: path.join(dir, "src", "a.ts") } });
    const first = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(first).toContain("LW-NESTED-SRC");
    expect(first).toContain("LW-SCOPED-RULE");

    // Second touch pre-compaction: nothing new.
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c3", input: { path: path.join(dir, "src", "b.ts") } });
    expect(pi.messages.map((m) => String(m.message.content)).join("\n")).not.toContain("LW-NESTED-SRC");

    await pi.fire("session_before_compact", { reason: "threshold" });
    await pi.fire("session_compact", { reason: "threshold" });

    // Root CLAUDE.md + unconditional rules survive via the per-turn suffix.
    const suffix = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(suffix).toContain("LW-ROOT-INSTRUCTIONS");
    expect(suffix).toContain("LW-UNCOND-RULE");

    // Path-scoped artifacts reload on next relevant access (regression: markers never reset).
    pi.messages.length = 0;
    await pi.fire("tool_call", { toolName: "read", toolCallId: "c4", input: { path: path.join(dir, "src", "b.ts") } });
    const after = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(after).toContain("LW-NESTED-SRC");
    expect(after).toContain("LW-SCOPED-RULE");
  });

  it("an active skill's disallowed-tools deny via the guard (enforcement)", async () => {
    // Before activation, WebFetch passes.
    const before = await pi.fire("tool_call", {
      toolName: "WebFetch",
      toolCallId: "d1",
      input: { url: "https://example.com" },
    });
    expect(before?.block ?? false).toBe(false);

    await pi.tools.get("Skill").execute("d2", { name: "limited" });

    const after = await pi.fire("tool_call", {
      toolName: "WebFetch",
      toolCallId: "d3",
      input: { url: "https://example.com" },
    });
    expect(after?.block).toBe(true);
    expect(String(after?.reason ?? "")).toContain("disallowed-tools");
  });
});
