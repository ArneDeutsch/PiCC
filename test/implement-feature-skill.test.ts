import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSkillBody, loadSkills, substituteArguments } from "../src/claude/skills.js";
import { REINJECT_PER_SKILL_MAX_CHARS } from "../src/runtime/skill-activation.js";
import { walkFiles } from "../src/util/fs.js";

// Resolve the shipped skills dir from THIS test file, never process.cwd() —
// sibling tests process.chdir into temp dirs (see implementer-generalist-agents.test.ts).
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".claude",
  "skills",
);
const SKILL_DIR = path.join(SKILLS_DIR, "implement-feature");
const REFERENCES_DIR = path.join(SKILL_DIR, "references");
const EVALUATE_DIR = path.join(SKILLS_DIR, "evaluate");

const norm = (p: string): string => p.replace(/\\/g, "/");

describe("implement-feature router", () => {
  // Use the real loader (not fs.readFileSync): loadSkillBody/parseMarkdown normalize
  // CRLF and strip the BOM, so the char count is deterministic cross-platform.
  const { skills } = loadSkills([{ dir: SKILLS_DIR, scope: "project" }], []);
  const skill = skills.find((s) => s.name === "implement-feature");

  // A representative ~150-char documented invocation, shared by the substitution-inflation and
  // margin tests below so both render the same worst-case body.
  const longArgsText =
    "#5 also add structured logging around the dispatch loop and make sure the retry path is " +
    "covered by an offline integration test in the tester layer please";

  it("loads with a valid frontmatter contract", () => {
    // `name` must equal the expected identity (catches a `name:` value typo; the loader falls back to
    // the dir basename, which is also "implement-feature", so a removed key still passes — acceptable).
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("implement-feature");
    expect(typeof skill!.description).toBe("string");
    expect(skill!.description.length).toBeGreaterThan(0);
  });

  // The trunk-size constraint, for whoever reddens the assertions below: SKILL.md is the
  // always-resident body — re-injected into context after every compaction — and is capped at
  // REINJECT_PER_SKILL_MAX_CHARS, a Claude-parity value whose rationale lives in its JSDoc in
  // src/runtime/skill-activation.ts. The references/*.md bodies are read on demand and carry no
  // budget. When a trunk edit trips the cap or the 2k margin, move the detail into a references/
  // file named by the phase spine — raising the constant is a runtime behavior change, not the fix.
  it("router body stays within the per-skill re-injection cap", () => {
    // Tie the assertion to the runtime constant, not a hardcoded 20000.
    const body = loadSkillBody(skill!);
    expect(body.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
  });

  it("rendered body stays within the cap even under a long invocation argument", () => {
    // Guards the substitution-inflation regression: the router must carry NO literal `$ARGUMENTS`
    // token (each mention is globally substituted at activation, which both garbles the prose and,
    // under a long documented invocation like `#5 also add …`, multiplies the args text into the
    // resident body and can push it past the cap). With no marker, the ref reaches the coordinator
    // once via the append-fallback instead. Render with a representative ~150-char invocation and
    // assert the rendered body still fits.
    const body = loadSkillBody(skill!);
    expect(longArgsText.length).toBeGreaterThanOrEqual(140);
    const rendered = substituteArguments(body, longArgsText, skill!.arguments);
    expect(rendered.text.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
    // The ref still reaches the coordinator — via the no-marker append fallback, since the router
    // body carries no literal `$ARGUMENTS`/`$N`/`$name` marker to substitute in place.
    expect(rendered.text).toContain(`ARGUMENTS: ${longArgsText}`);
  });

  it("trunk stays 2k under the re-injection cap — move detail into references/, never raise the constant", () => {
    const rendered = substituteArguments(loadSkillBody(skill!), longArgsText, skill!.arguments);
    expect(rendered.text.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS - 2000);
  });

  it("every linked reference resolves, and every reference file is linked (bidirectional, count-agnostic)", () => {
    const body = loadSkillBody(skill!);

    // Path tokens the router mentions (markdown link, bare path, or ${CLAUDE_SKILL_DIR}/ prefix),
    // deduped. Every token must resolve on disk (catches a link to a mistyped file).
    const mentioned = [...new Set(body.match(/references\/[A-Za-z0-9_-]+\.md/g) ?? [])];
    expect(mentioned.length).toBeGreaterThan(0);
    for (const token of mentioned) {
      expect(fs.existsSync(path.join(SKILL_DIR, token))).toBe(true);
    }

    // Every reference file on disk must be linked from the router (catches a dropped routing line).
    // Glob the actual references/*.md rather than hardcoding a file count.
    const onDisk = fs
      .readdirSync(REFERENCES_DIR)
      .filter((n) => n.endsWith(".md"))
      .map((n) => `references/${n}`);
    expect(onDisk.length).toBeGreaterThan(0);
    const mentionedSet = new Set(mentioned);
    for (const ref of onDisk) {
      expect(mentionedSet.has(ref)).toBe(true);
    }
  });

  it("keeps the write-discipline floor resident in the router (loose structural check)", () => {
    // The fail-closed floor must survive in the always-loaded router even after compaction — so the
    // resident checklist keeps its two load-bearing markers. Loose on purpose: assert the markers are
    // present (case-insensitive), not their exact prose, so this stays a floor check, not a
    // wording change-detector.
    const body = loadSkillBody(skill!).toLowerCase();
    expect(body).toContain("--body-file");
    expect(body).toContain("allow-list");
  });

  it("registers exactly one SKILL.md (no second skill), scoped to the skill dir", () => {
    // Reuse the loader's own primitive. Scope to the skill dir — a repo-wide walk
    // would hit many examples/** fixtures that ship their own SKILL.md.
    const hits = walkFiles(SKILL_DIR, (n) => n === "SKILL.md").map(norm);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toBe(norm(path.join(SKILL_DIR, "SKILL.md")));
  });
});

describe("description-based naming contract", () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.join(SKILL_DIR, relative), "utf8").replace(/\r\n/g, "\n");
  const collapsed = (relative: string): string => read(relative).toLowerCase().replace(/\s+/g, " ");
  const expectBefore = (body: string, first: string, second: string): void => {
    const firstIndex = body.indexOf(first);
    const secondIndex = body.indexOf(second);
    expect(firstIndex, `missing marker: ${first}`).toBeGreaterThanOrEqual(0);
    expect(secondIndex, `missing marker: ${second}`).toBeGreaterThanOrEqual(0);
    expect(firstIndex).toBeLessThan(secondIndex);
  };

  it("keeps the Phase 2 validation contract and collision/race backstops in phase-2-workspace.md (loose floor)", () => {
    const body = collapsed("references/phase-2-workspace.md");
    // Floor 5 — Phase 2 validation contract (kept verbatim: slug regex, bound, device list, ref-check).
    expect(body).toContain("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$");
    expect(body).toContain("3–48 characters");
    for (const reserved of ["`con`", "`prn`", "`aux`", "`nul`", "`com1`–`com9`", "`lpt1`–`lpt9`"]) {
      expect(body).toContain(reserved);
    }
    expect(body).toContain('git check-ref-format --branch "feature/<feature-slug>"');
    expect(body).toContain("fails closed");
    expect(body).toContain("never silently sanitize");
    expect(body).toContain("append/increment a numeric counter");

    // Floor 6 — collision/race backstops as a LOOSE representative subset, not the exhaustive prose.
    expect(body).toContain("create-or-reenter");
    expect(body).toContain("delete a newly appeared unregistered directory");
    expect(body).toContain("cannot atomically reserve");
    expect(body).toContain("cannot promise preservation or reliably detect");
    expect(body).toContain("no further workflow-initiated repository or github writes");
    expect(body).toContain("non-forcing `git switch -c feature/<feature-slug>");
    expect(body).toContain("identity finalized and immutable");
  });

  it("keeps the resident identity floor in the router (gate/announcement detail lives in the phase files)", () => {
    // Residency contract: the trunk keeps only the
    // always-resident identity kernels — resume classification, the task commit subject, fail-closed
    // slug validation, the resume confirmation gate, the race-deletion warning, and the repush
    // confirmation. The presentation-gate and announcement-field detail is deliberately
    // load-on-demand in references/phase-1-direction.md, pinned by the "hard pre-tool presentation
    // gate" test below — do not re-pin that prose against the trunk.
    const body = collapsed("SKILL.md");
    expect(body).toContain("classify resume before new naming");
    expect(body).toContain("<feature-slug>: t<task-number> — <description>");
    // The commit freshness reminder must stay resident: the stale-index hazard fires mid-phase,
    // with no phase-entry event to trigger a reference re-read.
    expect(body).toContain("the working tree for freshness");
    expect(body).toContain("never sanitize/add a counter");
    expect(body).toContain("explicit human confirmation");
    expect(body).toContain("may delete a raced unregistered directory");
    expect(body).toContain("confirmed self-owned fast-forward repush");
    expect(body).not.toMatch(/next free|pick the next free|feature\/<nn>|f<nn>/i);
  });

  it("Phase 7 review fan-out surfaces new untracked non-ignored files, not bare git diff HEAD", () => {
    // Loose positive floor: the fan-out step must stage (or otherwise surface) new untracked
    // non-ignored files so a reviewer's view is complete — guarding against a silent regression to
    // bare `git diff HEAD`, which has recurred repeatedly in practice. Accept either mechanism
    // (`git add -A` staging or a reviewer `git status --short` read); no brittle exact-phrase pin.
    // Slice to the step-3 fan-out region: the commit step legitimately reads `git status --short`
    // for freshness, so a file-wide match would pass on that text alone and stop guarding fan-out.
    const body = collapsed("references/phase-7-implementation.md");
    const start = body.indexOf("review fan-out");
    const end = body.indexOf("triage and fix");
    expect(start, "missing fan-out step marker").toBeGreaterThanOrEqual(0);
    expect(end, "missing triage step marker").toBeGreaterThan(start);
    expect(body.slice(start, end)).toMatch(/git add -a|git status --short/);
  });

  it("Phase 7 commit step pairs a scope check with a staleness-capable freshness check", () => {
    // Loose representative substrings of the pre-commit contract — the surrounding prose stays
    // freely editable. Guards against the two real incidents: a stale index committed after a fix
    // round (all gates green — they run on the working tree, not the index) and a `git mv` rename
    // from other work swept into an unrelated commit. `collapsed()` keeps backticks, so the
    // blank-add floor marker retains them.
    const body = collapsed("references/phase-7-implementation.md");
    expect(body).toContain("git diff --cached");
    expect(body).toContain("a double-letter code");
    expect(body).toContain("`git mv` auto-stages");
    expect(body).toContain("never a blank `git add -a && git commit`");
    // Bidirectional gate: both remedies key on one positively-enumerated intent predicate, so a
    // secret can never be staged. Pin the symmetric never-swap rule and the direction of each
    // remedy — unstage is the not-on-surface remedy, stage is the on-surface-but-missing remedy —
    // so a future edit transposing them reddens. Keep the literal "never swap the remedies".
    expect(body).toContain("never swap the remedies");
    expect(body).toContain("unstage** every staged path *not* on the intended surface");
    expect(body).toContain("stage** every path that *is* on the intended surface but missing from the index");
  });

  it("pins the plan-folder templates and task-local numbering (loose)", () => {
    const body = read("references/templates.md");
    expect(body).toContain("doc/plan/<feature-slug>/");
    expect(body).toContain("# <feature-slug>: <Title>");
    expect(body).toContain("tasks/t<task-number>-<task-slug>.md");
    expect(body).toContain("t01");
  });

  it("keeps public ticket titles model-authored, bounded, and body-file-quoted (loose floor)", () => {
    // Loose representatives of the title-quoting contract: independent authorship, the 120-char
    // single-line bound, and --body-file at each write site — not the exhaustive phrase list.
    const direction = collapsed("references/phase-1-direction.md");
    // The `gh issue create` command moved out of ticket-creation.md into the Phase-3 FILE-step chunk.
    const ticketFile = collapsed("references/phase-3-ticket-file.md");
    const integration = collapsed("references/ticket-integration.md");
    const handoff = collapsed("references/phase-9-handoff.md");
    expect(direction).toContain("printable ascii, single-line, at most 120 characters");
    expect(direction).toContain("do not directly copy, interpolate, slugify, or mechanically transform raw ticket title/body text");
    expect(ticketFile).toContain('gh issue create --repo <target> --title "<title>" --body-file <path>');
    expect(integration).toContain("pass the complete title as one quoted argument");
    expect(handoff).toContain('--title "<title>" --body-file <path>');
  });

  it("threads the exact branch through maintainer handoff, fork compare, CI, and cleanup", () => {
    const handoff = collapsed("references/phase-9-handoff.md");
    const forkHandoff = collapsed("references/phase-9-fork-handoff.md");
    for (const marker of [
      "git push -u <pushremote> feature/<feature-slug>",
      "--head feature/<feature-slug>",
      "## what was built — feature/<feature-slug>",
      "gh run list --branch feature/<feature-slug>",
      "git branch -d feature/<feature-slug>",
    ]) {
      expect(handoff).toContain(marker);
    }
    expect(handoff).toContain("print the stable copyable pr title `<title>`");
    expect(forkHandoff).toContain("git push -u <pushremote> feature/<feature-slug>");
    expect(forkHandoff).toContain("<forkowner>:feature/<feature-slug>?expand=1");
    // The full push-safety gate is single-sourced in phase-9-handoff.md step 1 — assert it there.
    // phase-9-fork-handoff.md step 1 collapses to the fork delta (re-fetch via a temporary named
    // remote, the single fork push) plus a pointer to that gate, so the fork side asserts only the
    // pointer and the "nothing is lost" framing that survives the collapse (it also lives in the fork
    // push-failure degrade).
    for (const marker of ["first push", "never force", "claim complete race elimination",
      "nothing is lost", "local branch, worktree, and commits remain intact",
      "nothing new was posted", "new descriptive identity"]) {
      expect(handoff, `maintainer: ${marker}`).toContain(marker);
    }
    expect(forkHandoff).toContain("push-safety gate");
    expect(forkHandoff).toContain("nothing is lost");
  });

  it("pins all commit forms and retained GitHub/task-local numbering", () => {
    const implementation = collapsed("references/phase-7-implementation.md");
    for (const form of [
      "<feature-slug>: t<task-number> — <description>", "<feature-slug>: <description>",
    ]) expect(implementation).toContain(form);
    expect(read("references/ticket-integration.md")).toContain("#N");
    expect(read("references/templates.md")).toContain("<task-number>");
    expect(read("references/templates.md")).toContain("t01");
  });

  it("contains no obsolete new-run numbering placeholders anywhere in the skill", () => {
    const files = ["SKILL.md", ...fs.readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md")).map((name) => `references/${name}`)];
    for (const file of files) {
      const body = read(file);
      expect(body, file).not.toMatch(/<nn>|f<nn>|feature\/<nn>|<nn>-<slug>|<feature-(?:number|id)>/i);
      expect(body, file).not.toMatch(/feature\/\d|doc\/plan\/\d|\bf\d+:/i);
      expect(body, file).not.toMatch(/next free (?:feature )?(?:id|number)|global feature (?:id|number)/i);
    }
  });

  it("pins the workflow's hard pre-tool presentation gate, replacement, and residual-race disclosure", () => {
    // The gate/announcement prose lives in phase-1-direction.md; the collision re-announcement loop
    // lives in phase-2-workspace.md step 2 — each marker is pinned in the file that holds it.
    const direction = collapsed("references/phase-1-direction.md");
    const workspace = collapsed("references/phase-2-workspace.md");
    for (const marker of [
      "hard presentation gate", "immediately after the explicit build go", "first read the references required for phase 2",
      "required reference reads are the only tool calls allowed before the announcement",
      "before every workspace, preflight, or mutating command", "before `enterworktree`",
      "complete identity announcement as user-visible prose", "never only as hidden reasoning",
      "may share the same assistant response with later tool calls", "requires no user reply",
      "after the required reference reads, do not invoke a workspace, fetch, validation, preflight, mutating command, or `enterworktree` before this prose is visible",
      "collision checks cover shared/fetched state but cannot eliminate simultaneous or disconnected same-slug races",
    ]) expect(direction).toContain(marker);
    for (const marker of [
      "author and revalidate a more specific descriptive slug", "repeat the entire fetched/filesystem/ref collision preflight",
      "repeat the full title/slug/branch/plan announcement",
    ]) expect(workspace).toContain(marker);
    for (const banned of ["before the first phase 2 tool call", "do not invoke even a read"]) {
      expect(direction).not.toContain(banned);
      expect(workspace).not.toContain(banned);
    }
    const ordered = [
      "title: `<title>`", "slug: `<feature-slug>`", "branch: `feature/<feature-slug>`",
      "plan: `doc/plan/<feature-slug>/`", "race disclosure:",
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expectBefore(direction, ordered[index]!, ordered[index + 1]!);
    }
    expectBefore(workspace, "repeat the entire fetched/filesystem/ref collision preflight", "repeat the full title/slug/branch/plan announcement");
  });

  it("uses canonical issue numbers and exact frozen Title through ticket creation", () => {
    // The FILE-step content (dedup search, create, synthesized cache, `<target>#N` ref) moved into
    // the Phase-3 FILE-step chunk; the frozen-Title contract is asserted there now.
    const ticketFile = read("references/phase-3-ticket-file.md");
    const integration = read("references/ticket-integration.md");
    for (const marker of [
      '--search "<Title>"', '--title "<Title>"', '`title=<Title>`',
      "equal the display title frozen at build go byte-for-byte", "cached `title` must equal the exact frozen `<Title>`",
    ]) expect(ticketFile).toContain(marker);
    expect(integration).toContain("the same exact frozen `<Title>` byte-for-byte");
    expect(ticketFile).toContain("`<target>#N`");
    expect(integration).toMatch(/only\s+that integer ever appears in a linking keyword/);
  });

  it("uses pushRemote for resolved maintainer operations and confines origin to the git-only degrade", () => {
    const workspace = collapsed("references/phase-2-workspace.md");
    const handoff = collapsed("references/phase-9-handoff.md");
    for (const marker of [
      "refs/remotes/<pushremote>/head", "git remote show <pushremote>", "git fetch <pushremote>",
      "<pushremote>/<targetdefault>", "git push -u <pushremote> feature/<feature-slug>",
      "<pushremote>/feature/<feature-slug>",
    ]) expect(`${workspace} ${handoff}`).toContain(marker);
    expect(workspace).toContain("only the explicit no-`gh` git-only degrade uses literal `origin`");
    expect(handoff).toContain("explicit no-`gh` git-only degrade alone reserves literal `origin`");
  });

  it("updates the contributor contract without scanning historical records", () => {
    const contributing = fs.readFileSync(path.resolve(SKILL_DIR, "../../../CONTRIBUTING.md"), "utf8").replace(/\r\n/g, "\n");
    expect(contributing).toContain("git checkout feature/<feature-slug>");
    expect(contributing).not.toMatch(/git checkout feature\/<nn>-<slug>/i);
  });

  it("gitignores the per-feature process folders and nothing else under doc/", () => {
    const gitignore = fs.readFileSync(path.resolve(SKILL_DIR, "../../../.gitignore"), "utf8").replace(/\r\n/g, "\n");
    const processFolders = ["doc/plan/", "doc/research/", "doc/review/"];
    for (const entry of processFolders) expect(gitignore).toContain(entry);
    // Everything else under doc/ is committed documentation. Assert the ignore list
    // reaches no further than the three process folders — a broader pattern would
    // untrack the docs silently, which is how this used to be checked one folder at
    // a time.
    const docEntries = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("doc/"));
    expect(docEntries.sort()).toEqual([...processFolders].sort());
  });

  it("no longer ships a CHANGELOG.md at the repo root", () => {
    expect(fs.existsSync(path.resolve(SKILL_DIR, "../../../CHANGELOG.md"))).toBe(false);
  });
});

describe("untrack-process-artifacts — implement-feature rework", () => {
  const read = (relative: string): string =>
    fs.readFileSync(path.join(SKILL_DIR, relative), "utf8").replace(/\r\n/g, "\n");
  const collapsed = (relative: string): string => read(relative).toLowerCase().replace(/\s+/g, " ");
  const AGENTS_DIR = path.resolve(SKILLS_DIR, "..", "agents");

  it("carries no case-insensitive 'changelog' anywhere under .claude/skills or .claude/agents", () => {
    // Regression guard for the whole purge — the scan covers every phase's files. Reuse the
    // loader's own file walker; CRLF is irrelevant to a
    // case-folded substring test.
    const files = [
      ...walkFiles(SKILLS_DIR, (n) => n.endsWith(".md")),
      ...walkFiles(AGENTS_DIR, (n) => n.endsWith(".md")),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8").toLowerCase(), norm(file)).not.toContain("changelog");
    }
  });

  it("carries no plan—/review— commit SUBJECT anywhere, and keeps the task form", () => {
    // Anchor to the commit SUBJECT form ": plan — " / ": review — ", NEVER bare "review — " prose:
    // SKILL.md legitimately says "implementation and review — all in this session" and "only
    // review — never dispatch one to implement". Scan the trunk plus every reference file — a
    // banned subject form could reappear in any of them.
    const files = [
      "SKILL.md",
      ...fs.readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md")).map((name) => `references/${name}`),
    ];
    for (const relative of files) {
      const body = read(relative);
      expect(body, relative).not.toContain(": plan — ");
      expect(body, relative).not.toContain(": review — ");
    }
    // The task commit subject form still ships in the trunk and the Phase 7 grammar home.
    for (const relative of ["SKILL.md", "references/phase-7-implementation.md"]) {
      expect(read(relative), relative).toContain("t<task-number> — ");
    }
  });

  it("classifies resume from the on-disk plan folder + feature.md heading, not plan—/review— commit agreement", () => {
    const body = collapsed("references/resume-and-aborting.md");
    // Reconstruction reads the surviving worktree on disk, not a committed tree.
    expect(body).toContain("on-disk (gitignored) plan folder");
    expect(body).toContain(
      "the exact on-disk `doc/plan/<feature-slug>/` folder and `# <feature-slug>: <title>` heading",
    );
    // The frozen title is single-sourced from the on-disk feature.md heading.
    expect(body).toContain("single-sourced from the on-disk `feature.md` heading");
    // Identity is no longer conditioned on plan—/review— commit-title agreement.
    expect(body).not.toContain(
      "`<feature-slug>: plan — ` and `<feature-slug>: review — ` must equal",
    );
    // The absent-plan-folder resume branch does not fall through to the generic stop.
    expect(body).toContain("never committed, and cannot be recovered here");
  });
});

describe("proposal-gate wiring floor markers", () => {
  // Loose, case-insensitive, whitespace-collapsed structural checks. The proposal-gate
  // wiring lives in the REFERENCE files (Phase 8 gate + Phase 1 annotate), NOT the router
  // body — loadSkillBody never reads reference bodies, and the router clause is optional —
  // so assert the marker in the files the wiring actually edits. We do NOT re-assert the
  // existing --body-file / allow-list floor (it already holds and stays green).
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");

  const FILE_FINDING_PATH = path.join(REFERENCES_DIR, "phase-8-file-finding.md");
  const TICKET_CREATION_PATH = path.join(REFERENCES_DIR, "ticket-creation.md");

  it("Phase 8 (phase-8-file-finding.md) gates findings through proposal-gate, dropping clear slop with a review.md tally", () => {
    const body = collapse(FILE_FINDING_PATH);
    expect(body).toContain("proposal-gate");
    // Clear slop dropped, but the tally says the dropped findings remain in review.md.
    expect(body).toContain("remain in review.md");
    // The gate only subtracts clear slop; per-presented-finding choice preserved (one coherent rule).
    expect(body).toContain("subtracts clear slop, never adds");
    expect(body).toContain("choose per _presented_ finding");
  });

  it("Phase 1 (ticket-creation.md) only annotates via proposal-gate in-session and never suppresses the offer", () => {
    const body = collapse(TICKET_CREATION_PATH);
    expect(body).toContain("proposal-gate");
    // Annotate-only, presented in-session and never baked into the filed public issue body.
    expect(body).toContain("in-session");
    expect(body).toContain("never baked into the filed public issue body");
    expect(body).toContain("only annotates");
    expect(body).toContain("never suppresses this offer");
  });
});

describe("evidence-grounded evaluation wiring", () => {
  // Loose, whitespace-collapsed, case-insensitive checks on the two implement-feature
  // reference files that consume proposal-gate. Dash seams are built from code points so
  // this source stays ASCII-clean; asserted path/tool examples use forward slashes (the
  // repo-relative convention the evidence anchors are normalized to).
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");
  const FILE_FINDING_PATH = path.join(REFERENCES_DIR, "phase-8-file-finding.md");
  const TICKET_CREATION_PATH = path.join(REFERENCES_DIR, "ticket-creation.md");
  const EN_DASH = String.fromCodePoint(0x2013);

  it("Phase 1 advisory (ticket-creation.md) investigates the project, presents the block with evidence anchors, never baked into the filed body", () => {
    const body = collapse(TICKET_CREATION_PATH);
    // Grounded: the advisory now investigates the project before it rates.
    expect(body).toContain("investigates the project and rates");
    // The grounding investigation is the EVALUATOR's job via Read/Grep/Glob; the
    // implement-feature coordinator adds NO new gh/fetch to satisfy grounding.
    expect(body).toContain("`read`/`grep`/`glob`");
    expect(body).toContain("coordinator adds no new");
    expect(body).toContain("no new `gh`");
    // The presented rating block now includes its evidence anchors, in-session only.
    expect(body).toContain("evidence anchors");
    expect(body).toContain("in-session");
    // Unchanged: the assessment is never baked into the filed public issue body.
    expect(body).toContain("never baked into the filed public issue body");
  });

  it("Phase 8 embed (phase-8-file-finding.md) carries repo-relative, leakage-stripped anchors under the full element-7 re-validation, gate semantics unchanged", () => {
    const body = collapse(FILE_FINDING_PATH);
    // The ## Evaluation embed carries the evidence anchors.
    expect(body).toContain("`## evaluation`");
    expect(body).toContain("evidence anchors");
    // Full engine element-7 anchor re-validation, NOT merely Rule 6.
    expect(body).toContain("element-7 anchor re-validation");
    expect(body).toContain("`..` traversal");
    expect(body).toContain("repo-root-relative forward-slash path");
    // The never-re-open property the anchor re-validation adds over Rule 6.
    expect(body).toContain("never re-opens or resolves");
    // Binds the load-bearing must-fix relationship: element-7 is applied IN ADDITION TO
    // Rule 6, not instead of it — a rewrite that dropped this distinction must redden.
    expect(body).toContain("strictly stronger check applied **in addition to** rule 6");
    // Pick-list density: disposition + at most 1–2 decision-flipping anchors.
    expect(body).toContain(`1${EN_DASH}2`);
    expect(body).toContain("decision-flipping anchors");
    // Unchanged gate semantics + per-item maintainer choice.
    expect(body).toContain("subtracts clear slop, never adds");
    expect(body).toContain("choose per _presented_ finding");
  });
});

describe("incoming-ticket evaluation preflight", () => {
  // Loose, whitespace-collapsed, case-insensitive structural floors for the Phase 0 preflight
  // (redirect free text unread -> evaluator -> approve -> hydrate) and the resume isolation. The
  // true runtime no-write / no-raw-ingest guarantees are live-eval concerns; the assertable surface
  // is the documented command shape + the cross-skill reuse-by-reference links.
  const read = (relative: string): string =>
    fs.readFileSync(path.join(SKILL_DIR, relative), "utf8").replace(/\r\n/g, "\n");
  const collapse = (relative: string): string => read(relative).toLowerCase().replace(/\s+/g, " ");
  // A second collapse that also strips backticks, so a revert to a backticked variant of a
  // forbidden phrase (e.g. "scan the cached issue `comments`") is still caught.
  const collapseNoTicks = (relative: string): string => collapse(relative).replace(/`/g, "");

  it("Phase 0 router splits into a trusted structured query (no free text) + an unread redirect + evaluator-before-hydrate", () => {
    const body = collapse("SKILL.md");
    // The trusted reachability query resolves only structured fields via --jq — it must NOT carry
    // the old all-fields form that pulled title/body/comments into the coordinator's context.
    expect(body).toContain("ispr:(.pull_request!=null)");
    expect(body).not.toContain("number,title,body,labels,state,url,comments");
    // Structural guard (not just the old exact string): isolate the trusted `gh api … --jq '{…}'`
    // reachability query and assert THAT projection carries no free-text field token. A regression
    // that reintroduces free text on the trusted side in ANOTHER shape (e.g. `--json title`, or a new
    // `body:.body` in the jq) reddens here, where the old exact-string guard alone would let it pass.
    const apiStart = body.indexOf("gh api repos");
    expect(apiStart, "missing trusted reachability query").toBeGreaterThanOrEqual(0);
    const jqEnd = body.indexOf("}'", apiStart);
    expect(jqEnd, "missing --jq structured projection").toBeGreaterThan(apiStart);
    const trustedQuery = body.slice(apiStart, jqEnd + 2);
    for (const freeText of ["title", "body", "comments"]) {
      expect(trustedQuery, `trusted reachability query leaks free text: ${freeText}`).not.toContain(
        freeText,
      );
    }
    // The untrusted free text is redirected to a tempfile the coordinator does not read.
    expect(body).toContain("title,body,comments > <tempfile>");
    expect(body).toContain("bash tool");
    // The evaluator is dispatched BEFORE any free-text hydration.
    const evalIdx = body.indexOf("evaluator");
    const hydrateIdx = body.indexOf("hydrat");
    expect(evalIdx, "missing evaluator dispatch").toBeGreaterThanOrEqual(0);
    expect(hydrateIdx, "missing hydrate step").toBeGreaterThan(evalIdx);
    // Free text is cached only post-approval, not at Phase 0.
    expect(body).toContain("post-approval");
  });

  it("Rule 9 (ticket-integration.md) is the metadata-only --jq html_url scan, not a cached-comments read", () => {
    const body = collapseNoTicks("references/ticket-integration.md");
    // Metadata-only form present, keyed on the hand-off opener (not the generic trailer).
    expect(body).toContain("html_url");
    expect(body).toContain("## what was built for #<n>");
    // The old cached-comments scan must be gone (backtick-insensitive, so a `comments` revert fails too).
    expect(body).not.toContain("scan the cached issue comments");
  });

  it("resume re-hydrate (ticket-creation.md) never re-ingests raw comments; the single-rule wording has no contradiction", () => {
    const body = collapse("references/ticket-creation.md");
    // The single rule: no raw comments on resume; body via feature.md or the screen.
    expect(body).toContain("no raw `comments` on resume");
    expect(body).toContain("frozen what/why");
    // The re-fetch is structured-metadata-only, and the old all-fields read is gone.
    expect(body).not.toContain("number,title,body,labels,state,url,comments");
  });

  it("resolves the cross-skill evaluate/evaluator links the preflight adds (wrong-form/broken link fails the suite)", () => {
    const refFiles = fs.readdirSync(REFERENCES_DIR).filter((n) => n.endsWith(".md"));
    const linkRe =
      /\((\.\.\/\.\.\/evaluate\/references\/[A-Za-z0-9_-]+\.md|\.\.\/\.\.\/\.\.\/agents\/[A-Za-z0-9_-]+\.md)\)/g;
    const seen = new Set<string>();
    for (const name of refFiles) {
      const text = fs.readFileSync(path.join(REFERENCES_DIR, name), "utf8");
      for (const m of text.matchAll(linkRe)) {
        const rel = m[1]!;
        seen.add(rel);
        expect(fs.existsSync(path.resolve(REFERENCES_DIR, rel)), `${name} -> ${rel}`).toBe(true);
      }
      // The repo-root `.claude/agents/…` form would NOT resolve from a references/*.md file.
      expect(text, name).not.toContain("](.claude/agents/");
    }
    // The four load-bearing preflight anchors must each ship in reference prose.
    for (const req of [
      "../../evaluate/references/issue-eval.md",
      "../../evaluate/references/write-discipline.md",
      "../../../agents/evaluator.md",
      "../../evaluate/references/proposal-gate.md",
    ]) {
      expect(seen.has(req), `missing cross-link: ${req}`).toBe(true);
    }
  });

  it("resolves the evaluate skill's back-links into implement-feature (reciprocal of the in-skill resolver)", () => {
    // The mirror of the resolver above: the existing tests only resolve implement-feature -> evaluate
    // and the in-skill references dir, so an evaluate/*.md link INTO implement-feature (e.g.
    // pr-eval.md's `phase-9-handoff.md` pointer) could dangle after a rename with a green suite. Glob
    // the whole evaluate skill and resolve every `../../implement-feature/references/<file>.md` and
    // `../../../agents/<file>.md` link on disk, from the containing file's own directory. Scheme-
    // qualified (http/mailto) and non-`.md` targets stay out of scope, matching the in-skill resolver.
    const evalFiles = walkFiles(EVALUATE_DIR, (name) => name.endsWith(".md"));
    expect(evalFiles.length).toBeGreaterThan(0);
    const linkRe =
      /\]\((\.\.\/\.\.\/implement-feature\/references\/[A-Za-z0-9_-]+\.md|\.\.\/\.\.\/\.\.\/agents\/[A-Za-z0-9_-]+\.md)\)/g;
    const seen = new Set<string>();
    for (const file of evalFiles) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(linkRe)) {
        const rel = m[1]!;
        seen.add(rel);
        expect(
          fs.existsSync(path.resolve(path.dirname(file), rel)),
          `${norm(path.relative(EVALUATE_DIR, file))} -> ${rel}`,
        ).toBe(true);
      }
    }
    // The load-bearing cross-link this task installs the guard for: pr-eval.md points at the renamed
    // phase-9-handoff.md. If a future rename drops the pr-eval.md repoint, this assertion reddens.
    expect(
      seen.has("../../implement-feature/references/phase-9-handoff.md"),
      "missing back-link: ../../implement-feature/references/phase-9-handoff.md",
    ).toBe(true);
  });
});

describe("Phase 8 coordinator-run advisory issue search", () => {
  // Loose, whitespace-collapsed, case-insensitive checks on ticket-integration.md's Phase 8 hook:
  // the coordinator (holding gh/Bash) runs ONE read-only `gh issue list --search` per surfaced
  // finding, feeds the result to the gate as a github_verified anchor, with coordinator-authored
  // terms (never target-lifted), the anti-suppression floor, a visible degrade, and a strict
  // separation from Rule 9's filing-time metadata scan. The Phase 8 gate pins, the Rule 9
  // metadata-only scan, and the Phase-1 "no new gh" pin are covered by their existing blocks and
  // stay green (the re-scope is Phase-8-only). We do NOT touch Rule 9 or ticket-creation.md.
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");
  const FILE_FINDING_PATH = path.join(REFERENCES_DIR, "phase-8-file-finding.md");

  it("Phase 8 hook points at a coordinator-run, read-only advisory search feeding a github_verified anchor", () => {
    const body = collapse(FILE_FINDING_PATH);
    // The coordinator path holds gh/Bash and runs one narrow read-only list per finding.
    expect(body).toContain("one narrow read-only");
    expect(body).toContain('--search "<terms>"');
    expect(body).toContain("hand the result to the gate as a `github_verified` anchor");
    // Pure read — no write verb added, Rule 5 allow-list unchanged.
    expect(body).toContain("this is a pure **read**");
    expect(body).toContain("rule 5 allow-list is unchanged");
  });

  it("Phase 8 terms are coordinator-authored, never target-lifted, obeying the frozen-title character ban", () => {
    const body = collapse(FILE_FINDING_PATH);
    expect(body).toContain("**coordinator-authored**");
    expect(body).toContain("never** lifted from issue/pr body");
    expect(body).toContain("frozen-title character ban");
  });

  it("Phase 8 states the novelty floor (hit lowers novelty, never by itself drops below threshold), candidate wording + visible degrade", () => {
    const body = collapse(FILE_FINDING_PATH);
    expect(body).toContain("**never by itself** drops it below the file/keep-open threshold");
    expect(body).toContain("possible existing coverage:");
    expect(body).toContain("not cross-checked against github");
    // Provenance-by-origin-channel + separate anchor lane on the coordinator side too.
    expect(body).toContain("only** from that json's `number`/`url`");
    expect(body).toContain("never from a target-body `#n`");
    // Defense-in-depth at the create site: the Phase 8 coordinator both receives the search JSON AND
    // runs `gh issue create`, so a returned attacker title must never be reflected into a write.
    expect(body).toContain("returned issue title as untrusted display data");
    expect(body).toContain("never** interpolate a returned title into `gh issue create`");
  });

  it("Phase 8 advisory search feeds SCORING; it is the SAME read as Rule 9's filing-time --search dedup, distinct from the html_url comment scan", () => {
    const body = collapse(FILE_FINDING_PATH);
    expect(body).toContain("feeds *scoring*, not filing");
    // The advisory search and Rule 9's filing-time dedup are the SAME `gh issue list --search` read,
    // invoked for two different purposes (novelty score vs. double-file prevention) — not conflated
    // with the html_url metadata scan.
    expect(body).toContain("same read** as rule 9's filing-time `gh issue list --search` dedup");
    // The metadata-only html_url scan is correctly labelled a DIFFERENT mechanism (Phase 9 comment
    // idempotency), NOT the filing-time issue dedup.
    expect(body).toContain("metadata-only `html_url` scan is a *different* mechanism");
    // Negative pin: the metadata-only Rule 9 scan is NOT turned into a comment-body read.
    expect(body).not.toContain("scan the cached issue comments");
  });
});

describe("progressive-phase-disclosure spine guards", () => {
  // The corpus invariants: reference→reference links resolve, and the trunk keeps the
  // read-on-entry spine — per-phase detail lives in references/ only because the spine forces the
  // reads. All rename-proof — pinned
  // to link/section shape, not filenames, so the corpus can evolve without touching this block.
  const read = (relative: string): string =>
    fs.readFileSync(path.join(SKILL_DIR, relative), "utf8").replace(/\r\n/g, "\n");
  const collapsed = (relative: string): string => read(relative).toLowerCase().replace(/\s+/g, " ");

  it("every reference-to-reference markdown link resolves from the references dir (fragments banned)", () => {
    // Mirrors the cross-skill resolver's shape but resolves EVERY relative .md link from
    // REFERENCES_DIR — the cross-skill test half-matches only the ../../ forms, so a renamed or
    // deleted sibling reference could otherwise leave a dangling pointer. Capture the full link
    // target before filtering: a naive \(...\.md\) pattern would silently SKIP an anchored
    // `file.md#frag` link instead of failing it. The corpus is 100% fragment-free (bare `file.md`
    // siblings plus `../../` cross-skill forms), so fragments are banned outright rather than
    // stripped.
    const refFiles = fs.readdirSync(REFERENCES_DIR).filter((n) => n.endsWith(".md"));
    expect(refFiles.length).toBeGreaterThan(0);
    let linksSeen = 0;
    for (const name of refFiles) {
      const text = read(`references/${name}`);
      for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        // Only relative markdown-doc links; scheme-qualified targets (https:, mailto:) are not
        // resolvable on disk and stay out of scope.
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || !target.includes(".md")) continue;
        linksSeen += 1;
        expect(target, `${name} -> ${target}`).toMatch(/^(?:\.\/)?[A-Za-z0-9._/-]+\.md$/);
        expect(fs.existsSync(path.resolve(REFERENCES_DIR, target)), `${name} -> ${target}`).toBe(
          true,
        );
      }
    }
    expect(linksSeen).toBeGreaterThan(0);
  });

  it("keeps the read-on-entry re-read rule's kernel resident in the trunk", () => {
    // The load-bearing mechanism of progressive disclosure: per-phase detail lives in references/
    // on the strength of this rule, so its kernel must survive every trunk slimming — the
    // verbatim-in-context test (with the compaction-summary exclusion) and the fail-closed
    // refuse-writes clause. Loose substring pins on the kernel, not the surrounding prose.
    const body = collapsed("SKILL.md");
    expect(body).toContain("not verbatim in context");
    expect(body).toContain("a compaction summary mentioning it does not count");
    expect(body).toContain("an unreadable named reference refuses that phase's writes");
  });

  it("every entry-gated phase section keeps a MUST-read line naming a references/ file (count-agnostic)", () => {
    // The phase spine, shape-pinned: split the trunk into ## sections and scan the Phase ones.
    // Every phase section names at least one references/*.md; every phase with an `Entry:` event
    // also carries a MUST-read line, so a slimming pass cannot silently drop the spine. Phase 0
    // is the one legitimate exception — it runs at ref-parse time with no entry event (no
    // `Entry:` line) — so at most ONE phase section may lack `Entry:`; a second one means a phase
    // dropped its entry gate together with its read requirement.
    const sections = read("SKILL.md")
      .split(/\n(?=## )/)
      .filter((section) => /^## Phase \d/.test(section));
    expect(sections.length).toBeGreaterThan(0);
    const entryGated = sections.filter((section) => /\bEntry:/.test(section));
    const nonGated = sections.filter((section) => !/\bEntry:/.test(section));
    expect(nonGated.length).toBeLessThanOrEqual(1);
    // The one legitimate non-gated section is Phase 0 (ref-parse time, no entry event) — pinning
    // its identity closes the two-edit hole where another phase de-gates while Phase 0 gains an
    // `Entry:` line in the same change.
    for (const section of nonGated) {
      expect(section.split("\n", 1)[0]!).toMatch(/^## Phase 0\b/);
    }
    for (const section of sections) {
      const heading = section.split("\n", 1)[0]!;
      expect(section, heading).toMatch(/references\/[A-Za-z0-9_-]+\.md/);
    }
    for (const section of entryGated) {
      const heading = section.split("\n", 1)[0]!;
      expect(section.toLowerCase().replace(/\s+/g, " "), heading).toContain("must read");
    }
  });
});

describe("fail-closed floor pointer on every write-site reference", () => {
  // Layer-1 static guard for the whole restructure's binding invariant: every reference file that
  // itself performs or authors a public GitHub write must BOTH name the nine-rules floor
  // (ticket-integration.md) AND carry a fail-closed clause — read the floor first, refuse the write if
  // it cannot be read. This is what keeps a write from proceeding with the rules unloaded, and no
  // prior test covered it. Tolerant on wording, strict on presence.
  const read = (relative: string): string =>
    fs.readFileSync(path.join(REFERENCES_DIR, relative), "utf8").replace(/\r\n/g, "\n");
  // Accept the corpus's wording variants: "cannot be read" (handoff), "can't be read" (feature-spec,
  // fork-handoff — the latter hard-wrapped across a newline), "can not be read", or "unreadable".
  // Whitespace between words is flexible (\s+) so a line break inside the clause still matches.
  const READ_FAILURE = /can(?:not|['\u2019]?t| not)\s+be\s+read|unreadable/i;

  // Every write-site reference file. phase-3-feature-spec.md points at the accepted create-offer's
  // FILE step and phase-3-ticket-file.md holds the actual `gh issue create` for it (t05 moved that
  // write out of ticket-creation.md, which no longer performs a write and drops off this list);
  // phase-8-file-finding.md files surfaced findings; the two Phase 9 files author the PR/comment.
  const writeSites = [
    "phase-3-feature-spec.md",
    "phase-3-ticket-file.md",
    // ticket-creation.md's write moved to phase-3-ticket-file.md (t05), but it retains a
    // defense-in-depth floor pointer — pin it so a future edit reintroducing a direct
    // `gh issue create` there can't slip past this guard.
    "ticket-creation.md",
    "phase-8-file-finding.md",
    "phase-9-handoff.md",
    "phase-9-fork-handoff.md",
  ];

  for (const site of writeSites) {
    it(`${site} names the nine-rules floor and carries a fail-closed clause`, () => {
      const body = read(site);
      expect(body, `${site}: missing ticket-integration.md floor pointer`).toContain(
        "ticket-integration.md",
      );
      expect(body, `${site}: missing refuse clause`).toMatch(/refuse/i);
      expect(body, `${site}: missing read-failure clause`).toMatch(READ_FAILURE);
    });
  }
});

describe("implementer standing rules — incremental logs and OS-temp scratch (#102)", () => {
  // The Phase-7 standing rules are duplicated: the coordinator relays them from
  // references/phase-7-implementation.md, and the implementer agent carries its own mirror in
  // .claude/agents/implementer.md. Both copies must require (a) writing the execution log to disk
  // incrementally as work proceeds — protecting the on-disk log a resume reads as the sole record
  // of a commit-less task's completion — and (b) keeping scratch/temp files in the OS temp dir,
  // never inside the worktree. Loose, whitespace-collapsed, case-insensitive markers.
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");
  const AGENTS_DIR = path.resolve(SKILLS_DIR, "..", "agents");
  const PHASE_7_PATH = path.join(REFERENCES_DIR, "phase-7-implementation.md");
  const IMPLEMENTER_PATH = path.join(AGENTS_DIR, "implementer.md");

  it("phase-7-implementation.md requires an incremental on-disk log and OS-temp-only scratch", () => {
    const body = collapse(PHASE_7_PATH);
    // Incremental-log marker: "brief bullets while working" alone existed before; the on-disk
    // incremental requirement is genuinely new.
    expect(body).toContain("incrementally as work proceeds");
    expect(body).toContain("append as you go");
    // OS-temp-scratch marker: keyed on the distinctive implementer-scratch wording, NOT the loose
    // "outside the worktree" that step 6's pre-existing `--body-file` clause already carries.
    expect(body).toContain("scratch/temp files");
    expect(body).toContain("never inside the worktree");
  });

  it("implementer.md mirrors the incremental on-disk log and OS-temp-only scratch rules", () => {
    const body = collapse(IMPLEMENTER_PATH);
    expect(body).toContain("incrementally as work proceeds");
    expect(body).toContain("append as you go");
    expect(body).toContain("scratch/temp files");
    expect(body).toContain("never inside the worktree");
  });
});
