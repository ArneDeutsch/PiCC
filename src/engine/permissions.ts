import path from "node:path";
import { createGlobMatcher, normalizeSlashes } from "../util/globs.js";
import type { PermissionRule, PermissionRules, ToolCallDescriptor } from "../types.js";

/**
 * Permission matcher grammar + deny engine (plan §6, research 02 §7).
 *
 * The matcher grammar is fully implemented even though `allow`/`ask` are a
 * graceful no-op (posture §6.1), because three subsystems reuse it:
 * - `deny` enforcement (hard, non-interactive block),
 * - `tools:` capability gating for agents/skills,
 * - hook `if:` conditions (the hooks engine imports {@link matchesRule}).
 *
 * Hard rule: nothing in this module ever throws on malformed rule text or
 * malformed tool input — matching degrades to `false` predictably.
 */

// ---------------------------------------------------------------------------
// Rule parsing
// ---------------------------------------------------------------------------

/**
 * Parse a rule string: `Tool`, `Tool(specifier)`, `mcp__server`,
 * `mcp__server__tool`, `*`. Whitespace-tolerant, never throws.
 * Malformed text (e.g. an unclosed paren) degrades to a bare-tool rule whose
 * tool name is the whole trimmed text — it then simply matches nothing real.
 */
export function parseRule(raw: string): PermissionRule {
  const text = typeof raw === "string" ? raw.trim() : "";
  // Tool name = leading run without parens/whitespace; specifier = everything
  // between the first "(" and the LAST ")" (Bash commands may contain parens).
  const m = /^([^()\s]+)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    return { raw, tool: m[1], specifier: m[2].trim() };
  }
  return { raw, tool: text };
}

// ---------------------------------------------------------------------------
// Small matching helpers
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Claude-style text wildcard: `*` matches any character sequence (including
 * spaces, slashes, newlines); everything else is literal. Anchored both ends.
 */
function wildcardRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[\\s\\S]*")}$`);
}

function wildcardMatch(pattern: string, value: string): boolean {
  return wildcardRegExp(pattern).test(value);
}

function inputString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

// ---------------------------------------------------------------------------
// Tool-name matching (bare rules, mcp prefixes, aliases)
// ---------------------------------------------------------------------------

/** Match a rule's tool part against a concrete call's tool name. */
function toolNameMatches(ruleTool: string, callTool: string): boolean {
  if (ruleTool === "*") return true;
  if (ruleTool === callTool) return true;
  // Agent/Task are the same tool under two Claude names (Task was renamed).
  if (
    (ruleTool === "Agent" && callTool === "Task") ||
    (ruleTool === "Task" && callTool === "Agent")
  ) {
    return true;
  }
  if (ruleTool.startsWith("mcp__")) {
    // `mcp__server__*` style globs on MCP tool names.
    if (ruleTool.includes("*")) return wildcardMatch(ruleTool, callTool);
    // `mcp__server` (bare server) matches every tool of that server.
    const parts = ruleTool.split("__");
    if (parts.length === 2) return callTool.startsWith(`${ruleTool}__`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Bash specifier matching (shell-operator aware)
// ---------------------------------------------------------------------------

/**
 * Split a command string on unquoted shell chaining operators
 * (`&&`, `||`, `|&`, `|`, `;`, `&`, newline). Operators inside single or
 * double quotes do not split; a backslash escapes the next char outside
 * single quotes; `>&` / `<&` (fd redirections like `2>&1`) are not splits.
 */
function splitShellCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        current += ch + command.charAt(i + 1);
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch + command.charAt(i + 1);
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&") {
      // `>&` / `<&` is a redirection (e.g. 2>&1), not a chain operator.
      const prev = command.charAt(i - 1);
      if (prev === ">" || prev === "<") {
        current += ch;
        continue;
      }
      segments.push(current);
      current = "";
      if (command.charAt(i + 1) === "&") i++; // consume `&&`
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      const next = command.charAt(i + 1);
      if (next === "|" || next === "&") i++; // consume `||` / `|&`
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Bash pattern semantics (research 02 §7.2):
 * - exact command: `Bash(git status)` — matches only that command;
 * - prefix wildcard: `Bash(git *)` — requires `git ` + anything (bare `git`
 *   does NOT match); `Bash(ls*)` matches `lsof` too (no word boundary);
 * - legacy `Bash(git:*)` is identical to `Bash(git *)`;
 * - `*` matches any sequence including spaces at any position.
 * Shell-operator conservatism is POLARITY-aware:
 * - allow/ask direction (`anySegment: false`, default): a chained command only
 *   matches when EVERY chained segment independently matches the same pattern —
 *   this prevents `git status && rm -rf /` from matching an allow `Bash(git *)`.
 * - deny direction (`anySegment: true`): a chained command matches when ANY
 *   segment matches — this prevents `git status && curl evil` from evading a
 *   deny `Bash(curl *)` by hiding behind a benign prefix.
 */
function bashSpecifierMatches(
  specifier: string,
  call: ToolCallDescriptor,
  opts: { anySegment?: boolean } = {},
): boolean {
  const command = inputString(call.input["command"]);
  let pattern = specifier;
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  const rx = wildcardRegExp(pattern);
  const segments = splitShellCommand(command);
  if (segments.length === 0) return false;
  return opts.anySegment
    ? segments.some((segment) => rx.test(segment))
    : segments.every((segment) => rx.test(segment));
}

// ---------------------------------------------------------------------------
// Path specifier matching (Read/Edit/Write/Glob/Grep)
// ---------------------------------------------------------------------------

/**
 * Claude anchor semantics: `path` / `./path` relative to the project dir
 * (here: call.cwd), `/path` anchored to the settings-source dir (also cwd
 * for us — NOT filesystem root), `//path` true absolute, `~/path` home.
 * A bare filename (no slash) matches at any depth (`.env` ≡ `**\/.env`).
 */
function pathSpecifierMatches(specifier: string, call: ToolCallDescriptor): boolean {
  const rawPath =
    call.input["file_path"] ?? call.input["path"] ?? call.input["notebook_path"];
  if (typeof rawPath !== "string" || rawPath.length === 0) return false;
  const cwd = call.cwd || ".";
  let pattern = specifier;
  // `/path` (single leading slash, not `//`): anchor to cwd, per Claude.
  if (/^\/(?!\/)/.test(pattern)) {
    pattern = normalizeSlashes(path.resolve(cwd)).replace(/\/$/, "") + pattern;
  }
  const abs = path.resolve(cwd, rawPath);
  return createGlobMatcher([pattern], { base: cwd })(normalizeSlashes(abs));
}

// ---------------------------------------------------------------------------
// WebFetch / WebSearch specifier matching
// ---------------------------------------------------------------------------

/**
 * `domain:` patterns: `*.example.com` matches subdomains only (not the
 * apex); non-leading `*` matches only within a single dot-separated label;
 * `domain:*` matches every host. Hostnames compare case-insensitively.
 */
function domainMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const pat = pattern.toLowerCase().trim().replace(/\.$/, "");
  if (!pat) return false;
  if (pat === "*") return true;
  if (pat.startsWith("*.")) {
    const rest = pat.slice(2).split("*").map(escapeRegExp).join("[^.]*");
    return new RegExp(`^.+\\.${rest}$`).test(host);
  }
  const rx = pat.split("*").map(escapeRegExp).join("[^.]*");
  return new RegExp(`^${rx}$`).test(host);
}

function webFetchSpecifierMatches(specifier: string, call: ToolCallDescriptor): boolean {
  const url = inputString(call.input["url"]);
  if (specifier.startsWith("domain:")) {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return false; // unparseable URL never matches a domain rule
    }
    return domainMatches(specifier.slice("domain:".length), hostname);
  }
  return wildcardMatch(specifier, url);
}

// ---------------------------------------------------------------------------
// Central matcher — PINNED CONTRACT (imported by the hooks engine for `if:`)
// ---------------------------------------------------------------------------

/**
 * Does a single rule text match a concrete tool call? Never throws.
 *
 * Unknown tools degrade predictably: the tool name must match by string
 * identity, and when the rule carries a specifier it is wildcard-matched
 * against `input.command ?? input.file_path ?? input.url ?? ""` (stringified)
 * — the three canonical single-string surfaces — so third-party/MCP rules
 * behave deterministically instead of erroring.
 */
export function matchesRule(
  ruleText: string,
  call: ToolCallDescriptor,
  opts: { anySegment?: boolean } = {},
): boolean {
  try {
    if (!call || typeof call.tool !== "string") return false;
    const rule = parseRule(ruleText);
    if (!rule.tool) return false;
    if (!toolNameMatches(rule.tool, call.tool)) return false;
    const specifier = rule.specifier;
    if (specifier === undefined || specifier === "") return true; // bare rule

    const input = call.input ?? {};
    const safeCall: ToolCallDescriptor = { ...call, input };

    switch (rule.tool) {
      case "*":
        return true; // `*` matches everything; a specifier on `*` is ignored
      case "Bash":
        return bashSpecifierMatches(specifier, safeCall, opts);
      case "Read":
      case "Edit":
      case "Write":
      case "Glob":
      case "Grep":
        return pathSpecifierMatches(specifier, safeCall);
      case "WebFetch":
        return webFetchSpecifierMatches(specifier, safeCall);
      case "WebSearch":
        return wildcardMatch(specifier, inputString(input["query"]));
      case "Agent":
      case "Task":
        return wildcardMatch(specifier, inputString(input["subagent_type"]));
      case "Skill":
        return wildcardMatch(specifier, inputString(input["skill"] ?? input["name"]));
      default: {
        // Unknown / MCP tool with specifier — see doc comment above.
        const target = input["command"] ?? input["file_path"] ?? input["url"] ?? "";
        return wildcardMatch(specifier, inputString(target));
      }
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Permission engine (deny = hard block; ask = logged downgrade; default-permissive)
// ---------------------------------------------------------------------------

export interface PermissionEvaluation {
  decision: "deny" | "allow" | "default";
  /** The raw rule text that produced a non-default decision. */
  rule?: string;
  /** True when an `ask` rule matched and was downgraded to allow (posture §6.1). */
  askDowngraded?: boolean;
}

export class PermissionEngine {
  private readonly rules: PermissionRules;
  private readonly cwd: string;

  constructor(rules: PermissionRules, opts: { cwd: string }) {
    this.rules = rules;
    this.cwd = opts.cwd;
  }

  /**
   * Evaluate a tool call. Order: deny → ask → allow (research 02 §7.1);
   * deny is a hard block; a matching `ask` rule is downgraded to allow but
   * reported (`askDowngraded`) so the caller can log it; no match at all is
   * "default" — never blocking (default-permissive posture, plan §6.1).
   */
  evaluate(call: ToolCallDescriptor): PermissionEvaluation {
    const effective: ToolCallDescriptor = { ...call, cwd: call?.cwd || this.cwd };
    for (const rule of this.ruleList("deny")) {
      // anySegment: a deny must hit even when the denied command hides inside
      // a chain (`git status && curl evil` vs deny `Bash(curl *)`).
      if (matchesRule(rule, effective, { anySegment: true })) {
        return { decision: "deny", rule };
      }
    }
    for (const rule of this.ruleList("ask")) {
      if (matchesRule(rule, effective)) {
        return { decision: "allow", rule, askDowngraded: true };
      }
    }
    for (const rule of this.ruleList("allow")) {
      if (matchesRule(rule, effective)) return { decision: "allow", rule };
    }
    return { decision: "default" };
  }

  /**
   * Capability gating for agents/skills (`tools:` / `disallowedTools:`).
   * granted undefined → all known tools; otherwise the intersection of
   * granted with allKnown; then minus disallowed. `*` in granted grants all
   * known; `*` in disallowed removes all. A bare `mcp__server` entry covers
   * every `mcp__server__*` tool. Entries with a specifier (e.g.
   * `Bash(rm *)`) grant the tool but never REMOVE it — a scoped deny leaves
   * the tool in context and blocks per-call instead (research 02 §7.1).
   */
  gateTools(
    granted: string[] | undefined,
    disallowed: string[] | undefined,
    allKnown: string[],
  ): string[] {
    const grantMatches = (entry: string, tool: string): boolean =>
      toolNameMatches(parseRule(entry).tool, tool);
    const removeMatches = (entry: string, tool: string): boolean => {
      const rule = parseRule(entry);
      if (rule.specifier !== undefined && rule.specifier !== "") return false;
      return toolNameMatches(rule.tool, tool);
    };

    let result =
      granted === undefined
        ? [...allKnown]
        : allKnown.filter((tool) => granted.some((g) => grantMatches(g, tool)));
    if (disallowed && disallowed.length > 0) {
      result = result.filter((tool) => !disallowed.some((d) => removeMatches(d, tool)));
    }
    return result;
  }

  private ruleList(kind: "deny" | "ask" | "allow"): string[] {
    const list = this.rules?.[kind];
    return Array.isArray(list) ? list.filter((r): r is string => typeof r === "string") : [];
  }
}

// ---------------------------------------------------------------------------
// Hook `if:` conditions
// ---------------------------------------------------------------------------

/** Split on top-level `,` and `||` (not inside parens or quotes). */
function splitAlternatives(expr: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr.charAt(i);
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (ch === ",") {
        parts.push(current);
        current = "";
        continue;
      }
      if (ch === "|" && expr.charAt(i + 1) === "|") {
        parts.push(current);
        current = "";
        i++;
        continue;
      }
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Evaluate a hook `if:` expression against a tool call. The expression is a
 * single permission rule or comma/`||`-separated alternatives (any match
 * wins). A leading `!` negates that alternative. Empty/blank expressions are
 * unconditionally true. Never throws.
 */
export function evaluateIfCondition(ifExpr: string, call: ToolCallDescriptor): boolean {
  try {
    const text = typeof ifExpr === "string" ? ifExpr.trim() : "";
    if (!text) return true;
    for (const rawAlt of splitAlternatives(text)) {
      let alt = rawAlt.trim();
      if (!alt) continue;
      let negate = false;
      while (alt.startsWith("!")) {
        negate = !negate;
        alt = alt.slice(1).trim();
      }
      if (!alt) continue;
      const matched = matchesRule(alt, call);
      if (negate ? !matched : matched) return true;
    }
    return false;
  } catch {
    return false;
  }
}
