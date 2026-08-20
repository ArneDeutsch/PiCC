import { afterEach, describe, expect, it, vi } from "vitest";

function mockRuntimeGraph(options: {
  definition?: unknown;
  keys?: () => unknown;
  capabilities?: () => unknown;
  Box?: new (...args: never[]) => unknown;
}): void {
  vi.doMock("../src/runtime-host.js", () => ({
    runtimeHostGraph: {
      codingAgent: {},
      tui: {
        Box: options.Box ?? class {},
        getCapabilities: options.capabilities ?? (() => ({ images: null, trueColor: false, hyperlinks: false })),
        getKeybindings: () => ({
          getDefinition: () => options.definition,
          getKeys: options.keys ?? (() => ["ctrl+o"]),
        }),
      },
    },
  }));
}

afterEach(() => {
  vi.doUnmock("../src/runtime-host.js");
  vi.resetModules();
});

describe("installed-graph TUI runtime adapter", () => {
  it.each([
    [undefined, ["unused"], { available: true, value: "ctrl+o" }, 0],
    [{ defaultKeys: "ctrl+o" }, ["alt+e"], { available: true, value: process.platform === "darwin" ? "option+e" : "alt+e" }, 1],
    [{ defaultKeys: "ctrl+o" }, [], { available: false }, 1],
  ] as const)("reports the installed graph's keybinding state", async (definition, configuredKeys, expected, calls) => {
    const keys = vi.fn(() => configuredKeys);
    mockRuntimeGraph({ definition, keys });
    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    expect(runtime.piToolsExpandKeyText()).toEqual(expected);
    expect(keys).toHaveBeenCalledTimes(calls);
  });

  it("degrades capability and identity failures without changing the component", async () => {
    class HostileBox { static [Symbol.hasInstance](): boolean { throw new Error("identity unavailable"); } }
    mockRuntimeGraph({
      definition: {},
      keys: () => { throw new Error("binding unavailable"); },
      capabilities: () => { throw new Error("capabilities unavailable"); },
      Box: HostileBox as never,
    });
    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    const component = Object.freeze({ render: (width: number) => [`native:${width}`] });
    expect(runtime.piToolsExpandKeyText()).toEqual({ available: false });
    expect(runtime.piTuiCapabilities()).toEqual({ available: false });
    expect(runtime.neutralizePiEditBoxBackground(component)).toBe(false);
    expect(component.render(7)).toEqual(["native:7"]);
  });

  it("uses only the installed graph and preserves its Box identity", async () => {
    class HostBox { setBgFn = vi.fn(); render(): string[] { return []; } }
    mockRuntimeGraph({
      definition: {},
      keys: () => ["ctrl+x"],
      capabilities: () => ({ images: "kitty", trueColor: true, hyperlinks: false }),
      Box: HostBox as never,
    });
    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    const box = new HostBox();
    expect(runtime.piToolsExpandKeyText()).toEqual({ available: true, value: "ctrl+x" });
    expect(runtime.piTuiCapabilities()).toEqual({ available: true, value: { images: "kitty", trueColor: true, hyperlinks: false } });
    expect(runtime.neutralizePiEditBoxBackground(box)).toBe(true);
    expect(box.setBgFn).toHaveBeenCalledOnce();
    expect(runtime.neutralizePiEditBoxBackground({ render: () => [] })).toBe(false);
  });
});
