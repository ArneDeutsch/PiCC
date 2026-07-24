import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { loadSkillBody, loadSkills } from "../../src/claude/skills.js";
import { REINJECT_PER_SKILL_MAX_CHARS } from "../../src/runtime/skill-activation.js";
import { walkFiles } from "../../src/util/fs.js";

export interface ShippedArtifactPaths {
  root: string;
  skills: string;
  evaluate: string;
  implementFeature: string;
  agents: string;
  settings: string;
}

export function shippedArtifactPaths(defaultRoot: string): ShippedArtifactPaths {
  const root = path.resolve(process.env["PICC_ARTIFACT_ROOT"] ?? defaultRoot);
  return {
    root,
    skills: path.join(root, ".claude", "skills"),
    evaluate: path.join(root, ".claude", "skills", "evaluate"),
    implementFeature: path.join(root, ".claude", "skills", "implement-feature"),
    agents: path.join(root, ".claude", "agents"),
    settings: path.resolve(
      process.env["PICC_SETTINGS_PATH"] ?? path.join(root, ".claude", "settings.json"),
    ),
  };
}

function normalized(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expectCanonicalRealpath(file: string, label: string): string {
  const lexical = path.resolve(file);
  const real = fs.realpathSync(file);
  expect(normalized(real), `${label} must not be a symlink`).toBe(normalized(lexical));
  return real;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface ResolvedMarkdownLink {
  label: string;
  target: string;
  lexicalPath: string;
  realPath: string;
}

export function resolveMarkdownLinks(source: string): ResolvedMarkdownLink[] {
  const body = fs.readFileSync(source, "utf8");
  return [...body.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)].flatMap((match) => {
    const label = match[1]?.trim() ?? "";
    const rawTarget = match[2]?.trim() ?? "";
    if (rawTarget === "" || rawTarget.startsWith("#") || /^[a-z]+:/i.test(rawTarget)) return [];
    const target = rawTarget.replace(/^<|>$/g, "").split("#", 1)[0] ?? "";
    const lexicalPath = path.resolve(path.dirname(source), target);
    return [{ label, target, lexicalPath, realPath: fs.realpathSync(lexicalPath) }];
  });
}

/** Assert loader, budget, graph-closure, and canonical containment for one shipped skill. */
export function expectShippedSkillContract(paths: ShippedArtifactPaths, name: string): string {
  const repoRoot = expectCanonicalRealpath(paths.root, "repository root");
  const shippedRoots = [paths.evaluate, paths.implementFeature, paths.agents].map((root) => {
    const real = expectCanonicalRealpath(root, `shipped root ${root}`);
    expect(isInside(real, repoRoot), `${root} must remain in the repository`).toBe(true);
    return real;
  });
  const skillRootPath = path.join(paths.skills, name);
  const skillRoot = expectCanonicalRealpath(skillRootPath, `skill root ${name}`);
  expect(shippedRoots.some((root) => normalized(root) === normalized(skillRoot))).toBe(true);

  const loaded = loadSkills([{ dir: paths.skills, scope: "project" }], []);
  const skill = loaded.skills.find((candidate) => candidate.name === name);
  expect(skill, `skill ${name} must load from the production skills root`).toBeDefined();
  expect(skill!.diagnostics).toEqual([]);
  expect(skill!.name).toBe(name);
  expect(skill!.description.trim()).not.toBe("");
  expect(skill!.argumentHint?.trim()).not.toBe("");
  expect(skill!.userInvocable).toBe(true);
  expect(skill!.disableModelInvocation).toBe(false);

  const skillFile = path.join(skillRootPath, "SKILL.md");
  const canonicalSkillFile = expectCanonicalRealpath(skillFile, `${name}/SKILL.md`);
  expect(normalized(skill!.source.path)).toBe(normalized(canonicalSkillFile));
  const body = loadSkillBody(skill!);
  expect(body.length).toBeGreaterThan(0);
  expect(body.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);

  const skillFiles = walkFiles(skillRootPath, (entry) => entry === "SKILL.md");
  expect(skillFiles.map((file) => normalized(fs.realpathSync(file)))).toEqual([
    normalized(canonicalSkillFile),
  ]);

  const linkedLocalReferences = new Set<string>();
  for (const source of walkFiles(skillRootPath, (entry) => entry.toLowerCase().endsWith(".md"))) {
    const sourceReal = fs.realpathSync(source);
    expect(isInside(sourceReal, skillRoot), `Markdown source escapes skill root: ${source}`).toBe(true);
    expect(normalized(sourceReal), `Markdown source must not be a symlink: ${source}`).toBe(
      normalized(source),
    );
    for (const link of resolveMarkdownLinks(source)) {
      const { target, lexicalPath: lexical, realPath: resolved } = link;
      const lexicalRoot = shippedRoots.find((root) => isInside(lexical, root));
      expect(lexicalRoot, `link lexically escapes allowlisted shipped roots: ${target}`).toBeDefined();
      expect(isInside(resolved, lexicalRoot!), `link resolves outside its shipped root: ${target}`).toBe(
        true,
      );
      if (isInside(resolved, skillRoot) && normalized(sourceReal) === normalized(canonicalSkillFile)) {
        linkedLocalReferences.add(path.relative(skillRoot, resolved).replace(/\\/g, "/"));
      }
    }
  }

  const referencesPath = path.join(skillRootPath, "references");
  const referencesRoot = expectCanonicalRealpath(referencesPath, `${name}/references`);
  expect(isInside(referencesRoot, skillRoot)).toBe(true);
  const onDiskReferences = walkFiles(referencesPath, (entry) => entry.endsWith(".md"))
    .map((file) => {
      const real = fs.realpathSync(file);
      expect(isInside(real, referencesRoot), `reference escapes references root: ${file}`).toBe(true);
      return path.relative(skillRoot, real).replace(/\\/g, "/");
    })
    .sort();
  expect(onDiskReferences.length).toBeGreaterThan(0);
  expect([...linkedLocalReferences].sort()).toEqual(onDiskReferences);
  return body;
}

export function collapsedFile(file: string): string {
  return fs.readFileSync(file, "utf8").toLowerCase().replace(/\s+/g, " ");
}

export function expectMarkers(body: string, markers: readonly string[]): void {
  for (const marker of markers) expect(body).toContain(marker.toLowerCase());
}

/** Test-only executable form of proposal-gate's model-followed double-quoted search discipline. */
export function isSafeAdvisorySearchTerm(term: string): boolean {
  return term.length > 0 && term.length <= 200 && /^[\x20-\x7e]+$/.test(term) && !/[`$"\\;|&]/.test(term);
}

export function isValidRepositoryOperandSyntax(repository: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository);
}
