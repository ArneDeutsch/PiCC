const QUALIFIED_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const MAX_QUALIFIED_PLUGIN_ID_LENGTH = 256;

export interface ParsedQualifiedPluginId {
  qualifiedIdentity: string;
  lifecycleName: string;
  marketplaceName: string;
}

export function isQualifiedPluginId(value: string): boolean {
  return QUALIFIED_PLUGIN_ID.test(value);
}

export function parseQualifiedPluginId(
  value: unknown,
  maximumLength = MAX_QUALIFIED_PLUGIN_ID_LENGTH,
): ParsedQualifiedPluginId | undefined {
  if (
    !Number.isSafeInteger(maximumLength) ||
    maximumLength < 1 ||
    typeof value !== "string" ||
    value.length > maximumLength ||
    !isQualifiedPluginId(value)
  ) {
    return undefined;
  }
  const separator = value.indexOf("@");
  return {
    qualifiedIdentity: value,
    lifecycleName: value.slice(0, separator),
    marketplaceName: value.slice(separator + 1),
  };
}
