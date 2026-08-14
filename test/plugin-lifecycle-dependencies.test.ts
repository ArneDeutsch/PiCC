import { describe, expect, it } from "vitest";
import { decodePersistedPluginDependencyPosture, enabledDependentsOf, pluginDependencyPosture } from "../src/plugin-lifecycle/dependencies.js";
import { resolveInitialPluginEnablement } from "../src/plugin-lifecycle/enablement.js";

const candidate = (pluginId: string, extra: Record<string, unknown> = {}) => ({
  pluginId, version: "1.0.0", enabled: true, available: true,
  ownership: "picc-owned" as const, dependencyDeclaration: "complete" as const,
  allowedCrossMarketplaceDependencies: [] as string[], ...extra,
});

describe("plugin lifecycle dependency and enablement semantics", () => {
  it("uses the frozen initial enablement precedence", () => {
    expect(resolveInitialPluginEnablement({ existingEffective: false, marketplaceDefault: true, manifestDefault: true })).toEqual({ enabled: false, source: "existing-effective" });
    expect(resolveInitialPluginEnablement({ marketplaceDefault: false, manifestDefault: true })).toEqual({ enabled: false, source: "marketplace-default" });
    expect(resolveInitialPluginEnablement({ manifestDefault: { presence: "explicit", value: false, sourcePath: "manifest" } })).toEqual({ enabled: false, source: "manifest-default" });
    expect(resolveInitialPluginEnablement({})).toEqual({ enabled: true, source: "default-enabled" });
  });

  it.each([
    ["missing", [candidate("root@one", { dependencies: [{ name: "dep", itemIndex: 0 }] })]],
    ["disabled", [candidate("root@one", { dependencies: [{ name: "dep", itemIndex: 0 }] }), candidate("dep@one", { enabled: false })]],
    ["incompatible", [candidate("root@one", { dependencies: [{ name: "dep", version: "^2", itemIndex: 0 }] }), candidate("dep@one")]],
    ["indeterminate", [candidate("root@one", { dependencies: [{ name: "dep", version: "^1", itemIndex: 0 }] }), candidate("dep@one", { version: "mutable" })]],
    ["cyclic", [candidate("root@one", { dependencies: [{ name: "dep", itemIndex: 0 }] }), candidate("dep@one", { dependencies: [{ name: "root", itemIndex: 0 }] })]],
    ["disallowed", [candidate("root@one", { dependencies: [{ name: "dep", marketplace: "two", itemIndex: 0 }] }), candidate("dep@two")]],
  ])("blocks %s dependency posture without acquisition or auto-enable", (reason, graph) => {
    const posture = pluginDependencyPosture("root@one", graph as never);
    expect(posture.blocking).toBe(true);
    expect(posture.selected.reasons).toContain(reason);
  });

  it("admits exact enabled compatible dependencies and an explicit cross-marketplace allowlist", () => {
    const posture = pluginDependencyPosture("root@one", [
      candidate("root@one", { dependencies: [{ name: "dep", marketplace: "two", version: "^1", itemIndex: 0 }], allowedCrossMarketplaceDependencies: ["two"] }),
      candidate("dep@two"),
    ] as never);
    expect(posture.selected).toEqual({ pluginId: "root@one", admitted: true, reasons: [] });
  });

  it("totally rejects malformed persisted dependency entries without invoking admission on them", () => {
    const valid = pluginDependencyPosture("root@one", [candidate("root@one", { dependencies: [{ name: "dep", itemIndex: 0 }] })] as never);
    for (const dependency of [null, [], {}, { name: "dep" }, { name: "dep", itemIndex: -1 }, { name: "dep", itemIndex: 0, extra: true }, { name: "x".repeat(2049), itemIndex: 0 }]) {
      const raw = structuredClone(valid) as unknown as { graph: Array<Record<string, unknown>> }; raw.graph[0]!["dependencies"] = [dependency];
      expect(() => decodePersistedPluginDependencyPosture(raw)).not.toThrow(); expect(decodePersistedPluginDependencyPosture(raw)).toMatchObject({ ok: false });
    }
  });

  it("returns ordered enabled dependents for manual disable guidance", () => {
    expect(enabledDependentsOf("dep@one", [
      { pluginId: "z@one", dependencies: [{ name: "dep", itemIndex: 0 }] },
      { pluginId: "a@two", dependencies: [{ name: "dep", marketplace: "one", itemIndex: 0 }] },
      { pluginId: "other@one", dependencies: [{ name: "different", itemIndex: 0 }] },
    ])).toEqual(["a@two", "z@one"]);
  });
});
