import { afterEach, describe, expect, it, vi } from "vitest";

function mockPackageContext(moduleFor: (source: "coding" | "tui") => unknown): void {
  const contextRequire = Object.assign(
    vi.fn((specifier: string) => moduleFor(
      specifier === "fixed-pi-tui-entry" ? "tui" : "coding",
    )),
    { resolve: vi.fn(() => "fixed-pi-tui-entry") },
  );
  vi.doMock("node:module", () => ({ createRequire: () => contextRequire }));
}

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("Pi-owned TUI runtime bridge fallbacks", () => {
  it("reports expansion-key lookup failure without rejecting module activation", async () => {
    mockPackageContext((source) => source === "coding"
      ? { keyText() { throw new Error("keybindings unavailable"); } }
      : undefined);
    vi.resetModules();

    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    expect(runtime.piToolsExpandKeyText()).toEqual({ available: false });
  });

  it("keeps each Pi-context failure conservative and leaves the exact component unchanged", async () => {
    const identityFailure = class {
      static [Symbol.hasInstance](): boolean {
        throw new Error("identity unavailable");
      }
    };
    mockPackageContext((source) => source === "coding"
      ? { keyText: () => "ctrl+o" }
      : {
          Box: identityFailure,
          getCapabilities() { throw new Error("capabilities unavailable"); },
        });
    vi.resetModules();

    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    const shell = await import("../src/runtime/tool-shell.js");
    const component = Object.freeze({ render: (width: number) => [`native:${width}`] });

    expect(runtime.piTuiCapabilities()).toEqual({ available: false });
    expect(runtime.neutralizePiEditBoxBackground(component)).toBe(false);
    expect(component.render(7)).toEqual(["native:7"]);
    expect(shell.getTextOutput({
      content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }],
    }, true)).toMatch(/Image/iu);
  });

  it("does not retry package resolution through another candidate after failure", async () => {
    const resolve = vi.fn(() => { throw new Error("Pi package unavailable"); });
    const fakeRequire = Object.assign(vi.fn(), { resolve });
    vi.resetModules();
    vi.doMock("node:module", () => ({ createRequire: () => fakeRequire }));

    const runtime = await import("../src/runtime/pi-tui-runtime.js");
    expect(runtime.piTuiCapabilities()).toEqual({ available: false });
    expect(runtime.piTuiCapabilities()).toEqual({ available: false });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(fakeRequire).not.toHaveBeenCalled();
  });
});
