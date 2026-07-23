import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { sanitize } from "../src/runtime/default-collapsed-tool-render.js";
import {
  formatDisplayPath,
  formatDisplayPathFromRoots,
  formatToolDisplayName,
  isLivePreExecutionDisplayContext,
  resolveDisplayRoots,
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

  it("does not rebase relative input when no valid workspace exists", () => {
    expect(formatDisplayPathFromRoots("src/../a.ts", { repository: "/repo" })).toBe("src/../a.ts");
    expect(formatDisplayPathFromRoots("/repo/a.ts", { repository: "/repo" })).toBe("repo:a.ts");
    expect(formatDisplayPathFromRoots("relative.ts", { workspace: "relative", repository: "/repo" }))
      .toBe("relative.ts");
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
      const safe = sanitize(classified, 16_384, true);
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
      const safe = sanitize(input, 16_384, true);
      expect(safe).toBe(expected);
      expect(safe).not.toMatch(/^(?:\.\.?[/\\]|[A-Za-z]:|[/\\]{2}[?.][/\\]|repo:\.\.)/u);
    }
    expect(sanitize("first\nsecond\rthird", 16_384)).toBe("first\nsecond�third");
    expect(sanitize("first\nsecond\rthird", 16_384, true)).toBe("first�second�third");
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
