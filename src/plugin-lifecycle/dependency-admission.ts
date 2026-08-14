import semver from "semver";
import type { PluginDependencyDeclarationEvidence, SafePluginManifestDependency } from "../claude/plugin-metadata.js";

export interface DependencyAdmissionCandidate {
  readonly pluginId: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly available?: boolean;
  readonly ownership: "picc-owned" | "claude-imported-readonly";
  readonly dependencies?: readonly SafePluginManifestDependency[];
  readonly dependencyDeclaration?: PluginDependencyDeclarationEvidence;
  readonly allowedCrossMarketplaceDependencies?: readonly string[];
}

export interface DependencyAdmissionDecision {
  readonly pluginId: string;
  readonly admitted: boolean;
  readonly reasons: readonly ("disabled" | "missing" | "incompatible" | "cyclic" | "disallowed" | "indeterminate")[];
}

function marketplace(pluginId: string): string | undefined {
  const split = pluginId.lastIndexOf("@"); return split > 0 ? pluginId.slice(split + 1) : undefined;
}

/** Central fail-closed dependency seam intended for startup assembly and later lifecycle mutation callers. */
export function admitDependencyGraph(candidates: readonly DependencyAdmissionCandidate[]): readonly DependencyAdmissionDecision[] {
  const byId = new Map<string, DependencyAdmissionCandidate>();
  const duplicate = new Set<string>();
  for (const candidate of candidates) byId.has(candidate.pluginId) ? duplicate.add(candidate.pluginId) : byId.set(candidate.pluginId, candidate);
  const reasons = new Map<string, Set<DependencyAdmissionDecision["reasons"][number]>>();
  const reason = (id: string, value: DependencyAdmissionDecision["reasons"][number]): void => { (reasons.get(id) ?? reasons.set(id, new Set()).get(id)!).add(value); };
  const edges = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (!candidate.enabled) reason(candidate.pluginId, "disabled");
    else if (candidate.available === false) reason(candidate.pluginId, "indeterminate");
    if (duplicate.has(candidate.pluginId)) reason(candidate.pluginId, "indeterminate");
    if (candidate.ownership === "picc-owned" && candidate.dependencyDeclaration !== "absent" && candidate.dependencyDeclaration !== "complete") reason(candidate.pluginId, "indeterminate");
    const ownerMarketplace = marketplace(candidate.pluginId);
    const targets: string[] = [];
    for (const dependency of candidate.dependencies ?? []) {
      const targetId = ownerMarketplace === undefined ? undefined : `${dependency.name}@${dependency.marketplace ?? ownerMarketplace}`;
      if (targetId === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dependency.name) || targetId === candidate.pluginId || dependency.itemIndex < 0 || !Number.isSafeInteger(dependency.itemIndex)) {
        reason(candidate.pluginId, targetId === candidate.pluginId ? "cyclic" : "disallowed"); continue;
      }
      const targetMarketplace = marketplace(targetId);
      if (candidate.ownership === "picc-owned" && targetMarketplace !== ownerMarketplace && !candidate.allowedCrossMarketplaceDependencies?.includes(targetMarketplace ?? "")) {
        reason(candidate.pluginId, "disallowed"); continue;
      }
      const target = byId.get(targetId);
      if (target === undefined) { reason(candidate.pluginId, "missing"); continue; }
      if (!target.enabled) { reason(candidate.pluginId, "disabled"); continue; }
      if (dependency.version !== undefined) {
        const range = semver.validRange(dependency.version); const version = semver.valid(target.version);
        if (range === null || version === null) { reason(candidate.pluginId, "indeterminate"); continue; }
        if (!semver.satisfies(version, range)) { reason(candidate.pluginId, "incompatible"); continue; }
      }
      targets.push(targetId);
    }
    edges.set(candidate.pluginId, targets);
  }
  const visiting = new Set<string>(); const visited = new Set<string>(); const stack: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id); for (const member of stack.slice(start)) reason(member, "cyclic"); return;
    }
    visiting.add(id); stack.push(id); for (const target of edges.get(id) ?? []) visit(target); stack.pop(); visiting.delete(id); visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, targets] of edges) if ((reasons.get(id)?.size ?? 0) === 0 && targets.some((target) => (reasons.get(target)?.size ?? 0) > 0)) { reason(id, "indeterminate"); changed = true; }
  }
  return Object.freeze([...byId.keys()].sort().map((pluginId) => {
    const values = [...(reasons.get(pluginId) ?? [])].sort();
    return Object.freeze({ pluginId, admitted: values.length === 0, reasons: Object.freeze(values) });
  }));
}
