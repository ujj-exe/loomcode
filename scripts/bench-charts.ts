// Renders the README's benchmark chart (docs/bench/cost.svg) from docs/bench/runs.csv,
// and prints the totals table the README shows under it.
// Usage: bun scripts/bench-charts.ts

const dir = new URL("../docs/bench/", import.meta.url).pathname;
const [head, ...lines] = (await Bun.file(dir + "runs.csv").text()).trim().split("\n");
const cols = head!.split(",");
type Key = "cost_usd" | "wall_s" | "tokens";
type Run = { task: string; difficulty: string; harness: string; solved: boolean } & Record<Key, number>;
const runs: Run[] = lines.map((l) => {
  const v = l.split(",").map((s) => s.replace(/^"|"$/g, ""));
  const r = Object.fromEntries(cols.map((c, i) => [c, v[i]!]));
  return { task: r.task!, difficulty: r.difficulty!, harness: r.harness!, solved: r.solved === "1", cost_usd: +r.cost_usd!, wall_s: +r.wall_s!, tokens: +r.tokens! };
});

const LOOM = "loomcode";
const CC = "Claude Code";
const of = (h: string) => runs.filter((r) => r.harness === h);
const sum = (h: string, k: Key) => of(h).reduce((a, r) => a + r[k], 0);
const solved = (h: string) => of(h).filter((r) => r.solved).length;
const N = of(LOOM).length;

const W = 760;
const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// Cost per fix: two thin bars per task.
function cost() {
  const rank: Record<string, number> = { easy: 0, medium: 1, hard: 2 };
  const tasks = [...new Set(runs.map((r) => r.task))]
    .map((task) => runs.find((r) => r.task === task)!)
    .sort((a, b) => rank[a.difficulty]! - rank[b.difficulty]! || a.task.localeCompare(b.task));
  // Light only, on white, so it reads the same on any page.
  const P = 40, labelW = 96, valW = 64, barH = 4, inner = 8, rowH = 52, top = P + 64;
  const plotW = W - P * 2 - labelW - valW;
  const max = Math.max(...runs.map((r) => r.cost_usd));
  const ORANGE = "#d97b2b", GREY = "#cfd4da", INK = "#16191d", MUTED = "#8b929a";
  const txt = (x: number, y: number, s: string, fill = MUTED, size = 12, extra = "") =>
    `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${fill}" font-family='${FONT}' font-size="${size}"${extra}>${esc(s)}</text>`;
  let b = txt(P, P + 10, "Cost per fix", INK, 15, ` font-weight="600"`);
  b += `<circle cx="${P + 4}" cy="${P + 33}" r="4" fill="${ORANGE}"/>` + txt(P + 14, P + 37, "loomcode");
  b += `<circle cx="${P + 90}" cy="${P + 33}" r="4" fill="${GREY}"/>` + txt(P + 100, P + 37, "Claude Code");
  tasks.forEach((task, i) => {
    const y = top + i * rowH;
    b += txt(P, y + 11, task.task);
    [LOOM, CC].forEach((h, k) => {
      const r = runs.find((o) => o.task === task.task && o.harness === h)!;
      const by = y + 2 + k * (barH + inner);
      const w = Math.max(barH, (r.cost_usd / max) * plotW);
      const x0 = P + labelW;
      const fill = h === LOOM ? ORANGE : GREY;
      b += r.solved
        ? `<rect x="${x0}" y="${by}" width="${w.toFixed(1)}" height="${barH}" rx="2" fill="${fill}"/>`
        : `<rect x="${x0 + 0.5}" y="${by + 0.5}" width="${(w - 1).toFixed(1)}" height="${barH - 1}" rx="1.5" fill="none" stroke="${fill}" stroke-dasharray="2 2"/>`;
      b += txt(x0 + w + 8, by + 4.5, `$${r.cost_usd.toFixed(2)}${r.solved ? "" : " ✕"}`, h === LOOM ? INK : MUTED, 11);
    });
  });
  const foot = top + tasks.length * rowH + 8;
  b += txt(P, foot, "✕ tests failed · one run per task · Claude Opus 5.5", MUTED, 11);
  const H = foot + P - 12;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per fix, loomcode and Claude Code"><rect width="${W}" height="${H}" rx="12" fill="#ffffff"/>${b}</svg>\n`;
}

const out: Record<string, string> = { "cost.svg": cost() };
for (const [name, text] of Object.entries(out)) await Bun.write(dir + name, text);
console.log(`wrote ${Object.keys(out).join(", ")} to ${dir}
`);

const x = (a: number, b: number) => `**${(a / b).toFixed(1)}×`;
const tok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1e3)}k`);
const per = (h: string) => sum(h, "cost_usd") / solved(h);
console.log(`| | loomcode | Claude Code | |
|---|---:|---:|---|
| Total cost | $${sum(LOOM, "cost_usd").toFixed(2)} | $${sum(CC, "cost_usd").toFixed(2)} | ${x(sum(CC, "cost_usd"), sum(LOOM, "cost_usd"))} cheaper** |
| Tokens processed | ${tok(sum(LOOM, "tokens"))} | ${tok(sum(CC, "tokens"))} | ${x(sum(CC, "tokens"), sum(LOOM, "tokens"))} fewer** |
| Wall time | ${(sum(LOOM, "wall_s") / 60).toFixed(1)} min | ${(sum(CC, "wall_s") / 60).toFixed(1)} min | ${x(sum(CC, "wall_s"), sum(LOOM, "wall_s"))} faster** |
| Cost per solved task | $${per(LOOM).toFixed(2)} | $${per(CC).toFixed(2)} | ${x(per(CC), per(LOOM))} cheaper** |
| Tests passed | ${solved(LOOM)} / ${N} | ${solved(CC)} / ${N} | |`);
