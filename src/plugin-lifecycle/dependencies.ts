import { admitDependencyGraph, type DependencyAdmissionCandidate, type DependencyAdmissionDecision } from "./dependency-admission.js";
import type { SafePluginManifestDependency } from "../claude/plugin-metadata.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import { canonicalJsonBytes, type StoreResult } from "./state-store.js";

export interface PluginDependencyPosture {
  readonly graph: readonly DependencyAdmissionCandidate[];
  readonly decisions: readonly DependencyAdmissionDecision[];
  readonly selected: DependencyAdmissionDecision;
  readonly blocking: boolean;
}

export function pluginDependencyPosture(
  selectedPluginId: string,
  candidates: readonly DependencyAdmissionCandidate[],
): PluginDependencyPosture {
  const graph = Object.freeze(candidates.map((candidate) => Object.freeze({
    pluginId: candidate.pluginId, version: candidate.version, enabled: candidate.enabled, ownership: candidate.ownership,
    ...(candidate.available === undefined ? {} : { available: candidate.available }),
    ...(candidate.dependencies === undefined ? {} : { dependencies: Object.freeze([...candidate.dependencies]) }),
    ...(candidate.dependencyDeclaration === undefined ? {} : { dependencyDeclaration: candidate.dependencyDeclaration }),
    ...(candidate.allowedCrossMarketplaceDependencies === undefined ? {} : { allowedCrossMarketplaceDependencies: Object.freeze([...candidate.allowedCrossMarketplaceDependencies]) }),
  })));
  const decisions = admitDependencyGraph(graph);
  const selected = decisions.find((decision) => decision.pluginId === selectedPluginId)
    ?? Object.freeze({ pluginId: selectedPluginId, admitted: false, reasons: Object.freeze(["indeterminate" as const]) });
  return Object.freeze({ graph, decisions, selected, blocking: !selected.admitted });
}

export interface EnabledDependent {
  readonly pluginId: string;
  readonly dependencies?: readonly SafePluginManifestDependency[];
}

const DECLARATIONS = new Set(["absent", "complete", "invalid", "truncated"]);
const REASONS = new Set(["disabled", "missing", "incompatible", "cyclic", "disallowed", "indeterminate"]);
function exactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function boundedText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2048; }
function fail(message: string): StoreResult<never> { return { ok: false, code: "invalid-summary", message }; }

/** Decodes persisted dependency evidence before the admission validator can observe it. */
export function decodePersistedPluginDependencyPosture(raw: unknown): StoreResult<PluginDependencyPosture> {
  try {
    if (!exactObject(raw, ["graph", "decisions", "selected", "blocking"]) || !Array.isArray(raw.graph) || raw.graph.length > 4096 || !Array.isArray(raw.decisions) || raw.decisions.length > 4096 || typeof raw.blocking !== "boolean") return fail("Persisted dependency posture has an invalid bounded shape");
    const graph: DependencyAdmissionCandidate[] = [];
    for (const candidate of raw.graph) {
      if (!exactObject(candidate, ["pluginId", "version", "enabled", "ownership"], ["available", "dependencies", "dependencyDeclaration", "allowedCrossMarketplaceDependencies"]) || !boundedText(candidate.pluginId) || !isQualifiedPluginId(candidate.pluginId) || !boundedText(candidate.version) || typeof candidate.enabled !== "boolean" || !["picc-owned", "claude-imported-readonly"].includes(String(candidate.ownership)) || (candidate.available !== undefined && typeof candidate.available !== "boolean") || (candidate.dependencyDeclaration !== undefined && !DECLARATIONS.has(String(candidate.dependencyDeclaration)))) return fail("Persisted dependency candidate is malformed");
      let dependencies: SafePluginManifestDependency[] | undefined;
      if (candidate.dependencies !== undefined) {
        if (!Array.isArray(candidate.dependencies) || candidate.dependencies.length > 128) return fail("Persisted dependency entries exceed their bound");
        dependencies = [];
        for (const dependency of candidate.dependencies) {
          if (!exactObject(dependency, ["name", "itemIndex"], ["version", "marketplace"]) || !boundedText(dependency.name) || !Number.isSafeInteger(dependency.itemIndex) || (dependency.itemIndex as number) < 0 || (dependency.version !== undefined && !boundedText(dependency.version)) || (dependency.marketplace !== undefined && !boundedText(dependency.marketplace))) return fail("Persisted dependency entry is malformed");
          dependencies.push(Object.freeze({ name: dependency.name, itemIndex: dependency.itemIndex as number, ...(dependency.version === undefined ? {} : { version: dependency.version as string }), ...(dependency.marketplace === undefined ? {} : { marketplace: dependency.marketplace as string }) }));
        }
      }
      let allowlist: string[] | undefined;
      if (candidate.allowedCrossMarketplaceDependencies !== undefined) {
        if (!Array.isArray(candidate.allowedCrossMarketplaceDependencies) || candidate.allowedCrossMarketplaceDependencies.length > 128 || candidate.allowedCrossMarketplaceDependencies.some((item) => !boundedText(item))) return fail("Persisted dependency allowlist is malformed");
        allowlist = [...candidate.allowedCrossMarketplaceDependencies] as string[];
      }
      graph.push(Object.freeze({ pluginId: candidate.pluginId, version: candidate.version, enabled: candidate.enabled, ownership: candidate.ownership as DependencyAdmissionCandidate["ownership"], ...(candidate.available === undefined ? {} : { available: candidate.available }), ...(dependencies === undefined ? {} : { dependencies: Object.freeze(dependencies) }), ...(candidate.dependencyDeclaration === undefined ? {} : { dependencyDeclaration: candidate.dependencyDeclaration as DependencyAdmissionCandidate["dependencyDeclaration"] }), ...(allowlist === undefined ? {} : { allowedCrossMarketplaceDependencies: Object.freeze(allowlist) }) }));
    }
    const decisions = raw.decisions;
    for (const decision of decisions) if (!exactObject(decision, ["pluginId", "admitted", "reasons"]) || !boundedText(decision.pluginId) || !isQualifiedPluginId(decision.pluginId) || typeof decision.admitted !== "boolean" || !Array.isArray(decision.reasons) || decision.reasons.length > 6 || decision.reasons.some((reason) => !REASONS.has(String(reason)))) return fail("Persisted dependency decision is malformed");
    if (!exactObject(raw.selected, ["pluginId", "admitted", "reasons"]) || !boundedText(raw.selected.pluginId) || !isQualifiedPluginId(raw.selected.pluginId) || typeof raw.selected.admitted !== "boolean" || !Array.isArray(raw.selected.reasons) || raw.selected.reasons.length > 6 || raw.selected.reasons.some((reason) => !REASONS.has(String(reason)))) return fail("Persisted selected dependency decision is malformed");
    const derived = pluginDependencyPosture(raw.selected.pluginId, graph); const expected = canonicalJsonBytes(derived); const actual = canonicalJsonBytes(raw);
    return expected.ok && actual.ok && Buffer.from(expected.value).equals(Buffer.from(actual.value)) ? { ok: true, value: derived } : fail("Persisted dependency posture is not the code-owned graph projection");
  } catch {
    return fail("Persisted dependency posture is malformed");
  }
}

export function enabledDependentsOf(pluginId: string, candidates: readonly EnabledDependent[]): readonly string[] {
  const split = pluginId.lastIndexOf("@");
  if (split < 1) return Object.freeze([]);
  const name = pluginId.slice(0, split); const marketplace = pluginId.slice(split + 1);
  return Object.freeze(candidates.filter((candidate) => candidate.pluginId !== pluginId && (candidate.dependencies ?? []).some((dependency) =>
    dependency.name === name && (dependency.marketplace ?? candidate.pluginId.slice(candidate.pluginId.lastIndexOf("@") + 1)) === marketplace))
    .map((candidate) => candidate.pluginId).sort());
}
