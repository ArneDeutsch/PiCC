import { runtimeHostGraph } from "../runtime-host.js";

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

const unavailable = Object.freeze({ available: false }) as PiTuiAvailability<never>;
const identityBackground = (text: string): string => text;

/** Return Pi's configured expansion-action text, or unavailable when hidden detail is not safely reachable. */
export function piToolsExpandKeyText(): PiTuiAvailability<string> {
  try {
    const keybindings = runtimeHostGraph.tui.getKeybindings();
    // Render seams can run before coding-agent installs app definitions, whose default remains Ctrl+O.
    if (keybindings.getDefinition("app.tools.expand") === undefined) return { available: true, value: "ctrl+o" };
    const keys = keybindings.getKeys("app.tools.expand");
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((key) => typeof key === "string")) return unavailable;
    const value = keys.map((key) => key.split("+").map((part) =>
      process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part).join("+")).join("/");
    return value.length > 0 ? { available: true, value } : unavailable;
  } catch {
    return unavailable;
  }
}

/** Read terminal capabilities from the canonical graph retained after supported host installation or deliberate fallback. */
export function piTuiCapabilities(): PiTuiAvailability<PiTuiCapabilities> {
  try {
    const capabilities = runtimeHostGraph.tui.getCapabilities();
    if (capabilities === null || typeof capabilities !== "object") return unavailable;
    const { images, trueColor, hyperlinks } = capabilities as unknown as Record<string, unknown>;
    if ((images !== null && images !== "kitty" && images !== "iterm2") ||
      typeof trueColor !== "boolean" || typeof hyperlinks !== "boolean") return unavailable;
    return { available: true, value: Object.freeze({ images, trueColor, hyperlinks }) };
  } catch {
    return unavailable;
  }
}

/** Neutralize only an Edit Box from the canonical graph retained after host installation or deliberate fallback. */
export function neutralizePiEditBoxBackground(component: Component): boolean {
  try {
    if (!(component instanceof runtimeHostGraph.tui.Box)) return false;
    const setBgFn = (component as Component & { setBgFn(background: (text: string) => string): void }).setBgFn;
    if (typeof setBgFn !== "function") return false;
    setBgFn.call(component, identityBackground);
    return true;
  } catch {
    return false;
  }
}
