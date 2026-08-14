import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupAddress } from "node:dns";
import type { MarketplaceRegistrationSource, Sha256 } from "../types.js";
import {
  ACQUISITION_LIMITS,
  acquisitionFailure,
  exactMarketplaceSource,
  issueAcquisitionAuthorityForTrustedAdapter,
  issueMarketplaceSnapshotEvidence,
  parseBoundedJsonObject,
  type AcquisitionResult,
  type MarketplaceSnapshotEvidence,
  type ReviewedHttpIdentity,
} from "./common.js";

export const ACCEPTED_PUBLIC_HTTPS_PORTS = Object.freeze([443, 8443] as const);

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type HttpResolver = (hostname: string, signal: AbortSignal | undefined) => Promise<readonly ResolvedAddress[]>;

export interface PinnedHttpRequest {
  readonly url: URL;
  readonly address: ResolvedAddress;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMilliseconds: number;
  readonly maximumBodyBytes: number;
}

export interface PinnedHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type HttpConnector = (request: PinnedHttpRequest) => Promise<PinnedHttpResponse>;

export interface PublicHttpsFetchOptions {
  readonly resolver?: HttpResolver;
  readonly connector?: HttpConnector;
  readonly signal?: AbortSignal;
  readonly maximumBodyBytes?: number;
  readonly maximumRedirects?: number;
  readonly timeoutMilliseconds?: number;
}

export interface PublicHttpsResponse {
  readonly finalUrl: string;
  readonly reviewed: ReviewedHttpIdentity;
  readonly body: Uint8Array;
  readonly status: number;
  readonly redirectCount: number;
}

const prohibited = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) prohibited.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
  ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20], ["5f00::", 16], ["::ffff:0:0:0", 96], ["fc00::", 7], ["fec0::", 10], ["fe80::", 10], ["ff00::", 8],
] as const) prohibited.addSubnet(network, prefix, "ipv6");
prohibited.addAddress("168.63.129.16", "ipv4");

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (match !== null) return match[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

export function isPublicAddress(address: string): boolean {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !prohibited.check(address, "ipv4");
  if (family !== 6) return false;
  let canonical: string;
  try { canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return false; }
  const mapped = mappedIpv4(canonical);
  return mapped !== undefined ? !prohibited.check(mapped, "ipv4") : !prohibited.check(canonical, "ipv6");
}

const NON_PUBLIC_DNS_SUFFIXES = new Set([
  "localhost", "local", "localdomain", "lan", "home", "internal", "alt", "test", "example", "invalid", "onion", "arpa",
]);

function lexicalPublicHostname(hostname: string): boolean {
  const canonical = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const labels = canonical.toLowerCase().split(".");
  const topLevel = labels.at(-1) ?? "";
  return canonical.length <= 253 && labels.length >= 2 && !NON_PUBLIC_DNS_SUFFIXES.has(topLevel)
    && labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    && (/^[a-z]{2,63}$/.test(topLevel) || /^xn--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(topLevel));
}

function publicUrl(input: string): URL | undefined {
  try {
    const url = new URL(input);
    const port = url.port === "" ? 443 : Number(url.port);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (url.protocol !== "https:" || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "" || isIP(hostname) !== 0
      || !ACCEPTED_PUBLIC_HTTPS_PORTS.includes(port as 443 | 8443)
      || port === 0 || !lexicalPublicHostname(hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function reviewed(url: URL, redirectCount: number, address: ResolvedAddress): ReviewedHttpIdentity {
  const port = url.port === "" ? 443 : Number(url.port);
  return Object.freeze({
    kind: "https-destination", origin: url.origin, hostname: url.hostname, port,
    address: address.address, family: address.family,
    canonicalUrl: url.href, path: url.pathname, redirectCount, redirected: redirectCount > 0,
  });
}

function rejectCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
}

export const productionResolver: HttpResolver = async (hostname, signal) => {
  rejectCancelled(signal);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  rejectCancelled(signal);
  return addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
};

class NativeHttpFault extends Error {
  constructor(readonly kind: "download-limit" | "timeout") { super(kind); }
}

interface NativeTlsOptions {
  readonly ca?: string | Buffer | (string | Buffer)[];
}

async function nativePinnedRequest(request: PinnedHttpRequest, tls: NativeTlsOptions = {}): Promise<PinnedHttpResponse> {
  return await new Promise((resolve, reject) => {
    if (request.signal?.aborted === true) {
      reject(new DOMException("cancelled", "AbortError"));
      return;
    }
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const family = request.address.family;
    const nativeOptions: https.RequestOptions = {
      protocol: "https:",
      hostname: request.url.hostname,
      port: request.url.port === "" ? "443" : request.url.port,
      method: "GET",
      path: request.url.pathname,
      servername: request.url.hostname,
      rejectUnauthorized: true,
      agent: false,
      headers: Object.freeze({ Accept: "application/octet-stream", "User-Agent": "PiCC" }),
      lookup: ((_hostname: string, options: { readonly all?: boolean }, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
        if (options.all === true) callback(null, [{ address: request.address.address, family }]);
        else callback(null, request.address.address, family);
      }) as never,
      ...tls,
    };
    const req = https.request(nativeOptions, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const contentLength = Number(response.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > request.maximumBodyBytes) {
        response.destroy(new NativeHttpFault("download-limit"));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > request.maximumBodyBytes) response.destroy(new NativeHttpFault("download-limit"));
        else chunks.push(Buffer.from(chunk));
      });
      response.on("error", fail);
      response.on("end", () => {
        if (settled) return;
        settled = true;
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
          else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
        }
        resolve(Object.freeze({ status: response.statusCode ?? 0, headers: Object.freeze(headers), body: Buffer.concat(chunks) }));
      });
    });
    const timer = setTimeout(() => req.destroy(new NativeHttpFault("timeout")), request.timeoutMilliseconds);
    timer.unref();
    const abort = (): void => { req.destroy(new DOMException("cancelled", "AbortError")); };
    request.signal?.addEventListener("abort", abort, { once: true });
    req.on("error", fail);
    req.on("close", () => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
    });
    req.end();
  });
}

export const productionHttpsConnector: HttpConnector = nativePinnedRequest;

declare const witnessBrand: unique symbol;
export interface PrevalidatedNativeEndpoint {
  readonly [witnessBrand]: true;
}
interface WitnessDetails {
  readonly hostname: string;
  readonly port: number;
  readonly address: ResolvedAddress;
  readonly ca: string | Buffer | (string | Buffer)[];
}
const witnessEndpoints = new WeakMap<PrevalidatedNativeEndpoint, WitnessDetails>();

export function issuePrevalidatedNativeEndpointForWitness(details: WitnessDetails): PrevalidatedNativeEndpoint {
  if (process.env["VITEST"] !== "true") throw new Error("Native witness endpoints are unavailable outside the focused test host");
  if ((details.hostname !== "connector-witness.test" && details.hostname !== "connector-witness.test.")
    || (details.address.address !== "127.0.0.1" && details.address.address !== "::1")
    || details.port < 1 || details.port > 65535) throw new Error("Invalid guarded native witness endpoint");
  const capability = Object.freeze({}) as PrevalidatedNativeEndpoint;
  witnessEndpoints.set(capability, Object.freeze({ ...details, address: Object.freeze({ ...details.address }) }));
  return capability;
}

export async function connectPrevalidatedNativeEndpointForWitness(
  endpoint: PrevalidatedNativeEndpoint,
  options: { readonly signal?: AbortSignal; readonly timeoutMilliseconds?: number; readonly maximumBodyBytes?: number } = {},
): Promise<PinnedHttpResponse> {
  const details = witnessEndpoints.get(endpoint);
  if (details === undefined) throw new Error("Unissued native witness endpoint");
  const hostname = details.hostname.endsWith(".") ? details.hostname.slice(0, -1) : details.hostname;
  return await nativePinnedRequest({
    url: new URL(`https://${hostname}:${details.port}/witness`),
    address: details.address,
    signal: options.signal,
    timeoutMilliseconds: options.timeoutMilliseconds ?? 2_000,
    maximumBodyBytes: options.maximumBodyBytes ?? 1024,
  }, { ca: details.ca });
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("cancelled", "AbortError");
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException("cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

export async function fetchPublicHttps(
  input: string,
  options: PublicHttpsFetchOptions = {},
): Promise<AcquisitionResult<PublicHttpsResponse>> {
  const resolver = options.resolver ?? productionResolver;
  const connector = options.connector ?? productionHttpsConnector;
  const maximumBodyBytes = options.maximumBodyBytes ?? ACQUISITION_LIMITS.maximumDownloadBytes;
  const maximumRedirects = options.maximumRedirects ?? ACQUISITION_LIMITS.maximumRedirects;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? ACQUISITION_LIMITS.timeoutMilliseconds;
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1
    || !Number.isSafeInteger(maximumRedirects) || maximumRedirects < 0
    || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    return acquisitionFailure("unsafe-source", "HTTP acquisition limits are invalid");
  }
  let current = publicUrl(input);
  if (current === undefined) return acquisitionFailure("unsafe-source", "The HTTP destination is not an admitted public HTTPS URL");
  const visited = new Set<string>();
  const operation = new AbortController();
  const cancelOperation = (): void => operation.abort();
  options.signal?.addEventListener("abort", cancelOperation, { once: true });
  if (options.signal?.aborted === true) operation.abort();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; operation.abort(); }, timeoutMilliseconds);
  timeout.unref();
  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      if (operation.signal.aborted) throw new DOMException("cancelled", "AbortError");
      if (visited.has(current.href)) return acquisitionFailure("network-failure", "The HTTP redirect chain contains a loop");
      visited.add(current.href);
      const addresses = await abortable(resolver(current.hostname, operation.signal), operation.signal);
      if (addresses.length === 0 || addresses.some((entry) => entry.family !== isIP(entry.address) || !isPublicAddress(entry.address))) {
        return acquisitionFailure("unsafe-source", "The HTTP destination did not resolve exclusively to admitted public addresses");
      }
      const response = await abortable(connector({
        url: current,
        address: Object.freeze({ ...addresses[0]! }),
        signal: operation.signal,
        timeoutMilliseconds,
        maximumBodyBytes,
      }), operation.signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= maximumRedirects) return acquisitionFailure("network-failure", "The HTTP redirect limit was exceeded");
        const location = response.headers["location"];
        if (location === undefined || location.length > 2048) return acquisitionFailure("network-failure", "The HTTP redirect response omitted or exceeded its bounded destination");
        const next = publicUrl(new URL(location, current).href);
        if (next === undefined) return acquisitionFailure("unsafe-source", "The HTTP redirect destination is not admitted");
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300 || response.body.byteLength > maximumBodyBytes) {
        return acquisitionFailure(response.body.byteLength > maximumBodyBytes ? "download-limit" : "network-failure", response.body.byteLength > maximumBodyBytes ? "The HTTP response exceeds the download limit" : "The HTTP response status is not an admitted success");
      }
      return { ok: true, value: Object.freeze({
        finalUrl: current.href,
        reviewed: reviewed(current, redirectCount, addresses[0]!),
        body: Uint8Array.from(response.body),
        status: response.status,
        redirectCount,
      }) };
    }
  } catch (error) {
    if (options.signal?.aborted === true) return acquisitionFailure("cancelled", "HTTP acquisition was cancelled");
    if (timedOut || (error instanceof NativeHttpFault && error.kind === "timeout")) return acquisitionFailure("timeout", "The bounded HTTPS request timed out");
    if (error instanceof NativeHttpFault && error.kind === "download-limit") return acquisitionFailure("download-limit", "The HTTP response exceeds the download limit");
    return acquisitionFailure("network-failure", "The bounded HTTPS request failed");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelOperation);
  }
}

function digestBytes(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function acquireHttpsCatalogDescriptor(
  source: MarketplaceRegistrationSource,
  options: PublicHttpsFetchOptions = {},
): Promise<AcquisitionResult<MarketplaceSnapshotEvidence>> {
  const exactSource = exactMarketplaceSource(source);
  if (exactSource === undefined || exactSource.kind !== "https-catalog") return acquisitionFailure("unsafe-source", "The source is not an exact HTTPS catalog declaration");
  const fetched = await fetchPublicHttps(exactSource.url, { ...options, maximumBodyBytes: Math.min(options.maximumBodyBytes ?? ACQUISITION_LIMITS.maximumCatalogBytes, ACQUISITION_LIMITS.maximumCatalogBytes) });
  if (!fetched.ok) return fetched;
  if (parseBoundedJsonObject(fetched.value.body) === undefined) {
    return acquisitionFailure("invalid-catalog", "The HTTPS catalog response is not a bounded JSON object");
  }
  const catalogDigest = digestBytes(fetched.value.body);
  return { ok: true, value: issueMarketplaceSnapshotEvidence({
    kind: "marketplace-snapshot",
    source: exactSource,
    snapshotId: `marketplace-${createHash("sha256").update(`${catalogDigest}\0${fetched.value.finalUrl}`).digest("base64url")}`,
    catalogDigest,
    provenance: Object.freeze({
      adapter: "public-https-catalog",
      reviewed: fetched.value.reviewed,
      artifactDigest: catalogDigest,
      selectedRoot: Object.freeze({ requested: "catalog-document", path: "", usedSingleWrapper: false }),
    }),
  }, { catalog: fetched.value.body }, issueAcquisitionAuthorityForTrustedAdapter("public-https-catalog")) };
}
