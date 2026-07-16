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

const norm = (p: string): string => p.replace(/\\/g, "/");

describe("implement-feature router (F12 t01)", () => {
  // Use the real loader (not fs.readFileSync): loadSkillBody/parseMarkdown normalize
  // CRLF and strip the BOM, so the char count is deterministic cross-platform.
  const { skills } = loadSkills([{ dir: SKILLS_DIR, scope: "project" }], []);
  const skill = skills.find((s) => s.name === "implement-feature");

  it("loads with a valid frontmatter contract", () => {
    // `name` must equal the expected identity (catches a `name:` value typo; the loader falls back to
    // the dir basename, which is also "implement-feature", so a removed key still passes — acceptable).
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("implement-feature");
    expect(typeof skill!.description).toBe("string");
    expect(skill!.description.length).toBeGreaterThan(0);
  });

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
    const argsText =
      "#5 also add structured logging around the dispatch loop and make sure the retry path is " +
      "covered by an offline integration test in the tester layer please";
    expect(argsText.length).toBeGreaterThanOrEqual(140);
    const rendered = substituteArguments(body, argsText, skill!.arguments);
    expect(rendered.text.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
    // The ref still reaches the coordinator — via the no-marker append fallback, since the router
    // body carries no literal `$ARGUMENTS`/`$N`/`$name` marker to substitute in place.
    expect(rendered.text).toContain(`ARGUMENTS: ${argsText}`);
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
    // Glob the actual references/*.md rather than hardcoding a file count — t02–t05 add more.
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

  it("pins validation, collision preflight, race backstops, and resume semantics in workflow-detail.md", () => {
    const body = collapsed("references/workflow-detail.md");
    expect(body).toContain("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$");
    expect(body).toContain("3–48 characters");
    for (const reserved of ["`con`", "`prn`", "`aux`", "`nul`", "`com1`–`com9`", "`lpt1`–`lpt9`"]) {
      expect(body).toContain(reserved);
    }
    expect(body).toContain('git check-ref-format --branch "feature/<feature-slug>"');
    expect(body).toContain("fails closed");
    expect(body).toContain("never silently sanitize");
    expect(body).toContain("append/increment a numeric counter");

    for (const marker of [
      "fetched `targetdefault` tree",
      "current filesystem including a dangling symlink",
      "physical `.claude/worktrees/<feature-slug>`",
      "registered worktree",
      "local `refs/heads/feature/<feature-slug>`",
      "local harness `refs/heads/worktree-<feature-slug>`",
      "fetched remote `refs/remotes/<pushremote>/feature/<feature-slug>`",
    ]) {
      expect(body).toContain(marker);
    }
    expect(body).toContain("case-insensitively");
    expect(body).toContain("exact git/path checks");
    expect(body).toContain("create-or-reenter");
    for (const raceMarker of [
      "delete a newly appeared unregistered directory",
      "adopt a newly appeared `worktree-<feature-slug>` harness branch",
      "seed files and run create hooks",
      "report the worktree as created",
      "cannot promise preservation or reliably detect",
      "exact worktree path",
      "exact harness/feature branch",
      "full `git status`",
      "possible deletion, branch adoption, seeding, and hook effects",
    ]) expect(body).toContain(raceMarker);
    expect(body).toContain("invoke it with `<feature-slug>`");
    expect(body).toContain("non-forcing `git switch -c feature/<feature-slug>");
    expect(body).toContain("no further workflow-initiated repository or github writes");
    expect(body).toContain("cannot atomically reserve");

    expectBefore(body, "resume classification", "author one concise descriptive");
    expect(body).toContain("worktree basename and exact current `feature/<feature-slug>` branch");
    expect(body).toContain("`doc/plan/<feature-slug>/` folder");
    expect(body).toContain("# <feature-slug> review: <title>");
    expect(body).toContain("with exactly the same frozen `<title>`");
    expect(body).toContain("`<feature-slug>: plan — ` and `<feature-slug>: review — ` must equal the frozen `<title>` exactly");
    expect(body).toContain("task and fix commits require only the slug prefix");
    expect(body).toContain("stop before further commands or writes");
    for (const trustMarker of [
      "recovered frozen title verbatim", "recovered scope", "reconstructed phase", "slug/branch/worktree/plan identity",
      "ticket target and reference", "exact remaining write contract", "require explicit confirmation",
      "freshly resolve `target`, `push`, `pushremote`, and `targetdefault`", "require its repo/reference to match",
    ]) expect(body).toContain(trustMarker);
    expect(body).toContain("identity finalized and immutable");
  });

  it("delimits a concrete legacy override through every remaining phase", () => {
    const raw = read("references/workflow-detail.md");
    const start = "<!-- LEGACY-RESUME-START: excluded only from new-run obsolete-form scans -->";
    const end = "<!-- LEGACY-RESUME-END -->";
    expectBefore(raw, start, end);
    const legacy = raw.slice(raw.indexOf(start), raw.indexOf(end) + end.length).toLowerCase();
    for (const marker of [
      "feature/20-de-number-feature-names", "doc/plan/20-de-number-feature-names/",
      "# f20: description-based feature naming", "# f20 review: description-based feature naming",
      "f20: plan —", "f20: t01 —", "f20: review —",
      "current plan, task, log, observations, and review paths", "push and configured upstream",
      "pr lookup/creation", "fork compare url", "ci lookup/repush", "abort guidance", "cleanup commands",
    ]) expect(legacy).toContain(marker);
  });

  it("keeps the resident router on the same descriptive identity and presentation gate", () => {
    const body = collapsed("SKILL.md");
    expect(body).toContain("classify resume before new naming");
    expect(body).toContain("<feature-slug>: plan — <title>");
    expect(body).toContain("<feature-slug>: t<task-number> — <description>");
    expect(body).toContain("never sanitize/add a counter");
    expect(body).toContain("explicit human confirmation");
    expect(body).toContain("complete override");
    expect(body).toContain("may delete a raced unregistered directory");
    expect(body).toContain("confirmed self-owned fast-forward repush");
    for (const marker of [
      "hard presentation gate", "immediately after build go", "first read the required phase 2 references",
      "reference reads are the only tool calls allowed before the announcement",
      "before every workspace/preflight/mutating command", "before `enterworktree`",
      "emit user-visible prose", "never leave it in hidden reasoning", "may share the response with later tool calls",
      "requires no reply",
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("before the first phase 2 tool call");
    const ordered = [
      "`title: <title>`", "`slug: <feature-slug>`", "`branch: feature/<feature-slug>`",
      "`plan: doc/plan/<feature-slug>/`", "`race disclosure:`",
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expectBefore(body, ordered[index]!, ordered[index + 1]!);
    }
    expect(body).not.toMatch(/next free|pick the next free|feature\/<nn>|f<nn>/i);
  });

  it("pins templates and task-local numbering independently", () => {
    const body = read("references/templates.md");
    expect(body).toContain("doc/plan/<feature-slug>/");
    expect(body).toContain("# <feature-slug>: <Title>");
    expect(body).toContain("# <feature-slug> Review: <Title>");
    expect(body).toContain("tasks/t<task-number>-<task-slug>.md");
    expect(body).toContain("log/t<task-number>.md");
    expect(body).toContain("t01");
    expect(body).toContain("t02");
  });

  it("keeps public ticket titles descriptive, stable, bounded, and safely quoted", () => {
    const workflow = collapsed("references/workflow-detail.md");
    const creation = collapsed("references/ticket-creation.md");
    const integration = collapsed("references/ticket-integration.md");
    const handoff = collapsed("references/handoff.md");
    expect(workflow).toContain("at the explicit build go, freeze that title");
    expect(workflow).toContain("a given ticket keeps its existing title unchanged");
    expect(workflow).toContain("printable ascii, single-line, at most 120 characters");
    expect(workflow).toContain("do not directly copy, interpolate, slugify, or mechanically transform raw ticket title/body text");
    expect(workflow).toContain("rather than rejecting incidental lexical overlap");
    expect(creation).toContain("no identifier prefix");
    expect(creation).toContain("single-line and at most 120 characters");
    expect(creation).toContain("same stable display title");
    expect(creation).toContain("frozen at build go");
    expect(creation).toContain('gh issue create --repo <target> --title "<title>" --body-file <path>');
    expect(creation).toContain("couples the public issue to the durable `ticket:` anchor");
    expect(integration).toContain("never directly copy, interpolate, slugify, or mechanically transform raw ticket text");
    expect(integration).toContain("incidental lexical overlap does not itself invalidate");
    expect(integration).toContain("freeze it at build go");
    expect(integration).toContain("never rewrite or substitute the existing title of a given ticket");
    expect(integration).toContain("public titles carry no invented identifier prefix");
    expect(integration).toContain("pass the complete title as one quoted argument");
    expect(integration).toContain("preserve every existing preview/reconfirmation and idempotency rule");
    expect(handoff).toContain('--title "<title>" --body-file <path>');
  });

  it("threads the exact branch through maintainer handoff, fork compare, CI, and cleanup", () => {
    const handoff = collapsed("references/handoff.md");
    const fork = collapsed("references/fork.md");
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
    expect(fork).toContain("git push -u <pushremote> feature/<feature-slug>");
    expect(fork).toContain("<forkowner>:feature/<feature-slug>?expand=1");
    for (const [name, body] of [["maintainer", handoff], ["fork", fork]] as const) {
      for (const marker of [
        "first push", "absent exact ref", "no case-fold sibling", "established self-owned branch",
        "live-run knowledge", "disk-resume trust gate", "configured upstream", "equal local `head` or be an ancestor",
        "non-forcing", "resumed handoff", "ci-fix repush", "foreign/ambiguous ref", "diverged", "never force",
      ]) expect(body, `${name}: ${marker}`).toContain(marker);
    }
    expect(fork).toContain("never claim complete race elimination");
    for (const body of [handoff, fork]) {
      for (const marker of ["nothing is lost", "local branch, worktree, and commits remain intact", "nothing new was posted", "new descriptive identity"]) {
        expect(body).toContain(marker);
      }
    }
  });

  it("pins all commit forms and retained GitHub/task-local numbering", () => {
    const workflow = collapsed("references/workflow-detail.md");
    for (const form of [
      "<feature-slug>: plan — <title>", "<feature-slug>: t<task-number> — <description>",
      "<feature-slug>: review — <title>", "<feature-slug>: <description>",
    ]) expect(workflow).toContain(form);
    expect(read("references/ticket-integration.md")).toContain("#N");
    expect(read("references/templates.md")).toContain("<task-number>");
    expect(read("references/templates.md")).toContain("t01");
  });

  it("contains no obsolete new-run placeholders outside only the delimited legacy section", () => {
    const files = ["SKILL.md", ...fs.readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md")).map((name) => `references/${name}`)];
    for (const file of files) {
      let body = read(file);
      if (file === "references/workflow-detail.md") {
        body = body.replace(/<!-- LEGACY-RESUME-START:[\s\S]*?<!-- LEGACY-RESUME-END -->/, "");
      }
      expect(body, file).not.toMatch(/<nn>|f<nn>|feature\/<nn>|<nn>-<slug>|<feature-(?:number|id)>/i);
      expect(body, file).not.toMatch(/feature\/\d|doc\/plan\/\d|\bf\d+:/i);
      expect(body, file).not.toMatch(/next free (?:feature )?(?:id|number)|global feature (?:id|number)/i);
    }
  });

  it("pins the workflow's hard pre-tool presentation gate, replacement, and residual-race disclosure", () => {
    const workflow = collapsed("references/workflow-detail.md");
    for (const marker of [
      "hard presentation gate", "immediately after the explicit build go", "first read the references required for phase 2",
      "required reference reads are the only tool calls allowed before the announcement",
      "before every workspace, preflight, or mutating command", "before `enterworktree`",
      "complete identity announcement as user-visible prose", "never only as hidden reasoning",
      "may share the same assistant response with later tool calls", "requires no user reply",
      "after the required reference reads, do not invoke a workspace, fetch, validation, preflight, mutating command, or `enterworktree` before this prose is visible",
      "collision checks cover shared/fetched state but cannot eliminate simultaneous or disconnected same-slug races",
      "author and revalidate a more specific descriptive slug", "repeat the entire fetched/filesystem/ref collision preflight",
      "repeat the full title/slug/branch/plan announcement",
    ]) expect(workflow).toContain(marker);
    expect(workflow).not.toContain("before the first phase 2 tool call");
    expect(workflow).not.toContain("do not invoke even a read");
    const ordered = [
      "title: `<title>`", "slug: `<feature-slug>`", "branch: `feature/<feature-slug>`",
      "plan: `doc/plan/<feature-slug>/`", "race disclosure:",
    ];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      expectBefore(workflow, ordered[index]!, ordered[index + 1]!);
    }
    expectBefore(workflow, "repeat the entire fetched/filesystem/ref collision preflight", "repeat the full title/slug/branch/plan announcement");
  });

  it("uses canonical issue numbers and exact frozen Title through ticket creation", () => {
    const creation = read("references/ticket-creation.md");
    const integration = read("references/ticket-integration.md");
    for (const marker of [
      '--search "<Title>"', '--title "<Title>"', '`title=<Title>`',
      "equal the display title frozen at build go byte-for-byte", "cached `title` must equal the exact frozen `<Title>`",
    ]) expect(creation).toContain(marker);
    expect(integration).toContain("the same exact frozen `<Title>` byte-for-byte");
    expect(creation).toContain("`<target>#N`");
    expect(integration).toMatch(/only\s+that integer ever appears in a linking keyword/);
  });

  it("uses pushRemote for resolved maintainer operations and confines origin to the git-only degrade", () => {
    const workflow = collapsed("references/workflow-detail.md");
    const handoff = collapsed("references/handoff.md");
    for (const marker of [
      "refs/remotes/<pushremote>/head", "git remote show <pushremote>", "git fetch <pushremote>",
      "<pushremote>/<targetdefault>", "git push -u <pushremote> feature/<feature-slug>",
      "<pushremote>/feature/<feature-slug>",
    ]) expect(`${workflow} ${handoff}`).toContain(marker);
    expect(workflow).toContain("only the explicit no-`gh` git-only degrade uses literal `origin`");
    expect(handoff).toContain("explicit no-`gh` git-only degrade alone reserves literal `origin`");
  });

  it("updates contributor and changelog contracts without scanning historical records", () => {
    const contributing = fs.readFileSync(path.resolve(SKILL_DIR, "../../../CONTRIBUTING.md"), "utf8").replace(/\r\n/g, "\n");
    const changelog = fs.readFileSync(path.resolve(SKILL_DIR, "../../../CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
    expect(contributing).toContain("git checkout feature/<feature-slug>");
    expect(contributing).not.toMatch(/git checkout feature\/<nn>-<slug>/i);
    const unreleased = changelog.slice(changelog.indexOf("## [Unreleased]"), changelog.indexOf("### Added — evaluate skill"));
    for (const marker of ["descriptive slug", "canonical numeric reference", "`t01`", "legacy"])
      expect(unreleased.toLowerCase()).toContain(marker);
  });
});

describe("proposal-gate wiring floor markers (evaluate-skill t04)", () => {
  // Loose, case-insensitive, whitespace-collapsed structural checks. The proposal-gate
  // wiring lives in the REFERENCE files (Phase 8 gate + Phase 1 annotate), NOT the router
  // body — loadSkillBody never reads reference bodies, and the router clause is optional —
  // so assert the marker in the files the wiring actually edits. We do NOT re-assert the
  // existing --body-file / allow-list floor (it already holds and stays green).
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");

  const TICKET_INTEGRATION_PATH = path.join(REFERENCES_DIR, "ticket-integration.md");
  const TICKET_CREATION_PATH = path.join(REFERENCES_DIR, "ticket-creation.md");

  it("Phase 8 (ticket-integration.md) gates findings through proposal-gate, dropping clear slop with a review.md tally", () => {
    const body = collapse(TICKET_INTEGRATION_PATH);
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

describe("evidence-grounded evaluation wiring (F23 t04)", () => {
  // Loose, whitespace-collapsed, case-insensitive checks on the two implement-feature
  // reference files that consume proposal-gate. Dash seams are built from code points so
  // this source stays ASCII-clean; asserted path/tool examples use forward slashes (the
  // repo-relative convention the evidence anchors are normalized to).
  const collapse = (p: string): string =>
    fs.readFileSync(p, "utf8").toLowerCase().replace(/\s+/g, " ");
  const TICKET_INTEGRATION_PATH = path.join(REFERENCES_DIR, "ticket-integration.md");
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

  it("Phase 8 embed (ticket-integration.md) carries repo-relative, leakage-stripped anchors under the full element-7 re-validation, gate semantics unchanged", () => {
    const body = collapse(TICKET_INTEGRATION_PATH);
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
