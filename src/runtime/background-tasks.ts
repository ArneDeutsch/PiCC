import { Type } from "typebox";
import type { Diagnostic } from "../types.js";

/**
 * Background task runtime (audit E4): `run_in_background: true` on the Agent
 * tool registers the (un-awaited) dispatch here; TaskOutput retrieves the
 * result, TaskStop requests a best-effort cooperative abort.
 *
 * Completeness floor: registered promises never reject unhandled — settlement
 * is folded into the task record (status/result/error) in both directions.
 */

export type BackgroundTaskStatus = "running" | "completed" | "failed" | "stopped";

/** Structural view of a DispatchResult (avoids an import cycle with subagents.ts). */
export interface BackgroundResultLike {
  /** True iff `outcome === "completed"`. */
  ok: boolean;
  /** Classified fate of the dispatch (t01 contract, mirrors DispatchResult exactly). */
  outcome: "completed" | "failed" | "aborted";
  /** The subagent's final message, verbatim (on failure: best-effort partial output). */
  finalMessage: string;
  agentName?: string;
  /** The single error channel: present iff `outcome !== "completed"`. */
  error?: string;
  diagnostics?: Diagnostic[];
}

export interface BackgroundTaskRecord {
  id: string;
  label: string;
  status: BackgroundTaskStatus;
  /**
   * Final text (verbatim subagent message) once completed; for failed tasks the
   * best-effort partial output produced before the failure, when any exists.
   */
  result?: string;
  error?: string;
  agentName?: string;
  diagnostics: Diagnostic[];
  /** Settles when the underlying dispatch ends (never rejects). */
  settled: Promise<void>;
  /** Cooperative abort hook (wired to the dispatch's AbortController), if any. */
  abort?: () => void;
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BackgroundTaskRecord>();
  private counter = 0;

  /**
   * Register a running dispatch. The returned id ("task-1", ...) is what the
   * model passes to TaskOutput/TaskStop. The promise gets a completion handler
   * attached in BOTH directions, so a failing background dispatch can never
   * become an unhandled rejection.
   */
  start(label: string, promise: Promise<BackgroundResultLike>, abort?: () => void): string {
    const id = `task-${++this.counter}`;
    const record: BackgroundTaskRecord = {
      id,
      label,
      status: "running",
      diagnostics: [],
      settled: Promise.resolve(),
      abort,
    };
    record.settled = promise.then(
      (result) => {
        record.agentName = result.agentName;
        record.diagnostics.push(...(result.diagnostics ?? []));
        if (record.status === "stopped") {
          // TaskStop contract: a stopped task's result is discarded.
          record.diagnostics.push({
            severity: "info",
            message: "task was stopped before completion; its result was discarded",
          });
          return;
        }
        if (result.outcome === "completed") {
          record.status = "completed";
          record.result = result.finalMessage;
        } else if (result.outcome === "aborted") {
          // Deliberate stop (abort/TaskStop inside the dispatch): reported as
          // stopped — never as failed, and NEVER as completed.
          record.status = "stopped";
          record.error = result.error ?? "subagent dispatch was aborted";
        } else {
          record.status = "failed";
          record.error = result.error ?? "subagent dispatch failed";
          // Preserve best-effort partial output for TaskOutput to surface.
          if (result.finalMessage.trim()) record.result = result.finalMessage;
        }
      },
      (err) => {
        if (record.status !== "stopped") {
          record.status = "failed";
          record.error = capErrorText(err instanceof Error ? err.message : String(err));
        }
      },
    );
    this.tasks.set(id, record);
    return id;
  }

  get(id: string): BackgroundTaskRecord | undefined {
    return this.tasks.get(id);
  }

  ids(): string[] {
    return [...this.tasks.keys()];
  }

  /** Await the task's settlement (no-op for unknown ids). */
  async wait(id: string): Promise<BackgroundTaskRecord | undefined> {
    const task = this.tasks.get(id);
    if (task) await task.settled;
    return task;
  }

  /**
   * Best-effort stop: a running task is marked stopped (result discarded on
   * completion) and its abort hook — when the dispatch wired one — is invoked.
   */
  stop(id: string): { found: boolean; alreadySettled: boolean; abortRequested: boolean } {
    const task = this.tasks.get(id);
    if (!task) return { found: false, alreadySettled: false, abortRequested: false };
    if (task.status !== "running") {
      return { found: true, alreadySettled: true, abortRequested: false };
    }
    task.status = "stopped";
    let abortRequested = false;
    if (task.abort) {
      try {
        task.abort();
        abortRequested = true;
      } catch {
        // best-effort — a failing abort hook must not fail the stop
      }
    }
    return { found: true, alreadySettled: false, abortRequested };
  }
}

/**
 * Mirror of subagents.ts `capErrorText` (deliberately duplicated: this module
 * stays free of value-level imports from subagents.ts, matching the structural
 * BackgroundResultLike mirror): model-visible error text is single-line —
 * control characters and whitespace runs collapse to spaces — and capped.
 */
const ERROR_TEXT_CAP = 500;

function capErrorText(message: string): string {
  const flat = message.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return flat.length > ERROR_TEXT_CAP ? `${flat.slice(0, ERROR_TEXT_CAP)} [truncated]` : flat;
}

function unknownIdError(registry: BackgroundTaskRegistry, id: string): Error {
  const known = registry.ids();
  return new Error(
    `Unknown task_id "${id}". Known background tasks: ${known.length ? known.join(", ") : "(none — start one with the Agent tool and run_in_background: true)"}`,
  );
}

/** The `TaskOutput` tool: retrieve a background task's result (waits by default). */
export function createTaskOutputTool(registry: BackgroundTaskRegistry): Record<string, unknown> {
  return {
    name: "TaskOutput",
    label: "TaskOutput",
    description:
      "Retrieve the result of a background task started with the Agent tool's run_in_background. Waits for completion by default; pass wait: false to poll the current status instead.",
    parameters: Type.Object({
      task_id: Type.String({ description: 'Task id returned at start, e.g. "task-1"' }),
      wait: Type.Optional(
        Type.Boolean({ description: "Wait for completion (default true)" }),
      ),
    }),
    async execute(_toolCallId: string, params: { task_id: string; wait?: boolean }) {
      const id = String(params.task_id ?? "").trim();
      const task = registry.get(id);
      if (!task) throw unknownIdError(registry, id);
      if (task.status === "running" && params.wait !== false) {
        await registry.wait(id);
      }
      let text: string;
      switch (task.status) {
        case "completed":
          // Verbatim-return contract (plan §4.3): the final message unwrapped.
          text = task.result ?? "";
          break;
        case "failed":
          text = `Background task ${id} (${task.label}) failed: ${task.error ?? "unknown error"}`;
          if (task.result?.trim()) {
            text += `\n\nPartial output before the failure:\n${task.result}`;
          }
          break;
        case "stopped":
          text = `Background task ${id} (${task.label}) was stopped; its result was discarded.`;
          break;
        default:
          text = `Background task ${id} (${task.label}) is still running. Call TaskOutput again (wait defaults to true) to await its result.`;
          break;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          taskId: id,
          status: task.status,
          agent: task.agentName,
          diagnostics: task.diagnostics,
        },
      };
    },
  };
}

/** The `TaskStop` tool: best-effort cooperative stop of a background task. */
export function createTaskStopTool(registry: BackgroundTaskRegistry): Record<string, unknown> {
  return {
    name: "TaskStop",
    label: "TaskStop",
    description:
      "Stop a running background task (best-effort). The task is marked stopped and its result is discarded.",
    parameters: Type.Object({
      task_id: Type.String({ description: 'Task id returned at start, e.g. "task-1"' }),
    }),
    async execute(_toolCallId: string, params: { task_id: string }) {
      const id = String(params.task_id ?? "").trim();
      const task = registry.get(id);
      if (!task) throw unknownIdError(registry, id);
      const stopped = registry.stop(id);
      const text = stopped.alreadySettled
        ? `Background task ${id} (${task.label}) already finished with status "${task.status}"; nothing to stop.`
        : stopped.abortRequested
          ? `Background task ${id} (${task.label}) stop requested (cooperative abort). The task is marked stopped and its result will be discarded.`
          : `Background task ${id} (${task.label}) marked stopped. Cooperative stop is not supported for this dispatch; it may run to completion, but its result will be discarded.`;
      return {
        content: [{ type: "text", text }],
        details: { taskId: id, status: task.status },
      };
    },
  };
}
