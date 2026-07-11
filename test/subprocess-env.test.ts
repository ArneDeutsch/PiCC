import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { applyUnicodeSafeProcessEnv, unicodeSafeSubprocessEnv } from "../src/util/env.js";

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
