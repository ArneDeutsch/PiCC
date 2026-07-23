import { describe, expect, it } from "vitest";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { withCompactSearchRendering } from "../src/runtime/search-tool-render.js";

interface Component {
  render(width: number): string[];
}

interface RenderDefinition {
  execute: unknown;
  renderResult: unknown;
  renderCall(args: unknown, theme: unknown, context: unknown): Component;
}

describe("real Pi stock-search rendering contract", () => {
  it("pins the grep/find/ls input fields PiCC consumes", () => {
    const cases = [
      [createGrepToolDefinition("/repo"), ["pattern", "path", "glob", "limit"]],
      [createFindToolDefinition("/repo"), ["pattern", "path", "limit"]],
      [createLsToolDefinition("/repo"), ["path", "limit"]],
    ] as const;
    for (const [definition, fields] of cases) {
      const properties = (definition.parameters as { properties: Record<string, unknown> }).properties;
      for (const field of fields) expect(properties).toHaveProperty(field);
    }
  });

  it("specializes only the call hierarchy and preserves Pi's execute and result renderers", () => {
    const cases = [
      {
        definition: createGrepToolDefinition("/repo"), args: { pattern: "needle", path: "/repo/src", glob: "*.ts", limit: 5 },
        primary: "needle", metadata: ["in src", "glob “*.ts”", "limit 5"],
      },
      {
        definition: createFindToolDefinition("/repo"), args: { pattern: "**/*.ts", path: "/repo/src", limit: 5 },
        primary: "**/*.ts", metadata: ["in src", "limit 5"],
      },
      {
        definition: createLsToolDefinition("/repo"), args: { path: "/repo/src", limit: 5 },
        primary: "src", metadata: ["limit 5"],
      },
    ] as const;

    for (const { definition, args, primary, metadata } of cases) {
      const decorated = withCompactSearchRendering(definition as unknown as ToolDefinition, {
        resolveDisplayRoot: () => "/repo",
        repositoryRoot: "/repo",
      }) as unknown as RenderDefinition;
      expect(decorated.execute).toBe(definition.execute);
      expect(decorated.renderResult).toBe(definition.renderResult);
      expect(decorated.renderCall).not.toBe(definition.renderCall);

      const calls: Array<{ slot: string; text: string }> = [];
      const theme = { fg(slot: string, text: string) { calls.push({ slot, text }); return text; } };
      const line = decorated.renderCall(args, theme, {
        args, state: {}, cwd: "/repo", argsComplete: true, executionStarted: false,
      }).render(120).join(" ");
      expect(line).toContain(primary);
      expect(calls.some((call) => call.slot === "accent" && call.text.includes(primary))).toBe(true);
      for (const fragment of metadata) {
        expect(line).toContain(fragment);
        expect(calls.some((call) => call.slot === "muted" && call.text.includes(fragment))).toBe(true);
      }
    }
  });
});
