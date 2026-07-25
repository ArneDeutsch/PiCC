import { fileURLToPath } from "node:url";
import { missingRealPiMessage, resolveRealPiCli } from "./resolve-real-pi-cli.mjs";

export function checkRealPi(options = {}) {
  const resolution = resolveRealPiCli(options);
  if (resolution.missing) {
    return { ok: false, message: missingRealPiMessage(resolution.cliPath) };
  }
  return { ok: true, cliPath: resolution.cliPath };
}

const USAGE = "Usage: node scripts/check-real-pi.mjs [--root <checkout-root>]";

function parseRootArgument(args) {
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== "--root" || !args[1]) {
    throw new Error(USAGE);
  }
  return args[1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const repoRoot = parseRootArgument(process.argv.slice(2));
    const result = checkRealPi(repoRoot ? { repoRoot } : undefined);
    if (!result.ok) {
      console.error(result.message);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
