import { c, clip, width, wrap } from "./ansi.ts";
import { highlight } from "./highlight.ts";

// Inline markdown: code spans, bold, italic, strike, links. Code spans are protected first.
export function inline(s: string): string {
  const spans: string[] = [];
  s = s.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (_, _t, code: string) => {
    spans.push(c.code(code.trim() === code ? code : code.trim()));
    return `\u0000${spans.length - 1}\u0000`;
  });
  s = s
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_, text, url) => `\x1b]8;;${url}\x07${c.link(c.under(text))}\x1b]8;;\x07`)
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, (_, _m, t) => c.bold(t))
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?!\w)/g, (_, pre, t) => pre + c.italic(t))
    .replace(/(^|\W)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, (_, pre, t) => pre + c.italic(t))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, (_, t) => c.strike(t));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)]!);
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|.*\|\s*$/;

// Renders one finished block (no fences) into wrapped, styled lines.
function block(lines: string[], cols: number): string[] {
  const first = lines[0]!;
  let m: RegExpExecArray | null;
  if ((m = HEADING.exec(first)) && lines.length === 1) {
    const text = inline(m[2]!);
    const styled = m[1]!.length === 1 ? c.bold(c.accent(text)) : m[1]!.length === 2 ? c.bold(text) : c.bold(c.muted(text));
    return wrap(styled, cols);
  }
  if (HR.test(first) && lines.length === 1) return [c.muted("─".repeat(Math.min(cols, 60)))];
  if (lines.every((l) => TABLE.test(l))) return table(lines, cols);
  if ((m = LIST.exec(first))) {
    const depth = Math.floor(m[1]!.replace(/\t/g, "  ").length / 2);
    const marker = /\d/.test(m[2]!) ? `${m[2]} ` : "• ";
    const pad = "  ".repeat(depth);
    const body = [m[3]!, ...lines.slice(1).map((l) => l.trim())].join(" ");
    let task = body;
    task = task.replace(/^\[ \]\s/, "☐ ").replace(/^\[[xX]\]\s/, "☑ ");
    return wrap(pad + c.accent(marker) + inline(task), cols, pad + " ".repeat(width(marker)));
  }
  if (first.trimStart().startsWith(">")) {
    const body = lines.map((l) => l.replace(/^\s*>\s?/, "")).join(" ");
    return wrap(c.muted("│ ") + c.italic(inline(body)), cols, c.muted("│ "));
  }
  // Paragraph: soft line breaks join; a trailing double space or backslash keeps the break.
  const out: string[] = [];
  let para = "";
  for (const l of lines) {
    const hard = /( {2,}|\\)$/.test(l);
    para += (para ? " " : "") + l.trim().replace(/\\$/, "");
    if (hard) {
      out.push(...wrap(inline(para), cols));
      para = "";
    }
  }
  if (para) out.push(...wrap(inline(para), cols));
  return out;
}

function table(lines: string[], cols: number): string[] {
  const rows = lines
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim()))
    .filter((r) => !r.every((x) => /^:?-{2,}:?$/.test(x)));
  const n = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r) => Array.from({ length: n }, (_, j) => inline(r[j] ?? "")));
  const natural = Array.from({ length: n }, (_, j) => Math.max(...cells.map((r) => width(r[j]!))));
  const widths = fitColumns(natural, cols - (n - 1) * 3);
  if (!widths) return lines.flatMap((l) => wrap(l, cols)); // too many columns to fit: show as written
  const wraps = widths.some((w, j) => w < natural[j]!);
  const sep = c.muted(" │ ");
  const rule = c.muted(widths.map((w) => "─".repeat(w)).join("─┼─"));
  return cells.flatMap((r, i) => {
    // Each cell wraps inside its column; the row is as tall as its tallest cell.
    const parts = r.map((cell, j) => wrap(cell, widths[j]!));
    const h = Math.max(...parts.map((p) => p.length));
    const out = Array.from({ length: h }, (_, k) => parts.map((p, j) => (p[k] ?? "") + " ".repeat(Math.max(0, widths[j]! - width(p[k] ?? "")))).join(sep));
    if (i === 0) return [...out.map(c.bold), rule];
    return wraps && i < cells.length - 1 ? [...out, rule] : out; // rules keep wrapped rows apart
  });
}

// Column widths that fit `avail`: narrow columns keep their width, wide ones share what is left evenly.
// Null when a column would get too narrow to read.
const MIN_COL = 6;
export function fitColumns(natural: number[], avail: number): number[] | null {
  if (natural.reduce((a, b) => a + b, 0) <= avail) return natural;
  const w = [...natural];
  let left = avail;
  let rest = natural.length;
  for (const j of natural.map((_, j) => j).sort((a, b) => natural[a]! - natural[b]!)) {
    w[j] = Math.min(natural[j]!, Math.floor(left / rest--));
    left -= w[j]!;
  }
  return w.some((x, j) => x < Math.min(MIN_COL, natural[j]!)) ? null : w;
}

// Streams markdown: finished blocks come out of take() once (for scrollback); the unfinished tail is
// re-rendered by live() on every frame. Code lines are emitted one by one as soon as they are complete.
export class StreamMarkdown {
  private partial = ""; // text after the last newline
  private block: string[] = []; // raw lines of the block being built
  private fence: { mark: string; lang: string; code: string[]; block: number } | null = null;
  readonly lines: string[] = []; // every finished line so far
  private taken = 0;
  readonly codeHeaders = new Map<number, number>(); // line index of a code block's header → index in codeBlocks
  private blankPending = false; // a blank line goes out before the next block, never at the end
  readonly raw: string[] = []; // full text, for /copy
  readonly codeBlocks: { lang: string; code: string }[] = [];

  constructor(public cols: number) {}

  push(delta: string) {
    this.raw.push(delta);
    const text = this.partial + delta;
    const parts = text.split("\n");
    this.partial = parts.pop()!;
    for (const line of parts) this.line(line);
  }

  // Finishes the stream: everything left goes out.
  end() {
    if (this.partial) this.line(this.partial);
    this.partial = "";
    if (this.fence) this.closeFence();
    this.flushBlock();
  }

  // Lines finished since the last take().
  take(): string[] {
    const o = this.lines.slice(this.taken);
    this.taken = this.lines.length;
    return o;
  }

  text = () => this.raw.join("");

  live(): string[] {
    if (this.fence) {
      // The code line being typed, clipped so it fits one row.
      return this.partial ? [clip(highlight(this.partial, this.fence.lang)[0] ?? "", this.cols)] : [];
    }
    const lines = this.partial ? [...this.block, this.partial] : this.block;
    if (!lines.length) return [];
    if (FENCE.test(this.partial)) return [];
    return block(lines, this.cols);
  }

  private emit(lines: string[]) {
    if (!lines.length) return;
    if (this.blankPending) this.lines.push("");
    this.blankPending = false;
    this.lines.push(...lines);
  }

  private line(l: string) {
    if (this.fence) {
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(l);
      if (m && m[1]![0] === this.fence.mark[0] && m[1]!.length >= this.fence.mark.length) return this.closeFence();
      this.fence.code.push(l);
      this.codeBlocks[this.fence.block]!.code = this.fence.code.join("\n");
      // Re-highlight the whole block so multi-line strings and comments stay right; emit only the new line.
      const lines = highlight(this.fence.code.join("\n"), this.fence.lang);
      this.lines.push(lines[lines.length - 1] ?? "");
      return;
    }
    const f = FENCE.exec(l);
    if (f) {
      this.flushBlock();
      const label = f[3] || "code";
      this.fence = { mark: f[2]!, lang: f[3] ?? "", code: [], block: this.codeBlocks.length };
      this.codeBlocks.push({ lang: f[3] ?? "", code: "" });
      const rule = Math.max(0, Math.min(this.cols, 72) - 12 - width(label));
      this.emit([c.muted(`─── ${label} ${"─".repeat(rule)} `) + c.dim("⧉ copy")]);
      this.codeHeaders.set(this.lines.length - 1, this.fence.block);
      return;
    }
    if (!l.trim()) {
      this.flushBlock();
      return;
    }
    // Headings and rules stand alone; a new list item or a change into/out of a table ends the block.
    if (HEADING.test(l) || HR.test(l)) {
      this.flushBlock();
      this.emit(block([l], this.cols));
      this.blankPending = true;
      return;
    }
    const isTable = TABLE.test(l);
    const inTable = this.block.length > 0 && TABLE.test(this.block[0]!);
    if ((LIST.test(l) && this.block.length) || (this.block.length && isTable !== inTable)) this.flushBlock(LIST.test(l) && LIST.test(this.block[0] ?? ""));
    this.block.push(l);
  }

  private flushBlock(tight = false) {
    if (!this.block.length) return;
    this.emit(block(this.block, this.cols));
    this.block = [];
    this.blankPending = !tight;
  }

  private closeFence() {
    this.fence = null;
    this.blankPending = true;
  }
}
