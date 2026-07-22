import path from "node:path";
import { describe, expect, it } from "vitest";
import { CwdState } from "../src/runtime/cwd-state.js";
import { createWorktreeTools } from "../src/runtime/tools/worktree-tools.js";
import type { HookOutcome } from "../src/types.js";

/**
 * Tool-layer tests for EnterWorktree / ExitWorktree against a stub
 * WorktreeManager: previous-worktree lock release on re-enter, and truthful
 * removal reporting. The git mechanics themselves live in worktrees.test.ts.
 */

type ToolResult = { content: { type: string; text: string }[]; details: Record<string, unknown> };
type Tool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { abort(): void },
  ) => Promise<ToolResult>;
};

interface Call {
  method: "enter" | "exit";
  args: Record<string, unknown>;
}

interface ExitStub {
  ok: boolean;
  removed: boolean;
  orphaned: boolean;
  error?: string;
  diagnostics: never[];
}

function makeHarness(opts: {
  exitResult?: ExitStub;
  hookOutcomes?: Partial<Record<"WorktreeCreate" | "WorktreeRemove", Partial<HookOutcome>>>;
} = {}) {
  const calls: Call[] = [];
  const hookCalls: string[] = [];
  const base = path.resolve(path.sep, "proj-base");
  const wtPath = (name: string) => path.join(base, ".claude", "worktrees", name);
  const worktrees = {
    enter: async (o: { name?: string; path?: string }) => {
      calls.push({ method: "enter", args: o });
      const dir = o.path !== undefined ? path.resolve(o.path) : wtPath(o.name ?? "x");
      return {
        ok: true,
        worktreePath: dir,
        branch: `worktree-${o.name ?? path.basename(dir)}`,
        created: o.name !== undefined,
        seededFiles: [],
        diagnostics: [],
      };
    },
    exit: async (o: { worktreePath: string; action: "keep" | "remove" }) => {
      calls.push({ method: "exit", args: o });
      return opts.exitResult ?? { ok: true, removed: true, orphaned: false, diagnostics: [] };
    },
    reapOrphans: async () => ({ reaped: [], diagnostics: [] }),
  };
  const cwdState = new CwdState(base);
  const hookRunner = {
    fire: async (event: "WorktreeCreate" | "WorktreeRemove") => {
      hookCalls.push(event);
      return {
        block: false,
        askDowngraded: false,
        diagnostics: [],
        ...opts.hookOutcomes?.[event],
      };
    },
  } as unknown as Parameters<typeof createWorktreeTools>[0]["hookRunner"];
  let universalStops = 0;
  const tools = createWorktreeTools({
    worktrees, cwdState, hookRunner,
    captureUniversalStop: () => () => { universalStops += 1; return true; },
  }) as unknown as Tool[];
  const enter = tools.find((t) => t.name === "EnterWorktree")!;
  const exit = tools.find((t) => t.name === "ExitWorktree")!;
  return { calls, hookCalls, cwdState, enter, exit, wtPath, base, universalStops: () => universalStops };
}

function text(res: ToolResult): string {
  return res.content.map((c) => c.text).join("\n");
}

describe("EnterWorktree tool: previous-worktree handling", () => {
  it("releases the previous worktree (exit keep) when entering a different one", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-a"));

    // Old code silently overwrote CwdState: wt-a stayed locked on disk forever.
    const res = await h.enter.execute("t2", { name: "wt-b" });
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-b"));
    const exits = h.calls.filter((c) => c.method === "exit");
    expect(exits).toEqual([
      { method: "exit", args: { worktreePath: h.wtPath("wt-a"), action: "keep" } },
    ]);
    expect(text(res)).toMatch(/Left previous worktree \(kept, unlocked\)/);
  });

  it("does not release anything when re-entering the same worktree", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.enter.execute("t2", { path: h.wtPath("wt-a") });
    expect(h.calls.filter((c) => c.method === "exit")).toEqual([]);
    expect(text(res)).not.toMatch(/Left previous worktree/);
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-a"));
  });

  it("keeps ordinary WorktreeCreate block output nonblocking", async () => {
    const h = makeHarness({
      hookOutcomes: { WorktreeCreate: { block: true, blockReason: "ordinary output" } },
    });
    let aborts = 0;
    const res = await h.enter.execute("t1", { name: "wt-a" }, undefined, undefined, {
      abort: () => { aborts += 1; },
    });

    expect(aborts).toBe(0);
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-a"));
    expect(text(res)).not.toContain("ordinary output");
  });

  it("aborts further model processing on a universal WorktreeCreate stop after entering truthfully", async () => {
    const h = makeHarness({
      hookOutcomes: { WorktreeCreate: { stop: true, stopReason: "create policy stopped" } },
    });
    let aborts = 0;
    const res = await h.enter.execute("t1", { name: "wt-a" }, undefined, undefined, {
      abort: () => { aborts += 1; },
    });

    expect(aborts).toBe(1);
    expect(h.hookCalls).toEqual(["WorktreeCreate"]);
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-a"));
    expect(text(res)).toContain("Created and entered");
    expect(text(res)).toContain("create policy stopped");
    expect(res.details).toMatchObject({ stoppedByHook: true, stopReason: "create policy stopped" });
    expect(h.universalStops()).toBe(1);
  });
});

describe("ExitWorktree tool: truthful reporting", () => {
  it("says removal FAILED (kept) when exit() reports neither removed nor orphaned", async () => {
    const h = makeHarness({
      exitResult: { ok: false, removed: false, orphaned: false, error: "boom", diagnostics: [] },
    });
    await h.enter.execute("t1", { name: "wt-a" });

    // Old code claimed "Exited and removed worktree" for this exact result.
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(text(res)).toMatch(/removal FAILED/);
    expect(text(res)).toMatch(/boom/);
    expect(text(res)).toMatch(/was kept/);
    expect(text(res)).not.toMatch(/Exited and removed/);
    expect(h.cwdState.getWorktree()).toBeUndefined();
    expect(h.cwdState.get()).toBe(h.base);
  });

  it("says removed only when removal actually happened", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(text(res)).toMatch(/Exited and removed worktree/);
  });

  it("keeps ordinary WorktreeRemove block output nonblocking", async () => {
    const h = makeHarness({
      hookOutcomes: { WorktreeRemove: { block: true, blockReason: "ordinary output" } },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    let aborts = 0;
    const res = await h.exit.execute("t2", { action: "remove" }, undefined, undefined, {
      abort: () => { aborts += 1; },
    });

    expect(aborts).toBe(0);
    expect(h.cwdState.getWorktree()).toBeUndefined();
    expect(text(res)).toContain("Exited and removed worktree");
    expect(text(res)).not.toContain("ordinary output");
  });

  it("aborts further model processing on a universal WorktreeRemove stop but still removes and exits", async () => {
    const h = makeHarness({
      hookOutcomes: { WorktreeRemove: { stop: true, stopReason: "remove policy stopped" } },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    let aborts = 0;
    const res = await h.exit.execute("t2", { action: "remove" }, undefined, undefined, {
      abort: () => { aborts += 1; },
    });

    expect(aborts).toBe(1);
    expect(h.hookCalls).toEqual(["WorktreeCreate", "WorktreeRemove"]);
    expect(h.calls.at(-1)).toEqual({
      method: "exit", args: { worktreePath: h.wtPath("wt-a"), action: "remove" },
    });
    expect(h.cwdState.getWorktree()).toBeUndefined();
    expect(text(res)).toContain("Exited and removed worktree");
    expect(text(res)).toContain("remove policy stopped");
    expect(res.details).toMatchObject({ stoppedByHook: true, stopReason: "remove policy stopped", removed: true });
    expect(h.universalStops()).toBe(1);
  });

  it("keeps the orphaned wording for blocked-but-orphaned removals", async () => {
    const h = makeHarness({
      exitResult: { ok: true, removed: false, orphaned: true, diagnostics: [] },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(text(res)).toMatch(/reaped later/);
    expect(text(res)).not.toMatch(/Exited and removed/);
  });

  it("reports keep and no-worktree cases unchanged", async () => {
    const h = makeHarness();
    const none = await h.exit.execute("t1", { action: "keep" });
    expect(text(none)).toMatch(/Not inside a worktree/);

    await h.enter.execute("t2", { name: "wt-a" });
    const kept = await h.exit.execute("t3", { action: "keep" });
    expect(text(kept)).toMatch(/Exited worktree \(kept\)/);
  });
});
