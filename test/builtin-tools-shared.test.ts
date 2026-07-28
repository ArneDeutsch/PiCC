import { describe, expect, it } from "vitest";
import {
  buildBashSpawnEnv,
  buildStockBuiltinTools,
  makeBuiltinBashOptions,
  type BuiltinToolSdk,
} from "../src/runtime/builtin-tools.js";
import { CwdState } from "../src/runtime/cwd-state.js";
import { NotebookSessionState } from "../src/runtime/notebook-session.js";

const PROJECT_ROOT = "/home/proj/root";

describe("built-in bash spawnHook env matrix (shared factory)", () => {
  // The exact env the subagent-env bug was about: a subagent Bash was NOT
  // receiving project.settings.env / CLAUDE_PROJECT_DIR. Pinning the shared
  // factory's env transform here fails against any regression on either path.
  const settingsEnv = {
    PROJECT_SETTING: "yes",
    SHARED_KEY: "from-settings",
  };
  const inherited = {
    INHERITED_ONLY: "keep-me",
    SHARED_KEY: "from-inherited",
    PATH: "/usr/bin",
    PICC_LAUNCHER_PID: "99",
    PICC_INSTALL_KIND: "source",
    PICC_VERSION: "1.2.3",
    PI_SKIP_VERSION_CHECK: "1",
  };

  function spawnEnv() {
    const opts = makeBuiltinBashOptions({ settingsEnv, projectRoot: PROJECT_ROOT });
    return opts.spawnHook({ command: "echo hi", cwd: "/somewhere", env: inherited }).env;
  }

  it("carries every settingsEnv key into the child env", () => {
    const env = spawnEnv();
    for (const [k, v] of Object.entries(settingsEnv)) {
      expect(env[k]).toBe(v);
    }
  });

  it("sets CLAUDE_PROJECT_DIR to the project root", () => {
    expect(spawnEnv().CLAUDE_PROJECT_DIR).toBe(PROJECT_ROOT);
  });

  it("applies the unicodeSafeSubprocessEnv UTF-8 defaults", () => {
    const env = spawnEnv();
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
  });

  it("keeps inherited env keys that settings do not touch", () => {
    const env = spawnEnv();
    expect(env.INHERITED_ONLY).toBe("keep-me");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips inherited launcher context while preserving settings", () => {
    const env = spawnEnv();
    expect(env.PICC_LAUNCHER_PID).toBeUndefined();
    expect(env.PICC_INSTALL_KIND).toBeUndefined();
    expect(env.PICC_VERSION).toBeUndefined();
    expect(env.PI_SKIP_VERSION_CHECK).toBeUndefined();
    expect(env.PROJECT_SETTING).toBe("yes");
  });

  it("lets settings win over inherited on a key collision", () => {
    expect(spawnEnv().SHARED_KEY).toBe("from-settings");
  });

  it("preserves the passthrough command and cwd", () => {
    const opts = makeBuiltinBashOptions({ settingsEnv, projectRoot: PROJECT_ROOT });
    const out = opts.spawnHook({ command: "echo hi", cwd: "/somewhere", env: inherited });
    expect(out.command).toBe("echo hi");
    expect(out.cwd).toBe("/somewhere");
  });

  it("buildBashSpawnEnv layers CLAUDE_PROJECT_DIR over a colliding settings key", () => {
    // CLAUDE_PROJECT_DIR wins even if settings also declares it.
    const env = buildBashSpawnEnv({}, { CLAUDE_PROJECT_DIR: "/wrong" }, PROJECT_ROOT);
    expect(env.CLAUDE_PROJECT_DIR).toBe(PROJECT_ROOT);
  });
});

describe("built-in bash options shellPath pin", () => {
  it("pins no session-environment exposure while omitting an absent shellPath", () => {
    const opts = makeBuiltinBashOptions({ settingsEnv: {}, projectRoot: PROJECT_ROOT });
    expect(opts.exposeSessionEnvironment).toBe(false);
    expect("shellPath" in opts).toBe(false);
  });

  it("carries a provided shellPath", () => {
    const opts = makeBuiltinBashOptions({
      settingsEnv: {},
      projectRoot: PROJECT_ROOT,
      shellPath: "C:/Program Files/Git/bin/bash.exe",
    });
    expect(opts.shellPath).toBe("C:/Program Files/Git/bin/bash.exe");
  });

  // win32-gated: on Windows the real factory pins Git Bash; the bash options must
  // then carry the shellPath the caller resolved.
  it.skipIf(process.platform !== "win32")(
    "win32: the resolved Git-Bash shellPath reaches the bash options",
    async () => {
      const { resolveGitBashPath } = await import("../src/engine/shell-inject.js");
      const shellPath = resolveGitBashPath();
      const opts = makeBuiltinBashOptions({
        settingsEnv: {},
        projectRoot: PROJECT_ROOT,
        ...(shellPath ? { shellPath } : {}),
      });
      if (shellPath) {
        expect(opts.shellPath).toBe(shellPath);
      } else {
        // No Git Bash on this box — the options must not fabricate one.
        expect("shellPath" in opts).toBe(false);
      }
    },
  );
});

describe("buildStockBuiltinTools structure (main + subagent shared path)", () => {
  // A recording fake SDK: every constructor returns a tagged instance/definition
  // so we can assert wiring without a real Pi.
  function fakeSdk(): { sdk: BuiltinToolSdk; bashOptions: unknown[] } {
    const bashOptions: unknown[] = [];
    const inst = (kind: string) => (cwd: string) => ({
      kind,
      cwd,
      execute: async () => `${kind}@${cwd}`,
    });
    const def = (kind: string) => (cwd: string) => ({
      kind,
      cwd,
      renderCall: () => `call:${kind}`,
      renderResult: () => `result:${kind}`,
    });
    const sdk: BuiltinToolSdk = {
      createBashTool: (cwd: string, options: unknown) => {
        bashOptions.push(options);
        return { kind: "bash", cwd, execute: async () => `bash@${cwd}` };
      },
      createReadTool: inst("read"),
      createWriteTool: inst("write"),
      createEditTool: inst("edit"),
      createGrepTool: inst("grep"),
      createFindTool: inst("find"),
      createLsTool: inst("ls"),
      createBashToolDefinition: def("bash"),
      createReadToolDefinition: def("read"),
      createWriteToolDefinition: def("write"),
      createEditToolDefinition: def("edit"),
      createGrepToolDefinition: def("grep"),
      createFindToolDefinition: def("find"),
      createLsToolDefinition: def("ls"),
    };
    return { sdk, bashOptions };
  }

  it("returns the seven builtins in a fixed order, renderers from the definition", () => {
    const { sdk } = fakeSdk();
    const tools = buildStockBuiltinTools(sdk, new CwdState("/base"), {
      settingsEnv: {},
      projectRoot: PROJECT_ROOT,
      notebookSession: new NotebookSessionState(),
    });
    expect(tools.map((t) => t.name)).toEqual([
      "bash",
      "read",
      "write",
      "edit",
      "grep",
      "find",
      "ls",
    ]);
    const read = tools.find((t) => t.name === "read")!;
    expect(typeof read.def.renderCall).toBe("function");
    expect(typeof read.def.renderResult).toBe("function");
  });

  it("pins the Bash options on both main and subagent factory invocations", () => {
    const { sdk, bashOptions } = fakeSdk();
    buildStockBuiltinTools(sdk, new CwdState("/main"), { settingsEnv: {}, projectRoot: PROJECT_ROOT });
    buildStockBuiltinTools(sdk, new CwdState("/subagent"), { settingsEnv: {}, projectRoot: PROJECT_ROOT });
    expect(bashOptions).toHaveLength(2);
    for (const options of bashOptions) {
      expect(options).toMatchObject({
        exposeSessionEnvironment: false,
        spawnHook: expect.any(Function),
      });
    }
  });

  it("execute rebinds against the LIVE cwd on every call", async () => {
    const { sdk } = fakeSdk();
    const cwd = new CwdState("/base");
    const tools = buildStockBuiltinTools(sdk, cwd, { settingsEnv: {}, projectRoot: PROJECT_ROOT });
    const write = tools.find((t) => t.name === "write")!;
    const exec = write.def.execute as (...a: unknown[]) => Promise<unknown>;
    expect(await exec("id", {}, null, null, null)).toBe("write@/base");
    cwd.enterWorktree("/wt");
    expect(await exec("id", {}, null, null, null)).toBe("write@/wt");
  });
});
