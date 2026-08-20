import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as agentCore from "@earendil-works/pi-agent-core";
import * as ai from "@earendil-works/pi-ai";
import * as aiCompat from "@earendil-works/pi-ai/compat";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import * as typebox from "typebox";
import * as typeboxCompile from "typebox/compile";
import { physicalPath } from "../bin/picc-admin.mjs";
import { pinPiccRuntime, presentPiccSourceNotice, selectPiccRuntime } from "../bin/picc-runtime.mjs";

// Keep a non-erasable declaration here so Pi upgrades must still prove this entry crosses Pi's aliasing TypeScript transform.
enum RuntimeHostTransformBoundary { Active = "active" }
const transformBoundary: string = RuntimeHostTransformBoundary.Active;
if (transformBoundary.length === 0) throw new Error("PiCC bootstrap transformation failed.");

// This canonical path preserves Pi's visible `picc` extension label across load and reload.
const packageRoot = physicalPath(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
let installationKind: "installed" | "source" = "installed";
try {
  const gitState = fs.lstatSync(path.join(packageRoot, ".git"));
  if (gitState.isDirectory() || gitState.isFile()) installationKind = "source";
} catch {
  installationKind = "installed";
}

const selection = selectPiccRuntime({ packageRoot, installationKind });
if (!selection.ok) throw new Error(selection.reason);
const representation = pinPiccRuntime({ packageRoot, installationKind, selection });
if (representation.mode === "source" && selection.mode === "source") {
  presentPiccSourceNotice({ packageRoot, installationKind, representation, selection });
}

const installer = representation.mode === "compiled"
  ? await import(new URL("../dist/runtime-host-bootstrap.js", import.meta.url).href) as typeof import("../src/runtime-host-bootstrap.js")
  : await import("../src/runtime-host-bootstrap.js");
installer.installRuntimeHost({ agentCore, ai, aiCompat, codingAgent, tui, typebox, typeboxCompile });

const implementation = representation.mode === "compiled"
  ? await import(new URL("../dist/extension.js", import.meta.url).href) as typeof import("../src/extension.js")
  : await import("../src/extension.js");

export default implementation.default;
