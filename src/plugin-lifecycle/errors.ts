export type LifecycleErrorCode =
  | "unsupported-source"
  | "unsafe-descriptor"
  | "invalid-relative-path"
  | "relative-source-unavailable"
  | "invalid-identity"
  | "invalid-location";

export interface LifecycleContractError {
  readonly code: LifecycleErrorCode;
  readonly message: string;
}

export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: LifecycleContractError };

export function lifecycleError(code: LifecycleErrorCode, message: string): ContractResult<never> {
  return { ok: false, error: Object.freeze({ code, message }) };
}
