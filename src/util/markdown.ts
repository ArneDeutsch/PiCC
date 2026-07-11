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
    diagnostics.push({
      severity: "warning",
      message: `Malformed frontmatter YAML (${(err as Error).message}); ignored`,
      source: sourcePath,
    });
    return { frontmatter: {}, body, diagnostics };
  }
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
