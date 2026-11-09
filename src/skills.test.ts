import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandSkill, frontmatter, loadSkills } from "./skills.ts";

async function skill(root: string, dir: string, text: string) {
  await mkdir(join(root, ".claude", "skills", dir), { recursive: true });
  await Bun.write(join(root, ".claude", "skills", dir, "SKILL.md"), text);
}

test("frontmatter reads plain, quoted and folded values", () => {
  expect(frontmatter(`---\nname: a\ndescription: "Quoted: yes"\n---\nbody`)).toEqual({ name: "a", description: "Quoted: yes" });
  expect(frontmatter(`---\nname: b\ndescription: >\n  first line\n  second line\nother: x\n---`)).toEqual({ name: "b", description: "first line second line", other: "x" });
  expect(frontmatter("no frontmatter")).toEqual({});
});

test("project skills replace user skills of the same name", async () => {
  const home = await mkdtemp(join(tmpdir(), "loom-home-"));
  const proj = await mkdtemp(join(tmpdir(), "loom-proj-"));
  await skill(home, "deploy", "---\nname: deploy\ndescription: user one\n---\nuser");
  await skill(home, "lint", "---\ndescription: no name, folder names it\n---\nlint");
  await skill(proj, "deploy", "---\nname: deploy\ndescription: project one\n---\nproject");
  await mkdir(join(proj, ".claude", "skills", "empty"), { recursive: true }); // no SKILL.md: skipped
  const skills = await loadSkills(proj, home);
  expect(skills.map((s) => [s.name, s.description])).toEqual([
    ["deploy", "project one"],
    ["lint", "no name, folder names it"],
  ]);
});

test("expandSkill inlines the instructions only for a known /name", async () => {
  const proj = await mkdtemp(join(tmpdir(), "loom-proj-"));
  await skill(proj, "greet", "---\nname: greet\ndescription: say hi\n---\nSay hi in French.\n");
  const skills = await loadSkills(proj, proj + "/nohome");
  const out = (await expandSkill("/greet to Ana", skills))!;
  expect(out).toContain('<skill name="greet">\nSay hi in French.\n</skill>');
  expect(out.endsWith("to Ana")).toBe(true);
  expect(out).not.toContain("description: say hi");
  expect(await expandSkill("/greet", skills)).toEndWith("Run this skill.");
  expect(await expandSkill("/nope do it", skills)).toBeNull();
  expect(await expandSkill("hello /greet", skills)).toBeNull();
});
