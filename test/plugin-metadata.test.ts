import { describe, expect, it } from "vitest";
import { projectPluginManifest } from "../src/claude/plugin-metadata.js";

describe("plugin manifest enablement metadata", () => {
  it("retains boolean defaultEnabled with exact manifest provenance", () => {
    expect(projectPluginManifest({ name: "tool", defaultEnabled: false }, "/artifact/.claude-plugin/plugin.json").projection.defaultEnabled).toEqual({
      presence: "explicit", value: false, sourcePath: "/artifact/.claude-plugin/plugin.json",
    });
    expect(projectPluginManifest({ name: "tool" }, "/artifact/.claude-plugin/plugin.json").projection.defaultEnabled).toEqual({
      presence: "absent", sourcePath: "/artifact/.claude-plugin/plugin.json",
    });
  });

  it("carries complete, absent, invalid, and truncated dependency-declaration evidence", () => {
    expect(projectPluginManifest({ name: "tool" }).projection.dependencyDeclaration).toBe("absent");
    expect(projectPluginManifest({ name: "tool", dependencies: ["base"] }).projection.dependencyDeclaration).toBe("complete");
    expect(projectPluginManifest({ name: "tool", dependencies: ["bad name"] }).projection.dependencyDeclaration).toBe("invalid");
    expect(projectPluginManifest({ name: "tool", dependencies: Array.from({ length: 129 }, () => "base") }).projection.dependencyDeclaration).toBe("truncated");
  });

  it("treats malformed defaultEnabled as absent diagnosed evidence", () => {
    const result = projectPluginManifest({ name: "tool", defaultEnabled: "false" }, "/artifact/plugin.json");
    expect(result.projection.defaultEnabled).toEqual({ presence: "absent", sourcePath: "/artifact/plugin.json" });
    expect(result.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining("defaultEnabled") })]);
  });
});
