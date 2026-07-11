import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { HookRunner } from "../../engine/hook-runner.js";
import type { CwdState } from "../cwd-state.js";
import type { WorktreeManagerLike } from "../subagents.js";

/**
 * EnterWorktree / ExitWorktree tool definitions (plan §4.4).
 * The cwd swap happens via CwdState — every other tool resolves through it.
 * WorktreeCreate / WorktreeRemove project hooks fire around the lifecycle.
 */
export function createWorktreeTools(deps: {
  worktrees: WorktreeManagerLike & {
    reapOrphans(): Promise<{ reaped: string[]; diagnostics: unknown[] }>;
  };
  cwdState: CwdState;
  hookRunner: HookRunner;
}): Record<string, unknown>[] {
  const enterTool = {
    name: "EnterWorktree",
    label: "EnterWorktree",
    description:
      "Create (name:) or re-enter (path:) an isolated git worktree under .claude/worktrees/ and switch the session's working directory into it. name and path are mutually exclusive.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "New worktree name (branch worktree-<name>)" })),
      path: Type.Optional(Type.String({ description: "Existing worktree path to re-enter" })),
    }),
    async execute(_id: string, params: { name?: string; path?: string }) {
      const result = await deps.worktrees.enter({ name: params.name, path: params.path });
      if (!result.ok || !result.worktreePath) {
        throw new Error(result.error ?? "EnterWorktree failed");
      }
      deps.cwdState.enterWorktree(result.worktreePath);
      const created = (result as { created?: boolean }).created ?? false;
      if (created) {
        await deps.hookRunner.fire("WorktreeCreate", {
          worktree_path: result.worktreePath,
          branch: (result as { branch?: string }).branch,
          cwd: result.worktreePath,
        });
      }
      const seeded = (result as { seededFiles?: string[] }).seededFiles ?? [];
      const lines = [
        `${created ? "Created and entered" : "Entered"} worktree: ${result.worktreePath}`,
        (result as { branch?: string }).branch ? `Branch: ${(result as { branch?: string }).branch}` : undefined,
        seeded.length ? `Seeded from .worktreeinclude: ${seeded.join(", ")}` : undefined,
        "The session working directory is now inside the worktree; all relative paths and shell commands run there.",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { worktreePath: result.worktreePath, created, seeded },
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
    async execute(_id: string, params: { action: "keep" | "remove" }) {
      const worktreePath = deps.cwdState.getWorktree();
      if (!worktreePath) {
        return {
          content: [{ type: "text", text: "Not inside a worktree; nothing to exit." }],
          details: {},
        };
      }
      if (params.action === "remove") {
        await deps.hookRunner.fire("WorktreeRemove", {
          worktree_path: worktreePath,
          cwd: deps.cwdState.getBase(),
        });
      }
      const result = (await deps.worktrees.exit({ worktreePath, action: params.action })) as {
        removed?: boolean;
        orphaned?: boolean;
      };
      deps.cwdState.exitWorktree();
      const text =
        params.action === "keep"
          ? `Exited worktree (kept): ${worktreePath}. Working directory restored to ${deps.cwdState.getBase()}.`
          : result.orphaned
            ? `Exited worktree; removal was blocked (Windows file lock?) — it will be reaped later. Working directory restored.`
            : `Exited and removed worktree: ${worktreePath}. Working directory restored.`;
      return { content: [{ type: "text", text }], details: { worktreePath, ...result } };
    },
  };

  return [enterTool, exitTool];
}
