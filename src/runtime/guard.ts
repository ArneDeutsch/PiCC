import type { PermissionEngine } from "../engine/permissions.js";
import type { HookRunner } from "../engine/hook-runner.js";
import { applyUpdatedInput, toClaudeCall, touchedFilePath } from "./tool-map.js";

/**
 * The enforcement guard: an inline Pi extension shared by the main session and every
 * subagent session. Implements, on Pi's tool events:
 *  - deny rules as a hard block (plan §6.1),
 *  - PreToolUse hooks (block / updatedInput / additionalContext),
 *  - PostToolUse / PostToolUseFailure hooks,
 *  - on-touch context injection (nested CLAUDE.md, path-scoped rules/skills).
 */
export interface GuardDeps {
  engine: PermissionEngine;
  hooks: HookRunner;
  getCwd: () => string;
  /** Returns context to inject when a file is touched (nested CLAUDE.md, path rules). */
  contextForTouchedFile?: (filePath: string) => string | undefined;
  /** Label used in notices (e.g. "subagent:reviewer"). */
  label?: string;
}

// Pi event payloads are typed loosely here; the pinned shapes are in doc/design/pi-integration.md.
type PiApi = {
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
};

export function createGuardExtension(deps: GuardDeps) {
  return (pi: PiApi) => {
    pi.on("tool_call", async (event: any) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const call = toClaudeCall(event.toolName, input, deps.getCwd());

      const decision = deps.engine.evaluate(call);
      if (decision.decision === "deny") {
        return {
          block: true,
          reason: `PiCC: blocked by permission deny rule ${decision.rule ?? ""}`.trim(),
        };
      }

      const outcome = await deps.hooks.fire(
        "PreToolUse",
        { tool_name: call.tool, tool_input: call.input, cwd: deps.getCwd() },
        call,
      );
      if (outcome.block) {
        return {
          block: true,
          reason: `PiCC: blocked by PreToolUse hook${outcome.blockReason ? `: ${outcome.blockReason}` : ""}`,
        };
      }
      if (outcome.updatedInput) {
        applyUpdatedInput(event.toolName, input, outcome.updatedInput);
      }
      const contextParts: string[] = [];
      if (outcome.additionalContext) contextParts.push(outcome.additionalContext);

      const touched = touchedFilePath(event.toolName, input);
      if (touched && deps.contextForTouchedFile) {
        const injected = deps.contextForTouchedFile(touched);
        if (injected) contextParts.push(injected);
      }
      if (contextParts.length) {
        pi.sendMessage(
          {
            customType: "picc-context",
            content: contextParts.join("\n\n"),
            display: true,
          },
          { deliverAs: "steer" },
        );
      }
      return undefined;
    });

    pi.on("tool_result", async (event: any) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const call = toClaudeCall(event.toolName, input, deps.getCwd());
      const responseText = Array.isArray(event.content)
        ? event.content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n")
        : undefined;
      const outcome = await deps.hooks.fire(
        event.isError ? "PostToolUseFailure" : "PostToolUse",
        {
          tool_name: call.tool,
          tool_input: call.input,
          tool_response: responseText,
          cwd: deps.getCwd(),
        },
        call,
      );
      if (outcome.additionalContext) {
        const content = Array.isArray(event.content) ? [...event.content] : [];
        content.push({ type: "text", text: `\n[hook context] ${outcome.additionalContext}` });
        return { content };
      }
      return undefined;
    });
  };
}
