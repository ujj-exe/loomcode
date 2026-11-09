// Styling and width helpers. Width comes from Bun.stringWidth, which skips ANSI escapes and knows wide glyphs.

const fg = (hex: number) => (s: string) => `\x1b[38;2;${hex >> 16};${(hex >> 8) & 255};${hex & 255}m${s}\x1b[39m`;

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  under: (s: string) => `\x1b[4m${s}\x1b[24m`,
  strike: (s: string) => `\x1b[9m${s}\x1b[29m`,
  inverse: (s: string) => `\x1b[7m${s}\x1b[27m`,
  accent: fg(0xd4a373), // warm loom thread
  user: fg(0x8ab4f8),
  ok: fg(0x7fc97f),
  err: fg(0xf28b82),
  warn: fg(0xf6c177),
  muted: fg(0x8a8f98),
  code: fg(0xe6c07b),
  link: fg(0x7aa2f7),
};

// Syntax colors per token type from @speed-highlight.
export const tokenColor: Record<string, (s: string) => string> = {
  kwd: fg(0xc678dd),
  type: fg(0xe5c07b),
  class: fg(0xe5c07b),
  func: fg(0x61afef),
  str: fg(0x98c379),
  num: fg(0xd19a66),
  bool: fg(0xd19a66),
  cmnt: (s) => `\x1b[2;3m${s}\x1b[22;23m`,
  oper: fg(0x56b6c2),
  var: fg(0xe06c75),
  esc: fg(0x56b6c2),
  insert: fg(0x98c379),
  deleted: fg(0xe06c75),
  section: fg(0x61afef),
  err: fg(0xf28b82),
};

export const width = (s: string) => Bun.stringWidth(s);

const ESC_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/y;

// Splits styled text into display chunks (an escape sequence, or one grapheme) without breaking escapes.
function* pieces(s: string): Generator<{ text: string; w: number }> {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let i = 0;
  while (i < s.length) {
    ESC_RE.lastIndex = i;
    const m = ESC_RE.exec(s);
    if (m) {
      yield { text: m[0], w: 0 };
      i += m[0].length;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== "\x1b") j++;
    for (const g of seg.segment(s.slice(i, j))) yield { text: g.segment, w: width(g.segment) };
    i = j;
  }
}

// Word-wraps styled text to `cols`, carrying the active SGR style onto continuation lines.
// `indent` is prepended to continuation lines (hanging indent for lists and quotes).
export function wrap(s: string, cols: number, indent = ""): string[] {
  cols = Math.max(cols, 4);
  if (width(s) <= cols) return [s];
  const out: string[] = [];
  const indentW = width(indent);
  let line = "";
  let lineW = 0;
  let word = "";
  let wordW = 0;
  let style = ""; // SGR codes seen so far, replayed at the start of each new line
  const flushLine = () => {
    out.push(line + (style ? "\x1b[0m" : ""));
    line = indent + style;
    lineW = indentW;
  };
  const placeWord = () => {
    if (!word) return;
    if (lineW + wordW > cols && lineW > indentW) {
      flushLine();
      if (word.startsWith(" ")) {
        word = word.trimStart();
        wordW = width(word);
      }
    }
    // A single word longer than the line is hard-split.
    while (lineW + wordW > cols) {
      let head = "";
      let headW = 0;
      for (const p of pieces(word)) {
        if (lineW + headW + p.w > cols) break;
        head += p.text;
        headW += p.w;
      }
      if (!head) break;
      line += head;
      word = word.slice(head.length);
      wordW -= headW;
      flushLine();
    }
    line += word;
    lineW += wordW;
    word = "";
    wordW = 0;
  };
  for (const p of pieces(s)) {
    if (p.w === 0 && p.text.startsWith("\x1b[")) {
      style = p.text.endsWith("m") && /\x1b\[0?m/.test(p.text) ? "" : style + (p.text.endsWith("m") ? p.text : "");
      word += p.text;
      continue;
    }
    if (p.text === " " && word && !word.endsWith(" ")) placeWord();
    word += p.text;
    wordW += p.w;
  }
  placeWord();
  if (line.trim()) out.push(line);
  return out;
}

// Truncates styled text to `cols` display columns, adding an ellipsis when cut.
export function clip(s: string, cols: number): string {
  if (width(s) <= cols) return s;
  let out = "";
  let w = 0;
  for (const p of pieces(s)) {
    if (w + p.w > cols - 1) break;
    out += p.text;
    w += p.w;
  }
  return `${out}…\x1b[0m`;
}

export const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

// Visible columns [from, to) of styled text. Every escape before `to` is kept, so the slice renders in the
// style that was active at `from`.
export function sliceCols(s: string, from: number, to = Infinity): string {
  let out = "";
  let col = 0;
  for (const p of pieces(s)) {
    if (p.w === 0) {
      if (col < to) out += p.text;
      continue;
    }
    if (col >= from && col + p.w <= to) out += p.text;
    col += p.w;
    if (col >= to) break;
  }
  return out;
}

// Exactly `cols` wide: clipped with an ellipsis or padded with spaces. Styles are closed at the end.
export function fit(s: string, cols: number): string {
  const w = width(s);
  if (w > cols) return clip(s, cols);
  return `${s}\x1b[0m${" ".repeat(cols - w)}`;
}

export const bg = (hex: number) => (s: string) => `\x1b[48;2;${hex >> 16};${(hex >> 8) & 255};${hex & 255}m${s}\x1b[49m`;
