import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgents } from "../src/claude/agents.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import type { ClaudeAgent, PermissionRules } from "../src/types.js";

// Assert the no-dispatch / no-skill-reentry invariant on the REAL shipped agent
// files (not fixtures): a fixture copy could stay green while the real file
// silently regains Agent. Resolve the dir from this test file, never from cwd —
// sibling tests process.chdir into temp dirs.
const AGENTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "agents",
);

// allKnownToolNames() is a private closure in src/index.ts (not exported), so we
// inline an equivalent list. It must include the tools we assert on.
const KNOWN = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "Skill",
  "EnterWorktree",
  "ExitWorktree",
  "TodoWrite",
];

function emptyRules(): PermissionRules {
  return { allow: [], deny: [], ask: [], additionalDirectories: [] };
}

describe("non-dispatching workflow agents", () => {
  const { agents, diagnostics } = loadAgents([{ dir: AGENTS_DIR, scope: "project" }]);
  const engine = new PermissionEngine(emptyRules(), { cwd: AGENTS_DIR });

  // Fail loudly if an agent is missing/unloadable — otherwise a rename or bad
  // frontmatter would drop it and the tool assertions would vacuously pass.
  const byName = (name: string): ClaudeAgent => {
    const agent = agents.find((a) => a.name === name);
    if (!agent) throw new Error(`agent "${name}" failed to load from ${AGENTS_DIR}`);
    return agent;
  };

  it("load the real agent files without diagnostics", () => {
    // Dir-wide: this also asserts the six existing specialists load clean, which
    // is deliberate roster-health coverage. A future unrelated agent breakage
    // would surface here.
    expect(diagnostics).toEqual([]);
  });

  it("implementer is write-capable but cannot dispatch or invoke skills", () => {
    const impl = byName("implementer");
    expect(impl.tools).toEqual(["Read", "Grep", "Glob", "Bash", "Edit", "Write"]);
    const granted = engine.gateTools(impl.tools, impl.disallowedTools, KNOWN);
    expect(granted).toContain("Edit");
    expect(granted).toContain("Write");
    expect(granted).not.toContain("Agent");
    expect(granted).not.toContain("Task");
    expect(granted).not.toContain("Skill");
  });

  it("generalist is read-only and cannot dispatch or invoke skills", () => {
    const gen = byName("generalist");
    expect(gen.tools).toEqual(["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"]);
    const granted = engine.gateTools(gen.tools, gen.disallowedTools, KNOWN);
    expect(granted).not.toContain("Edit");
    expect(granted).not.toContain("Write");
    expect(granted).not.toContain("Agent");
    expect(granted).not.toContain("Task");
    expect(granted).not.toContain("Skill");
  });
});
