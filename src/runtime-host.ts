import { acquireFallbackRuntimeHost, installedRuntimeHost } from "./runtime-host-bootstrap.js";

const host = installedRuntimeHost() ?? await acquireFallbackRuntimeHost();

export const Type: typeof import("typebox").Type = host.typebox.Type;
export const Compile: typeof import("typebox/compile").Compile = host.typeboxCompile.Compile;
export const { StringEnum, isContextOverflow, isRetryableAssistantError } = host.ai;
export const { openAICodexResponsesApi } = host.aiCompat;
export const { calculateContextTokens } = host.agentCore;
export const {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  SessionManager,
  createAgentSession,
  createEditToolDefinition,
  defineTool,
  formatSize,
  generateDiffString,
  truncateHead,
  withFileMutationQueue,
} = host.codingAgent;
export const {
  Box,
  KeybindingsManager,
  getImageDimensions,
  getKeybindings,
  imageFallback,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} = host.tui;

export const runtimeHostGraph = host;
