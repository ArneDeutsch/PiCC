import type { PluginInstallationScope, PluginManifestDefaultEnabledEvidence } from "../types.js";

export const PLUGIN_LIFECYCLE_LIMITS = Object.freeze({
  maximumArrayItems: 1024,
  maximumDocumentBytes: 1024 * 1024,
  maximumFileCount: 100_000,
  maximumKeyLength: 128,
  maximumNesting: 32,
  maximumObjectKeys: 256,
  maximumStringLength: 8192,
});

export const LIFECYCLE_OWNERSHIPS = ["picc-owned", "claude-imported-readonly"] as const;
export const MUTABLE_PLUGIN_SCOPES = ["user", "project", "local"] as const;

export type LifecycleOwnership = typeof LIFECYCLE_OWNERSHIPS[number];
export type MutablePluginScope = Exclude<PluginInstallationScope, "managed">;
export type Sha256 = `sha256:${string}`;
export type QualifiedPluginIdentity = `${string}@${string}`;
export type LifecycleProfileKey = `profile-${string}`;
export type CheckoutFamilyKey = `checkout-${string}`;

export type MarketplaceRegistrationSource =
  | { readonly kind: "local-directory"; readonly path: string }
  | { readonly kind: "local-catalog-file"; readonly path: string }
  | { readonly kind: "github"; readonly repository: string; readonly ref?: string }
  | { readonly kind: "https-git"; readonly url: string; readonly ref?: string }
  | { readonly kind: "https-catalog"; readonly url: string };

export type CatalogPluginSource =
  | { readonly kind: "relative"; readonly path: string; readonly pluginRoot?: string }
  | { readonly kind: "github"; readonly repository: string; readonly ref?: string; readonly sha?: string }
  | { readonly kind: "https-git"; readonly url: string; readonly ref?: string; readonly sha?: string }
  | { readonly kind: "https-git-subdir"; readonly url: string; readonly path: string; readonly ref?: string; readonly sha?: string }
  | { readonly kind: "npm"; readonly package: string; readonly version?: string; readonly registry: "https://registry.npmjs.org" }
  | { readonly kind: "https-zip"; readonly url: string; readonly sha256?: string };

export type MarketplaceSourceAdapter =
  | "local-directory-snapshot"
  | "local-catalog-snapshot"
  | "anonymous-https-git"
  | "public-https-catalog";

export type PluginSourceAdapter =
  | "marketplace-relative-tree"
  | "anonymous-https-git"
  | "anonymous-https-git-subdir"
  | "public-npm-tgz"
  | "public-https-zip";

export type LifecycleScopeLocation =
  | { readonly scope: "user"; readonly profileKey: LifecycleProfileKey }
  | { readonly scope: "project" | "local"; readonly profileKey: LifecycleProfileKey; readonly checkoutFamilyKey: CheckoutFamilyKey };

export type LifecycleSettingsTarget =
  | { readonly scope: "user"; readonly path: string; readonly profileKey: LifecycleProfileKey }
  | {
      readonly scope: "project" | "local";
      readonly path: string;
      readonly profileKey: LifecycleProfileKey;
      readonly activeCheckoutPath: string;
      readonly checkoutFamilyKey: CheckoutFamilyKey;
    };

export interface PluginDataIdentity {
  readonly profileKey: LifecycleProfileKey;
  readonly identity: QualifiedPluginIdentity;
}

export type DefaultEnabledEvidence =
  | { readonly presence: "explicit"; readonly value: boolean }
  | { readonly presence: "absent" };

export interface InitialEnablementEvidence {
  readonly existingEffective: DefaultEnabledEvidence;
  readonly marketplaceDefault: DefaultEnabledEvidence;
  readonly manifestDefault: PluginManifestDefaultEnabledEvidence;
}
