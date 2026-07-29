import fs from "node:fs";
import path from "node:path";
import {
  createGlobMatcher,
  isAbsoluteLike,
  normalizeDrivePath,
  normalizeSlashes,
} from "../util/globs.js";
import type { Diagnostic, PermissionRule, PermissionRules, ToolCallDescriptor } from "../types.js";

/**
 * Permission matcher grammar + deny engine.
 *
 * The matcher grammar is fully implemented even though `allow`/`ask` are a
 * graceful no-op, because three subsystems reuse it:
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
 *
 * `trailingSpaceStar` (Bash rules): Claude's word-boundary rule — a `*`
 * immediately preceded by a literal space means "space or end of string", so
 * `Bash(git *)` matches bare `git` AND `git push`, but never `gitk`, while
 * `Bash(ls*)` (no space) still matches `lsof`. The docs specify this for the
 * TRAILING space-star only; an interior space-star (`Bash(git * main)`) keeps
 * mandatory-space semantics, because compiling it to the optional form
 * `(?: [\s\S]*)?` would let the star swallow the following literal text
 * (` main`) and silently broaden the rule.
 */
function wildcardRegExp(pattern: string, opts: { trailingSpaceStar?: boolean } = {}): RegExp {
  let body = pattern;
  let suffix = "";
  if (opts.trailingSpaceStar && body.endsWith(" *")) {
    body = body.slice(0, -2);
    suffix = "(?: [\\s\\S]*)?";
  }
  return new RegExp(`^${body.split("*").map(escapeRegExp).join("[\\s\\S]*")}${suffix}$`);
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

/** The tools an `Edit` rule gates: ALL file-modification tools. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The tools a `Read` rule gates: ALL built-in file-reading tools. Grep/Glob are
 * documented Claude parity ("makes a best-effort attempt to apply `Read` rules
 * to all built-in tools that read files like Grep and Glob"); NotebookRead is
 * a RETIRED gating-token stub — notebook reads now route through `Read`, but the
 * name is retained here so `deny/allow: NotebookRead(<glob>)` rules keep gating
 * the notebook read. `Read` is present for symmetry with
 * {@link FILE_EDIT_TOOLS}; {@link toolNameMatches} already covers Read==Read.
 */
const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/**
 * The edit tools a **path-scoped, deny-direction** `Read` rule additionally
 * gates (Claude v2.1.208): a `deny: Read(<glob>)` also blocks `Edit`/`MultiEdit`
 * on a matching path — including creating a new file there — "because editing
 * requires reading the result back". This is Edit-family-minus-whole-writers:
 * `Write` and `NotebookEdit` are whole-file/cell writers that do NOT read the
 * result back, so they are deliberately excluded (documented Claude parity, not
 * an oversight). MultiEdit is a batched Edit with identical clobber semantics.
 * This cross is applied ONLY in the deny direction with a non-empty specifier
 * (see the guarded clause in {@link matchesRule}); it is intentionally NOT part
 * of {@link ruleToolMatches}, which is polarity-agnostic and would otherwise
 * leak the cross into allow/ask/hook-`if:` and into bare-`deny: Read` context
 * stripping — both divergent from Claude.
 */
export const READ_DENY_EDIT_TOOLS = new Set(["Edit", "MultiEdit"]);

/**
 * Reverse of the forward `Read`→read-family expansion, for `NotebookRead` only:
 * notebook reading now flows through `Read` (the standalone NotebookRead tool is
 * retired to a gating-token stub), so a `deny: NotebookRead(<glob>)` rule would
 * silently stop protecting the notebook once the read routes through `Read`. This
 * deny-only, specifier-scoped cross restores that protection — a path-scoped
 * `NotebookRead(<glob>)` deny also matches a `Read` call on the same path. It is
 * the mirror image of {@link READ_DENY_EDIT_TOOLS} (deny-direction only, so it
 * never leaks into allow/ask/hook-`if:`, and specifier-scoped, so a bare
 * `deny: NotebookRead` does NOT block all `Read`s). The forward
 * `ruleToolMatches` expansion is one-directional (`Read`→family only), so this
 * lives in {@link matchesRule} alongside the Read→Edit cross, not there.
 */
const NOTEBOOKREAD_DENY_READ_TOOLS = new Set(["Read"]);

/**
 * Rule-level tool matching: {@link toolNameMatches} plus Claude's documented
 * family expansions — "`Edit` = all file-editing tools" (Write/MultiEdit/
 * NotebookEdit) and "`Read` = all file-reading tools" (Grep/Glob/NotebookRead)
 * — so a deny `Edit(glob)` / `Read(glob)` cannot be bypassed by calling a
 * sibling tool on the same path. Both expansions are strictly one-directional:
 * a `Write`/`Grep`/`Glob`/`NotebookRead` rule does NOT gate Edit/Read calls.
 * The separate deny-only Read→Edit/MultiEdit cross (a `deny: Read(glob)` also
 * blocking Edit) lives in {@link matchesRule}, NOT here — see
 * {@link READ_DENY_EDIT_TOOLS}.
 */
function ruleToolMatches(ruleTool: string, callTool: string): boolean {
  if (toolNameMatches(ruleTool, callTool)) return true;
  if (ruleTool === "Edit" && FILE_EDIT_TOOLS.has(callTool)) return true;
  return ruleTool === "Read" && FILE_READ_TOOLS.has(callTool);
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

// --- Process-wrapper stripping ---------------------------------------------

/** Take the first whitespace-delimited token; `[token, rest]` or null. */
function takeToken(text: string): [string, string] | null {
  const m = /^(\S+)\s*/.exec(text);
  if (!m || m[1] === undefined) return null;
  return [m[1], text.slice(m[0].length)];
}

/** Consume leading `-`/`--` option tokens; options in `valueOpts` also consume a value token. */
function consumeOptions(text: string, valueOpts: ReadonlySet<string>): string {
  let rest = text;
  for (;;) {
    const t = takeToken(rest);
    if (!t || !t[0].startsWith("-")) return rest;
    rest = t[1];
    if (valueOpts.has(t[0])) {
      const v = takeToken(rest);
      if (v) rest = v[1];
    }
  }
}

/**
 * Strip ONE leading process wrapper — `timeout [opts] <dur>`, `time`,
 * `nice [-n N]`, `nohup`, `stdbuf <opts>`, bare `xargs`, `env [assignments]` —
 * the wrappers Claude strips before Bash pattern matching, so a deny
 * `Bash(curl *)` cannot be evaded via `nohup curl …`. Returns the
 * unwrapped remainder, or null when the segment does not start with a wrapper.
 */
function stripOneWrapper(segment: string): string | null {
  const t = takeToken(segment);
  if (!t) return null;
  const [word, rest] = t;
  switch (word) {
    case "nohup":
    case "time":
      return rest;
    case "xargs":
      // Only bare `xargs cmd …` (no options) is stripped, matching Claude.
      return rest.startsWith("-") ? null : rest;
    case "nice":
      return consumeOptions(rest, new Set(["-n", "--adjustment"]));
    case "stdbuf":
      return consumeOptions(rest, new Set(["-i", "-o", "-e"]));
    case "timeout": {
      const afterOpts = consumeOptions(rest, new Set(["-k", "--kill-after", "-s", "--signal"]));
      const duration = takeToken(afterOpts);
      return duration ? duration[1] : null; // duration, then the wrapped command
    }
    case "env": {
      // `env [-i] [-u NAME] [VAR=val …] cmd` — skip flags and assignments.
      let cur = rest;
      for (;;) {
        const tok = takeToken(cur);
        if (!tok) return null; // `env` alone / only assignments: nothing wrapped
        const [envWord, envRest] = tok;
        if (
          envWord === "-i" ||
          envWord === "-0" ||
          envWord === "--ignore-environment" ||
          /^--unset=/.test(envWord) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(envWord)
        ) {
          cur = envRest;
          continue;
        }
        if (envWord === "-u" || envWord === "--unset") {
          const v = takeToken(envRest);
          if (!v) return null;
          cur = v[1];
          continue;
        }
        if (envWord.startsWith("-")) return null; // unknown env option: don't guess
        return cur;
      }
    }
    default:
      return null;
  }
}

/**
 * All progressively-unwrapped forms of a segment, e.g.
 * `nohup timeout 5 curl x` → [`timeout 5 curl x`, `curl x`]. Bounded, never throws.
 */
function wrapperStrippedVariants(segment: string): string[] {
  const variants: string[] = [];
  let current = segment.trim();
  for (let i = 0; i < 8; i++) {
    const next = stripOneWrapper(current);
    if (next === null) break;
    const trimmed = next.trim();
    if (trimmed.length === 0 || trimmed === current) break;
    variants.push(trimmed);
    current = trimmed;
  }
  return variants;
}

// --- Leading env-assignment stripping (deny direction only) ----------------

/** One `VAR=value` shell assignment token (value optionally quoted). */
const ENV_ASSIGNMENT_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s]*)\s+)+/;

/**
 * Strip leading `VAR=value` env assignments (`FOO=bar rm -rf /` → `rm -rf /`).
 * Returns null when the segment has no assignments or is ONLY assignments.
 * Used in the DENY direction only, so a deny `Bash(rm *)` cannot be evaded by
 * an env prefix; in the allow direction assignments are NOT stripped — per
 * Claude, a rule naming the bare command does not auto-approve env-prefixed
 * invocations. (`env X=1 cmd` is separately handled by the `env` wrapper.)
 */
function stripLeadingAssignments(segment: string): string | null {
  const m = ENV_ASSIGNMENT_RE.exec(segment);
  if (!m) return null;
  const rest = segment.slice(m[0].length).trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Bash pattern semantics (official permissions docs):
 * - exact command: `Bash(git status)` — matches only that command;
 * - prefix wildcard: `Bash(git *)` — space-before-`*` is a word boundary
 *   meaning "space or end of string": matches bare `git` and `git push`,
 *   never `gitk`; `Bash(ls*)` (no space) matches `lsof` too;
 * - legacy `Bash(git:*)` is identical to `Bash(git *)`;
 * - `*` matches any sequence including spaces at any position;
 * - process wrappers (timeout/time/nice/nohup/stdbuf/xargs/env) are stripped
 *   before matching: a segment matches when the raw text OR any unwrapped
 *   variant matches the pattern;
 * - deny direction only: leading `VAR=value` assignments are also stripped
 *   (see {@link stripLeadingAssignments}).
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
  opts: { anySegment?: boolean; deny?: boolean } = {},
): boolean {
  const command = inputString(call.input["command"]);
  let pattern = specifier;
  if (pattern.endsWith(":*")) pattern = `${pattern.slice(0, -2)} *`;
  const rx = wildcardRegExp(pattern, { trailingSpaceStar: true });
  const segments = splitShellCommand(command);
  if (segments.length === 0) return false;
  const denyDirection = opts.anySegment === true || opts.deny === true;
  const segmentMatches = (segment: string): boolean => {
    const variants = [segment, ...wrapperStrippedVariants(segment)];
    if (denyDirection) {
      // Also try each variant with leading env assignments stripped (and
      // re-unwrapped: `FOO=1 nohup curl x` → `nohup curl x` → `curl x`).
      for (const variant of [...variants]) {
        const bare = stripLeadingAssignments(variant);
        if (bare !== null && !variants.includes(bare)) {
          variants.push(bare, ...wrapperStrippedVariants(bare));
        }
      }
    }
    return variants.some((variant) => rx.test(variant));
  };
  return opts.anySegment
    ? segments.some(segmentMatches)
    : segments.every(segmentMatches);
}

// ---------------------------------------------------------------------------
// Path specifier matching (Read/Edit/Write/Glob/Grep)
// ---------------------------------------------------------------------------

/**
 * Claude anchor semantics: `path` / `./path` relative to the project dir,
 * `/path` anchored to the settings-source dir (NOT filesystem root),
 * `//path` true absolute (incl. drive form `//c/**` and any-absolute
 * `//**\/x`), `~/path` home. A bare filename (no slash) matches at any depth
 * (`.env` ≡ `**\/.env`).
 *
 * Windows normalization (Claude Code 2.1.166): patterns and input paths are
 * canonicalized (backslashes → `/`, `C:/x` → `/c/x`, case-insensitive for
 * Windows/drive-lettered paths) by the shared glob engine before matching, so
 * a deny `Read(//c/**\/.env)` covers `C:\proj\.env` in any input flavor.
 * POSIX behavior is byte-identical.
 *
 * Anchoring is STABLE: patterns anchor to `opts.anchor` (the engine's fixed
 * settings-source/project root) when provided, never to the drifting live
 * session cwd — otherwise a deny `Read(/secrets/**)` would stop covering the
 * real secrets dir after EnterWorktree moved the session cwd. `call.cwd` is
 * used only to resolve relative *input* paths (the file actually touched).
 *
 * Deny direction (`opts.deny`) is deliberately broader, per Claude:
 * - patterns additionally match when anchored at the live call cwd (so a
 *   relative deny keeps covering the directory the session works in), and
 * - symlinks are resolved (realpath, existing paths only, graceful failure) —
 *   "deny rules fire if either the symlink or its target matches".
 */
function pathSpecifierMatches(
  specifier: string,
  call: ToolCallDescriptor,
  opts: { deny?: boolean; anchor?: string } = {},
): boolean {
  const rawPath =
    call.input["file_path"] ?? call.input["path"] ?? call.input["notebook_path"];
  if (typeof rawPath !== "string" || rawPath.length === 0) return false;
  const cwd = call.cwd || opts.anchor || ".";
  const primaryAnchor = opts.anchor || cwd;
  const anchors = [primaryAnchor];
  if (
    opts.deny &&
    normalizeDrivePath(path.resolve(cwd)) !== normalizeDrivePath(path.resolve(primaryAnchor))
  ) {
    anchors.push(cwd);
  }
  // A drive-lettered input is absolute even when evaluated off-Windows: pass
  // it through untouched so the glob engine's drive normalization applies
  // instead of resolving it against a POSIX cwd.
  const abs = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : isAbsoluteLike(rawPath)
      ? rawPath
      : path.resolve(cwd, rawPath);
  const candidates = [abs];
  // UNC inputs skip realpath: probing a nonexistent `\\host\...` can stall for
  // seconds in the Windows network stack — match on the literal form only.
  if (opts.deny && !/^(\\\\|\/\/)/.test(abs)) {
    try {
      const real = fs.realpathSync(abs);
      // Symlink targets participate in matching in NORMALIZED form too.
      if (real && normalizeDrivePath(real) !== normalizeDrivePath(abs)) candidates.push(real);
    } catch {
      // Nonexistent path / unresolvable symlink: degrade to literal-only.
    }
  }
  for (const anchorDir of anchors) {
    // Normalize pattern separators first so `\`-flavored rules behave like
    // their `/` forms (drive normalization happens in the glob engine).
    let pattern = normalizeSlashes(specifier);
    // `/path` (single leading slash, not `//`): anchor to the settings dir.
    if (/^\/(?!\/)/.test(pattern)) {
      pattern = normalizeSlashes(path.resolve(anchorDir)).replace(/\/$/, "") + pattern;
    }
    const matches = createGlobMatcher([pattern], { base: anchorDir });
    for (const candidate of candidates) {
      if (matches(normalizeSlashes(candidate))) return true;
    }
  }
  return false;
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
 * Canonicalized input fields that the specifier grammar already consumes —
 * these are NOT matchable via the `Tool(key:value)` parameter form.
 */
const CANONICAL_INPUT_FIELDS = new Set([
  "command",
  "file_path",
  "path",
  "notebook_path",
  "url",
  "query",
  "subagent_type",
  "skill",
  "name",
]);

/**
 * Does a single rule text match a concrete tool call? Never throws.
 *
 * `opts.anchor` is the stable settings-source/project dir used to anchor
 * Read/Edit path patterns (defaults to `call.cwd` when absent); `opts.deny`
 * marks the deny direction (broader path matching: live-cwd fallback anchor +
 * symlink resolution) and additionally enables the path-scoped Read→Edit/
 * MultiEdit cross (a `deny: Read(<glob>)` also matches an Edit/MultiEdit call on
 * a matching path — see {@link READ_DENY_EDIT_TOOLS}); `opts.anySegment` is the
 * deny-direction Bash mode.
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
  opts: { anySegment?: boolean; deny?: boolean; anchor?: string } = {},
): boolean {
  try {
    if (!call || typeof call.tool !== "string") return false;
    const rule = parseRule(ruleText);
    if (!rule.tool) return false;

    // Deny-only Read→Edit/MultiEdit cross (Claude v2.1.208): a path-scoped
    // `Read(<glob>)` deny also blocks Edit/MultiEdit on a matching path (editing
    // reads the result back), including creating a new file there. Path-specifier'd
    // only — a bare `deny: Read` does NOT block Edit. Deny-direction only and
    // one-directional, so it never leaks into allow/ask/hook-`if:`, and an `Edit`
    // rule never gates a Read. Placed BEFORE the `ruleToolMatches` gate (which,
    // being polarity-agnostic, would otherwise reject the Edit call for a Read
    // rule). Routes through `pathSpecifierMatches` so it reuses the exact glob /
    // anchor / deny-broadening / drive-normalization / realpath-degrade logic a
    // Read deny already applies.
    if (
      opts.deny === true &&
      rule.tool === "Read" &&
      READ_DENY_EDIT_TOOLS.has(call.tool) &&
      rule.specifier !== undefined &&
      rule.specifier !== ""
    ) {
      const input = call.input ?? {};
      return pathSpecifierMatches(
        rule.specifier,
        { ...call, input },
        { deny: opts.deny, anchor: opts.anchor },
      );
    }

    // Deny-only NotebookRead→Read cross: a path-scoped `deny: NotebookRead(<glob>)`
    // also blocks a `Read` call on a matching notebook, because notebook reading
    // now routes through `Read` (NotebookRead is retired to a gating-token stub).
    // Path-specifier'd only — a bare `deny: NotebookRead` does NOT block Reads.
    // Deny-direction only and one-directional (a `Read` rule never gates via this
    // clause). Placed BEFORE the `ruleToolMatches` gate, which — being polarity-
    // agnostic and expanding only `Read`→family, not the reverse — would otherwise
    // reject the Read call for a NotebookRead rule. Reuses `pathSpecifierMatches`
    // (which reads notebook_path/file_path interchangeably) for identical glob /
    // anchor / deny-broadening / drive-normalization / realpath-degrade logic.
    if (
      opts.deny === true &&
      rule.tool === "NotebookRead" &&
      NOTEBOOKREAD_DENY_READ_TOOLS.has(call.tool) &&
      rule.specifier !== undefined &&
      rule.specifier !== ""
    ) {
      const input = call.input ?? {};
      return pathSpecifierMatches(
        rule.specifier,
        { ...call, input },
        { deny: opts.deny, anchor: opts.anchor },
      );
    }

    if (!ruleToolMatches(rule.tool, call.tool)) return false;
    const specifier = rule.specifier;
    if (specifier === undefined || specifier === "") return true; // bare rule

    const input = call.input ?? {};
    const safeCall: ToolCallDescriptor = { ...call, input };
    const pathOpts = { deny: opts.deny, anchor: opts.anchor };

    // Parameter-matching form `Tool(key:value)`: one param per rule, `*`
    // wildcard allowed, e.g. Agent(model:opus), Agent(isolation:worktree),
    // Bash(run_in_background:true). Applies only to non-canonical keys actually
    // present on the call input, so the canonical forms (WebFetch(domain:…),
    // legacy Bash(git:*)) are unaffected.
    if (rule.tool !== "*") {
      const param = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*)$/.exec(specifier);
      const key = param?.[1];
      if (
        key !== undefined &&
        param?.[2] !== undefined &&
        !CANONICAL_INPUT_FIELDS.has(key) &&
        Object.prototype.hasOwnProperty.call(input, key)
      ) {
        return wildcardMatch(param[2].trim(), inputString(input[key]));
      }
    }

    switch (rule.tool) {
      case "*":
        return true; // `*` matches everything; a specifier on `*` is ignored
      case "Bash":
        return bashSpecifierMatches(specifier, safeCall, opts);
      case "NotebookEdit":
        // Claude accepts NotebookEdit(path) syntax but its file checks never match it;
        // Edit(path) is the scoped rule that governs NotebookEdit calls. Parameter
        // rules on non-canonical fields already returned above, and a bare
        // NotebookEdit returned before this switch.
        return false;
      case "Read":
      case "Edit":
      case "Write":
      case "MultiEdit":
      case "NotebookRead":
      case "Glob":
      case "Grep":
        return pathSpecifierMatches(specifier, safeCall, pathOpts);
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
  /** True when an `ask` rule matched and was downgraded to allow. */
  askDowngraded?: boolean;
}

/**
 * Is an MCP rule's tool part an UNANCHORED glob — a wildcard in or before the
 * server segment (`mcp__*`, `mcp__foo*`, `mcp__f*__bar`)? Claude Code rejects
 * these in the ALLOW direction (they would pre-approve arbitrary servers);
 * anchored tool globs (`mcp__server__*`, `mcp__server__get_*`) stay valid.
 * Deny/ask direction keeps accepting all globs (a broad deny is safe).
 */
function isUnanchoredMcpGlob(ruleTool: string): boolean {
  if (!ruleTool.startsWith("mcp__") || !ruleTool.includes("*")) return false;
  const rest = ruleTool.slice("mcp__".length);
  const sep = rest.indexOf("__");
  // No `__` separator before a tool part, or a wildcard inside the server name.
  return sep < 0 || rest.slice(0, sep).includes("*");
}

function isUnmatchedNotebookEditPathRule(ruleText: string): boolean {
  const rule = parseRule(ruleText);
  if (rule.tool !== "NotebookEdit" || rule.specifier === undefined || rule.specifier === "") return false;
  const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/u.exec(rule.specifier);
  return parameter?.[1] === undefined || CANONICAL_INPUT_FIELDS.has(parameter[1]);
}

export class PermissionEngine {
  private readonly rules: PermissionRules;
  private readonly cwd: string;
  private readonly anchor: string;
  /** Allow rules ignored by construction-time validation (unanchored MCP globs). */
  private readonly ignoredAllowRules: ReadonlySet<string>;
  /** Construction-time rule-validation warnings surfaced by the embedder. */
  readonly diagnostics: Diagnostic[] = [];

  /**
   * `cwd` — the session launch dir; used only as the fallback for resolving
   * relative input paths when a call carries no cwd of its own.
   * `root` — the STABLE anchor for path-rule matching: the settings-source /
   * project root that declared the rules (defaults to `cwd`). Both are fixed
   * at construction; rule anchoring never follows the live per-call cwd, so
   * EnterWorktree / cwd drift cannot move a deny rule off the paths it was
   * written to protect.
   */
  constructor(rules: PermissionRules, opts: { cwd: string; root?: string }) {
    this.rules = rules;
    this.cwd = opts.cwd;
    this.anchor = opts.root ?? opts.cwd;
    // Claude accepts NotebookEdit(path) rules but file permission checks never
    // match them; Edit(path) is the scoped family rule. Report every settings
    // occurrence without echoing project-controlled rule text to the terminal.
    for (const kind of ["allow", "deny", "ask"] as const) {
      for (const rule of this.ruleList(kind)) {
        if (!isUnmatchedNotebookEditPathRule(rule)) continue;
        this.diagnostics.push({
          severity: "warning",
          message:
            `permissions.${kind} contains a scoped NotebookEdit rule that is not matched by file ` +
            `permission checks; use Edit(path) instead (Edit rules cover NotebookEdit)`,
          source: "permissions",
        });
      }
    }

    // Claude rejects allow rules whose MCP tool part is an unanchored glob.
    // PiCC ignores them for allow matching and reports a warning.
    const ignored = new Set<string>();
    for (const rule of this.ruleList("allow")) {
      if (!isUnanchoredMcpGlob(parseRule(rule).tool)) continue;
      ignored.add(rule);
      this.diagnostics.push({
        severity: "warning",
        message:
          `permissions.allow rule "${rule}" ignored: MCP allow rules must anchor the ` +
          `server name (use "mcp__server" or "mcp__server__*"); Claude Code rejects ` +
          `unanchored globs like "mcp__*"`,
        source: "permissions",
      });
    }
    this.ignoredAllowRules = ignored;
  }

  /**
   * The STABLE settings-source/project anchor used for path-rule matching —
   * exposed so co-enforcers (the guard's active-skill deny rules) can match
   * with the exact same deny-direction anchoring as {@link evaluate}.
   */
  get pathAnchor(): string {
    return this.anchor;
  }

  /**
   * Evaluate a tool call. Order: deny → ask → allow; deny is a hard block; a
   * matching `ask` rule is downgraded to allow but reported (`askDowngraded`)
   * so the caller can log it; no match at all is "default" — never blocking
   * (default-permissive posture).
   */
  evaluate(call: ToolCallDescriptor): PermissionEvaluation {
    const effective: ToolCallDescriptor = { ...call, cwd: call?.cwd || this.cwd };
    for (const rule of this.ruleList("deny")) {
      // anySegment/deny: a deny must hit even when the denied command hides
      // inside a chain (`git status && curl evil` vs deny `Bash(curl *)`) or
      // behind a symlink / drifted cwd (path rules).
      if (matchesRule(rule, effective, { anySegment: true, deny: true, anchor: this.anchor })) {
        return { decision: "deny", rule };
      }
    }
    for (const rule of this.ruleList("ask")) {
      if (matchesRule(rule, effective, { anchor: this.anchor })) {
        return { decision: "allow", rule, askDowngraded: true };
      }
    }
    for (const rule of this.ruleList("allow")) {
      if (this.ignoredAllowRules.has(rule)) continue; // unanchored MCP glob
      if (matchesRule(rule, effective, { anchor: this.anchor })) {
        return { decision: "allow", rule };
      }
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
   * the tool in context and blocks per-call instead.
   *
   * Settings `deny` rules with a BARE tool name also remove the tool from
   * context entirely; a bare `Edit` deny removes all file-editing tools and
   * a bare `Read` deny removes all file-reading tools (Grep/Glob/NotebookRead),
   * matching the call-time rule expansion. A SCOPED deny (`Read(glob)`) removes
   * nothing from context — the specifier guard leaves the tool in place and it
   * is blocked per-call instead.
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
    const denyRemoves = (entry: string, tool: string): boolean => {
      const rule = parseRule(entry);
      if (rule.specifier !== undefined && rule.specifier !== "") return false;
      return ruleToolMatches(rule.tool, tool);
    };

    let result =
      granted === undefined
        ? [...allKnown]
        : allKnown.filter((tool) => granted.some((g) => grantMatches(g, tool)));
    if (disallowed && disallowed.length > 0) {
      result = result.filter((tool) => !disallowed.some((d) => removeMatches(d, tool)));
    }
    const deny = this.ruleList("deny");
    if (deny.length > 0) {
      result = result.filter((tool) => !deny.some((d) => denyRemoves(d, tool)));
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
