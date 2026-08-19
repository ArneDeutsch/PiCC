import * as agentCore from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai";
import * as aiCompat from "@earendil-works/pi-ai/compat";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import { installRuntimeHost } from "./runtime-host-bootstrap.js";

installRuntimeHost({ agentCore, ai, aiCompat, codingAgent, tui, typebox, typeboxCompile });
const implementation = await import("./extension.js");

export type { PiccTestSeam } from "./extension.js";
export const {
  buildMcpStartupNotice,
  createBoundedHeadlessDiagnosticSurface,
  FdWriteReleasedError,
  formatAgentMcpSetupWarning,
  pluginRuntimeContextForSource,
  preparePluginDataDir,
  projectPluginAgentRuntime,
  substitutePluginRuntimeText,
  validateAgentMcpAdmission,
  writeFdFully,
} = implementation;

const picc: typeof implementation.default = implementation.default;
export default picc;
