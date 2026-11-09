import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync } from "node:fs";
import { realpath, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { applyEdits, type Edit } from "./edit.ts";
import { runScript } from "./script.ts";

// Output caps from pi: whichever limit hits first wins.
export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;
const MAX_LINE_CHARS = 500;

export const TOOL_NAMES = ["read", "search", "edit", "shell", "script"].map((n) => `mcp__loom__${n}`);

// `text` is the data (what a script gets back); `note` is harness commentary — truncation, exit status — that
// the model sees but scripts never parse. `cut` marks notes that scripts must still be told about.
// `raw` is the uncut data for scripts, when `text` was squeezed for the model.
export type ToolResult = { text: string; isError: boolean; note?: string; cut?: boolean; raw?: string };
const ok = (text: string, note?: string, cut?: boolean): ToolResult => ({ text, isError: false, note, cut });
const fail = (text: string): ToolResult => ({ text, isError: true });

// Keeps the first (head) or last (tail) lines that fit both caps. Returns null when nothing was cut.
export function cap(out: string, keep: "head" | "tail"): { text: string; shown: number; total: number } | null {
  const lines = out.split("\n");
  if (lines.length <= MAX_LINES && Buffer.byteLength(out) <= MAX_BYTES) return null;
  const order = keep === "head" ? lines : [...lines].reverse();
  const kept: string[] = [];
  let bytes = 0;
  for (const line of order) {
    const size = Buffer.byteLength(line) + 1;
    if (kept.length >= MAX_LINES || bytes + size > MAX_BYTES) {
      // A single line bigger than the whole budget (minified code) still shows its start, so paging moves on.
      if (!kept.length) kept.push(`${Buffer.from(line).subarray(0, MAX_BYTES - 100).toString()}… [line cut: ${line.length} chars]`);
      break;
    }
    kept.push(line);
    bytes += size;
  }
  if (keep === "tail") kept.reverse();
  return { text: kept.join("\n"), shown: kept.length, total: lines.length };
}

// What the model sees of shell output: the head (where the first error usually is) and the tail (summaries,
// exit messages), with long lines clipped. The full text is spilled to a file and scripts get it uncut.
const SHELL_HEAD = { lines: 100, bytes: 5 * 1024 };
const SHELL_TAIL = { lines: 200, bytes: 11 * 1024 };

export function squeeze(out: string): { text: string; omitted?: [number, number]; total: number; clipped: number } | null {
  let clipped = 0;
  const lines = out.split("\n").map((l) => {
    if (l.length <= MAX_LINE_CHARS) return l;
    clipped++;
    return `${l.slice(0, MAX_LINE_CHARS)}… [+${l.length - MAX_LINE_CHARS} chars]`;
  });
  const take = (from: string[], max: { lines: number; bytes: number }) => {
    const kept: string[] = [];
    let bytes = 0;
    for (const l of from) {
      bytes += Buffer.byteLength(l) + 1;
      if (kept.length >= max.lines || bytes > max.bytes) break;
      kept.push(l);
    }
    return kept;
  };
  const head = take(lines, SHELL_HEAD);
  const tail = take(lines.slice(head.length).reverse(), SHELL_TAIL).reverse();
  const total = lines.length;
  if (head.length + tail.length === total) return clipped ? { text: lines.join("\n"), total, clipped } : null;
  const omitted: [number, number] = [head.length + 1, total - tail.length];
  return { text: [...head, `… [lines ${omitted[0]}-${omitted[1]} omitted] …`, ...tail].join("\n"), omitted, total, clipped };
}

let spillDir: string | undefined;
async function spill(text: string): Promise<string> {
  spillDir ??= mkdtempSync(join(tmpdir(), "loom-"));
  const path = join(spillDir, `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.log`);
  await Bun.write(path, text);
  return path;
}

// What each file looked like before loom first edited it this run (null: loom created it), so the UI can
// put a file back. Edits made through shell or script are not tracked.
export const originals = new Map<string, string | null>();
export async function revertFile(path: string): Promise<boolean> {
  const before = originals.get(path);
  if (before === undefined) return false;
  if (before === null) await unlink(path).catch(() => {});
  else await Bun.write(path, before);
  originals.delete(path);
  return true;
}

// Edits to one file run one after another; different files run in parallel.
const queues = new Map<string, Promise<unknown>>();
async function serial<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpath(path).catch(() => path);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(key, run.catch(() => {}));
  return run;
}

export type Impl = ReturnType<typeof loomImpl>;

// Plain handlers, shared by the MCP tools and by scripts.
export function loomImpl(cwd: string) {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

  async function read({ path, offset = 1, limit }: { path: string; offset?: number; limit?: number }) {
    const f = Bun.file(abs(path));
    if (!(await f.exists())) return fail(`not found: ${path}`);
    const all = (await f.text()).split("\n");
    if (offset > all.length) return fail(`offset ${offset} is past the end (${all.length} lines)`);
    const slice = all.slice(offset - 1, limit ? offset - 1 + limit : undefined);
    const body = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
    const c = cap(body, "head");
    if (!c) return ok(body);
    return ok(c.text, `[showed lines ${offset}-${offset + c.shown - 1} of ${all.length}; continue with offset=${offset + c.shown}]`, true);
  }

  async function search({ pattern, path = ".", glob, files_only }: { pattern: string; path?: string; glob?: string; files_only?: boolean }) {
    const args = ["rg", "--line-number", "--no-heading", "--color=never", `--max-columns=${MAX_LINE_CHARS}`, "--max-columns-preview"];
    if (files_only) args.push("--files-with-matches");
    if (glob) args.push("--glob", glob);
    args.push("--", pattern, abs(path));
    const p = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code === 1) return ok("", "[no matches]");
    if (code !== 0) return fail(err.trim() || `rg exited ${code}`);
    const body = out.trimEnd().replaceAll(`${cwd}/`, "");
    const c = cap(body, "head");
    return c ? ok(c.text, `[showed ${c.shown} of ${c.total} matching lines; narrow the pattern, path or glob]`, true) : ok(body);
  }

  async function edit({ path, edits }: { path: string; edits: Edit[] }) {
    const file = abs(path);
    return serial(file, async () => {
      const f = Bun.file(file);
      if (!(await f.exists())) {
        if (edits.length === 1 && edits[0]!.old_text === "") {
          if (!originals.has(file)) originals.set(file, null);
          await Bun.write(file, edits[0]!.new_text);
          return ok(`created ${path}`);
        }
        return fail(`not found: ${path} (to create it, pass one edit with empty old_text)`);
      }
      const before = await f.text();
      const r = applyEdits(before, edits);
      if (!r.ok) return fail(`${r.error}; nothing written`);
      if (!originals.has(file)) originals.set(file, before);
      await Bun.write(file, r.text);
      return ok(`edited ${path} at line ${r.lines.join(", ")}${r.fuzzy ? ` (${r.fuzzy} matched ignoring whitespace/quotes)` : ""}`);
    });
  }

  async function shell({ command, timeout_s = 120 }: { command: string; timeout_s?: number }) {
    // One stream so stderr lines stay in order with stdout.
    const p = Bun.spawn(["zsh", "-c", `exec 2>&1\nsetopt no_nomatch\n${command}`], { cwd, stdout: "pipe", stdin: "ignore", timeout: timeout_s * 1000, killSignal: "SIGKILL" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    const status = p.signalCode ? `killed by ${p.signalCode}${p.signalCode === "SIGKILL" ? ` (timeout ${timeout_s}s?)` : ""}` : `exit ${code}`;
    const body = out.trimEnd();
    const s = squeeze(body);
    const what = s && [s.omitted && `lines ${s.omitted[0]}-${s.omitted[1]} of ${s.total} omitted`, s.clipped && `${s.clipped} long line${s.clipped > 1 ? "s" : ""} clipped`];
    const cut = s ? `[${what!.filter(Boolean).join(", ")}; full output: ${await spill(body)} (read it with offset/limit)]` : "";
    const note = [cut, `[${status}]`].filter(Boolean).join("\n");
    return { text: s ? s.text : body, isError: code !== 0, note, cut: !!s, ...(s && { raw: body }) };
  }

  return { read, search, edit, shell };
}

export const render = (r: ToolResult) => [r.text, r.note].filter(Boolean).join("\n") || "(no output)";
const mcp = (r: ToolResult) => ({ content: [{ type: "text" as const, text: render(r) }], isError: r.isError });

export function loomTools(cwd: string) {
  const impl = loomImpl(cwd);
  const read = tool(
    "read",
    "Read a file as numbered lines. For big files pass offset/limit instead of reading it all.",
    { path: z.string(), offset: z.number().int().min(1).optional(), limit: z.number().int().min(1).optional() },
    async (a) => mcp(await impl.read(a)),
    { alwaysLoad: true },
  );
  const search = tool(
    "search",
    "Search file contents with ripgrep (regex), respecting .gitignore. files_only lists matching paths.",
    { pattern: z.string(), path: z.string().optional(), glob: z.string().optional(), files_only: z.boolean().optional() },
    async (a) => mcp(await impl.search(a)),
    { alwaysLoad: true },
  );
  const edit = tool(
    "edit",
    "Edit a file by exact replacement. Each old_text must match one place in the original file; edits must not overlap " +
      "(merge nearby changes into one edit). Keep old_text short. Batch all changes to a file in one call. " +
      "To create a file, pass one edit with empty old_text.",
    { path: z.string(), edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1) },
    async (a) => mcp(await impl.edit(a)),
    { alwaysLoad: true },
  );
  const shell = tool(
    "shell",
    "Run a zsh command in the project directory (stdout+stderr combined). Long output shows the first 100 and last 200 lines " +
      "(long lines clipped) and saves the full text to a file you can read.",
    { command: z.string(), timeout_s: z.number().int().min(1).max(600).optional() },
    async (a) => mcp(await impl.shell(a)),
    { alwaysLoad: true },
  );
  const script = tool(
    "script",
    "Run JavaScript (the body of an async function) that calls tools.read/search/edit/shell(args) — each returns its " +
      "text and throws on error. Only what you print()/console.log() and the return value come back, so use it to " +
      "batch many steps (read every match of a search, check a list of files) without filling the context.",
    { code: z.string(), timeout_s: z.number().int().min(1).max(600).optional() },
    async ({ code, timeout_s = 120 }) => mcp(await runScript(code, impl, timeout_s)),
    { alwaysLoad: true },
  );
  return createSdkMcpServer({ name: "loom", version: "0.2.0", tools: [read, search, edit, shell, script] });
}
