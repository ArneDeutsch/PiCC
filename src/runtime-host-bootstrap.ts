export interface RuntimeHostGraph {
  readonly agentCore: typeof import("@earendil-works/pi-agent-core");
  readonly ai: typeof import("@earendil-works/pi-ai");
  readonly aiCompat: typeof import("@earendil-works/pi-ai/compat");
  readonly codingAgent: typeof import("@earendil-works/pi-coding-agent");
  readonly tui: typeof import("@earendil-works/pi-tui");
  readonly typebox: typeof import("typebox");
  readonly typeboxCompile: typeof import("typebox/compile");
}

interface CanonicalRuntimeHostApi {
  installRuntimeHostGraph(graph: RuntimeHostGraph): RuntimeHostGraph;
  getRuntimeHostGraph(): RuntimeHostGraph | undefined;
  acquireFallbackRuntimeHostGraph(): Promise<RuntimeHostGraph>;
}

const canonicalRuntime = await import(new URL("../bin/picc-runtime.mjs", import.meta.url).href) as CanonicalRuntimeHostApi;

export function installRuntimeHost(graph: RuntimeHostGraph): RuntimeHostGraph {
  return canonicalRuntime.installRuntimeHostGraph(graph);
}

export function installedRuntimeHost(): RuntimeHostGraph | undefined {
  return canonicalRuntime.getRuntimeHostGraph();
}

export function acquireFallbackRuntimeHost(): Promise<RuntimeHostGraph> {
  return canonicalRuntime.acquireFallbackRuntimeHostGraph();
}
