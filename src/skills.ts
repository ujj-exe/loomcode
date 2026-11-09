// Skills run only when the user calls one: `/name what to do`. The model never sees a list of them,
// so they cost nothing until used. The skill's SKILL.md (minus frontmatter) goes into that one prompt,
// with its folder so the model can read any files the skill points to.
//
// Read from ~/.claude/skills/<name>/SKILL.md and <project>/.claude/skills/<name>/SKILL.md;
// a project skill replaces a user skill of the same name.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Skill = { name: string; description: string; dir: string; file: string };

// The frontmatter's `name` and `description`: plain, quoted, or folded (`>` / `|`) values.
export function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2]!.trim();
    if (/^[>|][-+]?$/.test(v)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S|^\s*$/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      v = block.filter(Boolean).join(" ");
    } else if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[kv[1]!] = v;
  }
  return out;
}

const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();

async function scan(root: string): Promise<Skill[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skills: Skill[] = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const dir = join(root, e.name);
    const file = join(dir, "SKILL.md");
    const f = Bun.file(file);
    if (!(await f.exists())) continue;
    const meta = frontmatter(await f.text());
    skills.push({ name: (meta.name || e.name).trim(), description: meta.description ?? "", dir, file });
  }
  return skills;
}

export async function loadSkills(cwd: string, home = homedir()): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")]) {
    for (const s of await scan(root)) byName.set(s.name, s);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// `/name args` → the prompt the model gets, or null when no skill has that name.
export async function expandSkill(text: string, skills: Skill[]): Promise<string | null> {
  const m = text.match(/^\/([\w.:-]+)(?:\s+([\s\S]*))?$/);
  const skill = m && skills.find((s) => s.name === m[1]);
  if (!skill) return null;
  const instructions = body(await Bun.file(skill.file).text());
  const ask = m![2]?.trim() || "Run this skill.";
  return `The user invoked the "${skill.name}" skill. Follow its instructions for this request. Files it mentions are relative to ${skill.dir}.\n\n<skill name="${skill.name}">\n${instructions}\n</skill>\n\n${ask}`;
}
