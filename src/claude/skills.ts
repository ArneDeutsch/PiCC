import path from "node:path";
import type {
  ClaudeSkill,
  Diagnostic,
  HookConfig,
  Scope,
  SkillArgumentSpec,
} from "../types.js";
import { parseMarkdown, toBool, toStringList } from "../util/markdown.js";
import { isDirectory, listDirSafe, readTextSafe, walkFiles } from "../util/fs.js";

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
 * Discover and parse skills (recursive `SKILL.md` under each skill dir) and
 * legacy commands (`*.md` directly inside each command dir).
 *
 * Dedupe by name: skills win over legacy commands; within each group the
 * first occurrence wins (callers encode scope precedence via input order).
 * Never throws (completeness floor).
 */
export function loadSkills(
  skillDirs: Array<{ dir: string; scope: Scope }>,
  commandDirs: Array<{ dir: string; scope: Scope }>,
  opts: { pluginName?: string } = {},
): LoadSkillsResult {
  const diagnostics: Diagnostic[] = [];
  const skills: ClaudeSkill[] = [];
  for (const { dir, scope } of skillDirs) {
    if (!isDirectory(dir)) continue;
    const files = walkFiles(dir, (name) => name === "SKILL.md").sort();
    for (const file of files) {
      const skill = parseSkillFile(file, scope, opts.pluginName, diagnostics);
      if (skill) skills.push(skill);
    }
  }

  const commands: ClaudeSkill[] = [];
  for (const { dir, scope } of commandDirs) {
    if (!isDirectory(dir)) continue;
    const names = listDirSafe(dir)
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const cmd = parseCommandFile(path.join(dir, name), dir, scope, opts.pluginName, diagnostics);
      if (cmd) commands.push(cmd);
    }
  }

  const byName = new Map<string, ClaudeSkill>();
  for (const entry of [...skills, ...commands]) {
    const existing = byName.get(entry.name);
    if (existing) {
      diagnostics.push({
        severity: "info",
        message: `${entry.legacyCommand ? "Legacy command" : "Skill"} "${entry.name}" at ${entry.source.path} shadowed by ${existing.legacyCommand ? "legacy command" : "skill"} at ${existing.source.path}`,
        source: entry.source.path,
      });
      continue;
    }
    byName.set(entry.name, entry);
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

  const description = toOptString(fm["description"]);
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
    allowedTools: toStringList(fm["allowed-tools"]),
    disallowedTools: toStringList(fm["disallowed-tools"]),
    model: toOptString(fm["model"]),
    effort: toOptString(fm["effort"]),
    contextFork: toOptString(fm["context"])?.toLowerCase() === "fork",
    forkAgentType: toOptString(fm["agent"]),
    hooks: toHookConfig(fm["hooks"], skillDiagnostics, file),
    paths: toStringList(fm["paths"]),
    shell: parseShell(fm["shell"], skillDiagnostics, file),
    metadata: isPlainObject(fm["metadata"]) ? fm["metadata"] : {},
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
    toOptString(fm["description"]) ?? firstHeadingOrLine(parsed.body) ?? name;

  return {
    name,
    description,
    whenToUse: toOptString(fm["when_to_use"] ?? fm["whenToUse"]),
    userInvocable: true, // legacy commands are always user-invocable
    disableModelInvocation: toBool(fm["disable-model-invocation"], false),
    argumentHint: toOptString(fm["argument-hint"]),
    arguments: toArgumentSpecs(fm["arguments"], skillDiagnostics, file),
    allowedTools: toStringList(fm["allowed-tools"]),
    disallowedTools: toStringList(fm["disallowed-tools"]),
    model: toOptString(fm["model"]),
    effort: toOptString(fm["effort"]),
    contextFork: toOptString(fm["context"])?.toLowerCase() === "fork",
    forkAgentType: toOptString(fm["agent"]),
    hooks: toHookConfig(fm["hooks"], skillDiagnostics, file),
    paths: toStringList(fm["paths"]),
    shell: parseShell(fm["shell"], skillDiagnostics, file),
    metadata: isPlainObject(fm["metadata"]) ? fm["metadata"] : {},
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

/**
 * Render the startup context listing: one line per model-invocable skill.
 * Deterministic (input order); stops when `budgetChars` would be exceeded and
 * appends "… (+N more skills)".
 */
export function renderSkillListing(
  skills: ClaudeSkill[],
  opts: { budgetChars?: number; maxDescChars?: number },
): string {
  const maxDesc = opts.maxDescChars ?? 200;
  const budget = opts.budgetChars ?? Number.POSITIVE_INFINITY;
  const visible = skills.filter((s) => !s.disableModelInvocation);
  const lines: string[] = [];
  let total = 0;
  let included = 0;
  for (const s of visible) {
    let line = `- ${s.name}: ${trimTo(s.description, maxDesc)}`;
    if (s.whenToUse) line += ` (when: ${trimTo(s.whenToUse, maxDesc)})`;
    const cost = line.length + (lines.length > 0 ? 1 : 0); // +1 for the joining newline
    if (total + cost > budget) break;
    lines.push(line);
    total += cost;
    included++;
  }
  const remaining = visible.length - included;
  if (remaining > 0) lines.push(`… (+${remaining} more skills)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Argument substitution ($ARGUMENTS / $N / $ARGUMENTS[N] / $name / $$)
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
 * - `$ARGUMENTS[N]` (0-based) / `$1`..`$9` (1-based) → positional token
 * - `$name` → named argument when `spec` defines it (`--name value`,
 *   `name=value`, or positional by spec order; falls back to spec default)
 * - `$$` → literal `$`
 * - unmatched positional/named → "" + info diagnostic
 * - args given but body has no marker → append `\n\nARGUMENTS: <argsText>`
 */
export function substituteArguments(
  body: string,
  argsText: string,
  spec?: SkillArgumentSpec[],
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

  const re = /\$\$|\$ARGUMENTS\[(\d+)\]|\$ARGUMENTS\b|\$([1-9])(?![0-9])|\$([A-Za-z_][A-Za-z0-9_-]*)/g;
  const text = body.replace(re, (m, bracketIdx?: string, posDigit?: string, name?: string) => {
    if (m === "$$") return "$";
    if (bracketIdx !== undefined) {
      markerCount++;
      const v = positionals[Number(bracketIdx)];
      return v === undefined ? unmatched(m) : v;
    }
    if (m === "$ARGUMENTS") {
      markerCount++;
      return argsText;
    }
    if (posDigit !== undefined) {
      markerCount++;
      const v = positionals[Number(posDigit) - 1];
      return v === undefined ? unmatched(m) : v;
    }
    if (name !== undefined && names.has(name)) {
      markerCount++;
      const v = resolved.get(name);
      return v === undefined ? unmatched(m) : v;
    }
    return m; // $SOMETHING that is not a known argument name stays verbatim
  });

  let out = text;
  if (argsText.trim() !== "" && markerCount === 0) {
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
