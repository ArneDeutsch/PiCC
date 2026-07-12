import path from "node:path";
import type {
  ClaudeSkill,
  Diagnostic,
  HookConfig,
  Scope,
  SkillArgumentSpec,
} from "../types.js";
import { parseMarkdown, toBool, toStringList } from "../util/markdown.js";
import { isDirectory, readTextSafe, walkFiles } from "../util/fs.js";

/**
 * Skills subsystem core (plan §4.1).
 *
 * Progressive disclosure is a hard NFR (§12.1): `loadSkills` parses ONLY the
 * frontmatter — the SKILL.md body is never stored on the returned objects
 * (`body: undefined`). The body enters context only via `loadSkillBody`,
 * which re-reads the file fresh on activation.
 */

// ---------------------------------------------------------------------------
// Frontmatter keys we recognize (everything else lands in `unknownKeys`).
// ---------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  "name",
  "description",
  "when_to_use",
  "whenToUse",
  "user-invocable",
  "disable-model-invocation",
  "argument-hint",
  "arguments",
  "allowed-tools",
  "disallowed-tools",
  "model",
  "effort",
  "context",
  "agent",
  "hooks",
  "paths",
  "shell",
  "metadata",
  "license",
  "display-name",
  "default-enabled",
  "fallback",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toOptString(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function parseShell(
  value: unknown,
  diagnostics: Diagnostic[],
  source: string,
): "bash" | "powershell" {
  if (value === undefined || value === null) return "bash";
  const s = String(value).trim().toLowerCase();
  if (s === "powershell" || s === "pwsh") return "powershell";
  if (s === "bash" || s === "") return "bash";
  diagnostics.push({
    severity: "warning",
    message: `Unknown shell "${String(value)}"; defaulting to bash`,
    source,
  });
  return "bash";
}

/**
 * Coerce `allowed-tools:` / `disallowed-tools:` / `paths:` frontmatter (Claude
 * Code convention: a YAML list, or a single comma-separated string) into a
 * string list. Unlike a naive comma split, commas nested inside (), [] or {}
 * do not separate items — permission rules like `Bash(echo a,b)` and globs
 * like `src/**\/*.{ts,tsx}` stay intact.
 */
function toRuleList(value: unknown): string[] | undefined {
  if (typeof value !== "string") return toStringList(value);
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of value) {
    if (c === "," && depth === 0) {
      items.push(cur);
      cur = "";
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    cur += c;
  }
  items.push(cur);
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Coerce the `arguments:` frontmatter (string, string list, or object list) into specs. */
function toArgumentSpecs(
  value: unknown,
  diagnostics: Diagnostic[],
  source: string,
): SkillArgumentSpec[] | undefined {
  if (value === undefined || value === null) return undefined;
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/).filter(Boolean)
      : [value];
  const specs: SkillArgumentSpec[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const name = item.trim();
      if (name) specs.push({ name });
      continue;
    }
    if (isPlainObject(item)) {
      const name = toOptString(item.name);
      if (!name) {
        diagnostics.push({
          severity: "warning",
          message: "arguments entry without a name ignored",
          source,
        });
        continue;
      }
      const spec: SkillArgumentSpec = { name };
      if (item.description !== undefined) spec.description = String(item.description);
      if (item.required !== undefined) spec.required = toBool(item.required, false);
      if (item.default !== undefined) spec.default = String(item.default);
      specs.push(spec);
    }
  }
  return specs.length ? specs : undefined;
}

/**
 * Skill metadata mapping: the `metadata:` block plus the dedicated informational
 * keys Claude Code parses since v2.1.186 (`license`, `display-name`) folded in.
 */
function toSkillMetadata(fm: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = isPlainObject(fm["metadata"]) ? { ...fm["metadata"] } : {};
  const license = toOptString(fm["license"]);
  if (license && metadata["license"] === undefined) metadata["license"] = license;
  const displayName = toOptString(fm["display-name"]);
  if (displayName && metadata["display-name"] === undefined) metadata["display-name"] = displayName;
  return metadata;
}

function toHookConfig(
  value: unknown,
  diagnostics: Diagnostic[],
  source: string,
): HookConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    diagnostics.push({
      severity: "warning",
      message: "hooks frontmatter is not a mapping; ignored",
      source,
    });
    return undefined;
  }
  return value as unknown as HookConfig;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export interface LoadSkillsResult {
  skills: ClaudeSkill[];
  diagnostics: Diagnostic[];
}

/**
 * Colon-qualified fallback name for an entry nested under intermediate
 * directories (Claude v2.1.203 nested-name qualification): the subdir path
 * relative to `rootDir` with separators turned into colons, prefixing the
 * entry's plain name (e.g. commands/frontend/deploy.md → `frontend:deploy`,
 * skills/group/foo/SKILL.md → `group:foo`). Undefined for top-level entries.
 */
function qualifiedNameFor(rootDir: string, containerDir: string, name: string): string | undefined {
  const rel = path.relative(rootDir, containerDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const segments = rel.split(/[\\/]/).filter(Boolean);
  if (!segments.length) return undefined;
  return [...segments, name].join(":");
}

/**
 * Discover and parse skills (recursive `SKILL.md` under each skill dir) and
 * legacy commands (recursive `*.md` under each command dir).
 *
 * Dedupe by name: skills win over legacy commands; within each group the
 * first occurrence wins the plain name (callers encode scope precedence via
 * input order). An entry nested under intermediate directories is ALWAYS also
 * reachable under its colon-qualified name (`<subdirs>:<name>`): a listing-
 * hidden alias entry is registered alongside the plain stem, and when the
 * plain name collides the entry is registered under the qualified name
 * instead of being dropped. Never throws (completeness floor).
 */
export function loadSkills(
  skillDirs: Array<{ dir: string; scope: Scope }>,
  commandDirs: Array<{ dir: string; scope: Scope }>,
  opts: { pluginName?: string } = {},
): LoadSkillsResult {
  const diagnostics: Diagnostic[] = [];
  type Entry = { skill: ClaudeSkill; qualified?: string };
  const skills: Entry[] = [];
  for (const { dir, scope } of skillDirs) {
    if (!isDirectory(dir)) continue;
    const files = walkFiles(dir, (name) => name === "SKILL.md").sort();
    for (const file of files) {
      const skill = parseSkillFile(file, scope, opts.pluginName, diagnostics);
      if (!skill) continue;
      // Intermediate dirs only: the skill's OWN directory is its identity, not a namespace.
      const qualified = qualifiedNameFor(dir, path.dirname(skill.baseDir), skill.name);
      skills.push({ skill, qualified });
    }
  }

  const commands: Entry[] = [];
  for (const { dir, scope } of commandDirs) {
    if (!isDirectory(dir)) continue;
    const files = walkFiles(dir, (name) => name.toLowerCase().endsWith(".md")).sort();
    for (const file of files) {
      const cmd = parseCommandFile(file, path.dirname(file), scope, opts.pluginName, diagnostics);
      if (!cmd) continue;
      const qualified = qualifiedNameFor(dir, path.dirname(file), cmd.name);
      commands.push({ skill: cmd, qualified });
    }
  }

  const byName = new Map<string, ClaudeSkill>();
  for (const { skill: entry, qualified } of [...skills, ...commands]) {
    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      // Nested entries are ALWAYS reachable under their colon-qualified name
      // too (not only on collision): register a lightweight alias entry that
      // is hidden from the model listing (the plain stem already lists) but
      // keeps the entry's own user-invocability for `/sub:name` slash calls.
      if (qualified && !byName.has(qualified)) {
        byName.set(qualified, { ...entry, name: qualified, disableModelInvocation: true });
      }
      continue;
    }
    if (qualified && !byName.has(qualified)) {
      diagnostics.push({
        severity: "info",
        message: `${entry.legacyCommand ? "Legacy command" : "Skill"} "${entry.name}" at ${entry.source.path} collides with ${existing.source.path}; registered as "${qualified}"`,
        source: entry.source.path,
      });
      entry.name = qualified;
      byName.set(qualified, entry);
      continue;
    }
    diagnostics.push({
      severity: "info",
      message: `${entry.legacyCommand ? "Legacy command" : "Skill"} "${entry.name}" at ${entry.source.path} shadowed by ${existing.legacyCommand ? "legacy command" : "skill"} at ${existing.source.path}`,
      source: entry.source.path,
    });
  }
  return { skills: [...byName.values()], diagnostics };
}

function parseSkillFile(
  file: string,
  scope: Scope,
  pluginName: string | undefined,
  outDiagnostics: Diagnostic[],
): ClaudeSkill | undefined {
  const raw = readTextSafe(file);
  if (raw === undefined) {
    outDiagnostics.push({
      severity: "warning",
      message: `Cannot read skill file; skipped`,
      source: file,
    });
    return undefined;
  }
  const parsed = parseMarkdown(raw, file);
  const fm = parsed.frontmatter;
  const skillDiagnostics: Diagnostic[] = [...parsed.diagnostics];
  const baseDir = path.dirname(file);
  const name = toOptString(fm["name"]) ?? path.basename(baseDir);

  // `fallback:` is the description default (v2.1.186) — it keeps a skill loadable
  // when the frontmatter degraded (lenient parse) or omits `description`.
  const description = toOptString(fm["description"]) ?? toOptString(fm["fallback"]);
  if (!description) {
    outDiagnostics.push({
      severity: "warning",
      message: `Skill "${name}" has no description; skipped`,
      source: file,
    });
    return undefined;
  }

  return {
    name,
    description,
    whenToUse: toOptString(fm["when_to_use"] ?? fm["whenToUse"]),
    userInvocable: toBool(fm["user-invocable"], true),
    disableModelInvocation: toBool(fm["disable-model-invocation"], false),
    argumentHint: toOptString(fm["argument-hint"]),
    arguments: toArgumentSpecs(fm["arguments"], skillDiagnostics, file),
    allowedTools: toRuleList(fm["allowed-tools"]),
    disallowedTools: toRuleList(fm["disallowed-tools"]),
    model: toOptString(fm["model"]),
    effort: toOptString(fm["effort"]),
    contextFork: toOptString(fm["context"])?.toLowerCase() === "fork",
    forkAgentType: toOptString(fm["agent"]),
    hooks: toHookConfig(fm["hooks"], skillDiagnostics, file),
    paths: toRuleList(fm["paths"]),
    shell: parseShell(fm["shell"], skillDiagnostics, file),
    metadata: toSkillMetadata(fm),
    baseDir,
    source: { path: file, scope, ...(pluginName ? { pluginName } : {}) },
    body: undefined, // progressive disclosure — loaded only via loadSkillBody
    legacyCommand: false,
    unknownKeys: Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k)),
    diagnostics: skillDiagnostics,
  };
}

/** First markdown heading text, else first non-empty line, of a body. */
function firstHeadingOrLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(t);
    return (h ? h[1]! : t).trim();
  }
  return undefined;
}

function parseCommandFile(
  file: string,
  commandDir: string,
  scope: Scope,
  pluginName: string | undefined,
  outDiagnostics: Diagnostic[],
): ClaudeSkill | undefined {
  const raw = readTextSafe(file);
  if (raw === undefined) {
    outDiagnostics.push({
      severity: "warning",
      message: `Cannot read command file; skipped`,
      source: file,
    });
    return undefined;
  }
  const parsed = parseMarkdown(raw, file);
  const fm = parsed.frontmatter;
  const skillDiagnostics: Diagnostic[] = [...parsed.diagnostics];
  const name = path.basename(file).replace(/\.md$/i, "");
  const description =
    toOptString(fm["description"]) ??
    toOptString(fm["fallback"]) ??
    firstHeadingOrLine(parsed.body) ??
    name;

  return {
    name,
    description,
    whenToUse: toOptString(fm["when_to_use"] ?? fm["whenToUse"]),
    userInvocable: true, // legacy commands are always user-invocable
    disableModelInvocation: toBool(fm["disable-model-invocation"], false),
    argumentHint: toOptString(fm["argument-hint"]),
    arguments: toArgumentSpecs(fm["arguments"], skillDiagnostics, file),
    allowedTools: toRuleList(fm["allowed-tools"]),
    disallowedTools: toRuleList(fm["disallowed-tools"]),
    model: toOptString(fm["model"]),
    effort: toOptString(fm["effort"]),
    contextFork: toOptString(fm["context"])?.toLowerCase() === "fork",
    forkAgentType: toOptString(fm["agent"]),
    hooks: toHookConfig(fm["hooks"], skillDiagnostics, file),
    paths: toRuleList(fm["paths"]),
    shell: parseShell(fm["shell"], skillDiagnostics, file),
    metadata: toSkillMetadata(fm),
    baseDir: commandDir,
    source: { path: file, scope, ...(pluginName ? { pluginName } : {}) },
    body: undefined,
    legacyCommand: true,
    unknownKeys: Object.keys(fm).filter((k) => !KNOWN_KEYS.has(k)),
    diagnostics: skillDiagnostics,
  };
}

/**
 * Load the skill body on activation. Reads the file fresh (live reload) and
 * returns the content after the frontmatter. Never throws: a missing/unreadable
 * file yields "". On success the body is also cached on `skill.body`.
 */
export function loadSkillBody(skill: ClaudeSkill): string {
  const raw = readTextSafe(skill.source.path);
  if (raw === undefined) return "";
  const body = parseMarkdown(raw, skill.source.path).body;
  skill.body = body;
  return body;
}

// ---------------------------------------------------------------------------
// Startup listing (Level-1 metadata; §12.1 budget)
// ---------------------------------------------------------------------------

function trimTo(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return one.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/** Claude's per-entry description cap for the skill listing. */
const LISTING_DEFAULT_MAX_DESC_CHARS = 1536;
/** Default listing budget: context window (~200k tokens × 4 chars) × 0.01. */
const LISTING_DEFAULT_BUDGET_CHARS = Math.max(500, Math.floor(200_000 * 4 * 0.01));
/** Tier-3 floor for the progressively halved per-entry description cap. */
const LISTING_MIN_DESC_CHARS = 64;

/**
 * Render the startup context listing: one line per model-invocable skill.
 * Deterministic (input order). When the listing exceeds the budget it degrades
 * in tiers like Claude Code rather than cutting skills off: tier 1 full entries,
 * tier 2 drops `when:` clauses, tier 3 progressively halves the description cap
 * (floor 64 chars), tier 4 lists names only. Every skill always appears.
 * `SLASH_COMMAND_TOOL_CHAR_BUDGET` (env, integer chars) overrides the budget.
 * The tier applied is reported as an info diagnostic via `opts.diagnostics`.
 */
export function renderSkillListing(
  skills: ClaudeSkill[],
  opts: { budgetChars?: number; maxDescChars?: number; diagnostics?: Diagnostic[] },
): string {
  const maxDesc = opts.maxDescChars ?? LISTING_DEFAULT_MAX_DESC_CHARS;
  const envRaw = process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET;
  const envBudget = envRaw === undefined ? Number.NaN : Number.parseInt(envRaw, 10);
  const budget =
    Number.isFinite(envBudget) && envBudget > 0
      ? envBudget
      : (opts.budgetChars ?? LISTING_DEFAULT_BUDGET_CHARS);
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (!visible.length) return "";

  const render = (descCap: number, withWhen: boolean): string =>
    visible
      .map((s) => {
        let line = `- ${s.name}: ${trimTo(s.description, descCap)}`;
        if (withWhen && s.whenToUse) line += ` (when: ${trimTo(s.whenToUse, descCap)})`;
        return line;
      })
      .join("\n");
  const degraded = (tier: number, text: string, detail: string): string => {
    opts.diagnostics?.push({
      severity: "info",
      message: `Skill listing over budget (${budget} chars); degraded to tier ${tier} (${detail})`,
    });
    return text;
  };

  // Tier 1: full entries.
  let text = render(maxDesc, true);
  if (text.length <= budget) return text;
  // Tier 2: drop when: clauses.
  text = render(maxDesc, false);
  if (text.length <= budget) return degraded(2, text, "dropped when: clauses");
  // Tier 3: progressively halve the per-entry description cap (floor 64).
  const capFloor = Math.min(LISTING_MIN_DESC_CHARS, maxDesc);
  let cap = Math.max(capFloor, Math.floor(maxDesc / 2));
  for (;;) {
    text = render(cap, false);
    if (text.length <= budget) {
      return degraded(3, text, `descriptions truncated to ${cap} chars`);
    }
    if (cap <= capFloor) break;
    cap = Math.max(capFloor, Math.floor(cap / 2));
  }
  // Tier 4: names only — never silently omit a skill.
  return degraded(4, visible.map((s) => `- ${s.name}`).join("\n"), "names only");
}

// ---------------------------------------------------------------------------
// Argument substitution ($ARGUMENTS / $N / $ARGUMENTS[N] / $name / \$ escaping)
// ---------------------------------------------------------------------------

/** Shell-like tokenizer: whitespace-separated, double/single quotes group words. */
function tokenizeArgs(s: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasToken = false;
  let quote: "'" | '"' | undefined;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = undefined;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      hasToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (hasToken) {
        tokens.push(cur);
        cur = "";
        hasToken = false;
      }
      continue;
    }
    cur += c;
    hasToken = true;
  }
  if (hasToken) tokens.push(cur);
  return tokens;
}

/**
 * Claude argument substitution semantics:
 * - `$ARGUMENTS` → full args string as typed
 * - `$N` ≡ `$ARGUMENTS[N]`: 0-based positional token (`$0` = first argument),
 *   greedy multi-digit (`$100` is ONE token = argument index 100)
 * - `$name` → named argument when `spec` defines it (`--name value`,
 *   `name=value`, or positional by spec order; falls back to spec default)
 * - a single `\` immediately before a recognizable token emits the literal
 *   token without that backslash and without substitution. Backslash PAIRS are
 *   NOT collapsed (Claude's rule, audit A2): `\\$1` keeps BOTH backslashes and
 *   the token still expands; only the odd trailing backslash of a run escapes
 *   (`\\\$1` → two backslashes + literal `$1`). A backslash before anything
 *   else is left untouched.
 * - `$$` has no special meaning (each `$` is scanned on its own)
 * - unmatched positional/named → "" + info diagnostic
 * - args given but body has no marker → append `\n\nARGUMENTS: <argsText>`
 *   (suppress via `opts.appendFallback: false` — used for tool-rule entries)
 */
export function substituteArguments(
  body: string,
  argsText: string,
  spec?: SkillArgumentSpec[],
  opts: { appendFallback?: boolean } = {},
): { text: string; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const tokens = tokenizeArgs(argsText);
  const specs = spec ?? [];
  const names = new Set(specs.map((s) => s.name));

  // Split tokens into named (matched against spec names) and positionals.
  const namedRaw = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=");
      const nm = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      if (names.has(nm)) {
        if (eq >= 0) {
          namedRaw.set(nm, t.slice(eq + 1));
        } else if (i + 1 < tokens.length) {
          namedRaw.set(nm, tokens[i + 1]!);
          i++;
        } else {
          namedRaw.set(nm, "");
        }
        continue;
      }
    } else {
      const eq = t.indexOf("=");
      if (eq > 0 && names.has(t.slice(0, eq))) {
        namedRaw.set(t.slice(0, eq), t.slice(eq + 1));
        continue;
      }
    }
    positionals.push(t);
  }

  // Resolve each spec name: explicit named > positional by spec order > default.
  const resolved = new Map<string, string | undefined>();
  let posCursor = 0;
  for (const s of specs) {
    if (namedRaw.has(s.name)) {
      resolved.set(s.name, namedRaw.get(s.name));
      continue;
    }
    if (posCursor < positionals.length) {
      resolved.set(s.name, positionals[posCursor++]);
      continue;
    }
    resolved.set(s.name, s.default);
  }

  let markerCount = 0;
  const unmatched = (marker: string): string => {
    diagnostics.push({
      severity: "info",
      message: `No argument value for ${marker}; substituted empty string`,
    });
    return "";
  };

  // A leading backslash run is captured so `\` can escape the token it precedes.
  const re =
    /(\\*)(\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$(\d+)|\$([A-Za-z_][A-Za-z0-9_-]*))/g;
  const text = body.replace(
    re,
    (m, backslashes: string, token: string, bracketIdx?: string, posDigits?: string, name?: string) => {
      // $SOMETHING that is not a known argument name stays verbatim (incl. any backslashes).
      if (name !== undefined && !names.has(name)) return m;
      // Claude's rule (audit A2): only the single odd trailing backslash of a
      // run escapes the token; backslash pairs stay VERBATIM (no bash-style
      // collapsing) and an even run still expands the token.
      if (backslashes.length % 2 === 1) return backslashes.slice(1) + token;
      const literalPrefix = backslashes;
      markerCount++;
      let value: string;
      if (bracketIdx !== undefined) {
        const v = positionals[Number(bracketIdx)];
        value = v === undefined ? unmatched(token) : v;
      } else if (token === "$ARGUMENTS") {
        value = argsText;
      } else if (posDigits !== undefined) {
        const v = positionals[Number(posDigits)];
        value = v === undefined ? unmatched(token) : v;
      } else {
        const v = resolved.get(name!);
        value = v === undefined ? unmatched(token) : v;
      }
      return literalPrefix + value;
    },
  );

  let out = text;
  if ((opts.appendFallback ?? true) && argsText.trim() !== "" && markerCount === 0) {
    out += `\n\nARGUMENTS: ${argsText}`;
  }
  return { text: out, diagnostics };
}

// ---------------------------------------------------------------------------
// ${CLAUDE_*} variable substitution
// ---------------------------------------------------------------------------

/**
 * Replace `${CLAUDE_*}` variables (`CLAUDE_SKILL_DIR`, `CLAUDE_PROJECT_DIR`,
 * `CLAUDE_SESSION_ID`, `CLAUDE_EFFORT`, `CLAUDE_PLUGIN_ROOT`,
 * `CLAUDE_PLUGIN_DATA`, and any other `CLAUDE_*` key present in `vars`).
 * Unknown / undefined variables are left verbatim (no error).
 */
export function substituteVariables(
  text: string,
  vars: Record<string, string | undefined>,
): string {
  return text.replace(/\$\{(CLAUDE_[A-Za-z0-9_]+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

/**
 * Apply the SAME `${CLAUDE_*}` and `$ARGUMENTS`/`$N`/`$name` substitution the
 * skill body gets to `allowed-tools` / `disallowed-tools` entries (Claude Code
 * substitutes both — docs; issue #67652). Returns a per-activation copy; the
 * loaded skill object is never mutated. The no-marker `ARGUMENTS:` fallback is
 * suppressed (tool rules are patterns, not prose). Never throws.
 */
export function substituteToolRules(
  rules: string[] | undefined,
  argsText: string,
  vars: Record<string, string | undefined>,
  spec?: SkillArgumentSpec[],
): string[] | undefined {
  if (!rules || rules.length === 0) return rules;
  return rules.map(
    (rule) =>
      substituteArguments(substituteVariables(rule, vars), argsText, spec, {
        appendFallback: false,
      }).text,
  );
}
