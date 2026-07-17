import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Graceful-degradation stubs: tool names a project can
 * reference in `tools:`, permission rules, or hook `if:` conditions must
 * resolve predictably even when PiCC does not implement them.
 *
 * Each stub is a callable no-op: it accepts arbitrary parameters and
 * RETURNS (never throws) a notice telling the model to proceed without the
 * tool — an unknown tool name must not fail a gate or wedge the session.
 */

export function createDegradeStub(toolName: string, note: string): ToolDefinition {
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
            text: `The ${toolName} tool is not available in PiCC: ${note}. Proceed without it.`,
          },
        ],
        details: { degraded: true },
      };
    },
  });
}

/** Tool names degraded to predictable no-ops, each with a note for the model. */
export const DEGRADED_TOOLS: Array<{ name: string; note: string }> = [
  {
    name: "NotebookEdit",
    note: "notebook editing is not implemented; edit the .ipynb file as JSON with Read/Edit instead",
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
