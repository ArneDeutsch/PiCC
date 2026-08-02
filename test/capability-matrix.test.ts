import { describe, expect, it } from "vitest";
import { renderCapabilityMatrix } from "../scripts/gen-capability-matrix.mjs";
import { CAPABILITY_REGISTRY, CLAUDE_BASELINE } from "../src/registry/capability-registry.js";

describe("renderCapabilityMatrix", () => {
  it("renders audited evidence, relationships, safety, ordering, and Markdown escaping", () => {
    const rendered = renderCapabilityMatrix([
      {
        id: "feature.z|unsafe",
        kind: "feature",
        tier: "not-supported",
        safetyRelevant: true,
        evidence: [
          { quality: "unverified", source: "page | open question" },
          { quality: "documented", source: "ä page" },
          { quality: "documented", source: "Z page", reviewed: "2025-04-10" },
          { quality: "documented", source: "MCP | metadata", reviewed: "2026-07-31" },
        ],
        related: ["feature.ä", "feature.zeta", "feature.alpha|pipe", "feature.Z"],
        note: "not | available",
      },
      {
        id: "feature.ä",
        kind: "feature",
        tier: "full",
        note: "code-unit-later",
      },
      {
        id: "feature.a",
        kind: "feature",
        tier: "full",
        note: "unaudited",
      },
    ], "synthetic-baseline");

    expect(rendered).toContain("The structured official-document review dates span **2025-04-10** through **2026-07-31** (2025-04-10, 2026-07-31).");
    expect(rendered).toContain("2025-04-10");
    expect(rendered).toContain("2026-07-31");
    expect(rendered).toContain("documented = stated by an allowlisted official page");
    expect(rendered).toContain("unverified = the reviewed evidence does not establish the behavior");
    expect(rendered).toContain("blank cell means the entry was not part of this audit");
    expect(rendered).toContain("**Related references** are navigation and context only");
    expect(rendered).toContain("search this document or the registry by ID");
    expect(rendered).toContain("`feature.z\\|unsafe` ⚠");
    expect(rendered).toContain("documented: MCP \\| metadata (2026-07-31); documented: Z page (2025-04-10); documented: ä page; unverified: page \\| open question");
    expect(rendered).toContain("`feature.Z`, `feature.alpha\\|pipe`, `feature.zeta`, `feature.ä`");
    expect(rendered).toContain("not \\| available");
    expect(rendered).toMatch(/\| `feature\.a` \| full \|  \|  \| unaudited \|/);
    expect(rendered.indexOf("`feature.a`")).toBeLessThan(rendered.indexOf("`feature.ä`"));
    expect(rendered.indexOf("`feature.ä`")).toBeLessThan(rendered.indexOf("`feature.z\\|unsafe`"));
  });

  it("projects final managed MCP claims into their own matrix rows", () => {
    const rendered = renderCapabilityMatrix(CAPABILITY_REGISTRY, CLAUDE_BASELINE);
    const row = (id: string): string => {
      const value = rendered.split("\n").find((line) => line.startsWith(`| \`${id}\``));
      expect(value, id).toBeDefined();
      return value!;
    };

    expect(row("setting.allowedMcpServers")).toMatch(/⚠ \| partial[\s\S]*documented soft allowlist/);
    expect(row("setting.allowManagedMcpServersOnly")).toContain("does not turn an ordinary soft allowlist into an immutable administrator list");
    expect(row("feature.mcp-managed-config")).toMatch(/⚠ \| partial[\s\S]*`feature.managed-policy`[\s\S]*`feature.mcp-project-approval`[\s\S]*PiCC-defined \/mcp and \/doctor summaries[\s\S]*not Claude UI parity/);
    expect(row("setting.strictPluginOnlyCustomization.mcp")).toContain("manual/CLI/runtime source delivery are themselves unsupported rather than governed");
  });
});
