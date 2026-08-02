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
  readonly reportOmitted: (field: string) => void;
}

type Validation = "valid" | "invalid" | "omitted";

const MAX_SCALAR_LENGTH = 512;
const MAX_PATH_SEGMENTS = 64;
const MAX_MCP_SERVER_KEYS = 64;
const MAX_USER_CONFIG_OPTIONS = 64;
const MAX_DEFAULT_ARRAY_ITEMS = 64;

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonempty(value: unknown): Validation {
  if (typeof value !== "string") return "invalid";
  if (value.length > MAX_SCALAR_LENGTH) return "omitted";
  return value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value) ? "valid" : "invalid";
}

function combine(...results: readonly Validation[]): Validation {
  if (results.includes("omitted")) return "omitted";
  return results.includes("invalid") ? "invalid" : "valid";
}

function safePluginRelativePath(value: unknown): Validation {
  if (typeof value !== "string") return "invalid";
  if (value.length > MAX_SCALAR_LENGTH) return "omitted";
  if (!value.startsWith("./") || value.startsWith("././") || /[\\?#\u0000-\u001f\u007f]/u.test(value)) return "invalid";
  let start = 2;
  let segments = 0;
  for (let index = 2; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== "/") continue;
    segments += 1;
    if (segments > MAX_PATH_SEGMENTS) return "omitted";
    const part = value.slice(start, index);
    if (part === "" || part === "." || part === ".." || part.includes(":")) return "invalid";
    start = index + 1;
  }
  return segments > 0 ? "valid" : "invalid";
}

function hasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (count > allowed.size || !allowed.has(key)) return false;
  }
  return true;
}

const monitorFields = new Set(["name", "command", "description", "when"]);

function monitorWhen(value: unknown): Validation {
  if (value === "always") return "valid";
  if (typeof value !== "string") return "invalid";
  if (value.length > MAX_SCALAR_LENGTH) return "omitted";
  if (!value.startsWith("on-skill-invoke:")) return "invalid";
  return nonempty(value.slice("on-skill-invoke:".length));
}

function monitor(value: unknown): Validation {
  if (typeof value === "string") return safePluginRelativePath(value);
  if (!plain(value) || !hasOnlyKeys(value, monitorFields)) return "invalid";
  return combine(
    nonempty(value["name"]),
    nonempty(value["command"]),
    nonempty(value["description"]),
    Object.hasOwn(value, "when") ? monitorWhen(value["when"]) : "valid",
  );
}

interface McpServerNames {
  readonly names: ReadonlySet<string>;
  readonly complete: boolean;
}

function mcpServerNames(container: Readonly<Record<string, unknown>>): McpServerNames {
  const raw = container["mcpServers"];
  if (!plain(raw)) return { names: new Set(), complete: true };
  const names = new Set<string>();
  let count = 0;
  for (const key in raw) {
    if (!Object.hasOwn(raw, key)) continue;
    count += 1;
    if (count > MAX_MCP_SERVER_KEYS) return { names, complete: false };
    if (nonempty(key) === "valid") names.add(key);
  }
  return { names, complete: true };
}

const channelOptionTypes = new Set(["string", "number", "boolean", "directory", "file"]);
const channelOptionFields = new Set(["type", "title", "description", "required", "default", "multiple", "sensitive", "min", "max"]);
const channelFields = new Set(["server", "displayName", "userConfig"]);

function channelDefault(value: unknown, type: string, multiple: unknown): Validation {
  if (Array.isArray(value)) {
    if (value.length > MAX_DEFAULT_ARRAY_ITEMS) return "omitted";
    if (type !== "string" || multiple !== true) return "invalid";
    return combine(...value.map((item) => {
      if (typeof item !== "string") return "invalid";
      return item.length > MAX_SCALAR_LENGTH ? "omitted" : "valid";
    }));
  }
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? "valid" : "invalid";
  if (type === "boolean") return typeof value === "boolean" ? "valid" : "invalid";
  if (typeof value !== "string") return "invalid";
  return value.length > MAX_SCALAR_LENGTH ? "omitted" : "valid";
}

function channelUserConfig(value: unknown): Validation {
  if (!plain(value)) return "invalid";
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    if (count > MAX_USER_CONFIG_OPTIONS) return "omitted";
  }
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (key.length > MAX_SCALAR_LENGTH) return "omitted";
    const option = value[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !plain(option) || !hasOnlyKeys(option, channelOptionFields)) return "invalid";
    const type = option["type"];
    if (!Object.hasOwn(option, "type") || typeof type !== "string" || !channelOptionTypes.has(type)) return "invalid";
    const labels = combine(
      Object.hasOwn(option, "title") ? nonempty(option["title"]) : "invalid",
      Object.hasOwn(option, "description") ? nonempty(option["description"]) : "invalid",
    );
    if (labels !== "valid") return labels;
    for (const field of ["sensitive", "required"] as const) {
      if (Object.hasOwn(option, field) && typeof option[field] !== "boolean") return "invalid";
    }
    if (Object.hasOwn(option, "multiple") && (typeof option["multiple"] !== "boolean" || type !== "string")) return "invalid";
    for (const field of ["min", "max"] as const) {
      if (Object.hasOwn(option, field) && (type !== "number" || typeof option[field] !== "number" || !Number.isFinite(option[field]))) return "invalid";
    }
    if (Object.hasOwn(option, "default")) {
      const result = channelDefault(option["default"], type, option["multiple"]);
      if (result !== "valid") return result;
    }
  }
  return "valid";
}

function channel(value: unknown, servers: McpServerNames): Validation {
  if (!plain(value) || !hasOnlyKeys(value, channelFields) || !Object.hasOwn(value, "server")) return "invalid";
  const server = nonempty(value["server"]);
  if (server !== "valid") return server;
  if (!servers.names.has(value["server"] as string)) return servers.complete ? "invalid" : "omitted";
  if (Object.hasOwn(value, "displayName")) {
    if (typeof value["displayName"] !== "string") return "invalid";
    if (value["displayName"].length > MAX_SCALAR_LENGTH) return "omitted";
  }
  return Object.hasOwn(value, "userConfig") ? channelUserConfig(value["userConfig"]) : "valid";
}

/** Validate unsupported plugin declarations while retaining only their bounded shape and count. */
export function observeUnsupportedPluginComponents(
  container: Readonly<Record<string, unknown>>,
  options: ObserveUnsupportedComponentOptions,
): UnsupportedComponentShapeResult {
  const observations: UnsupportedComponentShapeObservation[] = [];
  let omittedItems = 0;
  const omit = (field: string): void => {
    omittedItems += 1;
    options.reportOmitted(field);
  };
  const observe = (
    field: PluginMarketplaceUnsupportedComponentField,
    value: unknown,
    validateItem: (item: unknown) => Validation,
    allowSinglePath: boolean,
  ): void => {
    if (allowSinglePath && typeof value === "string") {
      const result = safePluginRelativePath(value);
      if (result === "valid") observations.push({ field, declaration: "string-shape", count: 1 });
      else if (result === "omitted") omit(field);
      else options.reportInvalid(field, false);
      return;
    }
    if (!Array.isArray(value)) {
      options.reportInvalid(field, false);
      return;
    }
    omittedItems += Math.max(0, value.length - options.maximumItems);
    let count = 0;
    for (const item of value.slice(0, options.maximumItems)) {
      const result = validateItem(item);
      if (result === "valid") count += 1;
      else if (result === "omitted") omit(field);
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
