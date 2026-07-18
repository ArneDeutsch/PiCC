import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Source-text pins for a NON-FUNCTIONAL requirement with no cheaper behavioral
 * proxy: the built-in `read` factory and its detection helpers must NOT eagerly
 * pull in Pi's image/Photon machinery (or the notebook renderer, which itself
 * imports the Pi package root). That machinery, when imported onto the
 * read-factory hot path — a path every session and every dispatched subagent
 * walks at build time — deadlocks fork-heavy test contexts. The fix keeps those
 * imports dynamic (`await import(...)` inside the branch that actually needs
 * them). A revert to eager static imports would only surface as a fragile
 * full-suite HANG; these are mechanism-level change-detectors that fail fast and
 * loud instead. Assert on the source text, since a hang can't be asserted on.
 */

function srcText(relFromSrcRuntime: string): Promise<string> {
  return readFile(
    fileURLToPath(new URL(`../src/runtime/${relFromSrcRuntime}`, import.meta.url)),
    "utf-8",
  );
}

describe("read hot-path lazy-import pins", () => {
  it("builtin-tools.ts imports notebook-render dynamically, never as a static top-level import", async () => {
    const source = await srcText("builtin-tools.ts");
    // No static `import ... from "./notebook-render..."` anywhere.
    expect(
      /^\s*import\b[^\n]*\bfrom\s+["']\.\/notebook-render/m.test(source),
      "builtin-tools.ts must not statically import ./notebook-render (it would eager-load Pi's package root onto the read-factory hot path)",
    ).toBe(false);
    // And it must still lazy-import it inside the notebook branch.
    expect(source).toContain('await import("./notebook-render.js")');
  });

  it("image-ingest.ts imports Pi's image machinery dynamically, never as a static top-level import", async () => {
    const source = await srcText("image-ingest.ts");
    // No static import of convertToPng/resizeImage from the Pi package.
    expect(
      /^\s*import\b[^\n]*\b(?:convertToPng|resizeImage)\b[^\n]*\bfrom\s+["']@earendil-works\/pi-coding-agent["']/m.test(
        source,
      ),
      "image-ingest.ts must not statically import convertToPng/resizeImage from @earendil-works/pi-coding-agent (it deadlocks fork-heavy contexts)",
    ).toBe(false);
    // And it must still lazy-import them inside toImageContent.
    expect(source).toContain('await import("@earendil-works/pi-coding-agent")');
  });
});
