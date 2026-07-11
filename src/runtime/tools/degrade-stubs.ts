import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Graceful-degradation stubs (plan §4.8, §7): tool names a project can
 * reference in `tools:`, permission rules, or hook `if:` conditions must
 * resolve predictably even when PiClauDex does not implement them.
 *
 * Each stub is a callable no-op: it accepts arbitrary parameters and
 * RETURNS (never throws) a notice telling the model to proceed without the
 * tool — an unknown tool name must not fail a gate or wedge the session.
 */

export function createDegradeStub(toolName: string, note: string): ToolDefinition {
  return defineTool({
    name: toolName,
    label: toolName,
    description: `Not available in PiClauDex (degraded no-op): ${note}`,
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: `The ${toolName} tool is not available in PiClauDex: ${note}. Proceed without it.`,
          },
        ],
        details: { degraded: true },
      };
    },
  });
}

/** Tool names degraded to predictable no-ops in v1, with §7-grounded notes. */
export const DEGRADED_TOOLS: Array<{ name: string; note: string }> = [
  {
    name: "NotebookEdit",
    note: "notebook editing is not implemented; edit the .ipynb file as JSON with Read/Edit instead",
  },
  {
    name: "NotebookRead",
    note: "notebook reading is not implemented; Read the .ipynb file as JSON instead",
  },
  {
    name: "AskUserQuestion",
    note: "interactive question prompts are deliberately not provided; ask the user in plain chat instead (plan §7)",
  },
  {
    name: "ExitPlanMode",
    note: "plan mode is a no-op in PiClauDex; simply continue with the work (plan §7)",
  },
  {
    name: "EnterPlanMode",
    note: "plan mode is a no-op in PiClauDex; treat planning guidance as ordinary instructions (plan §7)",
  },
  {
    name: "Artifact",
    note: "Artifacts are out of scope; write output to a regular file instead (plan §7)",
  },
  {
    name: "computer",
    note: "computer use is out of scope for PiClauDex (plan §7)",
  },
];
