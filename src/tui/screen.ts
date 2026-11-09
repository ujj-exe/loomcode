// Fullscreen renderer on the alternate screen. The app hands over a whole frame (one string per row);
// only rows that differ from the previous frame are rewritten, inside one synchronized update, so a
// streamed token costs one or two row writes and nothing flickers.

const ENTER = "\x1b[?1049h\x1b[?2004h\x1b[>1u\x1b[>4;2m\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J";
const LEAVE = "\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?25h\x1b[?1049l";

export class Screen {
  cols = process.stdout.columns || 80;
  rows = process.stdout.rows || 24;
  private prev: string[] = [];
  private out = process.stdout;
  private active = false;

  start(onResize: () => void) {
    this.active = true;
    this.out.write(ENTER);
    this.out.on("resize", () => {
      this.cols = this.out.columns;
      this.rows = this.out.rows;
      this.prev = [];
      this.out.write("\x1b[2J");
      onResize();
    });
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.out.write(LEAVE);
  }

  // Forces the next frame to repaint every row.
  invalidate() {
    this.prev = [];
  }

  render(rows: string[], cursor?: { row: number; col: number }) {
    let s = "\x1b[?2026h\x1b[?25l";
    for (let r = 0; r < this.rows; r++) {
      const line = rows[r] ?? "";
      if (line === this.prev[r]) continue;
      s += `\x1b[${r + 1};1H${line}\x1b[0m\x1b[K`;
    }
    this.prev = rows.slice(0, this.rows);
    if (cursor) s += `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h`;
    this.out.write(s + "\x1b[?2026l");
  }
}
