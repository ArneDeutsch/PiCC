import tls from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_PUBLIC_HTTPS_PORTS,
  acquireHttpsCatalogDescriptor,
  connectPrevalidatedNativeEndpointForWitness,
  fetchPublicHttps,
  isPublicAddress,
  issuePrevalidatedNativeEndpointForWitness,
  type HttpConnector,
  type HttpResolver,
} from "../src/plugin-lifecycle/acquisition/http.js";
import { issueAcquisitionAuthorityForTrustedAdapter, issueMarketplaceSnapshotEvidence } from "../src/plugin-lifecycle/acquisition/common.js";
import { acquireMarketplaceRelativePlugin, createMarketplaceGeneration } from "../src/plugin-lifecycle/marketplace-generation.js";
import type { OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCQ7kMxcCyyCJEl
U5mr08wVUYrFyOafCg09NFMbTmm7BfRaocm7mB+3HcHXAlcKQikQe5SSiMh25rf6
sIMonC2LSWyqU0+dp3RnPT9u6oo7aFHlR3rT6RO2iSerAxTx1VAOitMQLrLUB2Te
/SzZaK0vEfPrB1YhQAFd5jKyJUdPSsMlh1cgPuaTAenLcF9LxzYGuG/242jg2omB
yw+ib1UG8OGcRlbDksYWyKllBCbi7bOGBjhzta+hn9PYdB3FH1c5oG34X15e+o+a
lIXm5nmtFgL5UJQHJTUXiDPAVTY0zuzLrwpzCb616jg4b3IalnLpdjTSUhXahPGt
TO4blzPFAgMBAAECggEABlDDpSYIuedX/9g77uS8qhnSt29bkVxG8Gmqd3BReNYN
Fwf2z6cU4WNkEiz8GFUtZJZQsUP8TFDIfUhE0Y0LX7Ge5nCD8dBIE8RI/S8uP+F6
CXOLHYHfcImwgf9mjGqUYasuAFtbQpRh57pWQnu7vucu3wkuTnueCPaiMz4e9Ixc
2DLHcf0rYTnasMoqn1KULl73xfRD6RlPJoS7xcvaeCJid/sikRfyHKmctbT+xdaN
tFuoeV4uylMPNSKLYf/zWenxreK4Ff2wusxb6ozbDHgFYDYWr+c3AruATUNnjxj0
QeZb3zRVlnOXxFcui3uslotK9uYjhzHA4+GYvu9iYQKBgQDFLto83W7y4eJ8fg5v
5OvCQRXI1XDWMlF2if/Vq4S3Ut5uOpiAbffEdsbkOt5Yf02nULHilkLY50GdKKzN
3xldrXz6hUcbHJExHxsPTEtMEmHix2fQbJZNDbC0sOmbMbtsORQj95lD3zZSUg6R
V767vGKlCimU2UPNvLRZJUN6VQKBgQC8KVttOstJk9GruXFYq9kPvLASNsOEHMJk
ZHbVR6v6WTvisqzoG4/QCzZmo66/7VRXi21Ul8Dm6FZlpCHsNrNHgKNQzbskpKIq
s19nQOksBX1iSNDS9oYZc0ncP5Goveq6gkPZctwzxcJiqAmjOP/1P3aous6wqgIo
8plkZ14jsQKBgAc1e00WW2QN1hXvFeAJYoUrk/xPsVxjYo8O5IePSb7aDL/C7Khl
XNWV8heN/2sE3HXtgVNjYvZDHib8wbSVH3xJR3RxQvQ+yyAcnwSkKWySj3mXCLiZ
/7S5d2hjv2apHs0KGS5ncvcERhwkW9v8dUCv1ntqL7L9bnkrGPzZW+oxAoGAN1/Y
dznhT8L/5pDJqbXRSI9YJdQWEBBCqTbjvfq8ww110U6SEjDiTvCtzuEG8ZbPxn/S
6h1K+OmRW5JFJXYnprhV19bj53HIA9cMEaAJvxnSf5U8V4mTh3PlXbsbi9RwevkR
LLJf2aCuh0g6pd2FflByBFANufIedpyGxgShsNECgYAqCkyKcpQf901gRtrXffV3
6wia6daLxtWYLU9pLQi09ib7FGfLdovbs3+8Ogc/5tuoHivSirb9/STZ3bfgopxK
p7eF474V6ib28o1/9nzf1k3J5N0k5ko9YK2xfCE0nw8bIFzqhquRl3+HoSiqCTbe
C/fmZzPlxXPmqVWjXXKHcQ==
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIDRjCCAi6gAwIBAgIUXYdW0l3b1hj72cL13JVMIXW7elkwDQYJKoZIhvcNAQEL
BQAwITEfMB0GA1UEAwwWY29ubmVjdG9yLXdpdG5lc3MudGVzdDAeFw0yNjA4MTEx
NDEwNTRaFw0zNjA4MDgxNDEwNTRaMCExHzAdBgNVBAMMFmNvbm5lY3Rvci13aXRu
ZXNzLnRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCQ7kMxcCyy
CJElU5mr08wVUYrFyOafCg09NFMbTmm7BfRaocm7mB+3HcHXAlcKQikQe5SSiMh2
5rf6sIMonC2LSWyqU0+dp3RnPT9u6oo7aFHlR3rT6RO2iSerAxTx1VAOitMQLrLU
B2Te/SzZaK0vEfPrB1YhQAFd5jKyJUdPSsMlh1cgPuaTAenLcF9LxzYGuG/242jg
2omByw+ib1UG8OGcRlbDksYWyKllBCbi7bOGBjhzta+hn9PYdB3FH1c5oG34X15e
+o+alIXm5nmtFgL5UJQHJTUXiDPAVTY0zuzLrwpzCb616jg4b3IalnLpdjTSUhXa
hPGtTO4blzPFAgMBAAGjdjB0MB0GA1UdDgQWBBTn+qrKvrIaH+halrjCRtAPfflg
ojAfBgNVHSMEGDAWgBTn+qrKvrIaH+halrjCRtAPfflgojAPBgNVHRMBAf8EBTAD
AQH/MCEGA1UdEQQaMBiCFmNvbm5lY3Rvci13aXRuZXNzLnRlc3QwDQYJKoZIhvcN
AQELBQADggEBAIOTqoVyWvu/OlBZ9uB6/LP1EUg3ApOuIZ8wL/ib87vVBvCpkZNw
QB/qr7GvuJMPWJTj8wHdl/1GAFtJ2HEdpQitA4o3IWuIkNI2QkoUmrsB7r0hN0+t
U79IyvY9D471Q5nypHDv0val/iIXOJtN+4ZkWeaq2VyxGOY1GeCX5E+9IuGEHCVs
uSazaVTqfGI0lDEm/f0GFIjnnRTMTA4y0vXXT92ILUZKxIgEoaBtFn/orUOOn5ZL
CrjN8Mg3mJwjHBArRSH1IJ84aSO7F0rT+cbg/zwvVmvWYwxLY28bFu6SzUPfSRQl
bCK58f4Rx1BrNyfEONTj13P2eJhWF84CkvY=
-----END CERTIFICATE-----`;

const originalProxy = process.env["HTTPS_PROXY"];
afterEach(() => {
  if (originalProxy === undefined) delete process.env["HTTPS_PROXY"];
  else process.env["HTTPS_PROXY"] = originalProxy;
});

const publicResolver: HttpResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const okConnector = (body = "{}", status = 200, headers: Record<string, string> = {}): HttpConnector => async () => ({
  status, headers, body: Buffer.from(body),
});

interface ProhibitedRangeRow {
  readonly family: 4 | 6;
  readonly network: string;
  readonly prefix: number;
  readonly composition: string;
}

// This independent policy fixture deliberately records overlap at adjacent boundaries: a range's
// predecessor/successor is judged against the complete union, not presumed public.
const PROHIBITED_RANGE_ROWS: readonly ProhibitedRangeRow[] = [
  { family: 4, network: "0.0.0.0", prefix: 8, composition: "predecessor is the IPv4 floor" },
  { family: 4, network: "10.0.0.0", prefix: 8, composition: "isolated from other prohibited IPv4 ranges" },
  { family: 4, network: "100.64.0.0", prefix: 10, composition: "isolated shared-address space" },
  { family: 4, network: "127.0.0.0", prefix: 8, composition: "isolated loopback range" },
  { family: 4, network: "169.254.0.0", prefix: 16, composition: "Azure metadata singleton lies below this range" },
  { family: 4, network: "172.16.0.0", prefix: 12, composition: "isolated private range" },
  { family: 4, network: "192.0.0.0", prefix: 24, composition: "separate from later 192/8 special ranges" },
  { family: 4, network: "192.0.2.0", prefix: 24, composition: "documentation range" },
  { family: 4, network: "192.88.99.0", prefix: 24, composition: "deprecated relay range" },
  { family: 4, network: "192.168.0.0", prefix: 16, composition: "private range" },
  { family: 4, network: "198.18.0.0", prefix: 15, composition: "benchmark range" },
  { family: 4, network: "198.51.100.0", prefix: 24, composition: "documentation range" },
  { family: 4, network: "203.0.113.0", prefix: 24, composition: "documentation range" },
  { family: 4, network: "224.0.0.0", prefix: 4, composition: "successor enters the adjacent 240/4 range" },
  { family: 4, network: "240.0.0.0", prefix: 4, composition: "predecessor is covered by 224/4; successor is the IPv4 ceiling" },
  { family: 6, network: "::", prefix: 96, composition: "predecessor is the IPv6 floor; ::1 singleton overlaps" },
  { family: 6, network: "::1", prefix: 128, composition: "singleton overlaps ::/96" },
  { family: 6, network: "64:ff9b::", prefix: 96, composition: "well-known NAT64 prefix" },
  { family: 6, network: "64:ff9b:1::", prefix: 48, composition: "local-use NAT64 prefix" },
  { family: 6, network: "100::", prefix: 64, composition: "discard-only prefix" },
  { family: 6, network: "2001::", prefix: 23, composition: "IETF special-purpose block; separate from 2001:db8::/32" },
  { family: 6, network: "2001:db8::", prefix: 32, composition: "documentation range outside 2001::/23" },
  { family: 6, network: "2002::", prefix: 16, composition: "deprecated 6to4 prefix" },
  { family: 6, network: "3fff::", prefix: 20, composition: "documentation prefix" },
  { family: 6, network: "5f00::", prefix: 16, composition: "segment-routing prefix" },
  { family: 6, network: "::ffff:0:0:0", prefix: 96, composition: "IPv4-translatable prefix; distinct from ordinary ::ffff: mapped addresses" },
  { family: 6, network: "fc00::", prefix: 7, composition: "unique-local range" },
  { family: 6, network: "fec0::", prefix: 10, composition: "predecessor is covered by adjacent fe80::/10" },
  { family: 6, network: "fe80::", prefix: 10, composition: "successor is covered by adjacent fec0::/10" },
  { family: 6, network: "ff00::", prefix: 8, composition: "multicast range; successor is the IPv6 ceiling" },
];
const PROHIBITED_SINGLETON_ROWS = [
  { family: 4 as const, address: "168.63.129.16", composition: "Azure metadata address outside the adjacent CIDRs" },
];

function addressNumber(address: string, family: 4 | 6): bigint {
  if (family === 4) return address.split(".").reduce((value, part) => (value << 8n) | BigInt(part), 0n);
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left = "", right = ""] = canonical.split("::");
  const leftParts = left === "" ? [] : left.split(":");
  const rightParts = right === "" ? [] : right.split(":");
  const parts = canonical.includes("::")
    ? [...leftParts, ...Array<string>(8 - leftParts.length - rightParts.length).fill("0"), ...rightParts]
    : leftParts;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function formatAddress(value: bigint, family: 4 | 6): string {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
  return Array.from({ length: 8 }, (_, index) => Number((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16)).join(":");
}

function independentlyProhibited(value: bigint, family: 4 | 6): boolean {
  return PROHIBITED_RANGE_ROWS.some((row) => {
    if (row.family !== family) return false;
    const bits = family === 4 ? 32 : 128;
    const first = addressNumber(row.network, family);
    const last = first + (1n << BigInt(bits - row.prefix)) - 1n;
    return value >= first && value <= last;
  }) || PROHIBITED_SINGLETON_ROWS.some((row) => row.family === family && addressNumber(row.address, family) === value);
}

describe("shared public HTTPS policy", () => {
  it("matches every prohibited CIDR and singleton at first, last, predecessor, and successor boundaries", () => {
    for (const row of PROHIBITED_RANGE_ROWS) {
      expect(row.composition.length, `${row.network}/${row.prefix} documents adjacent composition`).toBeGreaterThan(0);
      const bits = row.family === 4 ? 32 : 128;
      const maximum = (1n << BigInt(bits)) - 1n;
      const first = addressNumber(row.network, row.family);
      const last = first + (1n << BigInt(bits - row.prefix)) - 1n;
      const points = [first === 0n ? undefined : first - 1n, first, last, last === maximum ? undefined : last + 1n];
      for (const [position, point] of points.entries()) {
        if (point === undefined) continue;
        expect(isPublicAddress(formatAddress(point, row.family)), `${row.network}/${row.prefix} boundary ${position}`)
          .toBe(!independentlyProhibited(point, row.family));
      }
    }
    for (const row of PROHIBITED_SINGLETON_ROWS) {
      expect(row.composition.length).toBeGreaterThan(0);
      const point = addressNumber(row.address, row.family);
      for (const [position, candidate] of [point - 1n, point, point, point + 1n].entries()) {
        expect(isPublicAddress(formatAddress(candidate, row.family)), `${row.address} boundary ${position}`)
          .toBe(!independentlyProhibited(candidate, row.family));
      }
    }
  });

  it("preserves mapped IPv4 policy while rejecting IPv4-translatable and NAT64 embeddings", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:10.0.0.1")).toBe(false);
    expect(isPublicAddress("::ffff:0:8.8.8.8")).toBe(false);
    expect(isPublicAddress("::ffff:0:10.0.0.1")).toBe(false);
    expect(isPublicAddress("64:ff9b::8.8.8.8")).toBe(false);
    expect(isPublicAddress("64:ff9b::10.0.0.1")).toBe(false);
    expect(isPublicAddress("fe80::1%eth0")).toBe(false);
  });

  it("admits only credential-free, query-free public HTTPS URLs on the explicit port set", async () => {
    expect(ACCEPTED_PUBLIC_HTTPS_PORTS).toEqual([443, 8443]);
    for (const url of ["https://public.example.org/file", "https://public.example.org:443/file", "https://public.example.org:8443/file"]) {
      expect((await fetchPublicHttps(url, { resolver: publicResolver, connector: okConnector() })).ok).toBe(true);
    }
    const secret = "credential-canary";
    for (const url of [
      "http://public.example.org/file", "https://public.example.org:0/file", "https://public.example.org:444/file",
      "https://127.0.0.1/file", "https://[::1]/file", `https://user:${secret}@public.example.org/file`,
      `https://public.example.org/file?token=${secret}`, `https://public.example.org/file#${secret}`,
    ]) {
      const result = await fetchPublicHttps(url, { resolver: publicResolver, connector: okConnector() });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    const rawFailure = await fetchPublicHttps("https://public.example.org/file", {
      resolver: publicResolver,
      connector: async () => { throw new Error(secret); },
    });
    expect(rawFailure.ok).toBe(false);
    expect(JSON.stringify(rawFailure)).not.toContain(secret);
  });

  it("rejects any unsafe DNS answer and re-resolves every redirect hop before connecting", async () => {
    const calls: string[] = [];
    const resolver: HttpResolver = async (hostname) => {
      calls.push(hostname);
      return calls.length === 1
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    };
    let connections = 0;
    const connector: HttpConnector = async (request) => {
      connections += 1;
      expect(request.address.address).toBe("93.184.216.34");
      return { status: 302, headers: { location: "https://second.example.org/final" }, body: new Uint8Array() };
    };
    expect(await fetchPublicHttps("https://first.example.org/start", { resolver, connector })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(calls).toEqual(["first.example.org", "second.example.org"]);
    expect(connections).toBe(1);

    expect((await fetchPublicHttps("https://public.example.org/file", {
      resolver: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }],
      connector: okConnector(),
    })).ok).toBe(false);
  });

  it("handles admitted cross-origin redirects while rejecting downgrade, loops, excess, and bodies", async () => {
    const destinations: string[] = [];
    const connector: HttpConnector = async ({ url }) => {
      destinations.push(url.hostname);
      if (url.hostname === "one.example.org") return { status: 302, headers: { location: "https://two.example.org/final" }, body: new Uint8Array() };
      return { status: 200, headers: Object.freeze({}) as Readonly<Record<string, string>>, body: Buffer.from("done") };
    };
    expect(await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector })).toMatchObject({ ok: true, value: { redirectCount: 1, finalUrl: "https://two.example.org/final" } });
    expect(destinations).toEqual(["one.example.org", "two.example.org"]);
    expect((await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector: okConnector("", 302, { location: "http://two.example.org/" }) })).ok).toBe(false);
    expect((await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector: okConnector("", 302, { location: "https://one.example.org/start" }) })).ok).toBe(false);
    expect((await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector: okConnector("", 302, { location: "https://two.example.org/" }), maximumRedirects: 0 })).ok).toBe(false);
    expect(await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector: okConnector("excess"), maximumBodyBytes: 2 })).toEqual({
      ok: false, error: { code: "download-limit", message: "The HTTP response exceeds the download limit" },
    });
  });

  it("revalidates every redirect status, relative and cross-origin target, including same-host rebinding", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const resolved: string[] = [];
      const result = await fetchPublicHttps("https://one.example.org/start", {
        resolver: async (hostname) => { resolved.push(hostname); return publicResolver(hostname, undefined); },
        connector: (async ({ url }) => url.pathname === "/start"
          ? { status, headers: { location: "/final" }, body: new Uint8Array() }
          : { status: 200, headers: Object.freeze({}) as Readonly<Record<string, string>>, body: Buffer.from("ok") }) as HttpConnector,
      });
      expect(result).toMatchObject({ ok: true, value: { finalUrl: "https://one.example.org/final", redirectCount: 1, reviewed: { redirected: true } } });
      expect(resolved).toEqual(["one.example.org", "one.example.org"]);
    }
    let calls = 0;
    expect(await fetchPublicHttps("https://same.example.org/start", {
      resolver: async () => (++calls === 1 ? [{ address: "8.8.8.8", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
      connector: okConnector("", 302, { location: "/next" }),
    })).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect((await fetchPublicHttps("https://one.example.org/start", { resolver: publicResolver, connector: okConnector("", 302, { location: "https://two.example.org:444/final" }) })).ok).toBe(false);
  });

  it("bounds a resolver that ignores cancellation and classifies explicit cancellation separately", async () => {
    const never: HttpResolver = async () => await new Promise<never>(() => {});
    expect(await fetchPublicHttps("https://public.example.org/file", {
      resolver: never,
      connector: okConnector(),
      timeoutMilliseconds: 20,
    })).toMatchObject({ ok: false, error: { code: "timeout" } });

    const controller = new AbortController();
    let entered!: () => void;
    const resolverEntered = new Promise<void>((resolve) => { entered = resolve; });
    const pending = fetchPublicHttps("https://public.example.org/file", {
      resolver: async () => { entered(); return await new Promise<never>(() => {}); },
      connector: okConnector(), signal: controller.signal,
    });
    await resolverEntered;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("requires adapter authority and bounded exact inputs at the generic marketplace evidence issuer", () => {
    const base = {
      kind: "marketplace-snapshot", source: { kind: "https-catalog", url: "https://catalog.example.org/marketplace.json" },
      snapshotId: "marketplace-test", catalogDigest: `sha256:${"0".repeat(64)}`,
      provenance: { adapter: "public-https-catalog", reviewed: {}, artifactDigest: `sha256:${"0".repeat(64)}`, selectedRoot: { requested: "catalog-document", path: "", usedSingleWrapper: false } },
    } as const;
    expect(() => issueMarketplaceSnapshotEvidence(base as never, { catalog: Buffer.from("not-json") }, issueAcquisitionAuthorityForTrustedAdapter("public-https-catalog"))).toThrow();
    expect(() => issueMarketplaceSnapshotEvidence({ ...base, source: { ...base.source, canary: "credential" } } as never, { catalog: Buffer.from("{}") }, issueAcquisitionAuthorityForTrustedAdapter("public-https-catalog"))).toThrow();
  });

  it("returns descriptor snapshot evidence without enabling relative plugin roots", async () => {
    let rejectedConnections = 0;
    const rejectedConnector: HttpConnector = async () => {
      rejectedConnections += 1;
      return { status: 200, headers: {}, body: Buffer.from("{}") };
    };
    for (const source of [
      { kind: "https-catalog", url: "https://catalog.example.org/marketplace.json", token: "canary" },
      { kind: "https-catalog", url: "https://catalog.example.org/marketplace.json?token=canary" },
      { kind: "https-catalog", url: "https://catalog.example.org/marketplace.json\n" },
    ]) {
      expect(await acquireHttpsCatalogDescriptor(source as never, { resolver: publicResolver, connector: rejectedConnector }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    }
    expect(rejectedConnections).toBe(0);
    const result = await acquireHttpsCatalogDescriptor(
      { kind: "https-catalog", url: "https://catalog.example.org/marketplace.json" },
      { resolver: publicResolver, connector: okConnector('{"name":"remote","plugins":[]}') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provenance).toMatchObject({
      adapter: "public-https-catalog", selectedRoot: { requested: "catalog-document" },
      reviewed: { address: "93.184.216.34", family: 4, canonicalUrl: "https://catalog.example.org/marketplace.json", path: "/marketplace.json", redirectCount: 0, redirected: false },
    });
    const generation = createMarketplaceGeneration(result.value);
    expect(generation.ok).toBe(true);
    if (generation.ok) {
      expect(await acquireMarketplaceRelativePlugin(generation.value, { kind: "relative", path: "plugins/tool" }, { store: {} as OwnedStateStore }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    }
  });

  it("uses one guarded native loopback witness for pinning, TLS, body bounds, closure, and absent ambient authorization", async () => {
    process.env["HTTPS_PROXY"] = "http://proxy-user:proxy-canary@127.0.0.1:9";
    const observed: { servernames: string[]; requests: string[]; closes: number } = { servernames: [], requests: [], closes: 0 };
    let requestNumber = 0;
    const enteredResolvers = new Map<number, () => void>();
    const entered = new Map<number, Promise<void>>([4, 5].map((number) => [number, new Promise<void>((resolve) => enteredResolvers.set(number, resolve))]));
    let allClosedResolve!: () => void;
    const allClosed = new Promise<void>((resolve) => { allClosedResolve = resolve; });
    const server = tls.createServer({ key: KEY, cert: CERT }, (socket) => {
      observed.servernames.push(typeof socket.servername === "string" ? socket.servername : "");
      socket.on("error", () => {});
      socket.on("close", () => { observed.closes += 1; if (observed.closes === 5) allClosedResolve(); });
      let request = "";
      socket.on("data", (chunk) => {
        request += chunk.toString("utf8");
        if (!request.includes("\r\n\r\n")) return;
        observed.requests.push(request); requestNumber += 1;
        if (requestNumber === 1) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
        else if (requestNumber === 2) socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2048\r\nConnection: close\r\n\r\n");
        else if (requestNumber === 3) socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\nxx\r\n0\r\n\r\n");
        else enteredResolvers.get(requestNumber)?.();
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("missing native witness address");
    const endpoint = issuePrevalidatedNativeEndpointForWitness({ hostname: "connector-witness.test", port: address.port, address: { address: "127.0.0.1", family: 4 }, ca: CERT });
    try {
      expect(Buffer.from((await connectPrevalidatedNativeEndpointForWitness(endpoint)).body).toString("utf8")).toBe("ok");
      await expect(connectPrevalidatedNativeEndpointForWitness(endpoint, { maximumBodyBytes: 1 })).rejects.toThrow("download-limit");
      await expect(connectPrevalidatedNativeEndpointForWitness(endpoint, { maximumBodyBytes: 1 })).rejects.toThrow("download-limit");
      const timedOut = connectPrevalidatedNativeEndpointForWitness(endpoint, { timeoutMilliseconds: 80 });
      await entered.get(4); await expect(timedOut).rejects.toThrow("timeout");
      const controller = new AbortController();
      const cancelled = connectPrevalidatedNativeEndpointForWitness(endpoint, { signal: controller.signal, timeoutMilliseconds: 2_000 });
      await entered.get(5); controller.abort(); await expect(cancelled).rejects.toThrow();
      await allClosed;
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    expect(observed.servernames).toEqual(Array(5).fill("connector-witness.test"));
    expect(observed.requests[0]).toContain("Host: connector-witness.test:");
    expect(observed.requests.join("\n").toLowerCase()).not.toContain("authorization");
    expect(observed.requests.join("\n")).not.toContain("proxy-canary");
    expect(observed.closes).toBe(5);
  }, 10_000);
});
