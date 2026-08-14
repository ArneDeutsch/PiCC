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
    expect(row("feature.managed-policy")).toMatch(/partial[\s\S]*`feature.managed-policy-windows-registry`[\s\S]*system managed settings file followed by lexically ordered drop-in files/);
    expect(row("feature.managed-policy-windows-registry")).toMatch(/⚠ \| not-supported[\s\S]*`feature.managed-policy`[\s\S]*HKLM and HKCU are neither queried nor probed[\s\S]*silently ignored/);
    expect(row("setting.strictPluginOnlyCustomization.mcp")).toContain("manual/CLI/runtime source delivery are themselves unsupported rather than governed");
  });

  it("projects local plugin lifecycle and excluded policy truth into distinct rows", () => {
    const rendered = renderCapabilityMatrix(CAPABILITY_REGISTRY, CLAUDE_BASELINE);
    const row = (id: string): string => {
      const value = rendered.split("\n").find((line) => line.startsWith(`| \`${id}\``));
      expect(value, id).toBeDefined();
      return value!;
    };

    expect(row("feature.plugin-marketplace")).toMatch(/partial[\s\S]*anonymous public HTTPS Git[\s\S]*Private\/SSH/);
    expect(row("feature.plugin-source-acquisition")).toMatch(/partial[\s\S]*retained materialized local or Git-backed marketplace trees[\s\S]*standalone public HTTPS catalog descriptors cannot confer relative content authority[\s\S]*public npm[\s\S]*without lifecycle scripts[\s\S]*public HTTPS ZIP/);
    expect(row("feature.plugin-dependencies")).toMatch(/PiCC-owned lifecycle activation[\s\S]*Imported dependency metadata remains observational/);
    expect(row("setting.enabledPlugins")).toMatch(/Declaration-only consent permits writing[\s\S]*never overrides a higher-precedence effective declaration/);
    expect(row("feature.plugin-lifecycle-automation")).toMatch(/not-supported[\s\S]*stable headless JSON[\s\S]*enterprise distribution/);
    expect(row("feature.plugins-command-plugins")).toMatch(/partial[\s\S]*observational session snapshot[\s\S]*no lifecycle mutation/);
    expect(row("feature.plugins-command-reload")).toMatch(/partial[\s\S]*ctx\.reload\(\)[\s\S]*authoritative new-session guidance/);
    expect(row("setting.allowManagedHooksOnly")).toMatch(/⚠ \| not-supported[\s\S]*PiCC-owned or imported plugins/);
    expect(row("setting.strictKnownMarketplaces")).toMatch(/⚠ \| partial[\s\S]*does not enforce/);
    expect(row("setting.blockedMarketplaces")).toMatch(/⚠ \| partial[\s\S]*does not enforce/);
    expect(row("setting.disableSideloadFlags")).toMatch(/not-supported[\s\S]*neither disables nor authorizes PiCC's explicit/);
  });
});
