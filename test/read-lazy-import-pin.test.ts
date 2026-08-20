import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isCallExpression,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isStringLiteral,
  isStringLiteralLikeNode,
  SyntaxKind,
  type FunctionLikeDeclaration,
  type Node,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { describe, expect, it } from "vitest";

/**
 * Source pins for a NON-FUNCTIONAL requirement with no cheaper behavioral
 * proxy: the built-in `read` factory must not eagerly load the notebook renderer,
 * and its detection helpers must not acquire the runtime-host fallback graph.
 * Supported bootstraps have already installed the coding-agent graph, but a
 * direct implementation/module import reaches the fallback; keeping the bridge
 * import inside image normalization prevents that path from acquiring Pi's
 * image/Photon machinery during Read detection. Regressions otherwise surface
 * as fragile full-suite hangs in fork-heavy contexts, so these syntax-level
 * change detectors fail fast instead.
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

  it("image-ingest.ts acquires the runtime bridge only inside image normalization", () => {
    const imageIngestPath = fileURLToPath(new URL("../src/runtime/image-ingest.ts", import.meta.url));
    const comparablePath = (path: string): string =>
      process.platform === "win32" ? path.toLowerCase() : path;
    const runtimeHostStem = comparablePath(
      fileURLToPath(new URL("../src/runtime-host.ts", import.meta.url)).replace(/\.ts$/iu, ""),
    );
    const targetsRuntimeHost = (specifier: string): boolean =>
      specifier.startsWith(".") &&
      comparablePath(
        resolve(dirname(imageIngestPath), specifier).replace(/\.[cm]?[jt]s$/iu, ""),
      ) === runtimeHostStem;
    const api = new API();
    try {
      const snapshot = api.updateSnapshot({ openFiles: [imageIngestPath] });
      const project = snapshot.getDefaultProjectForFile(imageIngestPath);
      const sourceFile = project?.program.getSourceFile(imageIngestPath);
      expect(sourceFile, "TypeScript must parse image-ingest.ts in its owning project").toBeDefined();

      const staticRuntimeHostImports: string[] = [];
      const valueCodingAgentImports: string[] = [];
      const runtimeHostImportEquals: string[] = [];
      const valueCodingAgentImportEquals: string[] = [];
      const dynamicImports: Array<{
        text: string;
        specifier: string | undefined;
        functionScope: FunctionLikeDeclaration | undefined;
      }> = [];

      const visit = (node: Node, functionScope?: FunctionLikeDeclaration): void => {
        const currentFunctionScope = isFunctionLikeDeclaration(node) ? node : functionScope;

        if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          if (targetsRuntimeHost(specifier)) {
            staticRuntimeHostImports.push(node.getText(sourceFile));
          }
          if (
            specifier === "@earendil-works/pi-coding-agent" &&
            node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword
          ) {
            valueCodingAgentImports.push(node.getText(sourceFile));
          }
        }

        if (
          isImportEqualsDeclaration(node) &&
          isExternalModuleReference(node.moduleReference) &&
          isStringLiteralLikeNode(node.moduleReference.expression)
        ) {
          const specifier = node.moduleReference.expression.text;
          if (targetsRuntimeHost(specifier)) {
            runtimeHostImportEquals.push(node.getText(sourceFile));
          }
          if (specifier === "@earendil-works/pi-coding-agent" && !node.isTypeOnly) {
            valueCodingAgentImportEquals.push(node.getText(sourceFile));
          }
        }

        const argument = isCallExpression(node) ? node.arguments[0] : undefined;
        if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
          dynamicImports.push({
            text: node.getText(sourceFile),
            specifier: argument !== undefined && isStringLiteralLikeNode(argument)
              ? argument.text
              : undefined,
            functionScope: currentFunctionScope,
          });
        }

        node.forEachChild((child) => visit(child, currentFunctionScope));
      };
      visit(sourceFile!);

      expect(
        staticRuntimeHostImports,
        "image-ingest.ts must not use any static or side-effect runtime-host import; a direct implementation/module import would acquire the fallback graph on the Read detection path",
      ).toEqual([]);
      expect(
        valueCodingAgentImports,
        "image-ingest.ts must not use any value-bearing static import from @earendil-works/pi-coding-agent; it would acquire the package graph on the Read detection path",
      ).toEqual([]);
      expect(
        runtimeHostImportEquals,
        "image-ingest.ts must not use import-equals for runtime-host, including type-only forms",
      ).toEqual([]);
      expect(
        valueCodingAgentImportEquals,
        "image-ingest.ts must not use a runtime-bearing import-equals for @earendil-works/pi-coding-agent",
      ).toEqual([]);
      expect(
        dynamicImports,
        "image-ingest.ts must contain exactly one dynamic import call; computed or additional imports could acquire an unpinned graph",
      ).toHaveLength(1);
      expect(
        dynamicImports[0]?.specifier !== undefined && targetsRuntimeHost(dynamicImports[0].specifier),
        "the sole dynamic import argument must resolve literally to the canonical runtime-host graph",
      ).toBe(true);
      expect(
        dynamicImports[0]?.functionScope !== undefined &&
          isFunctionDeclaration(dynamicImports[0].functionScope) &&
          dynamicImports[0].functionScope.name?.text === "toImageContent",
        "the sole runtime-host dynamic import must belong directly to the named toImageContent() function, not module or nested function scope",
      ).toBe(true);
    } finally {
      api.close();
    }
  });
});
