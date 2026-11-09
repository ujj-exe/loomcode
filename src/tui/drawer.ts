import { isAbsolute, relative } from "node:path";
import { c, clip, fit } from "./ansi.ts";
import { spinner } from "./transcript.ts";

type Change = { adds: number; dels: number; created: boolean };
// A row's click target, plus optional buttons at the right edge (columns relative to the panel's text area).
export type DrawerButton = { col: number; w: number; keep?: string; revert?: string };
export type DrawerAction = { toggle?: string; insert?: string; buttons?: DrawerButton[] };

const MAX_FILES = 20_000;

// Right-hand panel: what this session changed, and the project's files.
export class Drawer {
  open = true;
  scroll = 0;
  changes = new Map<string, Change>();
  active = new Map<string, number>(); // file a running tool is touching → since
  private files: string[] = [];
  private expanded = new Set<string>();
  private truncated = false;
  confirm: { file: string; until: number } | null = null; // ↺ asks once before it reverts

  constructor(private cwd: string) {}

  rel(p: string) {
    const r = isAbsolute(p) ? relative(this.cwd, p) : p.replace(/^\.\//, "");
    return r;
  }

  async refresh() {
    const run = async (args: string[]) => {
      const p = Bun.spawn(args, { cwd: this.cwd, stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      return (await p.exited) === 0 ? out : null;
    };
    const out = (await run(["git", "ls-files", "-co", "--exclude-standard"])) ?? (await run(["rg", "--files"])) ?? "";
    const all = out.split("\n").filter(Boolean).sort();
    this.truncated = all.length > MAX_FILES;
    this.files = all.slice(0, MAX_FILES);
  }

  // Records an edit tool call: created files, and lines added/removed per file.
  noteEdit(path: string, edits: { old_text?: string; new_text?: string }[]) {
    const f = this.rel(path);
    const ch = this.changes.get(f) ?? { adds: 0, dels: 0, created: false };
    const lines = (s?: string) => (s ? s.split("\n").length : 0);
    if (edits.length === 1 && !edits[0]!.old_text && !this.files.includes(f)) ch.created = true;
    for (const e of edits) {
      ch.adds += lines(e.new_text);
      ch.dels += lines(e.old_text);
    }
    this.changes.delete(f);
    this.changes.set(f, ch); // most recent last
    for (let d = f.lastIndexOf("/"); d > 0; d = f.lastIndexOf("/", d - 1)) this.expanded.add(f.slice(0, d));
    if (!this.files.includes(f)) this.files = [...this.files, f].sort();
  }

  toggle(dir: string) {
    if (this.expanded.has(dir)) this.expanded.delete(dir);
    else this.expanded.add(dir);
  }

  // Renders the panel as `h` rows of exactly `w` columns (including the left border).
  render(w: number, h: number): { lines: string[]; actions: Map<number, DrawerAction> } {
    const inner = w - 2;
    const rows: { text: string; action?: DrawerAction }[] = [];
    const counts = (ch: Change) =>
      (ch.adds ? c.ok(`+${ch.adds}`) : "") + (ch.dels ? ` ${c.err(`−${ch.dels}`)}` : "");

    rows.push({ text: c.bold("Changes") + c.dim(this.changes.size ? `  ${this.changes.size}` : "") });
    if (!this.changes.size && !this.active.size) rows.push({ text: c.dim("nothing yet") });
    for (const [f, since] of this.active) {
      if (!this.changes.has(f)) rows.push({ text: `${c.accent(spinner(since))} ${clip(f, inner - 2)}`, action: { insert: f } });
    }
    for (const [f, ch] of [...this.changes].reverse()) {
      const mark = this.active.has(f) ? c.accent(spinner(this.active.get(f))) : ch.created ? c.ok("+") : c.accent("●");
      const asking = this.confirm?.file === f && this.confirm.until > Date.now();
      // ✓ keeps the change (drops it from this list), ↺ puts the file back as it was before loom touched it.
      const btns = asking ? c.warn("revert? ↺") : `${c.ok("✓")} ${c.warn("↺")}`;
      const btnW = Bun.stringWidth(btns);
      const tail = `${counts(ch)}  ${btns}`;
      const name = clip(f, Math.max(4, inner - 2 - Bun.stringWidth(tail) - 1));
      const gapW = Math.max(1, inner - 2 - Bun.stringWidth(name) - Bun.stringWidth(tail));
      const end = inner;
      const buttons: DrawerButton[] = asking
        ? [{ col: end - btnW, w: btnW, revert: f }]
        : [{ col: end - 3, w: 1, keep: f }, { col: end - 1, w: 1, revert: f }];
      rows.push({ text: `${mark} ${name}${" ".repeat(gapW)}${tail}`, action: { insert: f, buttons } });
    }
    rows.push({ text: "" });
    rows.push({ text: c.bold("Files") + c.dim(`  ${this.files.length}${this.truncated ? "+" : ""}`) });

    // Tree: directories first, collapsed unless expanded.
    const changed = new Set(this.changes.keys());
    const walk = (prefix: string, depth: number) => {
      const dirs = new Set<string>();
      const leaves: string[] = [];
      for (const f of this.files) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash >= 0) dirs.add(rest.slice(0, slash));
        else leaves.push(rest);
      }
      const indent = "  ".repeat(depth);
      for (const d of [...dirs].sort()) {
        const path = prefix + d;
        const isOpen = this.expanded.has(path);
        const hot = [...changed].some((f) => f.startsWith(`${path}/`));
        rows.push({ text: `${indent}${c.muted(isOpen ? "▾" : "▸")} ${hot ? c.accent(`${d}/`) : `${d}/`}`, action: { toggle: path } });
        if (isOpen) walk(`${path}/`, depth + 1);
      }
      for (const l of leaves) {
        const path = prefix + l;
        rows.push({ text: `${indent}  ${changed.has(path) ? c.accent(l) : c.muted(l)}`, action: { insert: path } });
      }
    };
    walk("", 0);

    this.scroll = Math.max(0, Math.min(this.scroll, rows.length - h));
    const view = rows.slice(this.scroll, this.scroll + h);
    const lines: string[] = [];
    const actions = new Map<number, DrawerAction>();
    for (let i = 0; i < h; i++) {
      const r = view[i];
      if (r?.action) actions.set(i, r.action);
      lines.push(c.dim("│") + " " + fit(r?.text ?? "", inner));
    }
    return { lines, actions };
  }
}
