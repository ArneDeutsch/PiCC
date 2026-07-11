import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { applyUnicodeSafeProcessEnv, unicodeSafeSubprocessEnv } from "../src/util/env.js";
import { resolveShellBinary } from "../src/engine/shell-inject.js";

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

  it("drops undefined values", () => {
    const out = unicodeSafeSubprocessEnv({ A: "1", B: undefined });
    expect(out.A).toBe("1");
    expect("B" in out).toBe(false);
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
});

// End-to-end proof: Python prints U+2192 without a UnicodeEncodeError when the
// env carries our defaults. Skips gracefully if python isn't on PATH.
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

  it.skipIf(!python)("prints the arrow character", () => {
    const env = unicodeSafeSubprocessEnv({ ...process.env, PYTHONIOENCODING: undefined as never });
    const out = execFileSync(python!, ["-c", "print('a\\u2192b')"], {
      env,
      encoding: "utf8",
    });
    expect(out).toContain("a→b");
  });
});
