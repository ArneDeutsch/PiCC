import path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookRunner } from "../../engine/hook-runner.js";
import type { HookOutcome } from "../../types.js";
import type { CwdState } from "../cwd-state.js";
import type { WorktreeManagerLike } from "../subagents.js";

/**
 * EnterWorktree / ExitWorktree tool definitions.
 * The cwd swap happens via CwdState — every other tool resolves through it.
 * WorktreeCreate / WorktreeRemove project hooks fire around the lifecycle.
 */
export function createWorktreeTools(deps: {
  worktrees: WorktreeManagerLike & {
    reapOrphans(options?: { maxAgeDays?: number }): Promise<{ reaped: string[]; diagnostics: unknown[] }>;
  };
  cwdState: CwdState;
  hookRunner: HookRunner;
}): Record<string, unknown>[] {
  const applyUniversalStop = (outcome: HookOutcome, ctx?: Pick<ExtensionContext, "abort">) => {
    if (!outcome.stop) return undefined;
    try { ctx?.abort(); } catch { /* lifecycle cleanup and its result remain authoritative */ }
    return outcome.stopReason ?? "Worktree hook requested stop";
  };

  const enterTool = {
    name: "EnterWorktree",
    label: "EnterWorktree",
    description:
      "Create (name:) or re-enter (path:) an isolated git worktree under .claude/worktrees/ and switch the session's working directory into it. name and path are mutually exclusive.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "New worktree name (branch worktree-<name>)" })),
      path: Type.Optional(Type.String({ description: "Existing worktree path to re-enter" })),
    }),
    async execute(
      _id: string,
      params: { name?: string; path?: string },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: Pick<ExtensionContext, "abort">,
    ) {
      const previous = deps.cwdState.getWorktree();
      const result = await deps.worktrees.enter({ name: params.name, path: params.path });
      if (!result.ok || !result.worktreePath) {
        throw new Error(result.error ?? "EnterWorktree failed");
      }
      // Already inside a different worktree: CwdState has no stack, so release
      // the previous one (keep + unlock) — otherwise its on-disk
      // `git worktree lock` leaks and blocks the project's own remove/prune.
      let releasedLine: string | undefined;
      if (previous !== undefined && path.resolve(previous) !== path.resolve(result.worktreePath)) {
        await deps.worktrees.exit({ worktreePath: previous, action: "keep" });
        releasedLine = `Left previous worktree (kept, unlocked): ${previous}`;
      }
      deps.cwdState.enterWorktree(result.worktreePath);
      const created = (result as { created?: boolean }).created ?? false;
      let stopReason: string | undefined;
      if (created) {
        const outcome = await deps.hookRunner.fire("WorktreeCreate", {
          worktree_path: result.worktreePath,
          branch: (result as { branch?: string }).branch,
          cwd: result.worktreePath,
        });
        stopReason = applyUniversalStop(outcome, ctx);
      }
      const seeded = (result as { seededFiles?: string[] }).seededFiles ?? [];
      const lines = [
        `${created ? "Created and entered" : "Entered"} worktree: ${result.worktreePath}`,
        (result as { branch?: string }).branch ? `Branch: ${(result as { branch?: string }).branch}` : undefined,
        seeded.length ? `Seeded from .worktreeinclude: ${seeded.join(", ")}` : undefined,
        releasedLine,
        "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
        stopReason ? `WorktreeCreate hook stopped further model processing: ${stopReason}` : undefined,
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { worktreePath: result.worktreePath, created, seeded, ...(stopReason ? { stoppedByHook: true, stopReason } : {}) },
      };
    },
  };

  const exitTool = {
    name: "ExitWorktree",
    label: "ExitWorktree",
    description:
      "Leave the current worktree and restore the original working directory. action: keep preserves the worktree; remove deletes it (best-effort on Windows; orphans are reaped later).",
    parameters: Type.Object({
      action: StringEnum(["keep", "remove"] as const),
    }),
    async execute(
      _id: string,
      params: { action: "keep" | "remove" },
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: Pick<ExtensionContext, "abort">,
    ) {
      const worktreePath = deps.cwdState.getWorktree();
      if (!worktreePath) {
        return {
          content: [{ type: "text", text: "Not inside a worktree; nothing to exit." }],
          details: {},
        };
      }
      let stopReason: string | undefined;
      if (params.action === "remove") {
        const outcome = await deps.hookRunner.fire("WorktreeRemove", {
          worktree_path: worktreePath,
          cwd: deps.cwdState.getBase(),
        });
        stopReason = applyUniversalStop(outcome, ctx);
      }
      const result = (await deps.worktrees.exit({ worktreePath, action: params.action })) as {
        removed?: boolean;
        orphaned?: boolean;
        error?: string;
      };
      deps.cwdState.exitWorktree();
      // Report truthfully: "removed" only when removal actually happened.
      const text =
        params.action === "keep"
          ? `Exited worktree (kept): ${worktreePath}. Working directory restored to ${deps.cwdState.getBase()}.`
          : result.removed === true
            ? `Exited and removed worktree: ${worktreePath}. Working directory restored.`
            : result.orphaned === true
              ? `Exited worktree; removal was blocked (Windows file lock?) — it will be reaped later. Working directory restored.`
              : `Exited worktree, but removal FAILED${result.error ? ` (${result.error})` : ""} — ${worktreePath} was kept. Working directory restored.`;
      const stopped = stopReason ? `${text}\nWorktreeRemove hook stopped further model processing: ${stopReason}` : text;
      return {
        content: [{ type: "text", text: stopped }],
        details: { worktreePath, ...result, ...(stopReason ? { stoppedByHook: true, stopReason } : {}) },
      };
    },
  };

  return [enterTool, exitTool];
}
