import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as rootTui from "@earendil-works/pi-tui";

const requireFromPi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piTuiEntry = requireFromPi.resolve("@earendil-works/pi-tui");
const piTui = await import(pathToFileURL(piTuiEntry).href) as typeof rootTui;

function installCwdCandidate(directory: string): void {
  const packageDirectory = path.join(directory, "node_modules", "@earendil-works", "pi-tui");
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-tui",
    version: "99.0.0",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(path.join(packageDirectory, "index.js"), [
    "export class Box {}",
    "export function getCapabilities() { throw new Error('cwd candidate used'); }",
  ].join("\n"));
}

describe("installed Pi TUI runtime bridge contract", () => {
  it("uses Pi's public key state and Pi-context capabilities regardless of cwd candidates", async () => {
    const previousCwd = process.cwd();
    const candidateDirectory = mkdtempSync(path.join(tmpdir(), "picc-pi-tui-candidate-"));
    const previousRootCapabilities = rootTui.getCapabilities();
    const previousPiCapabilities = piTui.getCapabilities();
    const previousBindings = piTui.getKeybindings();
    try {
      installCwdCandidate(candidateDirectory);
      process.chdir(candidateDirectory);
      piTui.setKeybindings(new piTui.KeybindingsManager({
        ...piTui.TUI_KEYBINDINGS,
        "app.tools.expand": { defaultKeys: "ctrl+x", description: "Expand tools" },
      }));
      rootTui.setCapabilities({ images: "kitty", trueColor: false, hyperlinks: false });
      piTui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });

      const runtime = await import("../src/runtime/pi-tui-runtime.js");
      expect(runtime.piToolsExpandKeyText()).toEqual({
        available: true,
        value: codingAgent.keyText("app.tools.expand"),
      });
      expect(runtime.piToolsExpandKeyText()).toEqual({ available: true, value: "ctrl+x" });
      expect(runtime.piTuiCapabilities()).toEqual({
        available: true,
        value: { images: null, trueColor: true, hyperlinks: true },
      });

      const { getTextOutput } = await import("../src/runtime/tool-shell.js");
      const image = { content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }] };
      expect(getTextOutput(image, true)).toMatch(/Image/iu);
      if (rootTui.Box !== piTui.Box) {
        rootTui.setCapabilities({ images: null, trueColor: false, hyperlinks: false });
        piTui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
        expect(getTextOutput(image, true)).toBe("");
      }
    } finally {
      process.chdir(previousCwd);
      piTui.setKeybindings(previousBindings);
      rootTui.setCapabilities(previousRootCapabilities);
      piTui.setCapabilities(previousPiCapabilities);
      rmSync(candidateDirectory, { recursive: true, force: true });
    }
  });

  it("neutralizes only Pi's native Edit Box identity and preserves the component object", async () => {
    const { neutralizePiEditBoxBackground } = await import("../src/runtime/pi-tui-runtime.js");
    const piBox = new piTui.Box(0, 0);
    const piSetBgFn = vi.spyOn(piBox, "setBgFn");

    expect(neutralizePiEditBoxBackground(piBox)).toBe(true);
    expect(piSetBgFn).toHaveBeenCalledTimes(1);

    if (rootTui.Box !== piTui.Box) {
      const rootBox = new rootTui.Box(0, 0);
      const rootSetBgFn = vi.spyOn(rootBox, "setBgFn");
      expect(neutralizePiEditBoxBackground(rootBox)).toBe(false);
      expect(rootSetBgFn).not.toHaveBeenCalled();
    }
  });
});
