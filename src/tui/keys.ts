// Turns raw stdin bytes into key and paste events. Understands legacy escapes, xterm modifiers,
// the kitty keyboard protocol (CSI u) and bracketed paste.

export type Key = { type: "key"; name: string; ctrl: boolean; alt: boolean; shift: boolean; text?: string };
export type Paste = { type: "paste"; text: string };
// SGR mouse report. x/y are 0-based cells. `wheel` is set for scroll events.
export type Mouse = { type: "mouse"; x: number; y: number; button: number; drag: boolean; release: boolean; wheel: "up" | "down" | null };
export type InputEvent = Key | Paste | Mouse;

const key = (name: string, mods: Partial<Key> = {}): Key => ({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });

const NAMED: Record<string, string> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", P: "f1", Q: "f2", R: "f3", S: "f4", Z: "tab",
};
const TILDE: Record<string, string> = { "1": "home", "2": "insert", "3": "delete", "4": "end", "5": "pageup", "6": "pagedown", "7": "home", "8": "end" };
const CODEPOINT: Record<number, string> = { 9: "tab", 13: "enter", 27: "escape", 127: "backspace", 8: "backspace" };

// xterm/kitty modifier parameter: 1 + bitmask (shift 1, alt 2, ctrl 4).
const mods = (n: number) => {
  const m = Math.max(0, n - 1);
  return { shift: !!(m & 1), alt: !!(m & 2), ctrl: !!(m & 4) };
};

export class KeyParser {
  private buf = "";
  private paste: string | null = null;
  private escTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private emit: (e: InputEvent) => void) {}

  feed(chunk: string) {
    clearTimeout(this.escTimer);
    this.buf += chunk;
    this.drain();
    // A lone ESC is ambiguous with the start of a sequence; resolve it after a short pause.
    if (this.buf === "\x1b") this.escTimer = setTimeout(() => this.flushEsc(), 30);
  }

  private flushEsc() {
    if (this.buf === "\x1b") {
      this.buf = "";
      this.emit(key("escape"));
    }
  }

  private drain() {
    while (this.buf.length) {
      if (this.paste !== null) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end < 0) {
          // Hold back a tail that could be the start of the end marker split across reads.
          let keep = 0;
          for (let k = Math.min(5, this.buf.length); k > 0; k--) {
            if ("\x1b[201~".startsWith(this.buf.slice(-k))) {
              keep = k;
              break;
            }
          }
          this.paste += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 6);
        this.emit({ type: "paste", text: this.paste.replace(/\r\n?/g, "\n") });
        this.paste = null;
        continue;
      }
      if (this.buf.startsWith("\x1b[200~")) {
        this.paste = "";
        this.buf = this.buf.slice(6);
        continue;
      }
      const n = this.parseOne();
      if (n === 0) return; // incomplete sequence: wait for more bytes
      this.buf = this.buf.slice(n);
    }
  }

  // Parses one event at the start of the buffer; returns bytes consumed (0 = need more input).
  private parseOne(): number {
    const b = this.buf;
    const ch = b[0]!;
    if (ch === "\x1b") {
      if (b.length === 1) return 0;
      if (b.startsWith("\x1b[<")) {
        const mm = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(b);
        if (!mm) return /^\x1b\[<[\d;]*$/.test(b) ? 0 : (this.emit(key("escape")), 1);
        const code = Number(mm[1]);
        const wheel = code & 64 ? (code & 1 ? "down" : "up") : null;
        this.emit({ type: "mouse", x: Number(mm[2]) - 1, y: Number(mm[3]) - 1, button: code & 3, drag: !!(code & 32), release: mm[4] === "m", wheel });
        return mm[0].length;
      }
      if (b[1] === "[" || b[1] === "O") {
        const m = /^\x1b[\[O]([0-9;:?]*)([A-Za-z~u])/.exec(b);
        if (!m) return /^\x1b[\[O][0-9;:?]*$/.test(b) ? 0 : (this.emit(key("escape")), 1);
        const [all, params = "", final] = m;
        const parts = params.split(";");
        const mod = mods(Number(parts[1]?.split(":")[0] ?? 1) || 1);
        if (final === "u") {
          const cp = Number(parts[0]!.split(":")[0]);
          const name = CODEPOINT[cp];
          if (name) this.emit(key(name, mod));
          else if (mod.ctrl || mod.alt) this.emit(key(String.fromCodePoint(cp).toLowerCase(), mod));
          else this.emit(key("char", { ...mod, text: String.fromCodePoint(cp) }));
        } else if (final === "~") {
          if (parts[0] === "27") {
            // xterm modifyOtherKeys: CSI 27;mod;code~
            const cp = Number(parts[2]);
            const m2 = mods(Number(parts[1]) || 1);
            this.emit(key(CODEPOINT[cp] ?? String.fromCodePoint(cp).toLowerCase(), m2));
          } else this.emit(key(TILDE[parts[0]!] ?? "unknown", mod));
        } else {
          this.emit(key(NAMED[final!] ?? "unknown", final === "Z" ? { ...mod, shift: true } : mod));
        }
        return all.length;
      }
      // ESC + key = alt + key
      const rest = b[1]!;
      if (rest === "\r") this.emit(key("enter", { alt: true }));
      else if (rest === "\x7f") this.emit(key("backspace", { alt: true }));
      else if (rest === "b" || rest === "f") this.emit(key(rest === "b" ? "left" : "right", { alt: true })); // macOS option+arrows
      else this.emit(key(rest.toLowerCase(), { alt: true }));
      return 2;
    }
    const code = ch.charCodeAt(0);
    if (code === 13) return this.emit(key("enter")), 1;
    if (code === 10) return this.emit(key("enter", { ctrl: true })), 1; // ctrl+j / newline
    if (code === 9) return this.emit(key("tab")), 1;
    if (code === 127 || code === 8) return this.emit(key("backspace")), 1;
    if (code < 32) return this.emit(key(String.fromCharCode(code + 96), { ctrl: true })), 1;
    // A run of printable text (typed fast or pasted without bracketing) becomes one event.
    let end = 1;
    while (end < b.length && b.charCodeAt(end) >= 32 && b[end] !== "\x7f" && b[end] !== "\x1b") end++;
    const text = b.slice(0, end);
    this.emit(key("char", { text }));
    return end;
  }
}
