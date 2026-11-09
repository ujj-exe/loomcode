import { c, width } from "./ansi.ts";
import type { Attachment } from "./images.ts";
import type { Key } from "./keys.ts";

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (s: string) => Array.from(seg.segment(s), (g) => g.segment);
const isWord = (ch: string) => /[\p{L}\p{N}_]/u.test(ch);

// Multi-line prompt editor. Big pastes collapse to a marker that expands on submit; images are chips.
export class Editor {
  text = "";
  pos = 0; // cursor, as an index into `text`
  images: Attachment[] = [];
  private pastes = new Map<string, string>();
  private history: string[] = [];
  private hIndex = -1;
  private draft = "";

  insert(s: string) {
    this.text = this.text.slice(0, this.pos) + s + this.text.slice(this.pos);
    this.pos += s.length;
    this.hIndex = -1;
  }

  // Pastes longer than a few lines stay out of the way as `[paste #1 · 120 lines]`.
  paste(s: string) {
    const lines = s.split("\n").length;
    if (lines <= 4 && s.length <= 600) return this.insert(s);
    const marker = `[paste #${this.pastes.size + 1} · ${lines} lines]`;
    this.pastes.set(marker, s);
    this.insert(marker);
  }

  attach(img: Attachment) {
    this.images.push(img);
    this.insert(`[image ${this.images.length}]`);
  }

  // The prompt to send: paste markers expanded, plus the images whose markers are still in the text.
  submit(): { text: string; images: Attachment[] } {
    let text = this.text;
    for (const [marker, content] of this.pastes) text = text.split(marker).join(content);
    const images = this.images.filter((_, i) => this.text.includes(`[image ${i + 1}]`));
    if (this.text.trim()) this.history.unshift(this.text);
    this.clear();
    return { text, images };
  }

  clear() {
    this.text = "";
    this.pos = 0;
    this.images = [];
    this.pastes.clear();
    this.hIndex = -1;
  }

  private lineStart = () => this.text.lastIndexOf("\n", this.pos - 1) + 1;
  private lineEnd = () => {
    const i = this.text.indexOf("\n", this.pos);
    return i < 0 ? this.text.length : i;
  };
  private prevGrapheme = () => (this.pos ? graphemes(this.text.slice(0, this.pos)).at(-1)!.length : 0);
  private nextGrapheme = () => (this.pos < this.text.length ? graphemes(this.text.slice(this.pos, this.pos + 8))[0]!.length : 0);
  private wordLeft() {
    let i = this.pos;
    while (i > 0 && !isWord(this.text[i - 1]!)) i--;
    while (i > 0 && isWord(this.text[i - 1]!)) i--;
    return i;
  }
  private wordRight() {
    let i = this.pos;
    while (i < this.text.length && !isWord(this.text[i]!)) i++;
    while (i < this.text.length && isWord(this.text[i]!)) i++;
    return i;
  }
  private cut(from: number, to: number) {
    // A paste or image marker goes in one piece.
    for (const marker of [...this.pastes.keys(), ...this.images.map((_, i) => `[image ${i + 1}]`)]) {
      const at = this.text.indexOf(marker);
      if (at >= 0 && from < at + marker.length && to > at) {
        from = Math.min(from, at);
        to = Math.max(to, at + marker.length);
      }
    }
    this.text = this.text.slice(0, from) + this.text.slice(to);
    this.pos = from;
  }

  // Handles an editing key; returns false for keys the editor does not own.
  key(k: Key): boolean {
    const { name, ctrl, alt } = k;
    if (name === "char" && k.text && !ctrl) return this.insert(k.text), true;
    if (name === "enter" && (k.shift || alt || ctrl)) return this.insert("\n"), true;
    if (name === "backspace") return this.cut(alt || ctrl ? this.wordLeft() : this.pos - this.prevGrapheme(), this.pos), true;
    if (name === "delete" || (ctrl && name === "d" && this.text)) return this.cut(this.pos, alt ? this.wordRight() : this.pos + this.nextGrapheme()), true;
    if (ctrl && name === "w") return this.cut(this.wordLeft(), this.pos), true;
    if (ctrl && name === "u") return this.cut(this.lineStart(), this.pos), true;
    if (ctrl && name === "k") return this.cut(this.pos, this.lineEnd()), true;
    if (name === "left") return (this.pos = alt || ctrl ? this.wordLeft() : this.pos - this.prevGrapheme()), true;
    if (name === "right") return (this.pos = alt || ctrl ? this.wordRight() : this.pos + this.nextGrapheme()), true;
    if (name === "home" || (ctrl && name === "a")) return (this.pos = this.lineStart()), true;
    if (name === "end" || (ctrl && name === "e")) return (this.pos = this.lineEnd()), true;
    if (name === "up" || name === "down") return this.vertical(name === "up" ? -1 : 1);
    return false;
  }

  // Moves between lines; past the first/last line it walks the prompt history.
  private vertical(dir: -1 | 1): boolean {
    const start = this.lineStart();
    const col = this.pos - start;
    if (dir < 0 && start > 0) {
      const prevStart = this.text.lastIndexOf("\n", start - 2) + 1;
      this.pos = Math.min(prevStart + col, start - 1);
      return true;
    }
    if (dir > 0 && this.lineEnd() < this.text.length) {
      const nextStart = this.lineEnd() + 1;
      const nextEnd = this.text.indexOf("\n", nextStart);
      this.pos = Math.min(nextStart + col, nextEnd < 0 ? this.text.length : nextEnd);
      return true;
    }
    const target = this.hIndex + (dir < 0 ? 1 : -1);
    if (target < -1 || target >= this.history.length) return true;
    if (this.hIndex === -1) this.draft = this.text;
    this.hIndex = target;
    this.text = target === -1 ? this.draft : this.history[target]!;
    this.pos = this.text.length;
    return true;
  }

  // Lays the text out in `cols` columns (hard wrap, so the caret maps exactly). Returns lines and caret.
  render(cols: number, placeholder: string): { lines: string[]; cursor: { row: number; col: number } } {
    const prefix = c.accent("› ");
    const avail = Math.max(4, cols - 2);
    if (!this.text) return { lines: [prefix + c.dim(placeholder)], cursor: { row: 0, col: 2 } };
    const lines: string[] = [];
    let row = 0;
    let cursor = { row: 0, col: 2 };
    let i = 0;
    let line = "";
    let lineW = 0;
    const newline = () => {
      lines.push((row === 0 ? prefix : "  ") + line);
      row++;
      line = "";
      lineW = 0;
    };
    for (const g of graphemes(this.text)) {
      if (i === this.pos) cursor = { row, col: 2 + lineW };
      if (g === "\n") {
        newline();
        i += g.length;
        continue;
      }
      const w = width(g);
      if (lineW + w > avail) newline();
      if (i === this.pos) cursor = { row, col: 2 + lineW };
      line += g;
      lineW += w;
      i += g.length;
    }
    if (this.pos >= this.text.length) {
      if (lineW >= avail) newline();
      cursor = { row, col: 2 + lineW };
    }
    newline();
    // Paste and image markers stand out from typed text.
    const marked = lines.map((l) => l.replace(/\[(paste #\d+ · \d+ lines|image \d+)\]/g, (m) => c.accent(m)));
    return { lines: marked, cursor };
  }
}
