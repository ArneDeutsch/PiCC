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
  ["not-supported", "The capability behavior is unavailable in PiCC; any recognized input degrades as its note describes."],
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

const EVIDENCE_ORDER = ["documented", "observed", "inferred", "unverified"];
const compareCodeUnits = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function evidenceCell(entry) {
  return (entry.evidence ?? [])
    .slice()
    .sort((a, b) => {
      const quality = EVIDENCE_ORDER.indexOf(a.quality) - EVIDENCE_ORDER.indexOf(b.quality);
      return quality !== 0 ? quality : compareCodeUnits(a.source, b.source);
    })
    .map((record) => `${record.quality}: ${record.source}${record.reviewed ? ` (${record.reviewed})` : ""}`)
    .join("; ");
}

function relatedCell(entry) {
  return (entry.related ?? []).slice().sort(compareCodeUnits).map((id) => `\`${id}\``).join(", ");
}

function renderTable(kindEntries) {
  const rows = kindEntries
    .slice()
    .sort((a, b) => {
      const t = TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier);
      return t !== 0 ? t : compareCodeUnits(a.id, b.id);
    })
    .map((e) => `| ${idCell(e)} | ${TIER_LABELS[e.tier] ?? e.tier} | ${escapeCell(evidenceCell(e))} | ${escapeCell(relatedCell(e))} | ${escapeCell(e.note)} |`);
  return ["| ID | Tier | Claude evidence | Related | Note |", "|---|---|---|---|---|", ...rows].join("\n");
}

/**
 * Format the capability registry into the full Markdown document, EXACTLY as
 * written to doc/supported-features.md. Pure — no I/O, no spawning — so a test
 * can call it with the imported registry and diff against the committed file.
 *
 * @param {ReadonlyArray<{ id: string, kind: string, tier: string, safetyRelevant?: boolean, evidence?: ReadonlyArray<{quality: string, source: string, reviewed?: string}>, related?: ReadonlyArray<string>, note: string }>} entries
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
  const reviewedDates = [];
  for (const e of entries) {
    tierCounts[e.tier] = (tierCounts[e.tier] ?? 0) + 1;
    if (e.safetyRelevant === true) safetyCount++;
    for (const record of e.evidence ?? []) {
      if (record.reviewed) reviewedDates.push(record.reviewed);
    }
  }
  const auditDates = [...new Set(reviewedDates)].sort(compareCodeUnits);

  const lines = [];
  lines.push("# Supported features");
  lines.push("");
  lines.push(
    `> **Generated file — do not edit by hand.** This matrix is generated from the living ` +
      `capability registry (\`src/registry/capability-registry.ts\`), the single source of truth ` +
      `for what PiCC supports. The same registry drives the runtime \`/doctor\` report and this ` +
      `generated matrix, keeping both surfaces anchored to the same support claims.`,
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
    "Tier and Note describe PiCC behavior. **Claude evidence** describes only the upstream Claude Code surface: " +
      "documented = stated by an allowlisted official page; observed = reproduced on the named Claude version and bounded path; " +
      "inferred = reasoned from indirect evidence; unverified = the reviewed evidence does not establish the behavior. " +
      "Multiple qualities on one row are intentionally mixed; a blank cell means the entry was not part of this audit.",
  );
  if (auditDates.length === 1) {
    lines.push(`The structured official-document review horizon is **${auditDates[0]}**.`);
  } else if (auditDates.length > 1) {
    lines.push(`The structured official-document review dates span **${auditDates[0]}** through **${auditDates.at(-1)}** (${auditDates.join(", ")}).`);
  }
  lines.push(
    "**Related references** are navigation and context only; search this document or the registry by ID. They do not imply a shared tier, evidence quality, or dependency. " +
      "A separate ⚠ marker means PiCC fails to enforce an upstream restriction or mandatory gate, allowing an operation that should be restricted to run freely; `/doctor` labels detected project-specific safety findings.",
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
      `${safetyCount} entr${safetyCount === 1 ? "y is" : "ies are"} safety-relevant — ` +
      "a divergence where a project's restriction is not enforced, marked ⚠ in this matrix. " +
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
