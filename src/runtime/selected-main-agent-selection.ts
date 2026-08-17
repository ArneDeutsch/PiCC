import { findByName } from "../project.js";
import type { ClaudeAgent } from "../types.js";

export const SELECTED_MAIN_AGENT_ENTRY = "picc-selected-main-agent";
export const SELECTED_MAIN_AGENT_INITIAL_PROMPT = "picc-selected-main-agent-initial-prompt";
export const SELECTED_MAIN_AGENT_NAME_MAX_CHARS = 256;
export const SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES = 1_000_000;

export interface SelectedMainAgentEntryPayload {
  readonly version: 1;
  readonly requestedName: string;
}

export interface SelectedMainAgentInitialPromptDetails {
  readonly version: 1;
  readonly selectedName: string;
}

export type SelectedMainAgentBranchObservation =
  | { readonly kind: "no-record" }
  | { readonly kind: "persisted"; readonly requestedName: string }
  | { readonly kind: "persisted-uncertain" };

export type SelectedMainAgentResolution =
  | { readonly kind: "none" }
  | {
      readonly kind: "selected";
      readonly source: "cli" | "persisted" | "settings";
      readonly requestedName: string;
      readonly agent: ClaudeAgent;
      readonly appendSelectionEntry: boolean;
    }
  | {
      readonly kind: "missing-fresh";
      readonly source: "cli" | "settings";
      readonly requestedName?: string;
    }
  | { readonly kind: "missing-persisted"; readonly requestedName: string }
  | { readonly kind: "persisted-uncertain" };

interface SelectionInputs {
  readonly cliName?: string;
  readonly settingName?: string;
  readonly branchObservation: SelectedMainAgentBranchObservation;
  readonly agents: ClaudeAgent[];
}

type DataProperty =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: unknown };

function dataProperty(value: unknown, key: PropertyKey): DataProperty {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return { kind: "invalid" };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { kind: "absent" };
    if (!("value" in descriptor)) return { kind: "invalid" };
    return { kind: "value", value: descriptor.value };
  } catch {
    return { kind: "invalid" };
  }
}

function ordinaryArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    return false;
  }
}

function ordinaryRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function boundedSelector(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= SELECTED_MAIN_AGENT_NAME_MAX_CHARS
    && value.trim().length > 0
    && !value.includes("\0");
}

function decodeSelectionPayload(value: unknown): SelectedMainAgentEntryPayload | undefined {
  if (!ordinaryRecord(value)) return undefined;
  const version = dataProperty(value, "version");
  const requestedName = dataProperty(value, "requestedName");
  if (version.kind !== "value" || version.value !== 1
    || requestedName.kind !== "value" || !boundedSelector(requestedName.value)) return undefined;
  return { version: 1, requestedName: requestedName.value };
}

function decodeInitialPromptDetails(value: unknown): SelectedMainAgentInitialPromptDetails | undefined {
  if (!ordinaryRecord(value)) return undefined;
  const version = dataProperty(value, "version");
  const selectedName = dataProperty(value, "selectedName");
  if (version.kind !== "value" || version.value !== 1
    || selectedName.kind !== "value" || !boundedSelector(selectedName.value)) return undefined;
  return { version: 1, selectedName: selectedName.value };
}

function inspectBranch(branch: unknown): { entries: unknown[]; length: number } | undefined {
  if (!ordinaryArray(branch)) return undefined;
  const length = dataProperty(branch, "length");
  if (length.kind !== "value" || typeof length.value !== "number"
    || !Number.isSafeInteger(length.value) || length.value < 0
    || length.value > SELECTED_MAIN_AGENT_BRANCH_MAX_ENTRIES) {
    return undefined;
  }
  return { entries: branch, length: length.value };
}

function inspectEntry(entries: unknown[], index: number): Record<string, unknown> | undefined {
  const entry = dataProperty(entries, index);
  if (entry.kind !== "value" || !ordinaryRecord(entry.value)) return undefined;
  return entry.value;
}

/** Observe only the selected branch; unreadable evidence never degrades to absence. */
export function observeSelectedMainAgentBranch(branch: unknown): SelectedMainAgentBranchObservation {
  const inspected = inspectBranch(branch);
  if (inspected === undefined) return { kind: "persisted-uncertain" };
  for (let index = inspected.length - 1; index >= 0; index--) {
    const inspectedEntry = inspectEntry(inspected.entries, index);
    if (inspectedEntry === undefined) return { kind: "persisted-uncertain" };
    const type = dataProperty(inspectedEntry, "type");
    const customType = dataProperty(inspectedEntry, "customType");
    if (type.kind === "invalid" || customType.kind === "invalid") {
      return { kind: "persisted-uncertain" };
    }
    const reservedCustomType = customType.kind === "value"
      && customType.value === SELECTED_MAIN_AGENT_ENTRY;
    if (reservedCustomType && (type.kind !== "value" || type.value !== "custom")) {
      return { kind: "persisted-uncertain" };
    }
    if (type.kind !== "value" || type.value !== "custom" || !reservedCustomType) continue;
    const data = dataProperty(inspectedEntry, "data");
    if (data.kind !== "value") return { kind: "persisted-uncertain" };
    const payload = decodeSelectionPayload(data.value);
    return payload === undefined
      ? { kind: "persisted-uncertain" }
      : { kind: "persisted", requestedName: payload.requestedName };
  }
  return { kind: "no-record" };
}

/** Find durable proof that this branch already received this selected agent's initial prompt. */
export function selectedMainAgentInitialPromptDelivered(branch: unknown, name: string): boolean {
  if (!boundedSelector(name)) return false;
  const inspected = inspectBranch(branch);
  if (inspected === undefined) return false;
  for (let index = inspected.length - 1; index >= 0; index--) {
    const inspectedEntry = inspectEntry(inspected.entries, index);
    if (inspectedEntry === undefined) return false;
    const type = dataProperty(inspectedEntry, "type");
    if (type.kind === "invalid") return false;
    if (type.kind !== "value" || type.value !== "custom_message") continue;
    const customType = dataProperty(inspectedEntry, "customType");
    if (customType.kind === "invalid") return false;
    if (customType.kind !== "value" || customType.value !== SELECTED_MAIN_AGENT_INITIAL_PROMPT) continue;
    const content = dataProperty(inspectedEntry, "content");
    const details = dataProperty(inspectedEntry, "details");
    if (content.kind !== "value" || typeof content.value !== "string" || details.kind !== "value") continue;
    const decoded = decodeInitialPromptDetails(details.value);
    if (decoded?.selectedName === name) return true;
  }
  return false;
}

function freshResolution(
  source: "cli" | "settings",
  requestedName: string,
  agents: ClaudeAgent[],
  appendSelectionEntry: boolean,
): SelectedMainAgentResolution {
  if (!boundedSelector(requestedName)) return { kind: "missing-fresh", source };
  const agent = findByName(agents, requestedName);
  return agent === undefined
    ? { kind: "missing-fresh", source, requestedName }
    : { kind: "selected", source, requestedName, agent, appendSelectionEntry };
}

/** Resolve selector precedence without mutating the transcript or runtime. */
export function resolveSelectedMainAgentSelection(inputs: SelectionInputs): SelectedMainAgentResolution {
  if (inputs.cliName !== undefined) {
    const persistedSame = inputs.branchObservation.kind === "persisted"
      && inputs.branchObservation.requestedName === inputs.cliName;
    return freshResolution("cli", inputs.cliName, inputs.agents, !persistedSame);
  }
  if (inputs.branchObservation.kind === "persisted-uncertain") {
    return { kind: "persisted-uncertain" };
  }
  if (inputs.branchObservation.kind === "persisted") {
    const agent = findByName(inputs.agents, inputs.branchObservation.requestedName);
    return agent === undefined
      ? { kind: "missing-persisted", requestedName: inputs.branchObservation.requestedName }
      : {
          kind: "selected",
          source: "persisted",
          requestedName: inputs.branchObservation.requestedName,
          agent,
          appendSelectionEntry: false,
        };
  }
  if (inputs.settingName === undefined) return { kind: "none" };
  return freshResolution("settings", inputs.settingName, inputs.agents, true);
}
