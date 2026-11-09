import { bg, c, clip, fit, width, wrap } from "./ansi.ts";
import { StreamMarkdown } from "./markdown.ts";

// What a click on a rendered line does: copy some text, or toggle something open/closed.
export type LineAction = { copy?: () => string; toggle?: () => void };
export type Rendered = { lines: string[]; actions: Map<number, LineAction> };

export type Tool = {
  id: string;
  name: string;
  json: string;
  summary: string;
  started: number;
  status: "running" | "ok" | "err" | "stopped";
  ms?: number;
  detail?: string; // first line of an error, or an edit's +/- counts
  diff?: string[]; // an edit's changed lines, already styled
  open?: boolean; // diff expanded
};

export type Entry =
  | { kind: "user"; text: string; images: { name: string; w: number; h: number }[] }
  | { kind: "md"; md: StreamMarkdown; raw: string }
  | { kind: "thinking"; text: string; started: number; ms?: number; open: boolean }
  | { kind: "tool"; tool: Tool }
  | { kind: "note"; text: string };

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const spinner = (since = 0) => SPIN[Math.floor((performance.now() - since) / 80) % SPIN.length]!;
export const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
const USER_BG = bg(0x2b303b);
const USER_BG_ON = "\x1b[48;2;43;48;59m";
// A full-width tinted row. Resets inside the text would drop the tint, so it is re-applied after each one.
const band = (s: string, w: number) => {
  const text = width(s) > w ? clip(s, w) : s;
  return USER_BG(text.replace(/\x1b\[0?m/g, (m) => m + USER_BG_ON) + " ".repeat(Math.max(0, w - width(text))));
};
const DIFF_OPEN_MAX = 14; // diffs up to this many lines start expanded
const PAD = "  ";

// Content fills the pane, minus its padding.
export const measure = (w: number) => Math.max(20, w - 4);

function renderEntry(e: Entry, w: number): Rendered {
  const actions = new Map<number, LineAction>();
  const inner = measure(w);
  switch (e.kind) {
    case "user": {
      // A card: tinted band with an accent bar and a row of padding above and below.
      const body = e.text.length > 4000 ? `${e.text.slice(0, 4000)}…` : e.text;
      const lines = body.split("\n").flatMap((l) => wrap(c.user(l) || " ", inner - 2));
      const bar = c.accent("▌");
      const row = (s: string) => ` ${band(`${bar} ${s}`, w - 2)}`;
      const out = [row(""), ...lines.map((l) => row(l))];
      for (const img of e.images) out.push(row(c.dim(`▣ ${img.name}  ${img.w}×${img.h}`)));
      out.push(row(""));
      return { lines: out, actions };
    }
    case "md": {
      const lines = [...e.md.lines, ...e.md.live()];
      for (const [i, block] of e.md.codeHeaders) actions.set(i, { copy: () => e.md.codeBlocks[block]?.code ?? "" });
      return { lines: lines.map((l) => PAD + l), actions };
    }
    case "thinking": {
      const done = e.ms !== undefined;
      const text = e.text.replace(/\s+\n/g, "\n").trim();
      const body = text ? wrap(c.italic(text.replace(/\s+/g, " ")), inner - 2).map((l) => c.dim(`  ${l}`)) : [];
      // While thinking, the status line above the prompt carries the spinner and timer; here only the text streams.
      if (!done) return { lines: body.slice(-3).map((l) => PAD + l), actions };
      if (!text && e.ms! < 100) return { lines: [], actions }; // an empty block ("Thought for 0.0s") says nothing
      const lines = [c.dim(`✻ Thought for ${secs(e.ms!)}`) + c.dim(e.open ? "  ▾" : "  ▸"), ...(e.open ? body : [])];
      if (done && text) actions.set(0, { toggle: () => (e.open = !e.open) });
      return { lines: lines.map((l) => PAD + l), actions };
    }
    case "tool": {
      const t = e.tool;
      const mark =
        t.status === "running" ? c.accent(spinner(t.started)) : t.status === "ok" ? c.ok("✓") : t.status === "err" ? c.err("✗") : c.warn("■");
      const name = c.bold(t.name.padEnd(6));
      const time = c.dim(t.status === "running" ? secs(performance.now() - t.started) : t.status === "stopped" ? "stopped" : secs(t.ms ?? 0));
      const detail = t.detail && t.status !== "err" ? `  ${t.detail}` : "";
      const left = `${mark} ${name} ${c.muted(t.summary)}${detail}`;
      const room = inner - width(time) - 2;
      const line = width(left) > room ? clip(left, room) : left + " ".repeat(room - width(left));
      const lines = [`${line}  ${time}`];
      if (t.status === "err" && t.detail) lines.push(c.err(clip(`  ${t.detail}`, inner)));
      if (t.diff?.length) {
        const open = t.open ?? t.diff.length <= DIFF_OPEN_MAX;
        actions.set(0, { toggle: () => (t.open = !open) });
        if (open) lines.push(...t.diff.map((d) => clip(`  ${d}`, inner)), "");
        else lines.push(c.dim(`  ▸ ${t.diff.length}-line diff · click to show`));
      }
      return { lines: lines.map((l) => PAD + l), actions };
    }
    case "note":
      return { lines: wrap(c.dim(e.text), inner).map((l) => PAD + l), actions };
  }
}

// Blank lines between entries: tool calls stack tightly, everything else breathes, and a new prompt
// gets extra room so turns read as separate.
function gap(prev: Entry | undefined, e: Entry): number {
  if (!prev) return 1;
  if (e.kind === "user") return 2;
  if (e.kind === "tool" && prev.kind === "tool" && !prev.tool.diff?.length) return 0;
  return 1;
}

const REPLY_LABEL = PAD + c.bold(c.accent("◆ loom"));

export class Transcript {
  entries: Entry[] = [];
  private cache = new WeakMap<Entry, { w: number; r: Rendered }>();

  add(e: Entry) {
    this.entries.push(e);
    return e;
  }

  // Entries that may change on the next frame (streaming or running) are never cached.
  private live(e: Entry) {
    return e.kind === "md" || e.kind === "thinking" || (e.kind === "tool" && (e.tool.status === "running" || !!e.tool.diff));
  }

  // Lays out all entries for pane width `w`. Returns every line plus click actions keyed by line index.
  layout(w: number): Rendered {
    const lines: string[] = [];
    const actions = new Map<number, LineAction>();
    let prev: Entry | undefined;
    for (const e of this.entries) {
      let r: Rendered;
      const hit = this.cache.get(e);
      if (hit && hit.w === w && !this.live(e)) r = hit.r;
      else {
        r = renderEntry(e, w);
        // Only a settled render may be reused; one taken mid-stream or mid-run would go stale.
        if (!this.live(e)) this.cache.set(e, { w, r });
      }
      if (!r.lines.length) continue; // e.g. thinking that has no text yet: no gap, no label
      for (let g = gap(prev, e); g > 0; g--) lines.push("");
      // Every answer opens with a label, so it never reads as part of the prompt above it.
      if (prev?.kind === "user" && e.kind !== "user") lines.push(REPLY_LABEL, "");
      for (const [i, a] of r.actions) actions.set(lines.length + i, a);
      lines.push(...r.lines);
      prev = e;
    }
    return { lines, actions };
  }

  // On resize, markdown is re-flowed from its raw text.
  reflow(cols: number) {
    for (const e of this.entries) {
      if (e.kind !== "md") continue;
      const md = new StreamMarkdown(cols);
      md.push(e.raw);
      if (!this.streaming.has(e)) md.end();
      e.md = md;
    }
  }
  streaming = new Set<Entry>();
}
