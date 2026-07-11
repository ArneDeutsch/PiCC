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
  // Stack of (indent, container) — containers are mutated in place. For list
  // containers, itemIndent records where its `- ` items sit (YAML allows items
  // at the SAME indent as the owning key, e.g. `tools:\n- Read`).
  const stack: Array<{
    indent: number;
    value: Record<string, unknown> | unknown[];
    itemIndent?: number;
  }> = [{ indent: -1, value: root }];

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

    const isListItem = trimmed.startsWith("- ") || trimmed === "-";
    while (stack.length > 1) {
      const top = stack[stack.length - 1]!;
      if (Array.isArray(top.value)) {
        // A list frame stays open for items at its item indent (which may
        // equal the owning key's indent) and anything nested deeper.
        const itemIndent = top.itemIndent ?? top.indent + 1;
        if ((isListItem && indent === itemIndent) || indent > itemIndent) break;
        stack.pop();
        continue;
      }
      if (indent <= top.indent) {
        stack.pop();
        continue;
      }
      break;
    }
    const parent = stack[stack.length - 1]!.value;

    if (isListItem) {
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
      // Look ahead: list or nested mapping? YAML sequences may sit at the SAME
      // indent as their key (`tools:` followed by zero-indent `- Read`).
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
      const nextIndent = next ? next.length - next.trimStart().length : 0;
      const nextTrim = next?.trim() ?? "";
      if (next && nextIndent >= indent && (nextTrim.startsWith("- ") || nextTrim === "-")) {
        const list: unknown[] = [];
        parent[key] = list;
        stack.push({ indent, value: list, itemIndent: nextIndent });
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
    // skip the key so it degrades to "unset" rather than a bogus scalar. But a
    // prose scalar may legitimately START with a bracket (`[WIP] fix: things`),
    // so only skip when no closer appears anywhere in the value. A properly
    // closed flow collection is uncommon in Claude frontmatter; leave those to
    // the strict parser (which already succeeded if they were valid).
    if (
      (rest.startsWith("[") && !rest.includes("]")) ||
      (rest.startsWith("{") && !rest.includes("}"))
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
    // Split only on commas OUTSIDE (), [], {} nesting: values like
    // "src/**/*.{ts,tsx}" or "Bash(echo a,b)" keep their inner commas.
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
 * Fence-aware: comments inside ``` / ~~~ code fences are literal content and
 * kept; an unclosed <!-- never swallows the rest of the document (a multi-line
 * comment is only stripped when a line ending in --> closes it).
 */
export function stripBlockHtmlComments(content: string): string {
  const lines = content.split("\n"); // keep any \r on line ends to preserve bytes
  const out: string[] = [];
  let fenceChar: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      const ch = fence[1]![0]!;
      if (fenceChar === undefined) fenceChar = ch;
      else if (ch === fenceChar) fenceChar = undefined;
      out.push(line);
      continue;
    }
    if (fenceChar === undefined && /^[ \t]*<!--/.test(line)) {
      // Whole-line single-line comment: drop it.
      if (/^[ \t]*<!--.*?-->[ \t]*\r?$/.test(line)) continue;
      // Comment closes mid-line with trailing content: inline, keep.
      if (line.slice(line.indexOf("<!--") + 4).includes("-->")) {
        out.push(line);
        continue;
      }
      // Multi-line: strip only if a later line ENDS with --> (a mid-line
      // closer means this was never a block comment we should delete).
      let closed = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (/-->[ \t]*\r?$/.test(l)) {
          closed = j;
          break;
        }
        if (l.includes("-->")) break;
      }
      if (closed !== -1) {
        i = closed;
        continue;
      }
      // Unclosed <!--: keep content rather than deleting real text.
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
