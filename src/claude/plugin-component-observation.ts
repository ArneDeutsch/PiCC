import type { PluginMarketplaceUnsupportedComponentField } from "../types.js";

export interface UnsupportedComponentShapeObservation {
  readonly field: PluginMarketplaceUnsupportedComponentField;
  readonly declaration: "string-shape" | "array-shape";
  readonly count: number;
}

export interface UnsupportedComponentShapeResult {
  readonly observations: readonly UnsupportedComponentShapeObservation[];
  readonly omittedItems: number;
}

interface ObserveUnsupportedComponentOptions {
  readonly maximumItems: number;
  readonly reportInvalid: (field: string, item: boolean) => void;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safePluginRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("./") || value.startsWith("././") || /[\\?#\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.slice(2).split("/");
  return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes(":"));
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

const monitorFields = new Set(["name", "command", "description", "when"]);

function monitorWhen(value: unknown): boolean {
  if (value === "always") return true;
  if (typeof value !== "string" || !value.startsWith("on-skill-invoke:")) return false;
  return nonempty(value.slice("on-skill-invoke:".length));
}

function monitor(value: unknown): boolean {
  if (safePluginRelativePath(value)) return true;
  if (!plain(value) || !hasOnlyKeys(value, monitorFields)) return false;
  return nonempty(value["name"]) && nonempty(value["command"]) && nonempty(value["description"])
    && (!Object.hasOwn(value, "when") || monitorWhen(value["when"]));
}

function mcpServerNames(container: Readonly<Record<string, unknown>>): ReadonlySet<string> {
  const raw = container["mcpServers"];
  if (!plain(raw)) return new Set();
  return new Set(Object.keys(raw).filter((key) => nonempty(key)));
}

const channelOptionTypes = new Set(["string", "number", "boolean", "directory", "file"]);

const channelOptionFields = new Set(["type", "title", "description", "required", "default", "multiple", "sensitive", "min", "max"]);
const channelFields = new Set(["server", "displayName", "userConfig"]);

function channelDefault(value: unknown, type: string, multiple: unknown): boolean {
  if (Array.isArray(value)) return type === "string" && multiple === true && value.every((item) => typeof item === "string");
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "string";
}

function channelUserConfig(value: unknown): boolean {
  if (!plain(value)) return false;
  for (const [key, option] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !plain(option) || !hasOnlyKeys(option, channelOptionFields)) return false;
    const type = option["type"];
    if (!Object.hasOwn(option, "type") || typeof type !== "string" || !channelOptionTypes.has(type)) return false;
    if (!Object.hasOwn(option, "title") || !nonempty(option["title"]) || !Object.hasOwn(option, "description") || !nonempty(option["description"])) return false;
    for (const field of ["sensitive", "required"] as const) {
      if (Object.hasOwn(option, field) && typeof option[field] !== "boolean") return false;
    }
    if (Object.hasOwn(option, "multiple") && (typeof option["multiple"] !== "boolean" || type !== "string")) return false;
    for (const field of ["min", "max"] as const) {
      if (Object.hasOwn(option, field) && (type !== "number" || typeof option[field] !== "number" || !Number.isFinite(option[field]))) return false;
    }
    if (Object.hasOwn(option, "default") && !channelDefault(option["default"], type, option["multiple"])) return false;
  }
  return true;
}

function channel(value: unknown, servers: ReadonlySet<string>): boolean {
  if (!plain(value) || !hasOnlyKeys(value, channelFields) || !Object.hasOwn(value, "server") || !nonempty(value["server"]) || !servers.has(value["server"])) return false;
  if (Object.hasOwn(value, "displayName") && typeof value["displayName"] !== "string") return false;
  return !Object.hasOwn(value, "userConfig") || channelUserConfig(value["userConfig"]);
}

/** Validate unsupported plugin declarations while retaining only their bounded shape and count. */
export function observeUnsupportedPluginComponents(
  container: Readonly<Record<string, unknown>>,
  options: ObserveUnsupportedComponentOptions,
): UnsupportedComponentShapeResult {
  const observations: UnsupportedComponentShapeObservation[] = [];
  let omittedItems = 0;
  const observe = (
    field: PluginMarketplaceUnsupportedComponentField,
    value: unknown,
    validItem: (item: unknown) => boolean,
    allowSinglePath: boolean,
  ): void => {
    if (allowSinglePath && safePluginRelativePath(value)) {
      observations.push({ field, declaration: "string-shape", count: 1 });
      return;
    }
    if (!Array.isArray(value)) {
      options.reportInvalid(field, false);
      return;
    }
    omittedItems += Math.max(0, value.length - options.maximumItems);
    let count = 0;
    for (const item of value.slice(0, options.maximumItems)) {
      if (validItem(item)) count++;
      else options.reportInvalid(field, true);
    }
    if (count > 0 || value.length === 0) observations.push({ field, declaration: "array-shape", count });
  };

  for (const field of ["workflows", "outputStyles", "themes"] as const) {
    if (Object.hasOwn(container, field)) observe(field, container[field], safePluginRelativePath, true);
  }
  if (Object.hasOwn(container, "monitors")) observe("monitors", container["monitors"], monitor, true);
  if (Object.hasOwn(container, "channels")) {
    const servers = mcpServerNames(container);
    observe("channels", container["channels"], (item) => channel(item, servers), false);
  }

  if (Object.hasOwn(container, "experimental")) {
    const experimental = container["experimental"];
    if (!plain(experimental)) options.reportInvalid("experimental", false);
    else {
      if (Object.hasOwn(experimental, "themes")) observe("experimental.themes", experimental["themes"], safePluginRelativePath, true);
      if (Object.hasOwn(experimental, "monitors")) observe("experimental.monitors", experimental["monitors"], monitor, true);
    }
  }

  return { observations, omittedItems };
}
