import { parse as parseYaml } from "yaml";
import type { Diagnostic, ParsedMarkdown } from "../types.js";

/**
 * Split a markdown document into YAML frontmatter and body.
 *
 * Rules (Claude Code compatible):
 * - Frontmatter must start at the very first line with `---` and end at the next `---` line.
 * - Malformed YAML never throws: the file degrades to frontmatter={} with a warning
 *   diagnostic and the whole content as body (completeness floor, plan §2.2).
 * - CRLF tolerated.
 */
export function parseMarkdown(content: string, sourcePath?: string): ParsedMarkdown {
  const diagnostics: Diagnostic[] = [];
  const normalized = content.replace(/^﻿/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: normalized, diagnostics };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]?.trim();
    if (t === "---" || t === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    diagnostics.push({
      severity: "warning",
      message: "Unterminated frontmatter block; treating file as body-only",
      source: sourcePath,
    });
    return { frontmatter: {}, body: normalized, diagnostics };
  }

  const yamlText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  try {
    const parsed = parseYaml(yamlText);
    if (parsed === null || parsed === undefined) {
      return { frontmatter: {}, body, diagnostics };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      diagnostics.push({
        severity: "warning",
        message: "Frontmatter is not a mapping; ignored",
        source: sourcePath,
      });
      return { frontmatter: {}, body, diagnostics };
    }
    return { frontmatter: parsed as Record<string, unknown>, body, diagnostics };
  } catch (err) {
    // Claude Code is lenient where strict YAML is not (e.g. an unquoted
    // description containing ": "). Mechanical fidelity requires accepting
    // what Claude Code accepts — recover with a line-based lenient parse.
    const lenient = lenientParseFrontmatter(yamlText);
    diagnostics.push({
      severity: "info",
      message: `Frontmatter parsed leniently (strict YAML error: ${(err as Error).message.split("\n")[0]})`,
      source: sourcePath,
    });
    return { frontmatter: lenient, body, diagnostics };
  }
}

/**
 * Line-based lenient frontmatter parser (fallback when strict YAML fails).
 * Handles the shapes Claude artifacts actually use: `key: value` scalars
 * (colons allowed inside the value), `key:` starting a nested mapping or a
 * `- item` list, one nesting level per two-space indent, quoted scalars,
 * and `|`/`>` block scalars.
 */
export function lenientParseFrontmatter(yamlText: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = yamlText.split(/\r?\n/);
  // Stack of (indent, container) — containers are mutated in place.
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [
    { indent: -1, value: root },
  ];

  const unquote = (raw: string): string => {
    const t = raw.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const parent = stack[stack.length - 1]!.value;

    if (trimmed.startsWith("- ") || trimmed === "-") {
      const item = unquote(trimmed.slice(1).trim());
      if (Array.isArray(parent)) {
        parent.push(item);
      } else {
        // list item directly under a mapping key that we already turned into
        // an object — degrade by storing under a synthetic key order
        continue;
      }
      continue;
    }

    const m = /^([^:\s][^:]*?):(.*)$/.exec(trimmed);
    if (!m || Array.isArray(parent)) continue;
    const key = unquote(m[1] ?? "");
    const rest = (m[2] ?? "").trim();
    if (!key) continue;

    if (rest === "" ) {
      // Look ahead: list or nested mapping?
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
      const nextIndent = next ? next.length - next.trimStart().length : 0;
      if (next && nextIndent > indent && next.trim().startsWith("-")) {
        const list: unknown[] = [];
        parent[key] = list;
        stack.push({ indent, value: list });
      } else if (next && nextIndent > indent) {
        const obj: Record<string, unknown> = {};
        parent[key] = obj;
        stack.push({ indent, value: obj });
      } else {
        parent[key] = "";
      }
      continue;
    }

    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      // Block scalar: consume all more-indented lines.
      const block: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim() === "") {
          block.push("");
          continue;
        }
        const li = l.length - l.trimStart().length;
        if (li <= indent) break;
        block.push(l.slice(indent + 2));
      }
      i = j - 1;
      parent[key] = block.join(rest.startsWith(">") ? " " : "\n").trim();
      continue;
    }

    // A malformed inline flow collection (`[unclosed`, `{oops`) can't be trusted —
    // skip the key so it degrades to "unset" rather than a bogus scalar. A
    // properly-closed flow collection is uncommon in Claude frontmatter; leave
    // those to the strict parser (which already succeeded if they were valid).
    if (
      (rest.startsWith("[") && !rest.endsWith("]")) ||
      (rest.startsWith("{") && !rest.endsWith("}"))
    ) {
      continue;
    }

    if (rest === "true" || rest === "false") {
      parent[key] = rest === "true";
    } else if (/^-?\d+(\.\d+)?$/.test(rest)) {
      parent[key] = Number(rest);
    } else {
      parent[key] = unquote(rest);
    }
  }
  return root;
}

/** Coerce a frontmatter value that may be a string, comma/space list, or array into string[]. */
export function toStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [String(value)];
}

/** Coerce truthy frontmatter values ("true", true, "yes", 1). */
export function toBool(value: unknown, dflt: boolean): boolean {
  if (value === undefined || value === null) return dflt;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (["true", "yes", "on", "1"].includes(s)) return true;
  if (["false", "no", "off", "0"].includes(s)) return false;
  return dflt;
}

/**
 * Strip block-level HTML comments (<!-- ... -->) that occupy whole lines,
 * as Claude Code does for CLAUDE.md. Inline comments inside a line are kept.
 */
export function stripBlockHtmlComments(content: string): string {
  return content.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n?/gm, (match) =>
    // keep line structure stable only when comment spanned entire lines
    match.includes("\n") || /^[ \t]*<!--.*-->[ \t]*\r?\n?$/.test(match) ? "" : match,
  );
}
