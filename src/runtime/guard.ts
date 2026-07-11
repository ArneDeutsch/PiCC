import type { PermissionEngine } from "../engine/permissions.js";
import { matchesRule } from "../engine/permissions.js";
import type { HookRunner } from "../engine/hook-runner.js";
import { applyUpdatedInput, toClaudeCall, touchedFilePath } from "./tool-map.js";

/**
 * The enforcement guard: an inline Pi extension shared by the main session and every
 * subagent session. Implements, on Pi's tool events:
 *  - deny rules as a hard block (plan §6.1),
 *  - PreToolUse hooks (block / updatedInput / additionalContext),
 *  - PostToolUse / PostToolUseFailure hooks (block feedback reaches the model),
 *  - on-touch context injection (nested CLAUDE.md, path-scoped rules/skills).
 */
export interface GuardDeps {
  engine: PermissionEngine;
  hooks: HookRunner;
  getCwd: () => string;
  /** Returns context to inject when a file is touched (nested CLAUDE.md, path rules). */
  contextForTouchedFile?: (filePath: string) => string | undefined;
  /**
   * Extra deny rules evaluated after the engine (e.g. active skills'
   * `disallowed-tools`). Rule texts use the permission-rule grammar.
   */
  extraDenyRules?: () => string[];
  /** Label used in notices (e.g. "subagent:reviewer"). */
  label?: string;
}

// Pi event payloads are typed loosely here; the pinned shapes are in doc/design/pi-integration.md.
type PiApi = {
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
};

export function createGuardExtension(deps: GuardDeps) {
  // Ask downgrades are a graceful no-op (posture §6.1) but must be VISIBLE — once per rule.
  const reportedAskRules = new Set<string>();
  const where = deps.label ? ` [${deps.label}]` : "";

  const denyByExtraRules = (call: ReturnType<typeof toClaudeCall>): string | undefined => {
    for (const rule of deps.extraDenyRules?.() ?? []) {
      if (matchesRule(rule, call)) return rule;
    }
    return undefined;
  };

  const evaluateDeny = (call: ReturnType<typeof toClaudeCall>): { reason: string } | undefined => {
    const decision = deps.engine.evaluate(call);
    if (decision.decision === "deny") {
      return { reason: `PiCC: blocked by permission deny rule ${decision.rule ?? ""}`.trim() };
    }
    if (decision.askDowngraded && decision.rule && !reportedAskRules.has(decision.rule)) {
      reportedAskRules.add(decision.rule);
      console.error(
        `[picc]${where} ask rule "${decision.rule}" downgraded to allow (posture §6.1 — deny rules still enforced)`,
      );
    }
    const extraRule = denyByExtraRules(call);
    if (extraRule !== undefined) {
      return { reason: `PiCC: blocked by active skill disallowed-tools rule ${extraRule}`.trim() };
    }
    return undefined;
  };

  return (pi: PiApi) => {
    pi.on("tool_call", async (event: any) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const call = toClaudeCall(event.toolName, input, deps.getCwd());

      const denied = evaluateDeny(call);
      if (denied) return { block: true, reason: denied.reason };

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
        // Deny rules always apply to what actually executes (research 02 §7.5):
        // re-evaluate against the hook-rewritten input, or a hook rewrite could
        // smuggle a denied command past the pre-rewrite check.
        const updatedCall = toClaudeCall(event.toolName, input, deps.getCwd());
        const deniedAfterUpdate = evaluateDeny(updatedCall);
        if (deniedAfterUpdate) {
          return {
            block: true,
            reason: `${deniedAfterUpdate.reason} (after PreToolUse updatedInput)`,
          };
        }
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
      // Claude semantics: a blocking PostToolUse hook (exit 2 / decision "block")
      // feeds its reason back to the model — this is the post-edit lint-and-fix loop.
      const feedback: string[] = [];
      if (outcome.block) {
        feedback.push(`[hook blocked] ${outcome.blockReason ?? "PostToolUse hook rejected this result"}`);
      }
      if (outcome.additionalContext) feedback.push(`[hook context] ${outcome.additionalContext}`);
      if (feedback.length) {
        const content = Array.isArray(event.content) ? [...event.content] : [];
        content.push({ type: "text", text: `\n${feedback.join("\n")}` });
        return { content };
      }
      return undefined;
    });
  };
}
