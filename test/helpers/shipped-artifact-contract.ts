import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { loadSkillBody, loadSkills, substituteArguments } from "../../src/claude/skills.js";
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
    settings: path.resolve(process.env["PICC_SETTINGS_PATH"] ?? path.join(root, ".claude", "settings.json")),
  };
}

const normalized = (file: string): string => {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const inside = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const canonical = (file: string, label: string): string => {
  const lexical = path.resolve(file);
  const real = fs.realpathSync(file);
  expect(normalized(real), `${label} must not be a symlink`).toBe(normalized(lexical));
  return real;
};

export interface ResolvedMarkdownLink {
  target: string;
  lexicalPath: string;
  realPath: string;
}

export function resolveMarkdownLinks(source: string): ResolvedMarkdownLink[] {
  const body = fs.readFileSync(source, "utf8");
  return [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].flatMap((match) => {
    const raw = match[1]?.trim() ?? "";
    if (raw === "" || raw.startsWith("#") || /^[a-z]+:/i.test(raw)) return [];
    const target = raw.replace(/^<|>$/g, "").split("#", 1)[0] ?? "";
    const lexicalPath = path.resolve(path.dirname(source), target);
    return [{ target, lexicalPath, realPath: fs.realpathSync(lexicalPath) }];
  });
}

export interface ShippedSkillContractOptions {
  approvedExternalFiles?: readonly string[];
  representativeArguments?: string;
}

/** Exercises production loading plus lexical and real-path closure of a shipped prompt graph. */
export function expectShippedSkillContract(
  paths: ShippedArtifactPaths,
  name: string,
  options: ShippedSkillContractOptions = {},
): string {
  const repoRoot = canonical(paths.root, "repository root");
  const shippedRoots = [paths.evaluate, paths.implementFeature, paths.agents].map((root) => {
    const real = canonical(root, `shipped root ${root}`);
    expect(inside(real, repoRoot)).toBe(true);
    return real;
  });
  const approved = (options.approvedExternalFiles ?? []).map((file) => canonical(file, file));
  const skillRoot = canonical(path.join(paths.skills, name), `skill root ${name}`);
  expect(shippedRoots.map(normalized)).toContain(normalized(skillRoot));

  const loaded = loadSkills([{ dir: paths.skills, scope: "project" }], []);
  const skill = loaded.skills.find((candidate) => candidate.name === name);
  expect(skill, `skill ${name} must load`).toBeDefined();
  expect(skill!.diagnostics).toEqual([]);
  expect({ name: skill!.name, userInvocable: skill!.userInvocable, modelInvocable: !skill!.disableModelInvocation })
    .toEqual({ name, userInvocable: true, modelInvocable: true });
  expect(skill!.description.trim()).not.toBe("");
  expect(skill!.argumentHint?.trim()).not.toBe("");

  const skillFile = path.join(skillRoot, "SKILL.md");
  const canonicalSkill = canonical(skillFile, `${name}/SKILL.md`);
  expect(normalized(skill!.source.path)).toBe(normalized(canonicalSkill));
  const body = loadSkillBody(skill!);
  expect(body.length).toBeGreaterThan(0);
  expect(body.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
  if (options.representativeArguments !== undefined) {
    const rendered = substituteArguments(body, options.representativeArguments, skill!.arguments).text;
    expect(rendered).toContain(options.representativeArguments);
    expect(rendered.length).toBeLessThanOrEqual(REINJECT_PER_SKILL_MAX_CHARS);
  }
  expect(walkFiles(skillRoot, (entry) => entry.toLowerCase() === "skill.md").map(normalized))
    .toEqual([normalized(canonicalSkill)]);

  const linked = new Set<string>(body.match(/references\/[A-Za-z0-9_-]+\.md/gi) ?? []);
  const markdown = walkFiles(skillRoot, (entry) => entry.toLowerCase().endsWith(".md"));
  for (const source of markdown) {
    const sourceReal = canonical(source, `Markdown source ${source}`);
    expect(inside(sourceReal, skillRoot)).toBe(true);
    for (const link of resolveMarkdownLinks(source)) {
      const lexicalRoot = shippedRoots.find((root) => inside(link.lexicalPath, root));
      const external = approved.find((file) => normalized(file) === normalized(link.lexicalPath));
      expect(lexicalRoot ?? external, `link escapes approved roots: ${link.target}`).toBeDefined();
      if (lexicalRoot) expect(inside(link.realPath, lexicalRoot), `link traverses its root: ${link.target}`).toBe(true);
      else expect(normalized(link.realPath)).toBe(normalized(external!));
      if (inside(link.realPath, skillRoot)) linked.add(path.relative(skillRoot, link.realPath).replace(/\\/g, "/"));
    }
  }
  const references = path.join(skillRoot, "references");
  canonical(references, `${name}/references`);
  const onDisk = walkFiles(references, (entry) => entry.toLowerCase().endsWith(".md"))
    .map((file) => path.relative(skillRoot, canonical(file, file)).replace(/\\/g, "/")).sort();
  expect([...linked].sort()).toEqual(onDisk);
  return body;
}
