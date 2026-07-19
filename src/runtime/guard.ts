import type { PermissionEngine } from "../engine/permissions.js";
import { matchesRule, parseRule, READ_DENY_EDIT_TOOLS } from "../engine/permissions.js";
import type { HookRunnerLike } from "../engine/hook-runner.js";
import { applyUpdatedInput, toClaudeCall, touchedFilePath } from "./tool-map.js";
import { clipOversizedToolResult } from "./tool-clip.js";

/**
 * The enforcement guard: an inline Pi extension shared by the main session and every
 * subagent session. Implements, on Pi's tool events:
 *  - deny rules as a hard block (the one hard stop in PiCC's default-permissive posture),
 *  - PreToolUse hooks (block / updatedInput / additionalContext),
 *  - PostToolUse / PostToolUseFailure hooks (block feedback reaches the model),
 *  - on-touch context injection (nested CLAUDE.md, path-scoped rules/skills).
 */
export interface GuardDeps {
  engine: PermissionEngine;
  hooks: HookRunnerLike;
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
  /**
   * Per-text-block token budget above which a single tool result is clipped
   * (head + tail kept, middle replaced by a model-visible marker). Resolved once
   * at load (`config.compaction.clipMaxTokens`) and threaded in. Omitted where a
   * facade carries no config — the clip then simply does not run.
   */
  clipMaxTokens?: number;
}

// Pi event payloads are typed loosely here; the pinned shapes are in doc/pi-integration.md.
type PiApi = {
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
};

/** Cap on the serialized structured tool_response delivered to PostToolUse hooks. */
const TOOL_RESPONSE_MAX_CHARS = 50_000;

/** Claude payload `tool_use_id`, when the Pi event carries a tool-call id. */
function toolUseIdField(event: any): { tool_use_id?: string } {
  return typeof event?.toolCallId === "string" && event.toolCallId.length > 0
    ? { tool_use_id: event.toolCallId }
    : {};
}

export function createGuardExtension(deps: GuardDeps) {
  // Ask downgrades are a graceful no-op under PiCC's default-permissive posture
  // (there is no interactive prompt to raise), but must be VISIBLE — once per rule.
  const reportedAskRules = new Set<string>();
  const where = deps.label ? ` [${deps.label}]` : "";

  const denyByExtraRules = (call: ReturnType<typeof toClaudeCall>): string | undefined => {
    // Skill `disallowed-tools` are DENY rules: match with the same
    // deny-direction options PermissionEngine.evaluate uses (any-segment Bash
    // matching, env-assignment stripping, stable anchor) — allow-polarity
    // matching would let `echo hi && rm -rf x` or `FOO=1 rm -rf x` evade a
    // `Bash(rm *)` rule. The anchor is the engine's stable settings-source/
    // project root; a facade without one degrades to the live cwd.
    let anchor: string | undefined;
    try {
      anchor = typeof deps.engine.pathAnchor === "string" ? deps.engine.pathAnchor : undefined;
    } catch {
      anchor = undefined;
    }
    const denyOpts = { anySegment: true, deny: true, anchor: anchor ?? deps.getCwd() };
    for (const rule of deps.extraDenyRules?.() ?? []) {
      if (matchesRule(rule, call, denyOpts)) return rule;
    }
    return undefined;
  };

  // A path-scoped `deny: Read(<glob>)` also blocks Edit/MultiEdit (Claude
  // v2.1.208). When THAT is the cause, surface Claude's wording so the block is
  // explainable: the matched rule is a `Read` rule but the blocked call is an
  // Edit/MultiEdit. Returns the signal reason, or undefined for ordinary denies.
  const readDenyEditReason = (
    rule: string | undefined,
    call: ReturnType<typeof toClaudeCall>,
    kind: "permission deny rule" | "active skill disallowed-tools rule",
  ): string => {
    if (
      rule !== undefined &&
      READ_DENY_EDIT_TOOLS.has(call.tool) &&
      parseRule(rule).tool === "Read"
    ) {
      // Name the actual source so the signal stays truthful: the same cross fires
      // from a settings.json deny AND from an active skill's disallowed-tools.
      const source =
        kind === "permission deny rule"
          ? "in your permission settings"
          : "via an active skill's disallowed-tools rule";
      return `PiCC: File is covered by a Read deny rule ${source} — ${call.tool} blocked by ${rule}`;
    }
    return `PiCC: blocked by ${kind} ${rule ?? ""}`.trim();
  };

  const evaluateDeny = (call: ReturnType<typeof toClaudeCall>): { reason: string } | undefined => {
    const decision = deps.engine.evaluate(call);
    if (decision.decision === "deny") {
      return { reason: readDenyEditReason(decision.rule, call, "permission deny rule") };
    }
    if (decision.askDowngraded && decision.rule && !reportedAskRules.has(decision.rule)) {
      reportedAskRules.add(decision.rule);
      console.error(
        `[picc]${where} ask rule "${decision.rule}" downgraded to allow (default-permissive posture — deny rules still enforced)`,
      );
    }
    const extraRule = denyByExtraRules(call);
    if (extraRule !== undefined) {
      return { reason: readDenyEditReason(extraRule, call, "active skill disallowed-tools rule") };
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
        {
          tool_name: call.tool,
          tool_input: call.input,
          ...toolUseIdField(event),
          cwd: deps.getCwd(),
        },
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
        // Deny rules always apply to what actually executes:
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
      const eventName = event.isError ? "PostToolUseFailure" : "PostToolUse";
      // Clip oversized tool-result text BEFORE the hasHooks gate below, so the
      // backstop fires even for the common project that has no PostToolUse hooks.
      // The marker travels in-band on the canonical/model-visible result; a
      // specialized human renderer may summarize it without changing that result.
      // `clipContent === event.content` (same reference) means everyday-sized
      // results are left byte-identical.
      const clipContent =
        deps.clipMaxTokens !== undefined
          ? clipOversizedToolResult(event.content, deps.clipMaxTokens, event.toolName, event.input ?? {})
          : event.content;
      const clipped = clipContent !== event.content;
      // No hooks configured for this event: skip the payload construction
      // (including the serializability probe over a possibly huge result) and
      // the fire() entirely. Facades without hasHooks degrade to always-fire.
      // A clip still returns (replacing the result); an untouched result is a no-op.
      if (typeof deps.hooks.hasHooks === "function" && !deps.hooks.hasHooks(eventName)) {
        return clipped
          ? { content: clipContent, details: event.details, isError: event.isError }
          : undefined;
      }
      const input = (event.input ?? {}) as Record<string, unknown>;
      const call = toClaudeCall(event.toolName, input, deps.getCwd());
      // Claude sends `tool_response` STRUCTURED — the tool result content
      // array/object as-is, capped so a huge result cannot flood hook stdin.
      // Fall back to flattened text only when the value is not
      // JSON-serializable (never-throw floor).
      let toolResponse: unknown = event.content;
      try {
        const json = JSON.stringify(toolResponse);
        if (typeof json === "string" && json.length > TOOL_RESPONSE_MAX_CHARS) {
          toolResponse = {
            truncated: true,
            note: `tool_response truncated by picc (${json.length} chars)`,
            head: json.slice(0, TOOL_RESPONSE_MAX_CHARS),
          };
        }
      } catch {
        toolResponse = Array.isArray(event.content)
          ? event.content
              .filter((c: any) => c?.type === "text")
              .map((c: any) => String(c.text ?? ""))
              .join("\n")
          : undefined;
      }
      const outcome = await deps.hooks.fire(
        eventName,
        {
          tool_name: call.tool,
          tool_input: call.input,
          ...(toolResponse !== undefined ? { tool_response: toolResponse } : {}),
          ...toolUseIdField(event),
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
      // One owner of the return: the clipped content is the base, hook feedback is
      // appended to it, and details/isError are always preserved (a bare `{ content }`
      // lets agent-session.js overwrite details with undefined).
      if (feedback.length) {
        const content = Array.isArray(clipContent) ? [...clipContent] : [];
        content.push({ type: "text", text: `\n${feedback.join("\n")}` });
        return { content, details: event.details, isError: event.isError };
      }
      if (clipped) {
        return { content: clipContent, details: event.details, isError: event.isError };
      }
      return undefined;
    });
  };
}
