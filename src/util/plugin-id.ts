const QUALIFIED_PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isQualifiedPluginId(value: string): boolean {
  return QUALIFIED_PLUGIN_ID.test(value);
}
