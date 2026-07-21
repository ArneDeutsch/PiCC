import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

let directory: string;
let pi: FakePi;
const originalCwd = process.cwd();
const originalUserDir = process.env.PICC_CLAUDE_USER_DIR;

beforeAll(async () => {
  directory = materializeFixture("full-surface");
  const userDir = path.join(directory, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(directory);
  pi = fakePi();
  picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
  await pi.waitForInitialization();
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = originalUserDir;
  cleanupFixture(directory);
});

describe("main-session routine rendering registration", () => {
  it.each([
    {
      name: "WebFetch",
      args: { url: "https://example.test/invoked" },
      result: {
        content: [{ type: "text", text: "registered fetch body" }],
        details: {
          url: "https://example.test/invoked",
          finalUrl: "https://redirect.test/final",
          status: 200,
          contentType: "text/plain",
          truncated: false,
        },
      },
      invocation: "https://example.test/invoked",
      hidden: "registered fetch body",
    },
    {
      name: "WebSearch",
      args: { query: "registered query" },
      result: {
        content: [{ type: "text", text: "registered search title and snippet" }],
        details: { query: "registered query", backend: "brave", resultCount: 1, truncated: false },
      },
      invocation: "registered query",
      hidden: "registered search title",
    },
  ])("registers $name through routine rendering before the outer self shell", ({ name, args, result, invocation, hidden }) => {
    const tool = pi.tools.get(name);
    expect(tool).toBeDefined();
    expect(tool.renderShell).toBe("self");
    expect(typeof tool.execute).toBe("function");
    expect(tool.renderCall(args, undefined, { args }).render(80)).toEqual([]);

    const lines = tool.renderResult(
      result,
      { expanded: false, isPartial: false },
      undefined,
      { args, isError: false },
    ).render(80) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(invocation);
    expect(lines.join("\n")).not.toContain(hidden);
  });

  it.each([
    { name: "Skill", args: { name: "deploy", arguments: "render-skill 7.1" }, invocation: "deploy — render-skill 7.1" },
    { name: "SlashCommand", args: { command: "/deploy render-slash 7.2" }, invocation: "/deploy render-slash 7.2" },
  ])("executes and compactly renders a real fixture $name activation without changing canonical content", async ({ name, args, invocation }) => {
    const tool = pi.tools.get(name);
    expect(tool).toBeDefined();
    expect(tool.renderCall(args, undefined, { args }).render(100)).toEqual([]);

    const result = await tool.execute(`activation-${name}`, args);
    expect(result.content[0].text).toContain("FS-SKILL-ARGS-BODY");
    const lines = tool.renderResult(
      result,
      { expanded: true, isPartial: false },
      undefined,
      { args, isError: false },
    ).render(100) as string[];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(invocation);
    expect(lines.join("\n")).not.toContain("FS-SKILL-ARGS-BODY");
  });
});
