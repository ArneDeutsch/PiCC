import path from "node:path";
import { describe, expect, it } from "vitest";
import { CwdState } from "../src/runtime/cwd-state.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
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
  worktreePath?: string;
  outcome?: string;
  restorePath?: string;
}

function makeHarness(opts: {
  exitResult?: ExitStub;
  seededFiles?: string[];
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
        seededFiles: opts.seededFiles ?? [],
        diagnostics: [],
      };
    },
    exit: async (o: { worktreePath: string; action: "keep" | "remove" }) => {
      calls.push({ method: "exit", args: o });
      return opts.exitResult ?? {
        ok: true,
        removed: o.action === "remove",
        orphaned: false,
        diagnostics: [],
      };
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
  it("preserves seeded-file facts beside creation metadata", async () => {
    const h = makeHarness({ seededFiles: [".env.example", "config/dev.json"] });
    const res = await h.enter.execute("t0", { name: "wt-seeded" });
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-seeded"),
      branch: "worktree-wt-seeded",
      created: true,
      seeded: [".env.example", "config/dev.json"],
      previousUnlockAttempted: false,
    });
    expect(text(res)).toBe([
      `Created and entered worktree: ${h.wtPath("wt-seeded")}`,
      "Branch: worktree-wt-seeded",
      "Seeded from .worktreeinclude: .env.example, config/dev.json",
      "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
    ].join("\n"));
  });

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
    expect(text(res)).toBe([
      `Created and entered worktree: ${h.wtPath("wt-b")}`,
      "Branch: worktree-wt-b",
      `Left previous worktree (kept, unlocked): ${h.wtPath("wt-a")}`,
      "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
    ].join("\n"));
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-b"),
      branch: "worktree-wt-b",
      created: true,
      seeded: [],
      previousUnlockAttempted: true,
      previousWorktreePath: h.wtPath("wt-a"),
      previousKeepOutcome: "kept",
    });
  });

  it("preserves canonical Enter prose but exposes a failed previous keep for presentation", async () => {
    const h = makeHarness({
      exitResult: { ok: false, removed: false, orphaned: false, error: "unlock denied", diagnostics: [] },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.enter.execute("t2", { name: "wt-b" });

    expect(text(res)).toBe([
      `Created and entered worktree: ${h.wtPath("wt-b")}`,
      "Branch: worktree-wt-b",
      `Left previous worktree (kept, unlocked): ${h.wtPath("wt-a")}`,
      "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
    ].join("\n"));
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-b"),
      branch: "worktree-wt-b",
      created: true,
      seeded: [],
      previousUnlockAttempted: true,
      previousWorktreePath: h.wtPath("wt-a"),
      previousKeepOutcome: "keep-failed",
      previousKeepError: "unlock denied",
    });
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-b"));
  });

  it("does not release anything when re-entering the same worktree", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.enter.execute("t2", { path: h.wtPath("wt-a") });
    expect(h.calls.filter((c) => c.method === "exit")).toEqual([]);
    expect(text(res)).toBe([
      `Entered worktree: ${h.wtPath("wt-a")}`,
      "Branch: worktree-wt-a",
      "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
    ].join("\n"));
    expect(h.cwdState.getWorktree()).toBe(h.wtPath("wt-a"));
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-a"),
      branch: "worktree-wt-a",
      created: false,
      seeded: [],
      previousUnlockAttempted: false,
    });
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
    expect(text(res)).toBe(
      `Exited worktree, but removal FAILED (boom) — ${h.wtPath("wt-a")} was kept. Working directory restored.`,
    );
    expect(h.cwdState.getWorktree()).toBeUndefined();
    expect(h.cwdState.get()).toBe(h.base);
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-a"),
      outcome: "removal-failed",
      restorePath: h.base,
      ok: false,
      removed: false,
      orphaned: false,
      error: "boom",
      diagnostics: [],
    });
  });

  it("says removed only when removal actually happened", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(text(res)).toBe(
      `Exited and removed worktree: ${h.wtPath("wt-a")}. Working directory restored.`,
    );
    expect(res.details).toEqual({
      ok: true,
      removed: true,
      orphaned: false,
      diagnostics: [],
      worktreePath: h.wtPath("wt-a"),
      outcome: "removed",
      restorePath: h.base,
    });
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
    expect(text(res)).toBe(
      "Exited worktree; removal was blocked (Windows file lock?) — it will be reaped later. Working directory restored.",
    );
    expect(res.details).toEqual({
      ok: true,
      removed: false,
      orphaned: true,
      diagnostics: [],
      worktreePath: h.wtPath("wt-a"),
      outcome: "deferred-removal",
      restorePath: h.base,
    });
  });

  it("reports keep and no-worktree cases unchanged", async () => {
    const h = makeHarness();
    const none = await h.exit.execute("t1", { action: "keep" });
    expect(text(none)).toBe("Not inside a worktree; nothing to exit.");
    expect(none.details).toEqual({ outcome: "none", restorePath: h.base });

    await h.enter.execute("t2", { name: "wt-a" });
    const kept = await h.exit.execute("t3", { action: "keep" });
    expect(text(kept)).toBe(
      `Exited worktree (kept): ${h.wtPath("wt-a")}. Working directory restored to ${h.base}.`,
    );
    expect(kept.details).toEqual({
      ok: true,
      removed: false,
      orphaned: false,
      diagnostics: [],
      worktreePath: h.wtPath("wt-a"),
      outcome: "kept",
      restorePath: h.base,
    });
  });

  it("preserves canonical keep prose but exposes manager keep failure metadata", async () => {
    const h = makeHarness({
      exitResult: { ok: false, removed: false, orphaned: false, error: "unlock denied", diagnostics: [] },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "keep" });

    expect(text(res)).toBe(
      `Exited worktree (kept): ${h.wtPath("wt-a")}. Working directory restored to ${h.base}.`,
    );
    expect(res.details).toEqual({
      ok: false,
      removed: false,
      orphaned: false,
      error: "unlock denied",
      diagnostics: [],
      worktreePath: h.wtPath("wt-a"),
      outcome: "keep-failed",
      restorePath: h.base,
    });
  });

  it("keeps authoritative lifecycle facts when manager data contains conflicting presentation fields", async () => {
    const h = makeHarness({
      exitResult: {
        ok: true,
        removed: true,
        orphaned: false,
        diagnostics: [],
        worktreePath: "/manager/lie",
        outcome: "kept",
        restorePath: "/manager/restore-lie",
      },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(res.details).toEqual({
      ok: true,
      removed: true,
      orphaned: false,
      diagnostics: [],
      worktreePath: h.wtPath("wt-a"),
      outcome: "removed",
      restorePath: h.base,
    });
  });

  it("passes an actual producer result through the decorator without exposing canonical prose", async () => {
    const h = makeHarness();
    await h.enter.execute("t1", { name: "wt-a" });
    const result = await h.exit.execute("t2", { action: "remove" });
    const decorated = withRoutineToolRendering(h.exit as never) as unknown as {
      renderCall(args: unknown, theme: unknown, context: unknown): { render(width: number): string[] };
      renderResult(
        result: unknown,
        options: unknown,
        theme: unknown,
        context: unknown,
      ): { render(width: number): string[] };
    };
    expect(decorated.renderCall({ action: "remove" }, undefined, {}).render(120)).toEqual([]);
    expect(decorated.renderResult(
      result,
      { expanded: true, isPartial: false },
      undefined,
      { args: { action: "remove" }, isError: false },
    ).render(120)).toEqual([
      `ExitWorktree(${h.wtPath("wt-a")}) removed; restored ${h.base}`,
    ]);
    expect(text(result)).toBe(
      `Exited and removed worktree: ${h.wtPath("wt-a")}. Working directory restored.`,
    );
  });

  it("classifies the manager catch shape without inventing an error cause", async () => {
    const h = makeHarness({
      exitResult: { ok: false, removed: false, orphaned: false, diagnostics: [] },
    });
    await h.enter.execute("t1", { name: "wt-a" });
    const res = await h.exit.execute("t2", { action: "remove" });
    expect(text(res)).toBe(
      `Exited worktree, but removal FAILED — ${h.wtPath("wt-a")} was kept. Working directory restored.`,
    );
    expect(res.details).toEqual({
      worktreePath: h.wtPath("wt-a"),
      outcome: "removal-failed",
      restorePath: h.base,
      ok: false,
      removed: false,
      orphaned: false,
      diagnostics: [],
    });
  });
});
