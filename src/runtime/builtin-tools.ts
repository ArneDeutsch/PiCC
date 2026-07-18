/**
 * Single source of truth for constructing PiCC's seven built-in tools
 * (bash, read, write, edit, grep, find, ls).
 *
 * This is the shared source the main session and the subagent path both build
 * their built-ins from, by calling {@link buildStockBuiltinTools}, so the two
 * paths run the exact same tool implementations and differ only in *which* tools
 * a session is permitted to use — never in *how* any given tool behaves.
 *
 * The factory returns the merged defs RAW (unwrapped): it does NOT call
 * `wrapForSelfShell` and does NOT register with Pi. Both remain the caller's
 * concern, because the self-shell reframing and registration are session-shell
 * decisions, not tool-construction decisions.
 */
import { unicodeSafeSubprocessEnv } from "../util/env.js";
import type { CwdState } from "./cwd-state.js";

/**
 * A constructed Pi built-in tool instance. `execute` is the load-bearing member
 * (the factory rebinds it per call for live-cwd re-resolution); everything else
 * is spread through as the tool template.
 */
export type BuiltinToolInstance = {
  execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
  [key: string]: unknown;
};

/**
 * A Pi built-in tool *definition* — the renderer source. `create*Tool` strips
 * renderCall/renderResult via wrapToolDefinition, so diffs/truncation/highlighting
 * are re-sourced from `create*ToolDefinition`.
 */
export type BuiltinToolDefinition = {
  renderCall?: unknown;
  renderResult?: unknown;
  [key: string]: unknown;
};

/**
 * The narrow SDK handle {@link buildStockBuiltinTools} needs: the seven
 * `create<X>Tool` (EXECUTE source) and seven `create<X>ToolDefinition`
 * (RENDERER source) constructors, all REQUIRED.
 *
 * This is deliberately NOT `PiSdk` (whose mirror of these members is optional so
 * the un-wired fake still satisfies it). The main path passes the raw Pi import,
 * which has them; the subagent call site narrows/asserts its `PiSdk` handle to
 * this type before calling the factory.
 */
export interface BuiltinToolSdk {
  createBashTool(cwd: string, options: unknown): BuiltinToolInstance;
  createReadTool(cwd: string): BuiltinToolInstance;
  createWriteTool(cwd: string): BuiltinToolInstance;
  createEditTool(cwd: string): BuiltinToolInstance;
  createGrepTool(cwd: string): BuiltinToolInstance;
  createFindTool(cwd: string): BuiltinToolInstance;
  createLsTool(cwd: string): BuiltinToolInstance;
  createBashToolDefinition(cwd: string): BuiltinToolDefinition;
  createReadToolDefinition(cwd: string): BuiltinToolDefinition;
  createWriteToolDefinition(cwd: string): BuiltinToolDefinition;
  createEditToolDefinition(cwd: string): BuiltinToolDefinition;
  createGrepToolDefinition(cwd: string): BuiltinToolDefinition;
  createFindToolDefinition(cwd: string): BuiltinToolDefinition;
  createLsToolDefinition(cwd: string): BuiltinToolDefinition;
}

/** Deps every session supplies to shape the bash spawn environment + shell. */
export interface BuiltinToolDeps {
  /** The project's configured environment (`project.settings.env`). */
  settingsEnv: Record<string, string | undefined>;
  /** Absolute project root, injected as `CLAUDE_PROJECT_DIR`. */
  projectRoot: string;
  /** Pinned Git-Bash path on Windows (from resolveGitBashPath); absent elsewhere. */
  shellPath?: string;
}

/**
 * Pure transform for the built-in bash tool's subprocess environment: layer the
 * project's `settingsEnv` and `CLAUDE_PROJECT_DIR` over the inherited env, then
 * apply the Unicode-safe subprocess defaults. Settings win over inherited on a
 * key collision; `CLAUDE_PROJECT_DIR` wins over both.
 *
 * Extracted as a pure function so it can be asserted without constructing a tool
 * or spawning a process.
 */
export function buildBashSpawnEnv(
  inherited: Record<string, string | undefined>,
  settingsEnv: Record<string, string | undefined>,
  projectRoot: string,
): Record<string, string> {
  return unicodeSafeSubprocessEnv({
    ...inherited,
    ...settingsEnv,
    CLAUDE_PROJECT_DIR: projectRoot,
  });
}

/**
 * Build the `create*BashTool` options object: the Git-Bash `shellPath` pin (when
 * present) plus the spawnHook that rewrites the child's env via
 * {@link buildBashSpawnEnv}. Kept small so the subagent path reuses the identical
 * bash config.
 */
export function makeBuiltinBashOptions(deps: BuiltinToolDeps): {
  shellPath?: string;
  spawnHook(args: { command: unknown; cwd: unknown; env: Record<string, string | undefined> }): {
    command: unknown;
    cwd: unknown;
    env: Record<string, string>;
  };
} {
  return {
    ...(deps.shellPath ? { shellPath: deps.shellPath } : {}),
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: buildBashSpawnEnv(env, deps.settingsEnv, deps.projectRoot),
    }),
  };
}

/** A raw (unwrapped) merged built-in def, keyed by its PiCC tool name. */
export interface StockBuiltinTool {
  name: string;
  def: Record<string, unknown>;
}

/**
 * Construct the seven PiCC-semantic built-in tools.
 *
 * Each built-in carries TWO sourcings that stay separate:
 * - `factory` (`create*Tool`) is the EXECUTE source — it drives the live-cwd
 *   re-resolution, the bash spawnHook/env, Git-Bash pinning, and `read`'s ctx
 *   handling. The execute closure rebinds per call: `factory(cwdRef.get())`.
 * - `defFactory` (`create*ToolDefinition`) is the RENDERER source — its
 *   renderCall/renderResult are cwd-light (the render ctx supplies cwd), so one
 *   instance is pulled at construction.
 *
 * Returns the merged defs RAW — the caller applies `wrapForSelfShell` and
 * `pi.registerTool`. `cwdRef.get()` is read live inside `execute`.
 *
 * @see BuiltinToolSdk for why the SDK param is this narrow type, not `PiSdk`.
 */
export function buildStockBuiltinTools(
  sdk: BuiltinToolSdk,
  cwdRef: CwdState,
  deps: BuiltinToolDeps,
): StockBuiltinTool[] {
  const bashOptions = makeBuiltinBashOptions(deps);
  const factories: Array<
    [string, (cwd: string) => BuiltinToolInstance, (cwd: string) => BuiltinToolDefinition]
  > = [
    ["bash", (c) => sdk.createBashTool(c, bashOptions), (c) => sdk.createBashToolDefinition(c)],
    ["read", (c) => sdk.createReadTool(c), (c) => sdk.createReadToolDefinition(c)],
    ["write", (c) => sdk.createWriteTool(c), (c) => sdk.createWriteToolDefinition(c)],
    ["edit", (c) => sdk.createEditTool(c), (c) => sdk.createEditToolDefinition(c)],
    ["grep", (c) => sdk.createGrepTool(c), (c) => sdk.createGrepToolDefinition(c)],
    ["find", (c) => sdk.createFindTool(c), (c) => sdk.createFindToolDefinition(c)],
    ["ls", (c) => sdk.createLsTool(c), (c) => sdk.createLsToolDefinition(c)],
  ];
  const tools: StockBuiltinTool[] = [];
  for (const [name, factory, defFactory] of factories) {
    const template = factory(cwdRef.get());
    // Renderers only (execute stays sourced from `factory` below, byte-identical).
    const def = defFactory(cwdRef.get());
    tools.push({
      name,
      def: {
        ...template,
        name,
        renderCall: def.renderCall,
        renderResult: def.renderResult,
        async execute(id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) {
          const live = factory(cwdRef.get());
          return live.execute(id, params, signal, onUpdate, ctx);
        },
      },
    });
  }
  return tools;
}
