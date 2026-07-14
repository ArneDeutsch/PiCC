import { isAgentId } from "../util/subagent-transcripts.js";

const TASK_ID_RE = /^task-[1-9][0-9]{0,11}$/;
const TASK_ID_FALLBACK = "task-unavailable";
const AGENT_ID_FALLBACK = "agent-id-unavailable";
const TYPE_FALLBACK = "type-unavailable";
const TYPE_CAP = 120;

// Keep this formatter independent of terminal rendering. Identity metadata can
// reach model-visible plain text, so strip complete terminal escape families
// before removing the remaining controls/format characters.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");
const CSI_RE = new RegExp(`${ESC}\\[[0-9;:?]*[ -/]*[@-~]`, "g");
const FE_ESCAPE_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");

/** Return a registry-minted task id or the fixed, deliberately non-minted fallback. */
export function normalizeBackgroundTaskId(taskId: string): string {
  return TASK_ID_RE.test(taskId) ? taskId : TASK_ID_FALLBACK;
}

function sanitizeDisplayedType(displayedType: string): string {
  const plain = String(displayedType ?? "")
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(FE_ESCAPE_RE, "")
    .replace(/\p{Cf}+/gu, "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (!plain) return TYPE_FALLBACK;

  // Build atomic chunks so the cap can never bisect a Unicode code point or a
  // percent escape. Encoding '%' first also prevents input from supplying an
  // apparently pre-encoded tuple delimiter.
  const chunks: string[] = [];
  for (const codePoint of plain) {
    if (codePoint === "%") chunks.push("%25");
    else if (codePoint === "(") chunks.push("%28");
    else if (codePoint === ")") chunks.push("%29");
    else if (codePoint === "·") chunks.push("%C2%B7");
    else chunks.push(codePoint);
  }
  let encoded = chunks.join("");

  // A displayed label must not mint a second correlation token. Neutralize the
  // separating hyphen while preserving the readable label around it.
  encoded = encoded
    .replace(/(task)-([1-9][0-9]{0,11})/g, "$1%2D$2")
    .replace(/(agent)-([0-9a-f]{12})/g, "$1%2D$2");

  let bounded = "";
  for (let index = 0; index < encoded.length;) {
    // Treat every formatter-produced encoding as one chunk. In particular, the
    // middle-dot delimiter uses two percent escapes and must not be capped to
    // the misleading partial UTF-8 sequence `%C2`.
    const encodedMiddleDot = encoded.startsWith("%C2%B7", index);
    const percent = encoded[index] === "%" && /^[0-9A-F]{2}$/.test(encoded.slice(index + 1, index + 3));
    const codePoint = encoded.codePointAt(index);
    const token = encodedMiddleDot
      ? encoded.slice(index, index + 6)
      : percent
        ? encoded.slice(index, index + 3)
        : String.fromCodePoint(codePoint ?? 0);
    if (bounded.length + token.length > TYPE_CAP) break;
    bounded += token;
    index += token.length;
  }
  return bounded || TYPE_FALLBACK;
}

/** Format the canonical bounded identity tuple used by background lifecycle messages. */
export function formatBackgroundTaskIdentity(
  taskId: string,
  displayedType: string,
  agentId: string | undefined,
): string {
  const task = normalizeBackgroundTaskId(taskId);
  const type = sanitizeDisplayedType(displayedType);
  const agent = agentId && isAgentId(agentId) ? agentId : AGENT_ID_FALLBACK;
  return `Task(${task}) · Agent(${type}) · ${agent}`;
}
