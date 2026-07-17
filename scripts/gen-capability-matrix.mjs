#!/usr/bin/env node
/**
 * Generate doc/supported-features.md from the capability registry
 * (src/registry/capability-registry.ts) — the single source of truth.
 *
 * The registry is TypeScript, so this script cannot `import` it under plain
 * Node. Instead it spawns a short-lived `node --import tsx` child that loads the
 * registry and prints it as JSON; the parent formats that JSON into Markdown.
 * That keeps this file dependency-free (Node built-ins only) while the docs stay
 * generated — they cannot drift from actual runtime behavior.
 *
 * The pure formatter `renderCapabilityMatrix(entries, baseline)` is EXPORTED so a
 * test can regenerate the matrix IN-PROCESS (feed it the imported
 * CAPABILITY_REGISTRY) and assert the committed doc is in sync — no spawning, no
 * child-process/CRLF flakiness. Importing this module does NOT spawn
 * or write anything; the CLI runs only when executed directly.
 *
 * Run:  node scripts/gen-capability-matrix.mjs
 * (tsx is already a devDependency; no other setup required.)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

// --- Formatting helpers ----------------------------------------------------
const TIER_LABELS = {
  full: "full",
  partial: "partial",
  "degraded-noop": "degraded-noop",
  "not-supported": "not-supported",
  na: "n/a",
};
const TIER_ORDER = ["full", "partial", "degraded-noop", "not-supported", "na"];

const TIER_LEGEND = [
  ["full", "Implemented for real; every field the format defines is functional."],
  ["partial", "Works within limits — parsed and matched, but a constraint applies (see the note)."],
  ["degraded-noop", "Parsed and reported, then a visible, documented no-op. Never crashes."],
  ["not-supported", "Out of scope; the name still resolves for gating and degrades safely."],
  ["n/a", "Not applicable to this harness."],
];

// Section order + human titles. Any kind not listed here is appended generically.
const KIND_SECTIONS = [
  ["tool", "Tools", "Built-in tool names a project can reference in `tools:`, `permissions.*`, or a hook `if:`."],
  ["hook-event", "Hook events", "Lifecycle events the hooks engine can fire (`settings.json` `hooks`, plus skill/agent-scoped hooks)."],
  ["setting", "Settings", "`settings.json` / `settings.local.json` keys."],
  ["frontmatter", "Frontmatter fields", "Skill (`SKILL.md`), agent (`.claude/agents/*.md`), and rule frontmatter keys."],
  ["feature", "Runtime features", "Cross-cutting runtime subsystems and behaviors."],
];

function escapeCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
}

function idCell(entry) {
  const mark = entry.safetyRelevant === true ? " ⚠" : "";
  return `\`${escapeCell(entry.id)}\`${mark}`;
}

function renderTable(kindEntries) {
  const rows = kindEntries
    .slice()
    .sort((a, b) => {
      const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      return t !== 0 ? t : a.id.localeCompare(b.id);
    })
    .map((e) => `| ${idCell(e)} | ${TIER_LABELS[e.tier] ?? e.tier} | ${escapeCell(e.note)} |`);
  return ["| ID | Tier | Note |", "|---|---|---|", ...rows].join("\n");
}

/**
 * Format the capability registry into the full Markdown document, EXACTLY as
 * written to doc/supported-features.md. Pure — no I/O, no spawning — so a test
 * can call it with the imported registry and diff against the committed file.
 *
 * @param {Array<{ id: string, kind: string, tier: string, safetyRelevant?: boolean, note: string }>} entries
 * @param {string} baseline
 * @returns {string} the complete Markdown (ends with a single trailing newline).
 */
export function renderCapabilityMatrix(entries, baseline) {
  const byKind = new Map();
  for (const e of entries) {
    if (!byKind.has(e.kind)) byKind.set(e.kind, []);
    byKind.get(e.kind).push(e);
  }

  const tierCounts = Object.fromEntries(TIER_ORDER.map((t) => [t, 0]));
  let safetyCount = 0;
  for (const e of entries) {
    tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;
    if (e.safetyRelevant === true) safetyCount++;
  }

  const lines = [];
  lines.push("# Supported features");
  lines.push("");
  lines.push(
    `> **Generated file — do not edit by hand.** This matrix is generated from the living ` +
      `capability registry (\`src/registry/capability-registry.ts\`), the single source of truth ` +
      `for what PiCC supports. The same registry drives the runtime \`/doctor\` ` +
      `report and the startup compatibility notice, so this document cannot drift from actual behavior.`,
  );
  lines.push(">");
  lines.push(`> **Claude Code baseline:** \`${baseline}\`. Every support claim is stated relative to this`);
  lines.push("> baseline; anything upstream added after it is treated as *unassessed* and degrades safely.");
  lines.push(">");
  lines.push("> **Regenerate:** `node scripts/gen-capability-matrix.mjs`");
  lines.push("");
  lines.push("## Tier legend");
  lines.push("");
  lines.push("| Tier | Meaning |");
  lines.push("|---|---|");
  for (const [tier, meaning] of TIER_LEGEND) {
    lines.push(`| ${tier} | ${meaning} |`);
  }
  lines.push("");
  lines.push(
    "A ⚠ marker on an ID means the divergence is **safety-relevant**: something a project intended " +
      "to restrict now runs freely. These are always surfaced at startup and in `/doctor`, never silent.",
  );
  lines.push("");

  // Sections in declared order, then any unexpected kinds.
  const sectionsToEmit = [...KIND_SECTIONS];
  for (const kind of byKind.keys()) {
    if (!sectionsToEmit.some(([k]) => k === kind)) {
      sectionsToEmit.push([kind, kind, ""]);
    }
  }
  for (const [kind, title, blurb] of sectionsToEmit) {
    const kindEntries = byKind.get(kind);
    if (!kindEntries || kindEntries.length === 0) continue;
    lines.push(`## ${title} (${kindEntries.length})`);
    lines.push("");
    if (blurb) {
      lines.push(blurb);
      lines.push("");
    }
    lines.push(renderTable(kindEntries));
    lines.push("");
  }

  // Summary.
  lines.push("## Summary");
  lines.push("");
  const tierPhrases = TIER_ORDER.filter((t) => tierCounts[t] > 0).map(
    (t) => `**${tierCounts[t]} ${TIER_LABELS[t]}**`,
  );
  lines.push(
    `The registry enumerates **${entries.length} capabilities** against baseline \`${baseline}\`: ` +
      `${tierPhrases.join(", ")}. ` +
      `${safetyCount} entr${safetyCount === 1 ? "y is" : "ies are"} safety-relevant (marked ⚠) — ` +
      "a divergence where a project's restriction is not enforced and is therefore reported prominently. " +
      "Unknown inputs outside this registry are not counted here: they are unassessed by definition and " +
      "degrade safely at runtime.",
  );
  lines.push("");

  return lines.join("\n");
}

// --- CLI (runs only when executed directly) --------------------------------
function main() {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = path.resolve(HERE, "..");
  const REGISTRY = path.join(REPO_ROOT, "src", "registry", "capability-registry.ts");
  const OUT = path.join(REPO_ROOT, "doc", "supported-features.md");

  // Extract the registry as JSON via a tsx child. pathToFileURL keeps the dynamic
  // import valid on Windows (drive-letter paths).
  const registryUrl = new URL(`file://${REGISTRY.replace(/\\/g, "/")}`).href;
  const extractor = `
    import(${JSON.stringify(registryUrl)}).then((m) => {
      process.stdout.write(JSON.stringify({
        baseline: m.CLAUDE_BASELINE,
        entries: m.CAPABILITY_REGISTRY,
      }));
    }).catch((err) => { console.error(err?.stack ?? String(err)); process.exit(1); });
  `;

  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", extractor], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (child.status !== 0) {
    console.error("Failed to load the capability registry via tsx.");
    if (child.stderr) console.error(child.stderr);
    console.error("Is tsx installed? Run `npm install` in the PiCC checkout.");
    process.exit(1);
  }

  const { baseline, entries } = JSON.parse(child.stdout);
  fs.writeFileSync(OUT, renderCapabilityMatrix(entries, baseline), "utf8");
  console.log(`Wrote ${path.relative(REPO_ROOT, OUT)} (${entries.length} capabilities @ ${baseline}).`);
}

// Run the CLI only when invoked directly (not when imported by a test).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
