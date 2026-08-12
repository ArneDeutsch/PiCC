import type { PluginManifestDefaultEnabledEvidence } from "../types.js";

export type EnablementDefaultSource = "existing-effective" | "marketplace-default" | "manifest-default" | "default-enabled";
export interface ResolvedInitialEnablement { readonly enabled: boolean; readonly source: EnablementDefaultSource }

export function resolveInitialPluginEnablement(inputs: {
  readonly existingEffective?: boolean;
  readonly marketplaceDefault?: boolean;
  readonly manifestDefault?: PluginManifestDefaultEnabledEvidence | boolean;
}): ResolvedInitialEnablement {
  if (inputs.existingEffective !== undefined) return Object.freeze({ enabled: inputs.existingEffective, source: "existing-effective" });
  if (inputs.marketplaceDefault !== undefined) return Object.freeze({ enabled: inputs.marketplaceDefault, source: "marketplace-default" });
  const manifest = typeof inputs.manifestDefault === "boolean" ? inputs.manifestDefault
    : inputs.manifestDefault?.presence === "explicit" ? inputs.manifestDefault.value : undefined;
  if (manifest !== undefined) return Object.freeze({ enabled: manifest, source: "manifest-default" });
  return Object.freeze({ enabled: true, source: "default-enabled" });
}

export function preservedPluginEnablement(existingExplicit: boolean | undefined): boolean | undefined {
  return existingExplicit;
}
