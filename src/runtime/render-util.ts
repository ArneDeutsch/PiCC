import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Shared width/theme discipline for PiCC-owned TUI rows. Theme methods are
// untrusted extension seams: accept only balanced SGR that preserves the exact
// requested text, otherwise return that text unchanged.

const SGR_RE = /\u001b\[([0-9;]*)m/gu;

/** Display-only neutralization: CRLF becomes LF; non-inline LF survives, tabs become spaces, and other controls become inert markers. */
export function sanitizeDisplayText(value: string, limit: number, inline = false): string {
  let text = value.slice(0, limit + 1).replace(/\r\n/gu, "\n").slice(0, limit).normalize("NFC");
  text = text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "�")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu, "�")
    .replace(/\u001b(?:[ -/]*[@-~]?|.)?/gu, "�")
    .replace(/\r/gu, "�")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
      if (!inline && character === "\n") return "\n";
      return character === "\t" ? "   " : "�";
    });
  return inline ? text.replace(/\s+/gu, " ").trim() : text;
}

function safeSgrText(value: unknown, requested: string): string | undefined {
  if (typeof value !== "string") return undefined;
  let plain = "";
  let cursor = 0;
  const active = new Set<string>();
  for (const match of value.matchAll(SGR_RE)) {
    const index = match.index;
    const literal = value.slice(cursor, index);
    if (/[\p{Cc}\p{Cf}]/u.test(literal)) return undefined;
    plain += literal;
    const raw = match[1] ?? "";
    const codes = (raw === "" ? [0] : raw.split(";").map(Number));
    if (codes.some((code) => !Number.isSafeInteger(code))) return undefined;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] ?? 0;
      if (code === 0) active.clear();
      else if (code === 1 || code === 2) active.add("intensity");
      else if (code === 3) active.add("italic");
      else if (code === 4) active.add("underline");
      else if (code === 7) active.add("inverse");
      else if (code === 9) active.add("strike");
      else if (code === 22) active.delete("intensity");
      else if (code === 23) active.delete("italic");
      else if (code === 24) active.delete("underline");
      else if (code === 27) active.delete("inverse");
      else if (code === 29) active.delete("strike");
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) active.add("fg");
      else if (code === 39) active.delete("fg");
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) active.add("bg");
      else if (code === 49) active.delete("bg");
      else if (code === 38 || code === 48) {
        const channel = code === 38 ? "fg" : "bg";
        const mode = codes[++i];
        if (mode === 5) {
          const palette = codes[++i];
          if (palette === undefined || palette < 0 || palette > 255) return undefined;
        } else if (mode === 2) {
          const rgb = [codes[++i], codes[++i], codes[++i]];
          if (rgb.some((part) => part === undefined || part < 0 || part > 255)) return undefined;
        } else return undefined;
        active.add(channel);
      } else return undefined;
    }
    cursor = index + match[0].length;
  }
  const tail = value.slice(cursor);
  if (/[\p{Cc}\p{Cf}]/u.test(tail)) return undefined;
  plain += tail;
  if (plain !== requested || active.size > 0) return undefined;
  return value;
}

function invokeTheme(theme: unknown, method: "fg" | "bold", args: readonly string[], requested: string): string {
  try {
    const candidate = Reflect.get(theme as object, method);
    if (typeof candidate !== "function") return requested;
    return safeSgrText(Reflect.apply(candidate, theme, args), requested) ?? requested;
  } catch {
    return requested;
  }
}

/** `theme.fg(color, text)` only when it preserves text and emits balanced SGR. */
export function themedFg(theme: unknown, color: string, text: string): string {
  return invokeTheme(theme, "fg", [color, text], text);
}

/** `theme.bold(text)` only when it preserves text and emits balanced SGR. */
export function themedBold(theme: unknown, text: string): string {
  return invokeTheme(theme, "bold", [text], text);
}

/** Append `text` wrapped to `width` visible columns (ANSI- and wide-char-aware). */
export function pushWrapped(text: string, width: number, into: string[]): void {
  try {
    for (const line of wrapTextWithAnsi(String(text ?? ""), Math.max(1, width))) into.push(line);
  } catch {
    into.push(truncateToWidth(String(text ?? ""), Math.max(1, width), "…"));
  }
}

/** Wrap `text` to `width`, coloring each segment; every emitted line is <= width columns. */
export function pushColored(theme: unknown, color: string, text: string, width: number, into: string[]): void {
  pushWrapped(themedFg(theme, color, String(text ?? "")), width, into);
}

/** Final Pi-width clamp only; sanitize untrusted text before calling because valid ANSI is preserved. */
export function clampLines(lines: string[], width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return lines.map(() => "");
  const columns = Math.floor(width);
  return lines.map((line) => {
    try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
    catch { return truncateToWidth(line.replace(/[\p{Cc}\p{Cf}]/gu, ""), columns, "…"); }
  });
}
