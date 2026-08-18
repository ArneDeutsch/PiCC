import { createHash } from "node:crypto";
import path from "node:path";
import { lifecycleError, type ContractResult } from "./errors.js";
import type {
  CheckoutFamilyKey,
  LifecycleProfileKey,
  LifecycleSettingsTarget,
  MutablePluginScope,
  PluginDataIdentity,
  QualifiedPluginIdentity,
} from "./types.js";

export type LifecyclePlatform = "win32" | "posix";

export enum OwnedStateStoreNamespace {
  Plugins = "plugins",
  Mcp = "mcp",
}

export interface LifecycleLocationInputs {
  readonly homeDir: string;
  readonly profilePath: string;
  readonly platform: LifecyclePlatform;
  readonly project?: {
    readonly activeCheckoutPath: string;
    readonly checkoutFamilyPath: string;
  };
}

export interface LifecycleLocations {
  readonly platform: LifecyclePlatform;
  readonly storeNamespace: OwnedStateStoreNamespace;
  readonly root: string;
  readonly profileKey: LifecycleProfileKey;
  readonly profileRoot: string;
  readonly marketplacesRoot: string;
  readonly profilePluginsRoot: string;
  readonly dataRoot: string;
  readonly checkoutFamilyKey?: CheckoutFamilyKey;
  readonly checkoutFamilyRoot?: string;
  readonly checkoutFamilyPluginsRoot?: string;
}

function pathApi(platform: LifecyclePlatform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function isWindowsDeviceNamespace(value: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(value) || /^[\\/]\?\?[\\/]/.test(value);
}

export function canonicalLocationIdentity(value: string, platform: LifecyclePlatform): ContractResult<string> {
  const api = pathApi(platform);
  if (!api.isAbsolute(value)
    || value.includes("\0")
    || (platform === "win32" && isWindowsDeviceNamespace(value))) {
    return lifecycleError("invalid-location", "Lifecycle identity must be an absolute ordinary filesystem path");
  }
  const normalized = api.normalize(value);
  const withoutTrailingSeparator = normalized === api.parse(normalized).root
    ? normalized
    : normalized.replace(/[\\/]$/, "");
  return { ok: true, value: platform === "win32" ? withoutTrailingSeparator.toLowerCase() : withoutTrailingSeparator };
}

function locationKey(
  value: string,
  platform: LifecyclePlatform,
  prefix: "profile" | "checkout",
): ContractResult<LifecycleProfileKey | CheckoutFamilyKey> {
  const canonical = canonicalLocationIdentity(value, platform);
  if (!canonical.ok) return canonical;
  const digest = createHash("sha256").update(`${platform}\0${canonical.value}`, "utf8").digest("base64url");
  return { ok: true, value: `${prefix}-${digest}` };
}

export function profileLocationKey(value: string, platform: LifecyclePlatform): ContractResult<LifecycleProfileKey> {
  return locationKey(value, platform, "profile") as ContractResult<LifecycleProfileKey>;
}

export function checkoutFamilyLocationKey(value: string, platform: LifecyclePlatform): ContractResult<CheckoutFamilyKey> {
  return locationKey(value, platform, "checkout") as ContractResult<CheckoutFamilyKey>;
}

function createNamespacedLifecycleLocations(
  inputs: LifecycleLocationInputs,
  storeNamespace: OwnedStateStoreNamespace,
): ContractResult<LifecycleLocations> {
  const api = pathApi(inputs.platform);
  const profileKey = profileLocationKey(inputs.profilePath, inputs.platform);
  const home = canonicalLocationIdentity(inputs.homeDir, inputs.platform);
  if (!profileKey.ok) return profileKey;
  if (!home.ok) return home;

  const root = api.join(home.value, ".picc", storeNamespace, "v1");
  const profileRoot = api.join(root, "profiles", profileKey.value);
  if (inputs.project === undefined) {
    return { ok: true, value: Object.freeze({
      platform: inputs.platform,
      storeNamespace,
      root,
      profileKey: profileKey.value,
      profileRoot,
      marketplacesRoot: api.join(profileRoot, "marketplaces"),
      profilePluginsRoot: api.join(profileRoot, "plugins"),
      dataRoot: api.join(profileRoot, "data"),
    }) };
  }

  const checkoutFamilyKey = checkoutFamilyLocationKey(inputs.project.checkoutFamilyPath, inputs.platform);
  const activeCheckout = canonicalLocationIdentity(inputs.project.activeCheckoutPath, inputs.platform);
  if (!checkoutFamilyKey.ok) return checkoutFamilyKey;
  if (!activeCheckout.ok) return activeCheckout;
  const checkoutFamilyRoot = api.join(profileRoot, "checkouts", checkoutFamilyKey.value);
  return { ok: true, value: Object.freeze({
    platform: inputs.platform,
    storeNamespace,
    root,
    profileKey: profileKey.value,
    profileRoot,
    marketplacesRoot: api.join(profileRoot, "marketplaces"),
    profilePluginsRoot: api.join(profileRoot, "plugins"),
    dataRoot: api.join(profileRoot, "data"),
    checkoutFamilyKey: checkoutFamilyKey.value,
    checkoutFamilyRoot,
    checkoutFamilyPluginsRoot: api.join(checkoutFamilyRoot, "plugins"),
  }) };
}

export function createLifecycleLocations(inputs: LifecycleLocationInputs): ContractResult<LifecycleLocations> {
  return createNamespacedLifecycleLocations(inputs, OwnedStateStoreNamespace.Plugins);
}

export function createMcpLifecycleLocations(inputs: LifecycleLocationInputs): ContractResult<LifecycleLocations> {
  return createNamespacedLifecycleLocations(inputs, OwnedStateStoreNamespace.Mcp);
}

export function lifecycleSettingsTarget(
  inputs: LifecycleLocationInputs,
  scope: MutablePluginScope,
): ContractResult<LifecycleSettingsTarget> {
  const api = pathApi(inputs.platform);
  const profileKey = profileLocationKey(inputs.profilePath, inputs.platform);
  if (!profileKey.ok) return profileKey;
  if (scope === "user") {
    const profile = canonicalLocationIdentity(inputs.profilePath, inputs.platform);
    if (!profile.ok) return profile;
    return { ok: true, value: Object.freeze({
      scope,
      path: api.join(profile.value, "settings.json"),
      profileKey: profileKey.value,
    }) };
  }
  if (inputs.project === undefined) {
    return lifecycleError("invalid-location", `${scope} settings require an active checkout and checkout-family identity`);
  }
  const activeCheckout = canonicalLocationIdentity(inputs.project.activeCheckoutPath, inputs.platform);
  const checkoutFamilyKey = checkoutFamilyLocationKey(inputs.project.checkoutFamilyPath, inputs.platform);
  if (!activeCheckout.ok) return activeCheckout;
  if (!checkoutFamilyKey.ok) return checkoutFamilyKey;
  return { ok: true, value: Object.freeze({
    scope,
    path: api.join(activeCheckout.value, ".claude", scope === "local" ? "settings.local.json" : "settings.json"),
    profileKey: profileKey.value,
    activeCheckoutPath: activeCheckout.value,
    checkoutFamilyKey: checkoutFamilyKey.value,
  }) };
}

export function pluginDataIdentity(
  profileKey: LifecycleProfileKey,
  identity: QualifiedPluginIdentity,
): PluginDataIdentity {
  return Object.freeze({ profileKey, identity });
}

export function pluginDataPath(
  locations: LifecycleLocations,
  identity: QualifiedPluginIdentity,
): string {
  const key = createHash("sha256").update(identity, "utf8").digest("base64url");
  return pathApi(locations.platform).join(locations.dataRoot, `plugin-${key}`);
}

export function checkoutFamilyKeyForScope(
  scope: MutablePluginScope,
  locations: LifecycleLocations,
): ContractResult<CheckoutFamilyKey | undefined> {
  if (scope === "user") return { ok: true, value: undefined };
  return locations.checkoutFamilyKey === undefined
    ? lifecycleError("invalid-location", `${scope} installation requires checkout-family partitioning`)
    : { ok: true, value: locations.checkoutFamilyKey };
}
