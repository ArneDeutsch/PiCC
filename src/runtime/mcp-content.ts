import { defangClipMarker } from "../util/clip-middle.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";

/** PiCC uses the same conservative token estimate for MCP content and tool-result clipping. */
export const MCP_CONTENT_CHARS_PER_TOKEN = 4;

const MIN_CONTENT_BUDGET_CHARS = 1;

export function mcpContentCharBudget(clipMaxTokens: number): number {
  const tokens = Number.isFinite(clipMaxTokens) && clipMaxTokens > 0
    ? Math.floor(clipMaxTokens)
    : 0;
  return Math.max(MIN_CONTENT_BUDGET_CHARS, tokens * MCP_CONTENT_CHARS_PER_TOKEN);
}

export function neutralizeMcpContent(text: string): string {
  return defangClipMarker(neutralizeControlChars(text));
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Bounded-memory aggregate for untrusted MCP text. It retains an aggregate head and tail so
 * clipping preserves result order without first constructing the unbounded converted payload.
 */
export class McpContentAccumulator {
  readonly budgetChars: number;
  private readonly head: string[] = [];
  private readonly tail: string[] = [];
  private tailWriteIndex = 0;
  private totalChars = 0;

  constructor(clipMaxTokens: number) {
    this.budgetChars = mcpContentCharBudget(clipMaxTokens);
  }

  append(text: string): void {
    const safe = neutralizeMcpContent(text);
    for (const character of safe) {
      this.totalChars += 1;
      if (this.head.length < this.budgetChars) this.head.push(character);
      if (this.tail.length < this.budgetChars) {
        this.tail.push(character);
      } else {
        this.tail[this.tailWriteIndex] = character;
        this.tailWriteIndex = (this.tailWriteIndex + 1) % this.budgetChars;
      }
    }
  }

  private orderedTail(): string[] {
    if (this.tail.length < this.budgetChars || this.tailWriteIndex === 0) return this.tail;
    return this.tail.slice(this.tailWriteIndex).concat(this.tail.slice(0, this.tailWriteIndex));
  }

  finish(): string {
    if (this.totalChars <= this.budgetChars) return this.head.join("");

    const markerFor = (omitted: number): string =>
      `\n\n[PiCC clipped ${omitted} characters from untrusted MCP content]\n\n`;
    let headCount = Math.ceil(this.budgetChars / 2);
    let tailCount = this.budgetChars - headCount;
    let marker = "";
    while (true) {
      marker = markerFor(Math.max(0, this.totalChars - headCount - tailCount));
      const excess = headCount + tailCount + codePointLength(marker) - this.budgetChars;
      if (excess <= 0) break;
      const tailReduction = Math.min(tailCount, excess);
      tailCount -= tailReduction;
      headCount -= Math.min(headCount, excess - tailReduction);
      if (headCount === 0 && tailCount === 0 && codePointLength(marker) > this.budgetChars) {
        return Array.from(marker).slice(0, this.budgetChars).join("");
      }
    }

    const tail = this.orderedTail();
    return this.head.slice(0, headCount).join("") +
      marker +
      tail.slice(Math.max(0, tail.length - tailCount)).join("");
  }
}

export function boundedMcpErrorText(value: unknown, maxChars = 1_000): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "unknown error";
  return Array.from(neutralizeMcpContent(raw)).slice(0, Math.max(1, maxChars)).join("");
}
