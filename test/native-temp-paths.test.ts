import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { resolveShellBinary } from "../src/engine/shell-inject.js";
import { toNativeSafeTempForm } from "../src/util/env.js";

/**
 * #48 acceptance witness: the real mixed-tool route on Windows. A UTF-8 payload
 * written THROUGH PiCC's pinned Git Bash (POSIX-emulation shell) to a path in
 * `toNativeSafeTempForm` form must be read by the REAL native Pi Read tool on the
 * FIRST attempt, with byte-identical content.
 *
 * The defect this guards was a string-interpretation mismatch: the Bash tool and
 * the native Node file tools resolved the SAME `/tmp/...` string to two different
 * real files, so the first `Read` hit ENOENT and the model burned context on a
 * drive-wide recovery search. Testing either side alone cannot reproduce it —
 * only the shell-write → native-read handoff does.
 *
 * Gating: this genuinely EXECUTES on CI's `windows-latest` leg (which ships Git
 * for Windows), where it is the sole automated #48 witness. It skips cleanly
 * (green, not failed) on Linux/macOS (one shared namespace, no defect) and on any
 * Windows box lacking Git Bash. CAVEAT: if the `windows-latest` image ever drops
 * Git Bash, this skips green with NO signal — the witness would silently vanish.
 *
 * `hasBash` is probed once from the extension's OWN Git Bash resolution
 * (`resolveShellBinary`, which skips the System32 WSL stub), so it probes exactly
 * the binary the harness Bash tool spawns. Mirrors the BASH_AVAILABLE idiom in
 * test/e2e-live-pi.test.ts.
 */
const hasBash = (() => {
  try {
    execFileSync(resolveShellBinary("bash"), ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// Non-ASCII payload: a UTF-8 correctness nod (the Bash-tool redirect writes UTF-8,
// complementary to the established anti-UTF-16 encoding discipline) on top of the
// path-resolution contract this test primarily proves.
const PAYLOAD = "hello from git bash — native-safe temp path ✓ café Ω 日本語";

describe("native-safe temp paths: Git Bash write → native Read (first attempt)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it.skipIf(process.platform !== "win32" || !hasBash)(
    "reads a Bash-written UTF-8 file addressed in toNativeSafeTempForm on the first try",
    async () => {
      // Own scratch dir. realpath first, matching the production sequence in
      // src/index.ts (GitHub runners' os.tmpdir() can hand back an 8.3 short form).
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "picc-native-temp-")));

      // The harness form: forward-slash, drive-letter path both namespaces resolve
      // to the same real file. This is what the contract prescribes a skill hand off.
      const safeDir = toNativeSafeTempForm(dir, "win32");
      const filePath = `${safeDir}/payload.txt`;

      // Write side: spawn the REAL pinned Git Bash and redirect the UTF-8 payload
      // into the file. execFileSync guarantees the write process fully EXITS (file
      // flushed, no lingering open handle → no Windows share violation) before the
      // read runs. `printf %s` avoids a trailing newline so the compare is exact.
      execFileSync(
        resolveShellBinary("bash"),
        ["-c", `printf %s "$1" > "$2"`, "bash", PAYLOAD, filePath],
        { stdio: "ignore" },
      );

      // Read side: the REAL native Pi Read tool, wired exactly as src/index.ts does
      // — the factory takes a cwd STRING (not a thunk). 5-arg execute shape per
      // test/search-tools-rg.test.ts.
      // The pinned SDK read schema destructures `path`; Claude's tool surface names
      // it `file_path` (the SDK renderers accept that alias). Pass both so the call
      // matches the real execute param and documents the naming bridge.
      const CTX = {} as never;
      const tool = createReadTool(dir);
      const res = await tool.execute(
        "t03-read",
        { path: filePath, file_path: filePath },
        undefined,
        undefined,
        CTX,
      );

      // First-attempt success: no retry, no drive-wide search. Byte-identical UTF-8.
      const text = (res.content[0] as { type: string; text: string }).text;
      expect(text).toContain(PAYLOAD);
    },
  );
});
