import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

type ImageProtocol = "kitty" | "iterm2" | null;

export type PiTuiAvailability<T> =
  | { readonly available: true; readonly value: T }
  | { readonly available: false };

export interface PiTuiCapabilities {
  readonly images: ImageProtocol;
  readonly trueColor: boolean;
  readonly hyperlinks: boolean;
}

interface Component {
  render(width: number): string[];
}

interface PiBoxConstructor {
  [Symbol.hasInstance](value: unknown): boolean;
}

interface PiTuiModule {
  Box: PiBoxConstructor;
  getCapabilities(): unknown;
}

interface CodingAgentModule {
  keyText(action: string): unknown;
}

interface PiPackageContext {
  codingAgentPath: string;
  require: NodeJS.Require;
}

const unavailable = Object.freeze({ available: false }) as PiTuiAvailability<never>;
const identityBackground = (text: string): string => text;
let piPackageContext: PiPackageContext | null | undefined;
let piTuiModule: PiTuiModule | null | undefined;

function loadPiPackageContext(): PiPackageContext | undefined {
  if (piPackageContext !== undefined) return piPackageContext ?? undefined;
  try {
    const codingAgentUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    piPackageContext = {
      codingAgentPath: fileURLToPath(codingAgentUrl),
      require: createRequire(codingAgentUrl),
    };
    return piPackageContext;
  } catch {
    piPackageContext = null;
    return undefined;
  }
}

// Root and Pi-owned pi-tui copies can have different singleton and constructor identities.
// Resolve from Pi's package context so capability state and native Box instanceof checks agree with Pi.
function loadPiTuiModule(): PiTuiModule | undefined {
  if (piTuiModule !== undefined) return piTuiModule ?? undefined;
  try {
    const context = loadPiPackageContext();
    if (!context) return undefined;
    const entry = context.require.resolve("@earendil-works/pi-tui");
    const candidate = context.require(entry) as Partial<PiTuiModule>;
    if (typeof candidate.Box !== "function" || typeof candidate.getCapabilities !== "function") {
      piTuiModule = null;
      return undefined;
    }
    piTuiModule = candidate as PiTuiModule;
    return piTuiModule;
  } catch {
    piTuiModule = null;
    return undefined;
  }
}

/** Return Pi's configured expansion-action text, or unavailable when hidden detail is not safely reachable. */
export function piToolsExpandKeyText(): PiTuiAvailability<string> {
  try {
    const context = loadPiPackageContext();
    if (!context) return unavailable;
    const candidate = context.require(context.codingAgentPath) as Partial<CodingAgentModule>;
    if (typeof candidate.keyText !== "function") return unavailable;
    const value = candidate.keyText("app.tools.expand");
    return typeof value === "string" && value.length > 0
      ? { available: true, value }
      : unavailable;
  } catch {
    return unavailable;
  }
}

/** Read terminal capability state from the pi-tui instance owned by Pi. */
export function piTuiCapabilities(): PiTuiAvailability<PiTuiCapabilities> {
  try {
    const capabilities = loadPiTuiModule()?.getCapabilities();
    if (capabilities === null || typeof capabilities !== "object") return unavailable;
    const { images, trueColor, hyperlinks } = capabilities as Record<string, unknown>;
    if ((images !== null && images !== "kitty" && images !== "iterm2") ||
      typeof trueColor !== "boolean" || typeof hyperlinks !== "boolean") return unavailable;
    return {
      available: true,
      value: Object.freeze({ images, trueColor, hyperlinks }),
    };
  } catch {
    return unavailable;
  }
}

/** Neutralize only a native Edit Box from Pi's own pi-tui instance. */
export function neutralizePiEditBoxBackground(component: Component): boolean {
  try {
    const Box = loadPiTuiModule()?.Box;
    if (!Box || !(component instanceof Box)) return false;
    const setBgFn = (component as Component & {
      setBgFn(background: (text: string) => string): void;
    }).setBgFn;
    if (typeof setBgFn !== "function") return false;
    setBgFn.call(component, identityBackground);
    return true;
  } catch {
    return false;
  }
}
