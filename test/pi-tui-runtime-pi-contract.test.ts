import { describe, expect, it, vi } from "vitest";
import * as tui from "@earendil-works/pi-tui";

// Standalone imports deliberately acquire one public root graph. The real DefaultResourceLoader
// contract in pi-contract.test.ts owns the distinct Pi-host alias boundary.
describe("standalone Pi TUI runtime graph contract", () => {
  it("shares public keybinding and capability singleton state", async () => {
    const previousCapabilities = tui.getCapabilities();
    const previousBindings = tui.getKeybindings();
    try {
      tui.setKeybindings(new tui.KeybindingsManager({
        ...tui.TUI_KEYBINDINGS,
        "app.tools.expand": { defaultKeys: "ctrl+x", description: "Expand tools" },
      }));
      tui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
      const runtime = await import("../src/runtime/pi-tui-runtime.js");
      expect(runtime.piToolsExpandKeyText()).toEqual({ available: true, value: "ctrl+x" });
      expect(runtime.piTuiCapabilities()).toEqual({ available: true, value: { images: null, trueColor: true, hyperlinks: true } });
    } finally {
      tui.setKeybindings(previousBindings);
      tui.setCapabilities(previousCapabilities);
    }
  });

  it("keeps one immutable graph and rejects a non-identical later installation", async () => {
    const [{ runtimeHostGraph }, { installRuntimeHost }] = await Promise.all([
      import("../src/runtime-host.js"),
      import("../src/runtime-host-bootstrap.js"),
    ]);
    expect(Object.isFrozen(runtimeHostGraph)).toBe(true);
    expect(installRuntimeHost({ ...runtimeHostGraph })).toBe(runtimeHostGraph);
    expect(() => installRuntimeHost({ agentCore: runtimeHostGraph.agentCore } as never)).toThrow(/malformed/u);
    expect(() => installRuntimeHost({
      ...runtimeHostGraph,
      agentCore: { ...runtimeHostGraph.agentCore, Agent: class DifferentAgent {} } as never,
    })).toThrow(/non-identical Pi runtime package graphs/u);
    expect(installRuntimeHost({ ...runtimeHostGraph })).toBe(runtimeHostGraph);
  });

  it("neutralizes only the installed graph's native Edit Box", async () => {
    const { neutralizePiEditBoxBackground } = await import("../src/runtime/pi-tui-runtime.js");
    const box = new tui.Box(0, 0);
    const setBgFn = vi.spyOn(box, "setBgFn");
    expect(neutralizePiEditBoxBackground(box)).toBe(true);
    expect(setBgFn).toHaveBeenCalledOnce();
    expect(neutralizePiEditBoxBackground({ render: () => [] })).toBe(false);
  });
});
