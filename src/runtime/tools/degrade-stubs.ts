import { Type } from "../../runtime-host.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../../runtime-host.js";

/**
 * Graceful-degradation stubs: tool names a project can
 * reference in `tools:`, permission rules, or hook `if:` conditions must
 * resolve predictably even when PiCC does not implement them.
 *
 * Each stub is a callable no-op: it accepts arbitrary parameters and
 * RETURNS (never throws) a notice telling the model to proceed without the
 * tool — an unknown tool name must not fail a gate or wedge the session.
 */

/**
 * A `redirect` stub points the model at another tool that DOES the job, so the
 * generic "Proceed without it." tail (which tells the model to skip the work) is
 * omitted — its `note` already carries the redirect and states no capability is
 * lost. Non-redirect stubs keep the tail.
 */
export function createDegradeStub(
  toolName: string,
  note: string,
  opts: { redirect?: boolean } = {},
): ToolDefinition {
  const text = opts.redirect
    ? `The ${toolName} tool is not available in PiCC: ${note}.`
    : `The ${toolName} tool is not available in PiCC: ${note}. Proceed without it.`;
  return defineTool({
    name: toolName,
    label: toolName,
    description: `Not available in PiCC (degraded no-op): ${note}`,
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
        details: { degraded: true },
      };
    },
  });
}

/**
 * Tool names degraded to predictable no-ops, each with a note for the model.
 * A `redirect: true` entry omits the generic "proceed without it" tail because
 * its note points the model at a tool that still does the job (no capability
 * lost) — see {@link createDegradeStub}.
 */
export const DEGRADED_TOOLS: Array<{ name: string; note: string; redirect?: boolean }> = [
  {
    name: "NotebookRead",
    note:
      "read the notebook with Read instead — Read renders .ipynb cell-aware (source + outputs), " +
      "so no capability is lost; the NotebookRead name is retained only as a permission-gating token",
    redirect: true,
  },
  {
    name: "AskUserQuestion",
    note: "interactive question prompts are deliberately not provided; ask the user in plain chat instead",
  },
  {
    name: "ExitPlanMode",
    note: "plan mode is a no-op in PiCC; simply continue with the work",
  },
  {
    name: "EnterPlanMode",
    note: "plan mode is a no-op in PiCC; treat planning guidance as ordinary instructions",
  },
  {
    name: "Artifact",
    note: "Artifacts are out of scope; write output to a regular file instead",
  },
  {
    name: "computer",
    note: "computer use is out of scope for PiCC",
  },
  {
    name: "LSP",
    note: "language-server integration is out of scope; use Grep/Read to navigate code",
  },
  {
    name: "BashOutput",
    note: "background shells are not implemented; commands run in the foreground, so their output was already returned",
  },
  {
    name: "KillShell",
    note: "background shells are not implemented; there is no shell to kill",
  },
  {
    name: "KillBash",
    note: "background shells are not implemented; there is no shell to kill",
  },
];
