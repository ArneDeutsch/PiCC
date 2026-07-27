import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { withDefaultCollapsedToolRendering } from "./default-collapsed-tool-render.js";
import { withRoutineToolRendering } from "./routine-tool-render.js";
import { withCompactSearchRendering } from "./search-tool-render.js";
import { wrapForSelfShell } from "./tool-shell.js";
import type { DisplayRootResolver } from "./tool-display.js";

export interface MainSessionToolRenderOptions {
  resolveDisplayRoot?: DisplayRootResolver;
  resolveEditRenderCwd?: () => unknown;
  repositoryRoot?: string;
  fallbackCallDisplayName?: string;
}

const SEARCH_NAMES = new Set(["Grep", "Glob", "grep", "find", "ls"]);
const PRESENTATION_FIELDS = ["renderCall", "renderResult", "renderShell"] as const;

/** Apply the appropriate main-session presentation family without changing tool behavior. */
export function renderMainSessionTool<T extends ToolDefinition>(
  tool: T,
  options: MainSessionToolRenderOptions = {},
): T {
  const display = {
    resolveDisplayRoot: options.resolveDisplayRoot,
    repositoryRoot: options.repositoryRoot,
  };
  const searched = SEARCH_NAMES.has(tool.name)
    ? withCompactSearchRendering(tool, display)
    : tool;
  const routine = withRoutineToolRendering(searched, {
    ...display,
    resolveEditRenderCwd: options.resolveEditRenderCwd,
  });
  const collapsed = withDefaultCollapsedToolRendering(routine, display);
  const rendered = wrapForSelfShell(collapsed as unknown as Record<string, unknown>, {
    fallbackCallDisplayName: options.fallbackCallDisplayName,
  });

  // Some family decorators use object spread. Rebuild from the source descriptors so accessors,
  // schema identity, execute identity, and every non-presentation field remain exactly intact.
  const descriptors = Object.getOwnPropertyDescriptors(tool);
  for (const field of PRESENTATION_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(rendered, field);
    if (descriptor) descriptors[field] = descriptor;
    else delete descriptors[field];
  }
  return Object.defineProperties(Object.create(Object.getPrototypeOf(tool)), descriptors) as T;
}
