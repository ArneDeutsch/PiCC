import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  applyUnicodeSafeProcessEnv,
  computeSessionScratchDir,
  toNativeSafeTempForm,
  unicodeSafeSubprocessEnv,
  type ScratchDirIo,
} from "../src/util/env.js";

describe("unicodeSafeSubprocessEnv", () => {
  it("sets Python UTF-8 defaults when unset", () => {
    const out = unicodeSafeSubprocessEnv({ PATH: "/usr/bin" });
    expect(out.PYTHONIOENCODING).toBe("utf-8");
    expect(out.PYTHONUTF8).toBe("1");
    expect(out.PATH).toBe("/usr/bin");
  });

  it("never overwrites an explicit value", () => {
    const out = unicodeSafeSubprocessEnv({ PYTHONIOENCODING: "latin-1", PYTHONUTF8: "0" });
    expect(out.PYTHONIOENCODING).toBe("latin-1");
    expect(out.PYTHONUTF8).toBe("0");
  });

  it("treats an empty-string value as unset", () => {
    const out = unicodeSafeSubprocessEnv({ PYTHONIOENCODING: "", PYTHONUTF8: "" });
    expect(out.PYTHONIOENCODING).toBe("utf-8");
    expect(out.PYTHONUTF8).toBe("1");
  });

  it("drops undefined values", () => {
    const out = unicodeSafeSubprocessEnv({ A: "1", B: undefined });
    expect(out.A).toBe("1");
    expect("B" in out).toBe(false);
  });

  it("merges a full process.env-shaped base and still injects the defaults", () => {
    // This is the exact call shape the spawn sites use: spread of process.env
    // (possibly with settings env merged on top) handed to the helper. Assert
    // the wiring-relevant outcome directly: existing vars survive untouched
    // and both Python defaults are present in the env given to the child.
    const base = { ...process.env, PROJECT_SETTING: "yes", PYTHONIOENCODING: undefined as never };
    const env = unicodeSafeSubprocessEnv(base);
    expect(env.PROJECT_SETTING).toBe("yes");
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8 === "1" || env.PYTHONUTF8 === process.env.PYTHONUTF8).toBe(true);
    for (const [k, v] of Object.entries(base)) {
      if (v !== undefined && k !== "PYTHONIOENCODING" && k !== "PYTHONUTF8") {
        expect(env[k]).toBe(v);
      }
    }
  });
});

// Table-driven, platform-injected (ungated on all OSes) — locks the #48
// regression: the win32 result is the forward-slash drive-letter form both the
// pinned Git Bash and the native Read/Grep/Glob tools resolve to the same real
// dir, and is NEVER a bare `/tmp/...`, NEVER leading-slash. Off-win32 the path is
// byte-for-byte unchanged.
describe("toNativeSafeTempForm", () => {
  it("win32: converts backslashes to forward slashes (drive-letter form)", () => {
    const out = toNativeSafeTempForm("C:\\Users\\A\\Temp", "win32");
    expect(out).toBe("C:/Users/A/Temp");
    // Anti-/tmp regression: drive-letter form, not a leading-slash mount path.
    expect(out).toMatch(/^[A-Za-z]:\//);
    expect(out.startsWith("/")).toBe(false);
  });

  it("win32: a realistic %LOCALAPPDATA%\\Temp scratch dir stays drive-anchored", () => {
    const out = toNativeSafeTempForm(
      "C:\\Users\\Arne\\AppData\\Local\\Temp\\picc-scratch-a1b2c3",
      "win32",
    );
    expect(out).toBe("C:/Users/Arne/AppData/Local/Temp/picc-scratch-a1b2c3");
    expect(out.startsWith("/")).toBe(false);
  });

  it("linux: returns the path unchanged", () => {
    expect(toNativeSafeTempForm("/tmp/x", "linux")).toBe("/tmp/x");
  });

  it("darwin: returns the path unchanged", () => {
    expect(toNativeSafeTempForm("/var/folders/x", "darwin")).toBe("/var/folders/x");
  });

  it("win32: idempotent — applying twice equals applying once", () => {
    const once = toNativeSafeTempForm("C:\\Users\\A\\Temp", "win32");
    const twice = toNativeSafeTempForm(once, "win32");
    expect(twice).toBe(once);
  });

  it("defaults platform to process.platform", () => {
    const input = process.platform === "win32" ? "C:\\a\\b" : "/a/b";
    const expected = toNativeSafeTempForm(input, process.platform);
    expect(toNativeSafeTempForm(input)).toBe(expected);
  });
});

describe("computeSessionScratchDir (index.ts computation seam — revert-catcher)", () => {
  // A backslash-joining stub so the win32 root-selection path is exercised on any host.
  const winJoin = (a: string, b: string) => `${a}\\${b}`;

  function io(overrides: Partial<ScratchDirIo> & Pick<ScratchDirIo, "mkdtemp" | "realpath">): ScratchDirIo {
    return {
      env: {},
      tmpdir: () => "C:\\Fallback\\Temp",
      join: winJoin,
      platform: "win32",
      ...overrides,
    };
  }

  it("(a) CLAUDE_CODE_TMPDIR wins over tmpdir() — RED if the env knob honoring is removed", () => {
    let seenPrefix = "";
    computeSessionScratchDir(
      io({
        env: { CLAUDE_CODE_TMPDIR: "D:\\Relocated" },
        tmpdir: () => "C:\\Fallback\\Temp",
        mkdtemp: (prefix) => {
          seenPrefix = prefix;
          return `${prefix}XYZ`;
        },
        realpath: (p) => p,
      }),
    );
    // The mkdtemp template must be rooted at CLAUDE_CODE_TMPDIR, not os.tmpdir().
    expect(seenPrefix).toBe("D:\\Relocated\\picc-scratch-");
    expect(seenPrefix).not.toContain("Fallback");
  });

  it("(a') falls back to tmpdir() when CLAUDE_CODE_TMPDIR is unset", () => {
    let seenPrefix = "";
    computeSessionScratchDir(
      io({
        env: {},
        tmpdir: () => "C:\\Fallback\\Temp",
        mkdtemp: (prefix) => {
          seenPrefix = prefix;
          return `${prefix}XYZ`;
        },
        realpath: (p) => p,
      }),
    );
    expect(seenPrefix).toBe("C:\\Fallback\\Temp\\picc-scratch-");
  });

  it("(b)+(c) win32: realpath is applied BEFORE the slash-transform — RED if the order is swapped", () => {
    // mkdtemp yields a RAW (possibly short/symlinked) path; realpath canonicalizes to
    // a DIFFERENT REAL path. Both are backslash form.
    const raw = "C:\\Fallback\\Temp\\picc-scratch-RAW";
    const real = "C:\\Fallback\\Temp\\picc-scratch-REAL";
    let realpathArg = "";
    const result = computeSessionScratchDir(
      io({
        env: {},
        mkdtemp: () => raw,
        realpath: (p) => {
          realpathArg = p;
          return real;
        },
      }),
    );
    // realpath must receive the RAW backslash mkdtemp output — if the transform ran
    // first it would receive the forward-slash "C:/…/RAW" instead.
    expect(realpathArg).toBe(raw);
    // Final value is realpath's REAL output, forward-slashed (win32 form). Order swap
    // would instead yield the backslash REAL path (no transform after realpath) or the
    // RAW segment — this single assertion catches both the order swap and a missing
    // win32 transform.
    expect(result).toBe("C:/Fallback/Temp/picc-scratch-REAL");
    expect(result).not.toContain("\\");
    expect(result).not.toContain("RAW");
  });

  it("non-win32: realpath output is returned unchanged (no slash transform)", () => {
    const result = computeSessionScratchDir({
      env: {},
      tmpdir: () => "/tmp",
      join: (a, b) => `${a}/${b}`,
      platform: "linux",
      mkdtemp: (prefix) => `${prefix}raw`,
      realpath: () => "/tmp/picc-scratch-real",
    });
    expect(result).toBe("/tmp/picc-scratch-real");
  });
});

describe("applyUnicodeSafeProcessEnv", () => {
  const savedIO = process.env.PYTHONIOENCODING;
  const savedUTF8 = process.env.PYTHONUTF8;
  afterEach(() => {
    if (savedIO === undefined) delete process.env.PYTHONIOENCODING;
    else process.env.PYTHONIOENCODING = savedIO;
    if (savedUTF8 === undefined) delete process.env.PYTHONUTF8;
    else process.env.PYTHONUTF8 = savedUTF8;
  });

  it("sets process env defaults without overwriting", () => {
    delete process.env.PYTHONIOENCODING;
    process.env.PYTHONUTF8 = "0";
    applyUnicodeSafeProcessEnv();
    expect(process.env.PYTHONIOENCODING).toBe("utf-8");
    expect(process.env.PYTHONUTF8).toBe("0");
  });

  it("sets both defaults when neither is present", () => {
    delete process.env.PYTHONIOENCODING;
    delete process.env.PYTHONUTF8;
    applyUnicodeSafeProcessEnv();
    expect(process.env.PYTHONIOENCODING).toBe("utf-8");
    expect(process.env.PYTHONUTF8).toBe("1");
  });
});

// End-to-end proof: Python prints U+2192 without a UnicodeEncodeError when the
// env carries our defaults. Skips gracefully if python isn't on PATH.
// NOTE: on modern Python (UTF-8 mode default, PEP 686) the print alone would
// succeed regardless, so the test additionally asserts the injected env vars
// are what the child actually sees — that part can never pass vacuously.
describe("python emits Unicode cleanly with the defaults", () => {
  const python = (() => {
    for (const cand of ["python", "python3", "py"]) {
      try {
        execFileSync(cand, ["--version"], { stdio: "ignore" });
        return cand;
      } catch {
        /* try next */
      }
    }
    return undefined;
  })();

  it.skipIf(!python)("prints the arrow character and sees the injected env", () => {
    const env = unicodeSafeSubprocessEnv({
      ...process.env,
      PYTHONIOENCODING: undefined as never,
      PYTHONUTF8: undefined as never,
    });
    // The env built for the child must carry the defaults (non-vacuous check).
    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
    const out = execFileSync(
      python!,
      [
        "-c",
        "import os,sys; print('a\\u2192b'); print('io=' + os.environ.get('PYTHONIOENCODING','')); print('enc=' + sys.stdout.encoding)",
      ],
      { env, encoding: "utf8" },
    );
    expect(out).toContain("a→b");
    // The child process observed the injected variable...
    expect(out).toContain("io=utf-8");
    // ...and its stdout encoding is UTF-8 because of it.
    expect(out.toLowerCase()).toMatch(/enc=utf-?8/);
  });
});
