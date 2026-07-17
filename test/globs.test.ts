import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  createGlobMatcher,
  escapeGlobPath,
  matchesAny,
  normalizeDrivePath,
  normalizeSlashes,
} from "../src/util/globs.js";

// Build absolute paths through path.resolve so bases behave identically on
// Windows and POSIX runners.
const abs = (...segs: string[]) => normalizeSlashes(path.resolve(...segs));

describe("createGlobMatcher: core ** semantics", () => {
  const base = path.resolve("proj");

  it("anchored src/** matches at any depth under base only", () => {
    const m = createGlobMatcher(["src/**"], { base });
    expect(m(abs(base, "src/a.ts"))).toBe(true);
    expect(m(abs(base, "src/deep/nested/b.ts"))).toBe(true);
    expect(m(abs(base, "lib/a.ts"))).toBe(false);
    expect(m(abs(base, "other/src/a.ts"))).toBe(false);
  });

  it("** crosses directory boundaries in the middle of a pattern", () => {
    const m = createGlobMatcher(["src/**/test/*.ts"], { base });
    expect(m(abs(base, "src/a/b/test/x.ts"))).toBe(true);
    expect(m(abs(base, "src/test/x.ts"))).toBe(true);
    expect(m(abs(base, "src/test/sub/x.ts"))).toBe(false);
  });

  it("bare *.md matches by basename at any depth", () => {
    const m = createGlobMatcher(["*.md"], { base });
    expect(m(abs(base, "README.md"))).toBe(true);
    expect(m(abs(base, "docs/deep/notes.md"))).toBe(true);
    expect(m(abs(base, "docs/notes.txt"))).toBe(false);
  });

  it("dotfiles are matched (dot: true)", () => {
    const m = createGlobMatcher([".env"], { base });
    expect(m(abs(base, "a/b/.env"))).toBe(true);
    expect(m(abs(base, "a/b/.envrc"))).toBe(false);
  });
});

describe("createGlobMatcher: base paths with glob metacharacters", () => {
  it("matches when the base contains parentheses (Program Files (x86) style)", () => {
    const base = path.resolve("Program Files (x86)", "proj");
    const m = createGlobMatcher(["src/**"], { base });
    expect(m(abs(base, "src/a.ts"))).toBe(true);
    expect(m(abs(base, "lib/a.ts"))).toBe(false);
  });

  it("matches when the base contains brackets and plus signs", () => {
    const base = path.resolve("work [copy] + backup", "proj (1)");
    const m = createGlobMatcher(["secrets/**"], { base });
    expect(m(abs(base, "secrets/key.pem"))).toBe(true);
    expect(m(abs(base, "public/key.pem"))).toBe(false);
  });

  it("deny-rule shape: cwd-prefixed absolute pattern with metachar cwd (permissions.ts:210 shape)", () => {
    const base = path.resolve("OneDrive - Corp (2)", "proj");
    // permissions.ts prepends the resolved cwd onto `/path` specifiers; the
    // engine must treat that literal prefix as a path, not glob syntax.
    const pattern = `${normalizeSlashes(base)}/secrets/**`;
    const m = createGlobMatcher([pattern], { base });
    expect(m(abs(base, "secrets/key.pem"))).toBe(true);
    expect(m(abs(base, "src/ok.ts"))).toBe(false);
  });

  it("home expansion with metacharacters in the home path", () => {
    const home = path.resolve("Users", "Arne (2)");
    const m = createGlobMatcher(["~/secrets/**"], { home });
    expect(m(abs(home, "secrets/token"))).toBe(true);
    expect(m(abs(home, "public/token"))).toBe(false);
  });

  it("matchesAny with a parenthesized base", () => {
    const base = path.resolve("proj (1)");
    expect(matchesAny("vendor/CLAUDE.md", ["vendor/**"], base)).toBe(true);
    expect(matchesAny("src/CLAUDE.md", ["vendor/**"], base)).toBe(false);
  });
});

describe("createGlobMatcher: Windows path handling", () => {
  const base = path.resolve("proj");

  it("normalizes backslash candidate paths", () => {
    const m = createGlobMatcher(["src/**"], { base });
    const backslashed = abs(base, "src/a.ts").replace(/\//g, "\\");
    expect(m(backslashed)).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("is case-insensitive on Windows", () => {
    const m = createGlobMatcher(["src/**"], { base });
    expect(m(abs(base, "src/a.ts").toUpperCase())).toBe(true);
    const m2 = createGlobMatcher(["SRC/**"], { base });
    expect(m2(abs(base, "src/a.ts"))).toBe(true);
  });

  it("opts.nocase forces the Windows case behavior on any platform", () => {
    const insensitive = createGlobMatcher(["src/**"], { base, nocase: true });
    expect(insensitive(abs(base, "SRC/A.TS"))).toBe(true);
    const sensitive = createGlobMatcher(["src/**"], { base, nocase: false });
    expect(sensitive(abs(base, "SRC/A.TS"))).toBe(false);
    expect(sensitive(abs(base, "src/a.ts"))).toBe(true);
  });
});

describe("createGlobMatcher: drive normalization (D2, platform-independent)", () => {
  it("normalizeDrivePath canonicalizes drive-lettered paths", () => {
    expect(normalizeDrivePath("C:\\Users\\x")).toBe("/c/Users/x");
    expect(normalizeDrivePath("d:/data/y")).toBe("/d/data/y");
    expect(normalizeDrivePath("C:/")).toBe("/c/");
    expect(normalizeDrivePath("/etc/x")).toBe("/etc/x");
    expect(normalizeDrivePath("rel\\a")).toBe("rel/a");
  });

  it("//c/** patterns match drive-lettered candidates in any flavor", () => {
    const m = createGlobMatcher(["//c/**/.env"]);
    expect(m("C:\\proj\\.env")).toBe(true);
    expect(m("C:/proj/deep/.env")).toBe(true);
    expect(m("D:\\proj\\.env")).toBe(false);
  });

  it("drive-lettered patterns match backslash candidates case-insensitively", () => {
    const m = createGlobMatcher(["C:/proj/**"]);
    expect(m("C:\\proj\\x.txt")).toBe(true);
    expect(m("c:\\PROJ\\X.TXT")).toBe(true);
    expect(m("D:\\proj\\x.txt")).toBe(false);
  });

  it("a drive-lettered base anchors relative patterns for drive-lettered candidates", () => {
    // path.resolve is bypassed for absolute-like candidates, so this works on
    // POSIX runners too once base and candidate normalize to the same space.
    const m = createGlobMatcher(["src/**"], { base: "C:\\proj" });
    expect(m("C:\\proj\\src\\a.ts")).toBe(true);
    expect(m("C:\\proj\\lib\\a.ts")).toBe(false);
  });
});

describe("createGlobMatcher: UNC path patterns", () => {
  it("//server/share/** matches UNC candidates in either slash flavor", () => {
    const m = createGlobMatcher(["//server/share/**"]);
    expect(m("\\\\server\\share\\x.env")).toBe(true);
    expect(m("//server/share/deep/x.env")).toBe(true);
    expect(m("\\\\other\\share\\x.env")).toBe(false);
  });

  it("deny-rule shape: a UNC pattern with a wildcard tail matches nested UNC files", () => {
    const m = createGlobMatcher(["//server/share/**/.env"]);
    expect(m("\\\\server\\share\\proj\\.env")).toBe(true);
    expect(m("\\\\server\\share\\.env")).toBe(true);
    expect(m("\\\\server\\share\\proj\\config.ts")).toBe(false);
  });

  it("a trailing-slash UNC pattern matches the share's contents", () => {
    const m = createGlobMatcher(["//server/share/"]);
    expect(m("\\\\server\\share\\a\\b.txt")).toBe(true);
    expect(m("\\\\server\\other\\a\\b.txt")).toBe(false);
  });

  it("a non-drive // pattern still matches the fs-root absolute form (POSIX behavior unchanged) AND its UNC form", () => {
    const m = createGlobMatcher(["//etc/passwd"]);
    expect(m("/etc/passwd")).toBe(true); // fs-root anchor, as before
    expect(m("\\\\etc\\passwd")).toBe(true); // UNC form of the same absolute pattern
    expect(m("/home/etc/passwd")).toBe(false);
  });

  it("//**/x (any absolute) matches drive paths, POSIX-root paths, AND UNC paths", () => {
    const m = createGlobMatcher(["//**/.env"]);
    expect(m("C:\\proj\\.env")).toBe(true);
    expect(m("/srv/app/.env")).toBe(true);
    expect(m("\\\\server\\share\\proj\\.env")).toBe(true);
    expect(m("C:\\proj\\.envrc")).toBe(false);
  });

  it("//c/** keeps its drive semantics and does not match a UNC server of another name", () => {
    const m = createGlobMatcher(["//c/**/.env"]);
    expect(m("C:\\proj\\.env")).toBe(true);
    expect(m("\\\\corp\\share\\.env")).toBe(false);
  });
});

describe("createGlobMatcher: gitignore-style directory patterns", () => {
  const base = path.resolve("proj");

  it("a bare directory name matches everything inside it", () => {
    const m = createGlobMatcher(["dist"], { base });
    expect(m(abs(base, "dist/app.js"))).toBe(true);
    expect(m(abs(base, "packages/a/dist/deep/app.js"))).toBe(true);
    // ...and a plain file with that exact name.
    expect(m(abs(base, "sub/dist"))).toBe(true);
    expect(m(abs(base, "distribution/app.js"))).toBe(false);
  });

  it("claudeMdExcludes shape: [\"vendor\"] excludes vendor/CLAUDE.md", () => {
    expect(matchesAny("vendor/CLAUDE.md", ["vendor"], base)).toBe(true);
    expect(matchesAny("src/CLAUDE.md", ["vendor"], base)).toBe(false);
  });

  it("a trailing-slash pattern is NOT anchored and matches nested dirs", () => {
    const m = createGlobMatcher(["build/"], { base });
    expect(m(abs(base, "build/out.js"))).toBe(true);
    expect(m(abs(base, "packages/a/build/deep/out.js"))).toBe(true);
    expect(m(abs(base, "buildings/out.js"))).toBe(false);
  });

  it("a multi-segment trailing-slash pattern stays anchored", () => {
    const m = createGlobMatcher(["foo/bar/"], { base });
    expect(m(abs(base, "foo/bar/x.txt"))).toBe(true);
    expect(m(abs(base, "other/foo/bar/x.txt"))).toBe(false);
  });
});

describe("createGlobMatcher: anchors and path resolution", () => {
  it("relative candidate paths are resolved against base", () => {
    const base = path.resolve("proj");
    const m = createGlobMatcher(["src/**"], { base });
    expect(m("src/a.ts")).toBe(true);
    expect(m("lib/a.ts")).toBe(false);
  });

  it("`//` anchors to the filesystem root", () => {
    const m = createGlobMatcher(["//etc/passwd"]);
    expect(m("/etc/passwd")).toBe(true);
    expect(m("/home/etc/passwd")).toBe(false);
  });

  it("absolute patterns outside base still match directly", () => {
    const other = abs("elsewhere");
    const m = createGlobMatcher([`${other}/logs/**`], { base: path.resolve("proj") });
    expect(m(`${other}/logs/x.log`)).toBe(true);
    expect(m(abs("proj", "logs/x.log"))).toBe(false);
  });

  it("`./`-prefixed patterns anchor like plain relative patterns", () => {
    const base = path.resolve("proj");
    const m = createGlobMatcher(["./src/**"], { base });
    expect(m(abs(base, "src/a.ts"))).toBe(true);
    expect(m(abs(base, "lib/a.ts"))).toBe(false);
  });

  it("empty and whitespace patterns never match", () => {
    const m = createGlobMatcher(["", "   "], { base: path.resolve("proj") });
    expect(m(abs("proj", "anything"))).toBe(false);
  });

  it("exposes the original pattern list", () => {
    const m = createGlobMatcher(["a/**", "*.md"]);
    expect(m.patterns).toEqual(["a/**", "*.md"]);
  });
});

describe("escapeGlobPath", () => {
  it("escapes picomatch metacharacters so paths match literally", () => {
    const escaped = escapeGlobPath("C:/Program Files (x86)/proj [v2]+x");
    expect(escaped).toBe("C:/Program Files \\(x86\\)/proj \\[v2\\]\\+x");
  });
});
