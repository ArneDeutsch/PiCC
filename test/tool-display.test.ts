import fs from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { sanitizeDisplayText } from "../src/runtime/render-util.js";
import {
  escapeRepositoryDisplayCollision,
  formatDisplayPath,
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  isLivePreExecutionDisplayContext,
  resolveDisplayRoots,
  sanitizeInlineDisplay,
  semanticDisplayRow,
  type SemanticDisplayRowOptions,
} from "../src/runtime/tool-display.js";

describe("display-only tool helpers", () => {
  it("formats canonical names without changing their source values", () => {
    const names = ["WebFetch", "MultiEdit", "TaskOutput", "TodoWrite", "read"] as const;
    expect(names.map(formatToolDisplayName)).toEqual([
      "web fetch", "multi edit", "task output", "todo write", "read",
    ]);
    expect(names).toEqual(["WebFetch", "MultiEdit", "TaskOutput", "TodoWrite", "read"]);
  });

  it("classifies POSIX paths workspace-first without filesystem I/O", () => {
    const realpath = vi.spyOn(fs, "realpathSync");
    const stat = vi.spyOn(fs, "statSync");
    const roots = { workspace: "/repo/.worktrees/feature", repository: "/repo" };
    const cases = [
      ["/repo/.worktrees/feature", "."],
      ["/repo/.worktrees/feature/src/a.ts", "src/a.ts"],
      ["./src/../a.ts", "a.ts"],
      ["../feature-sibling/a.ts", "repo:.worktrees/feature-sibling/a.ts"],
      ["/repo/src/a.ts", "repo:src/a.ts"],
      ["/repo-sibling/a.ts", "/repo-sibling/a.ts"],
      ["../../external/a.ts", "repo:external/a.ts"],
    ] as const;
    for (const [input, expected] of cases) expect(formatDisplayPathFromRoots(input, roots)).toBe(expected);
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    realpath.mockRestore();
    stat.mockRestore();
  });

  it("handles Windows drive and UNC namespaces independently of the host", () => {
    const driveRoots = { workspace: "C:\\Repo\\worktree", repository: "C:\\Repo" };
    const uncRoots = { workspace: "\\\\server\\share\\repo\\worktree", repository: "\\\\server\\share\\repo" };
    const cases = [
      ["c:/repo/worktree/src/a.ts", driveRoots, "src\\a.ts"],
      ["C:\\Repo\\src\\a.ts", driveRoots, "repo:src\\a.ts"],
      ["C:\\RepoSibling\\a.ts", driveRoots, "C:\\RepoSibling\\a.ts"],
      ["D:\\outside\\a.ts", driveRoots, "D:\\outside\\a.ts"],
      ["\\\\SERVER\\SHARE\\repo\\worktree\\a.ts", uncRoots, "a.ts"],
      ["\\\\server\\share\\repo\\a.ts", uncRoots, "repo:a.ts"],
      ["\\\\server\\share2\\a.ts", uncRoots, "\\\\server\\share2\\a.ts"],
      ["/repo/a.ts", driveRoots, "/repo/a.ts"],
      ["C:\\repo\\a.ts", { workspace: "/repo", repository: "/repo" }, "C:\\repo\\a.ts"],
      ["\\root-relative\\a.ts", driveRoots, "\\root-relative\\a.ts"],
      ["/root-relative/a.ts", driveRoots, "/root-relative/a.ts"],
      ["\\share-relative\\a.ts", uncRoots, "\\share-relative\\a.ts"],
    ] as const;
    for (const [input, roots, expected] of cases) expect(formatDisplayPathFromRoots(input, roots)).toBe(expected);
  });

  it("marks repository fallback only when it differs from the workspace", () => {
    expect(formatDisplayPathFromRoots("/repo/src/a.ts", { workspace: "/repo", repository: "/repo" }))
      .toBe("src/a.ts");
    expect(formatDisplayPathFromRoots("/repo", { workspace: "/repo/worktree", repository: "/repo" }))
      .toBe("repo:.");
    expect(formatDisplayPathFromRoots("/repo/worktree/src/a.ts", {
      workspace: "/repo/worktree", repository: "/repo/worktree-copy",
    })).toBe("src/a.ts");
    expect(formatDisplayPathFromRoots("/repo/worktree-copy/src/a.ts", {
      workspace: "/repo/worktree", repository: "/repo/worktree-copy",
    })).toBe("repo:src/a.ts");
  });

  it("does not rebase relative input when no valid workspace exists and reserves generated repo markers", () => {
    expect(formatDisplayPathFromRoots("src/../a.ts", { repository: "/repo" })).toBe("src/../a.ts");
    expect(formatDisplayPathFromRoots("/repo/a.ts", { repository: "/repo" })).toBe("repo:a.ts");
    expect(formatDisplayPathFromRoots("relative.ts", { workspace: "relative", repository: "/repo" }))
      .toBe("relative.ts");
    expect(formatDisplayPathFromRoots("repo:literal.ts", { repository: "/repo" })).toBe("./repo:literal.ts");
    expect(formatDisplayPathFromRoots("repo:literal.ts", { workspace: "/workspace", repository: "/repo" }))
      .toBe("./repo:literal.ts");
    expect(escapeRepositoryDisplayCollision("repo:literal.ts")).toBe("./repo:literal.ts");
    expect(escapeRepositoryDisplayCollision("repo-generated-elsewhere")).toBe("repo-generated-elsewhere");
  });

  it.each([
    ["C:\\repo", "C:src\\a.ts"],
    ["C:\\repo", "D:other.txt"],
    ["/repo", "\\\\?\\C:\\repo\\a.ts"],
    ["C:\\repo", "\\\\.\\pipe\\name"],
    ["C:\\repo", "\\\\server"],
    ["C:\\repo", "//server"],
    ["C:\\repo", "\\??\\C:\\repo\\a.ts"],
    ["C:\\repo", "\\\\??\\C:\\repo\\a.ts"],
    ["C:\\repo", "\\\\\\??\\C:\\repo\\a.ts"],
    ["C:\\repo", "\\\\server\\..\\a.ts"],
    ["C:\\repo", "\\\\server\\bad:share\\a.ts"],
    ["C:\\repo", "\\\\server\\share:bad\\a.ts"],
  ])("leaves ambiguous, device, and malformed forms unchanged (%s, %s)", (root, input) => {
    expect(formatDisplayPathFromRoots(input, { workspace: root })).toBe(input);
  });

  it("keeps legacy workspace-only formatting while failing closed on ambiguity", () => {
    expect(formatDisplayPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(formatDisplayPath("..", "/repo/worktree")).toBe("/repo");
    expect(formatDisplayPath("C:src\\a.ts", "C:\\repo")).toBe("C:src\\a.ts");
  });

  it("classifies raw paths before sanitization and never deletes controls into path syntax", () => {
    const fixtures = [
      ["/repo/\u202E../safe.ts", "�../safe.ts"],
      ["/repo/src/\u2066..\u2069/a.ts", "src/�..�/a.ts"],
      ["/repo/src/colon\u200B:a.ts", "src/colon�:a.ts"],
      ["/repo/src/line\u2028separator.ts", "src/line�separator.ts"],
      ["/repo/src/slash\u0000/../a.ts", "src/a.ts"],
      ["/repo/\r../outside.ts", "�../outside.ts"],
    ] as const;
    for (const [input, expected] of fixtures) {
      const classified = formatDisplayPathFromRoots(input, { workspace: "/repo" });
      const safe = sanitizeInlineDisplay(classified);
      expect(safe).toBe(expected);
      expect(safe).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    }

    const adversarialInline = [
      ["\r../outside", "�../outside"],
      ["C\r:\\device", "C�:\\device"],
      ["\\\r\\?\\device", "\\�\\?\\device"],
      ["repo\r:..", "repo�:.."],
      ["\u2028../outside", "�../outside"],
    ] as const;
    for (const [input, expected] of adversarialInline) {
      const safe = sanitizeInlineDisplay(input);
      expect(safe).toBe(expected);
      expect(safe).not.toMatch(/^(?:\.\.?[/\\]|[A-Za-z]:|[/\\]{2}[?.][/\\]|repo:\.\.)/u);
    }
    expect(sanitizeInlineDisplay("a\u001b[31mb\u001b]0;title\u0007c\u009bd\u009de\u009cf\tg\u0085h"))
      .toBe("a�b�c��f�g�h");
    expect(sanitizeInlineDisplay("K:/secret")).toBe("K:/secret");
    const textCases = [
      ["crlf\r\nline", "crlf\nline"],
      ["lone\rreturn", "lone�return"],
      ["c0\u0001control", "c0�control"],
      ["c1\u0085control", "c1�control"],
      ["csi\u001b[31mred", "csi�red"],
      ["c1-csi\u009b31mred", "c1-csi�red"],
      ["osc\u001b]0;title\u0007body", "osc�body"],
      ["unterminated\u001b]0;title", "unterminated�"],
      ["format\u200bmark", "format�mark"],
      ["tab\tstop", "tab   stop"],
      ["separator\u2028line\u2029paragraph", "separator�line�paragraph"],
    ] as const;
    for (const [input, expected] of textCases) expect(sanitizeDisplayText(input, 16_384)).toBe(expected);
    expect(sanitizeDisplayText("first\r\nsecond\rthird\tlast", 16_384, true)).toBe("first�second�third last");
  });

  it("selects mutable workspace state only for the explicit live pre-execution pair", () => {
    const resolver = vi.fn(() => "/live/worktree");
    const liveContext = { cwd: "/context/worktree", argsComplete: true, executionStarted: false };
    expect(isLivePreExecutionDisplayContext(liveContext)).toBe(true);
    const live = resolveDisplayRoots(resolver, "/repo", liveContext);
    expect(live).toEqual({ workspace: "/live/worktree", repository: "/repo" });
    expect(Object.isFrozen(live)).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);

    for (const context of [
      { cwd: "/history/worktree", argsComplete: true, executionStarted: true },
      { cwd: "/incomplete/worktree", argsComplete: false, executionStarted: false },
      { cwd: "/missing/worktree" },
      { cwd: "/missing-start", argsComplete: true },
    ]) {
      expect(isLivePreExecutionDisplayContext(context)).toBe(false);
      expect(resolveDisplayRoots(resolver, "/repo", context)).toEqual({
        workspace: context.cwd, repository: "/repo",
      });
    }
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("falls back to supplied context cwd when the live resolver fails or is invalid", () => {
    const throwing = vi.fn(() => { throw new Error("unavailable"); });
    expect(resolveDisplayRoots(throwing, "relative-repository", {
      cwd: "C:\\context\\worktree", argsComplete: true, executionStarted: false,
    })).toEqual({ workspace: "C:\\context\\worktree" });
    expect(resolveDisplayRoots(() => "relative", "/repo", {
      cwd: "/context", argsComplete: true, executionStarted: false,
    })).toEqual({ workspace: "/context", repository: "/repo" });
  });
});

describe("semantic display rows", () => {
  const plainOptions = {
    action: "read",
    primary: "src/a.ts",
    required: [{ text: "lines 1-10", tone: "warning" as const }],
    optional: ["cached"],
    cue: "ctrl-o expand",
  };

  const stripSgr = (value: string): string => value.replace(/\u001b\[[0-9;]*m/gu, "");

  it("applies semantic theme slots and centered-dot separators independently", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const rendered = semanticDisplayRow(plainOptions, { fg }).render(200);
    expect(rendered).toEqual(["read src/a.ts · lines 1-10 · cached · ctrl-o expand"]);
    expect(fg.mock.calls).toEqual([
      ["text", "read"],
      ["accent", "src/a.ts"],
      ["muted", " · "],
      ["warning", "lines 1-10"],
      ["muted", " · "],
      ["muted", "cached"],
      ["muted", " · "],
      ["muted", "ctrl-o expand"],
    ]);
  });

  it.each([
    ["text", "text"],
    ["muted", "muted"],
    ["success", "success"],
    ["warning", "warning"],
    ["error", "error"],
    ["invalid runtime tone", "not-a-tone"],
  ] as const)("routes the %s required tone safely", (_name, tone) => {
    const fg = vi.fn((_color: string, text: string) => text);
    semanticDisplayRow({
      action: "row",
      required: [{ text: "evidence", tone: tone as never }],
    }, { fg }).render(80);
    expect(fg).toHaveBeenCalledWith(tone === "not-a-tone" ? "text" : tone, "evidence");
  });

  it("drops optional metadata before shortening the primary and preserves required evidence and cue", () => {
    const row = semanticDisplayRow({
      action: "read",
      primary: "abcdefghij",
      required: [{ text: "required", tone: "warning" }],
      optional: ["telemetry"],
      cue: "expand",
    }, undefined);
    expect(row.render(35)).toEqual(["read abcdefghij · required · expand"]);
    expect(row.render(31)).toEqual(["read abcde… · required · expand"]);
    expect(row.render(20)).toEqual(["read abc… · required", "expand"]);
  });

  it("uses full and compact configured cues at deterministic widths and recovers on widening", () => {
    const row = semanticDisplayRow({
      action: "read",
      primary: "src/a.ts",
      required: [{ text: "lines 1-10", tone: "warning" }],
      optional: ["cached"],
      cue: "ctrl+o to expand",
      compactCue: "ctrl+o",
    }, undefined);
    const tiny = row.render(7);
    expect(tiny).toHaveLength(1);
    expect(visibleWidth(tiny[0] ?? "")).toBeLessThanOrEqual(7);
    expect(row.render(8).map(stripSgr)).toEqual(["read · …", "ctrl+o"]);
    expect(row.render(15).map(stripSgr)).toEqual(["read · lines 1…", "ctrl+o"]);
    expect(row.render(16).map(stripSgr)).toEqual(["read · lines 1-…", "ctrl+o to expand"]);
    expect(row.render(200)).toEqual(["read src/a.ts · lines 1-10 · cached · ctrl+o to expand"]);
  });

  it("bounds zero, non-finite, fractional, tiny, wide, and combining-Unicode renders", () => {
    const row = semanticDisplayRow({
      action: "查阅",
      primary: "q\u0338werty",
      required: [{ text: "文件", tone: "muted" }],
      cue: "open",
    }, undefined);
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(row.render(width)).toEqual([""]);
    for (const width of [0.9, 1, 2, 7, 12.8, 80]) {
      const lines = row.render(width);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.floor(width));
    }
    expect(row.render(80)).toEqual(["查阅 q̸werty · 文件 · open"]);
  });

  it("inline-sanitizes terminal and format controls in every non-literal field", () => {
    const rendered = semanticDisplayRow({
      action: "re\u001b[31mad",
      primary: "file\u001b]0;title\u0007.ts",
      required: [{ text: "warn\u009b31mred", tone: "warning" }],
      optional: ["meta\rdata"],
      cue: "ctrl\u202E-o",
    }, undefined).render(200)[0] ?? "";
    expect(rendered).toBe("re�ad file�.ts · warn�red · meta�data · ctrl�-o");
    expect(rendered).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
  });

  it("snapshots bounded scalars and arrays before construction returns", () => {
    const required = [{ text: "required", tone: "warning" as const }];
    const optional = ["one", "two"];
    const row = semanticDisplayRow({
      action: "row", required, optional, cue: "cue",
    }, undefined);
    required[0]!.text = "changed";
    required.push({ text: "late", tone: "warning" });
    optional[0] = "changed";
    optional.push("late");
    const rendered = row.render(10_000)[0] ?? "";
    expect(rendered).toBe("row · required · one · two · cue");
    expect(rendered).not.toContain("changed");
    expect(rendered).not.toContain("late");

    const bounded = semanticDisplayRow({
      action: "row",
      required: Array.from({ length: 10 }, (_, index) => ({ text: `r${index}`, tone: "text" as const })),
      optional: Array.from({ length: 10 }, (_, index) => `o${index}`),
    }, undefined).render(10_000)[0] ?? "";
    expect(bounded).toContain("r9");
    expect(bounded).toContain("o5");
    expect(bounded).not.toContain("o6");
  });

  it.each([
    ["action", (value: string): SemanticDisplayRowOptions => ({ action: value })],
    ["primary", (value: string): SemanticDisplayRowOptions => ({ action: "", primary: value })],
    ["required", (value: string): SemanticDisplayRowOptions => ({
      action: "", required: [{ text: value, tone: "text" }],
    })],
    ["optional", (value: string): SemanticDisplayRowOptions => ({ action: "", optional: [value] })],
    ["cue", (value: string): SemanticDisplayRowOptions => ({ action: "", cue: value })],
    ["compact cue", (value: string): SemanticDisplayRowOptions => ({
      action: "long action", cue: "full cue does not fit", compactCue: value,
    })],
  ] as const)("applies the common scalar cap to %s", (_name, optionsFor) => {
    const value = `x${"\u0301".repeat(2_047)}TAIL`;
    const rendered = semanticDisplayRow(optionsFor(value), undefined).render(8).join("\n");
    expect(rendered).toContain(`x${"\u0301".repeat(2_047)}`);
    expect(rendered).not.toContain("TAIL");
  });

  it.each([
    ["missing", undefined],
    ["throwing", { fg: () => { throw new Error("theme failed"); } }],
    ["text-altering", { fg: () => "changed" }],
    ["unbalanced SGR", { fg: (_color: string, text: string) => `\u001b[31m${text}` }],
  ])("degrades a %s theme to unchanged plain text", (_name, theme) => {
    expect(semanticDisplayRow(plainOptions, theme).render(200)).toEqual([
      "read src/a.ts · lines 1-10 · cached · ctrl-o expand",
    ]);
  });

  it.each([
    ["foreground-only", (text: string) => `\u001b[31m${text}\u001b[39m`],
    ["balanced emphasis", (text: string) => `\u001b[1m${text}\u001b[22m`],
  ])("retains %s styling accepted by the shared theme boundary", (_name, style) => {
    const rendered = semanticDisplayRow(plainOptions, {
      fg: (_color: string, text: string) => style(text),
    }).render(200)[0] ?? "";
    expect(rendered).toContain("\u001b[");
    expect(stripSgr(rendered)).toBe("read src/a.ts · lines 1-10 · cached · ctrl-o expand");
  });
});
