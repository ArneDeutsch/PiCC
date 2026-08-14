import { routeCatalogPluginSource, routeMarketplaceSource } from "../source-matrix.js";
import type { CatalogPluginSource, MarketplaceRegistrationSource } from "../types.js";

export type GithubGitSource =
  | Extract<MarketplaceRegistrationSource, { readonly kind: "github" }>
  | Extract<CatalogPluginSource, { readonly kind: "github" }>;

export interface NormalizedGithubGitSource {
  readonly source: GithubGitSource;
  readonly url: string;
}

function githubUrl(repository: string): string {
  return `https://github.com/${repository}${repository.toLowerCase().endsWith(".git") ? "" : ".git"}`;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined);
}

export function normalizeGithubMarketplaceSource(value: unknown): NormalizedGithubGitSource | undefined {
  if (!plain(value)) return undefined;
  const candidate = value;
  const routed = routeMarketplaceSource({ source: "github", repo: candidate["repository"], ...(candidate["ref"] === undefined ? {} : { ref: candidate["ref"] }) });
  if (!routed.ok || routed.value.descriptor.kind !== "github") return undefined;
  const source = routed.value.descriptor;
  if (Object.getOwnPropertyNames(candidate).length !== Object.getOwnPropertyNames(source).length
    || candidate["kind"] !== source.kind || candidate["repository"] !== source.repository || candidate["ref"] !== source.ref) return undefined;
  return Object.freeze({ source, url: githubUrl(source.repository) });
}

export function normalizeGithubPluginSource(value: unknown): NormalizedGithubGitSource | undefined {
  if (!plain(value)) return undefined;
  const candidate = value;
  const routed = routeCatalogPluginSource({
    source: "github", repo: candidate["repository"],
    ...(candidate["ref"] === undefined ? {} : { ref: candidate["ref"] }),
    ...(candidate["sha"] === undefined ? {} : { sha: candidate["sha"] }),
  }, { marketplaceSourceKind: "local-directory" });
  if (!routed.ok || routed.value.descriptor.kind !== "github") return undefined;
  const source = routed.value.descriptor;
  if (Object.getOwnPropertyNames(candidate).length !== Object.getOwnPropertyNames(source).length
    || candidate["kind"] !== source.kind || candidate["repository"] !== source.repository
    || candidate["ref"] !== source.ref || candidate["sha"] !== source.sha) return undefined;
  return Object.freeze({ source, url: githubUrl(source.repository) });
}
