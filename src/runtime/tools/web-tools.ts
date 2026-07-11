import { Type } from "typebox";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Web tools (plan §4.8): real `WebFetch` / `WebSearch` implementations —
 * research skills and agent `tools:` allowlists depend on these names
 * resolving to working tools.
 *
 * All network paths honor both a hard 30s timeout and the execute()
 * AbortSignal (never hang), and all output is truncated.
 */

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "PiCC/0.1";
const MAX_REDIRECTS = 5;
const MAX_SEARCH_RESULTS = 8;

export interface WebToolOptions {
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Shared fetch plumbing
// ---------------------------------------------------------------------------

interface FetchedDocument {
  status: number;
  statusText: string;
  contentType: string;
  finalUrl: string;
  body: string;
}

/**
 * Fetch a URL with a hard timeout wired to BOTH the timeout and the caller's
 * signal, following up to MAX_REDIRECTS redirects manually. The body read is
 * included in the timeout window.
 */
async function fetchDocument(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
  extraHeaders?: Record<string, string>,
): Promise<FetchedDocument> {
  if (signal?.aborted) {
    throw new Error("aborted before the request started");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)),
    FETCH_TIMEOUT_MS,
  );
  const onAbort = () => controller.abort(signal?.reason ?? new Error("aborted"));
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, ...extraHeaders },
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(`redirect (HTTP ${res.status}) without a Location header`);
        }
        try {
          await res.body?.cancel();
        } catch {
          /* best-effort drain */
        }
        current = new URL(location, current).toString();
        continue;
      }
      const body = await res.text();
      return {
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") ?? "",
        finalUrl: current,
        body,
      };
    }
    throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Undici wraps network failures; the cause usually carries the real story.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message) return `${err.message} (${cause.message})`;
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&#(\d+);/g, (_m, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    })
    .replace(/&amp;/gi, "&"); // last, so "&amp;lt;" does not double-decode
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

/** Convert HTML to readable plain text (best-effort, regex-based). */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Anchors → "text (href)"
  s = s.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, inner: string) => {
      const text = stripTags(inner).replace(/\s+/g, " ").trim();
      const target = href.trim();
      if (!target || target.startsWith("#") || target.toLowerCase().startsWith("javascript:")) {
        return text;
      }
      return text ? `${text} (${target})` : target;
    },
  );
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<(h[1-6])\b[^>]*>/gi, "\n\n");
  s = s.replace(/<\/h[1-6]\s*>/gi, "\n\n");
  s = s.replace(
    /<\/(p|div|li|tr|table|ul|ol|blockquote|pre|section|article|header|footer)\s*>/gi,
    "\n",
  );
  s = stripTags(s);
  s = decodeEntities(s);
  // Collapse whitespace.
  s = s.replace(/[ \t\r\u00a0]+/g, " ");
  s = s.replace(/ ?\n ?/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function looksLikeHtml(contentType: string, body: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes("html") || ct.includes("xhtml")) return true;
  if (ct) return false;
  return /^\s*(<!doctype\s+html|<html)/i.test(body);
}

// ---------------------------------------------------------------------------
// WebFetch
// ---------------------------------------------------------------------------

export function createWebFetchTool(
  _getCwd: () => string,
  opts: WebToolOptions = {},
): ToolDefinition {
  return defineTool({
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as readable text. HTML is converted to plain text; " +
      "JSON is pretty-printed; other content is returned as-is. Follows up to 5 redirects, " +
      "30 second timeout. Optionally pass a prompt describing what to look for in the page.",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      prompt: Type.Optional(
        Type.String({ description: "What to extract or analyze from the fetched content" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const fetchImpl = opts.fetchImpl ?? fetch;
      let doc: FetchedDocument;
      try {
        doc = await fetchDocument(params.url, fetchImpl, signal);
      } catch (err) {
        throw new Error(`WebFetch failed for ${params.url}: ${errorMessage(err)}`);
      }
      if (doc.status >= 400) {
        throw new Error(
          `WebFetch failed for ${params.url}: HTTP ${doc.status} ${doc.statusText}`.trim(),
        );
      }

      let text: string;
      if (looksLikeHtml(doc.contentType, doc.body)) {
        text = htmlToText(doc.body);
      } else if (doc.contentType.toLowerCase().includes("json")) {
        try {
          text = JSON.stringify(JSON.parse(doc.body), null, 2);
        } catch {
          text = doc.body;
        }
      } else {
        text = doc.body;
      }

      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let output = truncation.content;
      if (truncation.truncated) {
        output += `\n\n[Content truncated: showing first ${truncation.outputLines} of ${truncation.totalLines} lines]`;
      }
      if (params.prompt !== undefined) {
        output = `Content of ${params.url} (analyze per prompt: ${params.prompt}):\n\n${output}`;
      }
      return {
        content: [{ type: "text" as const, text: output }],
        details: {
          url: params.url,
          finalUrl: doc.finalUrl,
          status: doc.status,
          contentType: doc.contentType,
          truncated: truncation.truncated,
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// WebSearch
// ---------------------------------------------------------------------------

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(hostname: string, domain: string): boolean {
  const d = domain.toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
  return hostname === d || hostname.endsWith(`.${d}`);
}

function applyDomainFilters(
  results: SearchResult[],
  allowed: string[] | undefined,
  blocked: string[] | undefined,
): SearchResult[] {
  let out = results;
  if (allowed && allowed.length > 0) {
    out = out.filter((r) => allowed.some((d) => domainMatches(hostnameOf(r.url), d)));
  }
  if (blocked && blocked.length > 0) {
    out = out.filter((r) => !blocked.some((d) => domainMatches(hostnameOf(r.url), d)));
  }
  return out;
}

async function braveSearch(
  query: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_SEARCH_RESULTS}`;
  const doc = await fetchDocument(url, fetchImpl, signal, {
    "X-Subscription-Token": apiKey,
    Accept: "application/json",
  });
  if (doc.status >= 400) {
    throw new Error(`Brave search API returned HTTP ${doc.status} ${doc.statusText}`.trim());
  }
  const data = JSON.parse(doc.body) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const raw = data.web?.results ?? [];
  return raw
    .filter((r): r is { title?: string; url?: string; description?: string } => !!r && !!r.url)
    .slice(0, MAX_SEARCH_RESULTS)
    .map((r) => ({
      title: htmlToText(r.title ?? "").trim() || (r.url as string),
      url: r.url as string,
      snippet: htmlToText(r.description ?? "").trim(),
    }));
}

/** Decode a DuckDuckGo redirect href (…uddg=<encoded-url>…) to the target URL. */
function decodeDdgHref(href: string): string {
  let h = decodeEntities(href.trim());
  const uddg = /[?&]uddg=([^&"]+)/.exec(h);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      /* fall through to raw href */
    }
  }
  if (h.startsWith("//")) h = `https:${h}`;
  return h;
}

async function duckDuckGoSearch(
  query: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const doc = await fetchDocument(url, fetchImpl, signal, {
    Accept: "text/html",
  });
  if (doc.status >= 400) {
    throw new Error(`DuckDuckGo returned HTTP ${doc.status} ${doc.statusText}`.trim());
  }

  // Best-effort regex parsing of the HTML results page.
  const results: SearchResult[] = [];
  const anchorRe = /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(doc.body)) !== null && results.length < MAX_SEARCH_RESULTS) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const hrefMatch = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attrs);
    if (!hrefMatch?.[1]) continue;
    const target = decodeDdgHref(hrefMatch[1]);
    const title = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    if (!target || !title) continue;
    results.push({ title, url: target, snippet: "" });
  }

  // Snippets appear in document order; zip by index (best-effort).
  const snippetRe = /<a\b[^>]*\bresult__snippet\b[^>]*>([\s\S]*?)<\/a\s*>/gi;
  let i = 0;
  while ((m = snippetRe.exec(doc.body)) !== null && i < results.length) {
    const entry = results[i];
    if (entry) {
      entry.snippet = decodeEntities(stripTags(m[1] ?? "")).replace(/\s+/g, " ").trim();
    }
    i++;
  }
  return results;
}

export function createWebSearchTool(
  _getCwd: () => string,
  opts: WebToolOptions = {},
): ToolDefinition {
  return defineTool({
    name: "WebSearch",
    label: "Web Search",
    description:
      "Search the web and return up to 8 results (title, URL, snippet). Uses the Brave Search " +
      "API when BRAVE_API_KEY is set, otherwise falls back to DuckDuckGo. Supports " +
      "allowed_domains / blocked_domains hostname filters.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      allowed_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Only include results from these domains",
        }),
      ),
      blocked_domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Never include results from these domains",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const fetchImpl = opts.fetchImpl ?? fetch;
      const errors: string[] = [];
      let results: SearchResult[] | undefined;
      let backend = "";

      const braveKey = process.env.BRAVE_API_KEY;
      if (braveKey) {
        try {
          results = await braveSearch(params.query, braveKey, fetchImpl, signal);
          backend = "brave";
        } catch (err) {
          errors.push(`Brave: ${errorMessage(err)}`);
        }
      }
      if (results === undefined) {
        try {
          results = await duckDuckGoSearch(params.query, fetchImpl, signal);
          backend = "duckduckgo";
        } catch (err) {
          errors.push(`DuckDuckGo: ${errorMessage(err)}`);
        }
      }
      if (results === undefined) {
        throw new Error(
          `WebSearch failed for "${params.query}": ${errors.join("; ")}. ` +
            "Consider setting BRAVE_API_KEY to use the Brave Search API backend.",
        );
      }

      const filtered = applyDomainFilters(results, params.allowed_domains, params.blocked_domains);
      let text: string;
      if (filtered.length === 0) {
        text = `No results found for "${params.query}".`;
      } else {
        const lines = filtered.map(
          (r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`,
        );
        text = `Search results for "${params.query}":\n\n${lines.join("\n\n")}`;
      }
      const truncation = truncateHead(text, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      return {
        content: [{ type: "text" as const, text: truncation.content }],
        details: {
          query: params.query,
          backend,
          resultCount: filtered.length,
          truncated: truncation.truncated,
        },
      };
    },
  });
}
