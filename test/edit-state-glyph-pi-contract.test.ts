import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
  type KeybindingsConfig,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  createEditToolDefinition,
  initTheme,
  ToolExecutionComponent,
  type Theme,
  type ThemeColor,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withDefaultCollapsedToolRendering } from "../src/runtime/default-collapsed-tool-render.js";
import { withRoutineToolRendering } from "../src/runtime/routine-tool-render.js";
import { wrapForSelfShell } from "../src/runtime/tool-shell.js";
import { waitUntil } from "./helpers/async.js";

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\].*?(?:\u0007|\u001b\\)/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}

function glyphs(value: string): string[] {
  return stripAnsi(value).match(/[○●✗■]/gu) ?? [];
}

type EditDefinition = ReturnType<typeof createEditToolDefinition>;

function productionDefinition(definition: EditDefinition): ToolDefinition {
  const genericDefinition = definition as unknown as ToolDefinition;
  const decorated = withDefaultCollapsedToolRendering(withRoutineToolRendering(genericDefinition));
  return wrapForSelfShell(decorated as unknown as Record<string, unknown>) as unknown as ToolDefinition;
}

function installExpandBinding(): () => void {
  const previous = getKeybindings();
  const bindings: KeybindingsConfig = { "app.tools.expand": ["ctrl+o"] };
  setKeybindings(new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  }, bindings));
  return () => setKeybindings(previous);
}

function initializedTheme(): Theme {
  const theme = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("@earendil-works/pi-coding-agent:theme")
  ];
  if (!theme || typeof theme !== "object") throw new Error("Pi theme was not initialized");
  return theme as Theme;
}

function renderUi(requestRender: () => void): TUI {
  return { requestRender } as unknown as TUI;
}

function expectOneGlyph(lines: string[], glyph: "○" | "●" | "✗"): void {
  expect(glyphs(lines.join("\n"))).toEqual([glyph]);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
}

function expectNativeDiffForeground(calls: Array<[color: ThemeColor, text: string]>): void {
  expect(calls.map(([slot]) => slot)).toEqual(expect.arrayContaining([
    "toolDiffRemoved", "toolDiffAdded",
  ]));
}

describe("Edit state glyph production composition", () => {
  it("neutralizes pending/success/error backgrounds across Edit preview and repeated result renders", async () => {
    initTheme();
    const theme = initializedTheme();
    const bg = vi.spyOn(theme, "bg");
    const fg = vi.spyOn(theme, "fg");
    const restoreBinding = installExpandBinding();
    const directory = mkdtempSync(join(tmpdir(), "picc-edit-glyph-"));
    const filePath = "target.ts";
    const args = { path: filePath, edits: [{ oldText: "const before = 1;", newText: "const after = 2;" }] };
    let invalidations = 0;
    try {
      writeFileSync(join(directory, filePath), "const before = 1;\n");
      const native = createEditToolDefinition(directory);
      const row = new ToolExecutionComponent(
        "edit", "edit-glyph-contract", args, {}, productionDefinition(native),
        renderUi(() => { invalidations++; }), directory.replace(/\\/gu, "/"),
      );
      row.setArgsComplete();
      fg.mockClear();
      const pending = row.render(100);
      expectOneGlyph(pending, "○");
      expect(pending.map(stripAnsi).filter((line) => line.trim() === "")).toHaveLength(1);
      await waitUntil({
        predicate: () => invalidations >= 2,
        description: "Edit preview invalidation before lifecycle assertions",
      });
      const preview = row.render(100);
      expectOneGlyph(preview, "○");
      expect(stripAnsi(preview.join("\n"))).toContain("before");
      expect(stripAnsi(preview.join("\n"))).toContain("after");
      expect(preview.join("\n")).toContain("\u001b[");
      expectNativeDiffForeground(fg.mock.calls);

      fg.mockClear();
      row.updateResult({
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in target.ts." }],
        details: {
          diff: "-1 const before = 1;\n+1 const after = 2;",
          patch: "detached",
          firstChangedLine: 1,
        },
        isError: false,
      }, false);
      const collapsed = row.render(100);
      expectOneGlyph(collapsed, "●");
      expect(stripAnsi(collapsed.join("\n"))).toContain("Edit target.ts · 1 edit applied");
      expect(stripAnsi(collapsed.join("\n"))).not.toContain("const before");

      for (const expanded of [true, false, true]) {
        row.setExpanded(expanded);
        const lines = row.render(100);
        expectOneGlyph(lines, "●");
        if (expanded) {
          const plain = lines.map(stripAnsi);
          expect(plain.join("\n")).toContain("const before");
          expect(plain.join("\n")).toContain("const after");
          expect(plain.filter((line) => line.includes("const ")).every((line) => line.startsWith("  "))).toBe(true);
          expect(lines.join("\n")).toContain("\u001b[");
          expectNativeDiffForeground(fg.mock.calls);
        }
      }

      const failed = new ToolExecutionComponent(
        "edit", "edit-error-contract", args, {}, productionDefinition(createEditToolDefinition(directory)),
        renderUi(() => {}), directory.replace(/\\/gu, "/"),
      );
      failed.setArgsComplete();
      failed.render(100);
      failed.updateResult({
        content: [{ type: "text", text: "Edit failed visibly" }],
        isError: true,
      }, false);
      const error = failed.render(100);
      expectOneGlyph(error, "✗");
      expect(stripAnsi(error.join("\n"))).toContain("Edit failed visibly");

      expect(bg.mock.calls.filter(([slot]) =>
        slot === "toolPendingBg" || slot === "toolSuccessBg" || slot === "toolErrorBg"
      )).toEqual([]);
    } finally {
      fg.mockRestore();
      bg.mockRestore();
      restoreBinding();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains preview-failure refusal while keeping its elaborated Edit row background-free", async () => {
    initTheme();
    const bg = vi.spyOn(initializedTheme(), "bg");
    const restoreBinding = installExpandBinding();
    const directory = mkdtempSync(join(tmpdir(), "picc-edit-glyph-preview-failure-"));
    try {
      const args = { path: "missing.ts", edits: [{ oldText: "old", newText: "new" }] };
      const row = new ToolExecutionComponent(
        "edit", "edit-preview-failure", args, {},
        productionDefinition(createEditToolDefinition(directory)),
        renderUi(() => {}), directory.replace(/\\/gu, "/"),
      );
      row.setArgsComplete();
      row.render(100);
      await vi.waitFor(() => expect(stripAnsi(row.render(100).join("\n")))
        .toMatch(/ENOENT|no such file|could not/iu));
      row.updateResult({
        content: [{ type: "text", text: "Successfully replaced 1 block(s) in missing.ts." }],
        details: { diff: "-1 old\n+1 new", patch: "detached", firstChangedLine: 1 },
        isError: false,
      }, false);
      const lines = row.render(100);
      expectOneGlyph(lines, "●");
      expect(stripAnsi(lines.join("\n"))).toContain("Edit preview failed:");
      expect(stripAnsi(lines.join("\n"))).toContain("old");
      expect(bg.mock.calls.filter(([slot]) => String(slot).startsWith("tool") && String(slot).endsWith("Bg"))).toEqual([]);
    } finally {
      bg.mockRestore();
      restoreBinding();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps MultiEdit canonical data detached while collapsed and expanded delegated diffs use one glyph", async () => {
    initTheme();
    const theme = initializedTheme();
    const bg = vi.spyOn(theme, "bg");
    const fg = vi.spyOn(theme, "fg");
    const restoreBinding = installExpandBinding();
    try {
      const args = Object.freeze({
        file_path: "src/multi.ts",
        edits: Object.freeze([Object.freeze({ old_string: "old", new_string: "new" })]),
      });
      const content = Object.freeze([Object.freeze({
        type: "text", text: "Successfully applied 1 edit(s) to src/multi.ts.",
      })]);
      const details = Object.freeze({
        filePath: "src/multi.ts", edits: 1, created: false,
        diff: "-1 old\n+1 new", firstChangedLine: 1,
      });
      const result = Object.freeze({ content, details, isError: false });
      const multiEditDefinition = { ...createEditToolDefinition(process.cwd()), name: "MultiEdit" };
      const row = new ToolExecutionComponent(
        "MultiEdit", "multiedit-glyph-contract", args, {},
        productionDefinition(multiEditDefinition),
        renderUi(() => {}), process.cwd().replace(/\\/gu, "/"),
      );
      row.setArgsComplete();
      expectOneGlyph(row.render(100), "○");
      fg.mockClear();
      row.updateResult(result as unknown as Parameters<ToolExecutionComponent["updateResult"]>[0], false);
      const collapsed = row.render(100);
      expectOneGlyph(collapsed, "●");
      expect(stripAnsi(collapsed.join("\n"))).toContain("MultiEdit src/multi.ts · 1 edit applied");
      expect(stripAnsi(collapsed.join("\n"))).not.toContain("-1 old");

      row.setExpanded(true);
      const expanded = row.render(100);
      expectOneGlyph(expanded, "●");
      const plain = expanded.map(stripAnsi);
      expect(plain.join("\n")).toContain("old");
      expect(plain.join("\n")).toContain("new");
      expect(plain.filter((line) => line.includes("old") || line.includes("new"))
        .every((line) => line.startsWith("  "))).toBe(true);
      expect(content[0]?.text).toBe("Successfully applied 1 edit(s) to src/multi.ts.");
      expect(details.diff).toBe("-1 old\n+1 new");
      expectNativeDiffForeground(fg.mock.calls);
      expect(bg.mock.calls.filter(([slot]) => String(slot).startsWith("tool") && String(slot).endsWith("Bg"))).toEqual([]);
    } finally {
      fg.mockRestore();
      bg.mockRestore();
      restoreBinding();
    }
  });
});
