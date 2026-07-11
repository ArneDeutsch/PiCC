import { describe, expect, it } from "vitest";
import { parseMarkdown, lenientParseFrontmatter } from "../src/util/markdown.js";
import { loadAgents } from "../src/claude/agents.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression: real Claude projects (DemonMatrix) carry frontmatter that is
 * lenient-YAML but not strict-YAML — an unquoted `description:` value containing
 * `: ` trips the strict parser. Claude Code accepts it; mechanical fidelity
 * (plan §2.1) requires we do too.
 */
describe("lenient frontmatter recovery", () => {
  it("recovers a description containing ': ' that strict YAML rejects", () => {
    const md = [
      "---",
      "name: coder",
      "description: Implementation-craft specialist. Fires on: code tasks, `refactors`, etc.",
      "tools: Read, Edit, Bash",
      "---",
      "Body here.",
    ].join("\n");
    const parsed = parseMarkdown(md, "coder.md");
    expect(parsed.frontmatter.name).toBe("coder");
    expect(String(parsed.frontmatter.description)).toContain("Fires on:");
    expect(parsed.frontmatter.tools).toBe("Read, Edit, Bash");
    // Degrades to info, never a hard error.
    expect(parsed.diagnostics.every((d) => d.severity !== "error")).toBe(true);
  });

  it("parses nested mappings and lists leniently", () => {
    const fm = lenientParseFrontmatter(
      [
        "name: x",
        "metadata:",
        "  portability: generic",
        "  nested: yes",
        "paths:",
        "  - src/**/*.rs",
        "  - lib/**",
        "count: 3",
        "flag: true",
      ].join("\n"),
    );
    expect(fm.name).toBe("x");
    expect((fm.metadata as Record<string, unknown>).portability).toBe("generic");
    expect(fm.paths).toEqual(["src/**/*.rs", "lib/**"]);
    expect(fm.count).toBe(3);
    expect(fm.flag).toBe(true);
  });

  it("handles block scalars", () => {
    const fm = lenientParseFrontmatter(
      ["name: y", "description: |", "  line one", "  line two"].join("\n"),
    );
    expect(String(fm.description)).toContain("line one");
    expect(String(fm.description)).toContain("line two");
  });

  it("loadAgents recovers agents whose descriptions break strict YAML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-lenient-"));
    try {
      fs.writeFileSync(
        path.join(dir, "coder.md"),
        [
          "---",
          "name: coder",
          "description: Implementation specialist. Fires on: tasks matching `**/*.rs`.",
          "tools: Read, Edit",
          "---",
          "You are the coder.",
        ].join("\n"),
      );
      const { agents } = loadAgents([{ dir, scope: "project" }]);
      expect(agents.length).toBe(1);
      expect(agents[0]?.name).toBe("coder");
      expect(agents[0]?.description).toContain("Fires on:");
      expect(agents[0]?.tools).toEqual(["Read", "Edit"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still parses strict YAML unchanged", () => {
    const parsed = parseMarkdown(
      ["---", 'name: ok', 'description: "quoted, with comma"', "---", "body"].join("\n"),
    );
    expect(parsed.frontmatter.name).toBe("ok");
    expect(parsed.frontmatter.description).toBe("quoted, with comma");
    expect(parsed.diagnostics.length).toBe(0);
  });
});
