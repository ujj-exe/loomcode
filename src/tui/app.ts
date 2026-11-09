import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { appendFile, mkdir } from "node:fs/promises";
import type { Effort, Session } from "../session.ts";
import { bg, c, fit, sliceCols, strip, width } from "./ansi.ts";
import { Drawer } from "./drawer.ts";
import { Editor } from "./editor.ts";
import { preloadGrammars } from "./highlight.ts";
import { clipboardImage, copyText, droppedImages, loadImage } from "./images.ts";
import { type InputEvent, type Key, KeyParser, type Mouse } from "./keys.ts";
import { StreamMarkdown } from "./markdown.ts";
import { Screen } from "./screen.ts";
import { saveSettings, type Settings } from "../settings.ts";
import { expandSkill, loadSkills, type Skill } from "../skills.ts";
import { revertFile } from "../tools.ts";
import { type Entry, measure, secs, spinner, type Tool, Transcript } from "./transcript.ts";

const COMMANDS: [string, string][] = [
  ["/model", "switch model"],
  ["/effort", "set thinking effort"],
  ["/copy", "copy the last reply (/copy code: its last code block)"],
  ["/files", "show or hide the files drawer (ctrl+b)"],
  ["/mcp", "MCP servers and claude.ai connectors"],
  ["/compact", "summarize the conversation to free context"],
  ["/clear", "start a fresh conversation"],
  ["/help", "keys and commands"],
  ["/exit", "quit"],
];
const HEADER = 2;
const EDITOR_MAX = 8;
const EFFORT_COLOR: Record<string, (s: string) => string> = { low: c.muted, medium: c.ok, high: c.warn, xhigh: c.accent, max: c.err };

type Picker = { title: string; items: { label: string; value: string; hint?: string }[]; index: number; pick: (v: string) => void };
type Phase = "idle" | "starting" | "waiting" | "thinking" | "writing" | "tool" | "compacting";
type ModelInfo = { value: string; displayName: string; description: string; resolvedModel?: string; supportedEffortLevels?: Effort[] };
type Pos = { line: number; col: number };

// mcp__loom__edit → edit; mcp__claude-in-chrome__navigate → chrome · navigate; mcp__claude_ai_Notion__search → notion · search
const toolName = (n: string) => {
  if (n.startsWith("mcp__loom__")) return n.slice(11);
  if (n === "ToolSearch") return "tools";
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (!m) return n;
  const server = m[1]!.replace(/^claude[-_.]?ai[-_ ]?/i, "").replace(/^claude-in-/, "").replace(/[-_]/g, " ").toLowerCase();
  return `${server} · ${m[2]!.replace(/_/g, " ")}`;
};
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

// One line describing a tool call from its input.
let shortPath = (p: string) => p; // set to cwd-relative once the TUI knows its cwd
function describe(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "read": return shortPath(s(input.path)) + (input.offset ? `:${input.offset}` : "");
    case "search": return `/${s(input.pattern)}/` + (input.path ? ` in ${shortPath(s(input.path))}` : "");
    case "edit": return shortPath(s(input.path));
    case "shell": return s(input.command).split("\n")[0]!;
    case "script": return `${s(input.code).split("\n").length} lines of js`;
    case "tools": return `loading ${s(input.query).replace(/^select:/, "").split(",").map((t) => toolName(t.trim())).join(", ")}`;
    default: {
      // MCP tools: the first short string argument says the most (url, query, title…).
      const v = Object.values(input).find((x) => typeof x === "string" && x.length < 200);
      return typeof v === "string" ? v.split("\n")[0]! : "";
    }
  }
}

// Inline diff for an edit call: removed lines then added lines per edit, numbered from where it landed.
function editDiff(input: any, result: string): string[] {
  const at = (/at line ([\d, ]+)/.exec(result)?.[1] ?? "").split(",").map((x) => Number(x.trim()));
  const out: string[] = [];
  if (result.startsWith("created")) {
    const lines = String(input.edits?.[0]?.new_text ?? "").split("\n");
    lines.slice(0, 8).forEach((l, i) => out.push(`${c.dim(String(i + 1).padStart(4))} ${c.ok("+")} ${c.ok(l)}`));
    if (lines.length > 8) out.push(c.dim(`       … ${lines.length - 8} more lines`));
    return out;
  }
  (input.edits ?? []).forEach((e: any, i: number) => {
    const start = at[i] || 1;
    if (i) out.push(c.dim("     ⋯"));
    String(e.old_text ?? "").split("\n").forEach((l, k) => out.push(`${c.dim(String(start + k).padStart(4))} ${c.err("−")} ${c.err(l)}`));
    String(e.new_text ?? "").split("\n").forEach((l, k) => out.push(`${c.dim(String(start + k).padStart(4))} ${c.ok("+")} ${c.ok(l)}`));
  });
  return out;
}


async function gitBranch(cwd: string) {
  const p = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 ? out : "";
}

export async function runTui(opts: { cwd: string; model?: string; effort: Effort; settings: Settings; warnings: string[] }) {
  const screen = new Screen();
  const editor = new Editor();
  const transcript = new Transcript();
  const drawer = new Drawer(opts.cwd);
  shortPath = (p) => (p ? drawer.rel(p) : p);
  let session: Session | undefined;
  let gen = 0; // bumps on /clear so a dying session's late messages are ignored
  let model = opts.model ?? "";
  let modelLabel = "";
  let models: ModelInfo[] = [];
  let effort: Effort = opts.effort;
  let efforts: Effort[] = ["low", "medium", "high", "xhigh", "max"];
  let branch = "";
  let phase: Phase = "starting";
  let phaseSince = performance.now();
  let sentAt = 0;
  let firstToken = 0;
  let lastTurn = "";
  let queue: { text: string; images: any[]; prompt?: string }[] = [];
  let skills: Skill[] = [];
  // Built-in commands, then the user's skills (a skill never shadows a built-in).
  const slashItems = (): [string, string][] => [
    ...COMMANDS,
    ...skills.filter((s) => !COMMANDS.some(([k]) => k === `/${s.name}`)).map((s): [string, string] => [`/${s.name}`, s.description || "skill"]),
  ];
  let stopping = false;
  let picker: Picker | null = null;
  let notice = "";
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let ctrlCArmed = false;
  // Tool calls waiting for the user's yes/no, oldest first; "always" remembers per tool for this session.
  const approvals: { tool: string; input: Record<string, unknown>; index: number; resolve: (ok: boolean) => void }[] = [];
  const alwaysAllow = new Set<string>();
  let palette: { filter: string; index: number } | null = null;
  let headerToggle = { from: 0, to: 0 }; // columns of the files toggle in the header
  const settings = opts.settings;
  // Choices made here (/model, /effort, the drawer, connectors) are saved to ~/.loom/settings.json.
  let saveWarned = false;
  const remember = (patch: Partial<Settings>) =>
    saveSettings(patch).then((ok) => {
      if (!ok && !saveWarned) (saveWarned = true), say("~/.loom/settings.json isn't valid JSON, so changes aren't saved", 6000);
    });
  let servers: { name: string; status: string }[] = [];
  // View state: scroll is lines up from the bottom (0 follows the stream).
  let scroll = 0;
  let sel: { a: Pos; b: Pos; moved: boolean } | null = null;
  let mdCols = 0;
  let view = { top: 0, bodyH: 0, leftW: 0, total: 0, drawerActions: new Map<number, any>(), actions: new Map<number, any>(), lines: [] as string[] };

  // Stream state for the model call in flight (block indexes restart with each call).
  let mdEntry: Extract<Entry, { kind: "md" }> | null = null;
  let thinkEntry: Extract<Entry, { kind: "thinking" }> | null = null;
  const blockKind = new Map<number, "text" | "thinking" | "tool">();
  const blockTool = new Map<number, Tool>();
  const running = new Map<string, Tool>();
  const toolInput = new Map<string, any>();
  let lastReply = "";

  const setPhase = (p: Phase) => {
    if (p !== phase) phaseSince = performance.now();
    phase = p;
  };
  const busy = () => phase !== "idle" && phase !== "starting";
  const say = (msg: string, ms = 2500) => {
    notice = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => ((notice = ""), draw()), ms);
    draw();
  };

  // ── frame ──────────────────────────────────────────────────────────────────
  // Bursts of events (stream deltas arriving together) collapse into one frame on the next microtask,
  // so a lone token still paints immediately; frames are at least 16ms apart, so a flood of wheel
  // events from a trackpad can't outrun the terminal.
  let drawQueued = false;
  let lastFrame = 0;
  function draw() {
    if (drawQueued) return;
    drawQueued = true;
    const run = () => {
      drawQueued = false;
      lastFrame = performance.now();
      frame();
    };
    const wait = lastFrame + 16 - performance.now();
    if (wait > 0) setTimeout(run, wait);
    else queueMicrotask(run);
  }
  let lastTotal = 0;

  function header(W: number, drawerW: number): string[] {
    const project = basename(opts.cwd);
    const badge = bg(0xd4a373)(c.bold("\x1b[38;2;28;30;36m ◆ loom \x1b[39m"));
    const left = ` ${badge}  ${c.bold(project)}${branch ? c.dim(`   ⎇ ${branch}`) : ""}`;
    const ratio = session?.context ? session.context / session.window : 0;
    const cells = 8;
    const filled = Math.min(cells, Math.round(ratio * cells));
    const gaugeColor = ratio > 0.75 ? c.err : ratio > 0.5 ? c.warn : c.ok;
    const gauge = gaugeColor("▰".repeat(filled)) + c.dim("▱".repeat(cells - filled));
    const ctx = session?.context ? `${gauge} ${c.dim(`${fmtTokens(session.context)} / ${fmtTokens(session.window)}`)}` : c.dim("▱".repeat(cells));
    const chip = drawer.open ? bg(0x3a4050)(c.accent(" ▤ files ")) : c.dim(" ▤ files ");
    const right = `${c.bold(modelLabel || "connecting…")}${c.dim("   ·   ")}${(EFFORT_COLOR[effort] ?? c.muted)(effort)}${c.dim("   ·   ")}${ctx}   ${chip} `;
    const gapW = W - width(left) - width(right);
    headerToggle = { from: W - width(chip) - 1, to: W - 1 };
    const row0 = gapW > 1 ? left + " ".repeat(gapW) + right : fit(left, W);
    const rule = drawerW ? "─".repeat(W - drawerW) + "┬" + "─".repeat(drawerW - 1) : "─".repeat(W);
    return [row0, c.dim(rule)];
  }

  function bottom(W: number): { lines: string[]; cursor: { row: number; col: number } } {
    const lines: string[] = [""]; // breathing room between the conversation and the status line
    for (const q of queue) lines.push(fit(c.dim(`  ⧗ queued   ${q.text.replace(/\s+/g, " ")}`), W));
    // status line: live phase while busy, the last turn's timing when idle
    if (busy() || (phase === "starting" && queue.length)) {
      const label: Record<Phase, string> = {
        idle: "", starting: "Connecting", waiting: "Sending", thinking: "Thinking", writing: "Writing", tool: "Running tools", compacting: "Compacting",
      };
      const el = secs(performance.now() - (phase === "waiting" ? sentAt : phaseSince));
      const ft = firstToken ? c.dim(`   ·   first token ${secs(firstToken)}`) : "";
      const l = `  ${c.accent(spinner())} ${c.accent(label[phase])}  ${c.dim(el)}${ft}`;
      const r = c.dim("esc to stop  ");
      lines.push(l + " ".repeat(Math.max(1, W - width(l) - width(r))) + r);
    } else lines.push(lastTurn ? c.dim(`  ${lastTurn}`) : "");
    const ask = approvals[0];
    if (ask) {
      const args = Object.entries(ask.input)
        .filter(([, v]) => v !== undefined && v !== "")
        .slice(0, 3)
        .map(([k, v]) => `${c.dim(k)} ${typeof v === "string" ? v.split("\n")[0] : JSON.stringify(v)}`);
      const server = toolName(ask.tool).split(" · ")[0]!;
      lines.push("", fit(`  ${c.warn("⚠")}  ${c.bold("Allow")} ${c.accent(toolName(ask.tool))}${approvals.length > 1 ? c.dim(`   (+${approvals.length - 1} more waiting)`) : ""}`, W));
      for (const a of args) lines.push(fit(`     ${a}`, W));
      const opts = ["Allow once", `Always allow ${server}`, "Deny"];
      lines.push(`     ${opts.map((o, i) => (i === ask.index ? bg(0x3a4050)(c.bold(` ${i + 1} ${o} `)) : c.dim(` ${i + 1} ${o} `))).join("  ")}`);
    } else if (palette) {
      const items = paletteItems(palette.filter);
      palette.index = Math.min(palette.index, Math.max(0, items.length - 1));
      lines.push("", fit(`  ${c.accent("⌘")} ${palette.filter ? palette.filter : c.dim("type to search commands, models, effort…")}`, W));
      items.slice(0, 8).forEach((it, i) => {
        const on = i === palette!.index;
        lines.push(fit(`    ${on ? c.accent("› ") : "  "}${on ? c.bold(it.label) : it.label}${it.hint ? c.dim(`   ${it.hint}`) : ""}`, W));
      });
      if (!items.length) lines.push(c.dim("      no matches"));
    } else if (picker) {
      lines.push("", `  ${c.bold(picker.title)}`);
      picker.items.forEach((it, i) => {
        const on = i === picker!.index;
        lines.push(fit(`  ${on ? c.accent("› ") : "  "}${on ? c.bold(it.label) : it.label}${it.hint ? c.dim(`    ${it.hint}`) : ""}`, W));
      });
      lines.push(c.dim("  ↑↓ choose · enter select · esc cancel"));
    } else if (editor.text.startsWith("/") && !editor.text.includes(" ")) {
      lines.push("");
      const hits = slashItems().filter(([cmd]) => cmd.startsWith(editor.text));
      const pad = Math.min(28, Math.max(11, ...hits.map(([k]) => k.length + 2)));
      for (const [cmd, help] of hits.slice(0, 10)) lines.push(fit(`    ${c.accent(cmd.padEnd(pad))}${c.dim(help.replace(/\s+/g, " "))}`, W));
      if (hits.length > 10) lines.push(c.dim(`    … ${hits.length - 10} more, keep typing`));
    }
    lines.push(c.dim("─".repeat(W)));
    // editor, scrolled to keep the caret visible
    const ed = editor.render(W - 3, phase === "starting" ? "type now — connecting in the background" : "Ask loom anything   ·   / for commands");
    const first = ed.lines.length > EDITOR_MAX ? Math.max(0, Math.min(ed.cursor.row - EDITOR_MAX + 1, ed.lines.length - EDITOR_MAX)) : 0;
    const edRow = lines.length;
    for (const l of ed.lines.slice(first, first + EDITOR_MAX)) lines.push(` ${l}`);
    const cursor = { row: edRow + ed.cursor.row - first, col: ed.cursor.col + 1 };
    lines.push("");
    if (editor.images.length) lines.push(fit(c.accent(`  ▣ ${editor.images.length} image${editor.images.length > 1 ? "s" : ""} attached`), W));
    return { lines, cursor };
  }

  function frame() {
    const W = screen.cols;
    const H = screen.rows;
    const drawerW = drawer.open && W >= 90 ? (W >= 140 ? 40 : 32) : 0;
    const leftW = W - drawerW;
    const want = measure(leftW);
    if (want !== mdCols) {
      mdCols = want;
      transcript.reflow(mdCols);
    }
    const bot = bottom(W);
    const bodyH = Math.max(1, H - HEADER - bot.lines.length);
    const { lines, actions } = transcript.layout(leftW);
    const total = lines.length;
    // Scrolled up, the view stays on the same lines while the reply grows (or shrinks) below it.
    if (scroll > 0) scroll += total - lastTotal;
    lastTotal = total;
    scroll = Math.max(0, Math.min(scroll, total - bodyH));
    const top = Math.max(0, total - bodyH - scroll);
    const dr = drawerW ? drawer.render(drawerW, bodyH) : { lines: [] as string[], actions: new Map() };

    const rows = header(W, drawerW);
    const [sa, sb] = sel ? order(sel.a, sel.b) : [null, null];
    for (let i = 0; i < bodyH; i++) {
      const n = top + i;
      let l = lines[n] ?? "";
      if (sa && sb && sel!.moved && n >= sa.line && n <= sb.line) {
        const from = n === sa.line ? sa.col : 0;
        const end = Math.min(n === sb.line ? sb.col + 1 : Infinity, width(l));
        if (end > from) l = sliceCols(l, 0, from) + "\x1b[0m" + c.inverse(strip(sliceCols(l, from, end))) + sliceCols(l, end);
      }
      if (i === 0 && notice) {
        // Toast: a pill pinned to the top-right of the conversation pane.
        const toast = bg(0x3a4050)(` ${c.accent("●")} ${notice} `);
        l = fit(l, Math.max(0, leftW - width(toast) - 2)) + toast + "  ";
      }
      if (i === bodyH - 1 && scroll > 0) {
        const tag = c.accent(` ↓ ${scroll} more · esc `);
        l = fit(l, leftW - width(tag) - 1) + tag + " ";
      }
      rows.push(fit(l, leftW) + (dr.lines[i] ?? ""));
    }
    const botTop = rows.length;
    rows.push(...bot.lines.map((l) => fit(l, W)));
    view = { top, bodyH, leftW, total, drawerActions: dr.actions, actions, lines };
    screen.render(rows, { row: botTop + bot.cursor.row, col: bot.cursor.col });
  }

  const order = (a: Pos, b: Pos): [Pos, Pos] => (a.line < b.line || (a.line === b.line && a.col <= b.col) ? [a, b] : [b, a]);

  function selectedText(): string {
    if (!sel) return "";
    const [a, b] = order(sel.a, sel.b);
    const out: string[] = [];
    for (let n = a.line; n <= b.line; n++) {
      const from = n === a.line ? a.col : 0;
      let t = strip(sliceCols(view.lines[n] ?? "", from, n === b.line ? b.col + 1 : Infinity));
      if (from < 2) t = t.replace(/^ {1,2}/, ""); // drop the pane's left padding
      out.push(t.trimEnd());
    }
    return out.join("\n");
  }

  // Spinners and timers tick only while something runs.
  setInterval(() => {
    if (busy() || running.size || thinkEntry) draw();
  }, 80);

  // ── stream ─────────────────────────────────────────────────────────────────
  const markFirstToken = () => {
    if (!firstToken && sentAt) firstToken = performance.now() - sentAt;
  };
  const endText = () => {
    if (!mdEntry) return;
    mdEntry.md.end();
    transcript.streaming.delete(mdEntry);
    lastReply = mdEntry.raw;
    mdEntry = null;
  };
  const endThinking = () => {
    if (!thinkEntry) return;
    thinkEntry.ms = performance.now() - thinkEntry.started;
    if (!thinkEntry.text.trim()) transcript.entries.splice(transcript.entries.indexOf(thinkEntry), 1);
    thinkEntry = null;
  };

  function onStream(e: any) {
    switch (e.type) {
      case "message_start":
        blockKind.clear();
        blockTool.clear();
        if (phase === "tool") setPhase("waiting");
        break;
      case "content_block_start": {
        const b = e.content_block;
        if (b.type === "thinking" || b.type === "redacted_thinking") {
          blockKind.set(e.index, "thinking");
          thinkEntry = transcript.add({ kind: "thinking", text: "", started: performance.now(), open: false }) as typeof thinkEntry;
          setPhase("thinking");
          markFirstToken();
        } else if (b.type === "text") {
          endThinking();
          blockKind.set(e.index, "text");
          mdEntry = transcript.add({ kind: "md", md: new StreamMarkdown(mdCols), raw: "" }) as typeof mdEntry;
          transcript.streaming.add(mdEntry!);
          setPhase("writing");
        } else if (b.type === "tool_use") {
          endThinking();
          endText();
          blockKind.set(e.index, "tool");
          // The call shows the moment the model names it, before its arguments finish streaming.
          const t: Tool = { id: b.id, name: toolName(b.name), json: "", summary: "", started: performance.now(), status: "running" };
          blockTool.set(e.index, t);
          running.set(b.id, t);
          transcript.add({ kind: "tool", tool: t });
          setPhase("tool");
          markFirstToken();
        }
        break;
      }
      case "content_block_delta": {
        const d = e.delta;
        if (d.type === "text_delta" && mdEntry) {
          markFirstToken();
          mdEntry.md.push(d.text);
          mdEntry.raw += d.text;
        } else if (d.type === "thinking_delta" && thinkEntry) {
          thinkEntry.text += d.thinking;
        } else if (d.type === "input_json_delta") {
          const t = blockTool.get(e.index);
          if (t) {
            t.json += d.partial_json;
            const m = /"(?:path|command|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(t.json)?.[1];
            if (m) t.summary = m.replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
          }
        }
        break;
      }
      case "content_block_stop": {
        const kind = blockKind.get(e.index);
        if (kind === "thinking") endThinking();
        else if (kind === "text") endText();
        else if (kind === "tool") {
          const t = blockTool.get(e.index);
          if (t) {
            try {
              const input = JSON.parse(t.json || "{}");
              toolInput.set(t.id, input);
              t.summary = describe(t.name, input);
              if (t.name === "edit" && typeof input.path === "string") drawer.active.set(drawer.rel(input.path), t.started);
            } catch {}
          }
        }
        break;
      }
    }
    draw();
  }

  function onToolResults(content: any[]) {
    let refresh = false;
    for (const r of content) {
      if (r?.type !== "tool_result") continue;
      const t = running.get(r.tool_use_id);
      if (!t) continue;
      running.delete(r.tool_use_id);
      t.ms = performance.now() - t.started;
      const text = strip(typeof r.content === "string" ? r.content : (r.content ?? []).map((x: any) => x.text ?? "").join("\n"));
      const input = toolInput.get(t.id) ?? {};
      toolInput.delete(t.id);
      if (typeof input.path === "string") drawer.active.delete(drawer.rel(input.path));
      if (r.is_error && stopping) t.status = "stopped";
      else if (r.is_error) {
        t.status = "err";
        t.detail = text.split("\n").find((l: string) => l.trim()) ?? "";
      } else {
        t.status = "ok";
        if (t.name === "edit" && Array.isArray(input.edits)) {
          drawer.noteEdit(input.path, input.edits);
          const lines = (s?: string) => (s ? s.split("\n").length : 0);
          const adds = input.edits.reduce((n: number, e: any) => n + lines(e.new_text), 0);
          const dels = input.edits.reduce((n: number, e: any) => n + lines(e.old_text), 0);
          t.detail = text.startsWith("created") ? c.ok(`new · ${adds} lines`) : `${c.ok(`+${adds}`)} ${c.err(`−${dels}`)}`;
          t.diff = editDiff(input, text);
        }
        if (t.name === "shell" || t.name === "script") refresh = true;
      }
    }
    if (refresh) drawer.refresh().then(draw);
    if (!running.size) setPhase("waiting");
    draw();
  }

  function onResult(m: any) {
    endThinking();
    endText();
    for (const t of running.values()) {
      t.status = "stopped";
      t.ms = performance.now() - t.started;
    }
    running.clear();
    drawer.active.clear();
    const u = m.usage ?? {};
    lastTurn = [
      firstToken ? `first token ${secs(firstToken)}` : "",
      `done in ${secs(performance.now() - sentAt)}`,
      `↓ ${fmtTokens(u.output_tokens ?? 0)} tokens`,
      m.subtype !== "success" ? (stopping ? "stopped" : m.subtype.replace(/_/g, " ")) : "",
    ].filter(Boolean).join("   ·   ");
    if (session && session.inFlight > 0) {
      sentAt = performance.now(); // the prompt after a /compact starts right away
      firstToken = 0;
      setPhase("waiting");
    } else if (queue.length) dispatch(queue.shift()!);
    else setPhase("idle");
    draw();
  }

  async function pump(s: Session, mine: number) {
    for await (const m of s.messages as AsyncIterable<SDKMessage>) {
      if (mine !== gen) return;
      s.track(m);
      if (m.type === "stream_event") {
        if (!m.parent_tool_use_id) onStream(m.event);
      } else if (m.type === "user") {
        const content = (m.message as any).content;
        if (Array.isArray(content)) onToolResults(content);
      } else if (m.type === "result") onResult(m);
      else if (m.type === "system" && m.subtype === "init") {
        // claude re-sends init with every prompt; only the first one names the session's model.
        if (!model) {
          model = m.model;
          modelLabel = prettyModel(model);
        }
        servers = m.mcp_servers.filter((x) => x.name !== "loom");
        draw();
      } else if (m.type === "system" && m.subtype === "compact_boundary") {
        const k = m.compact_metadata;
        transcript.add({ kind: "note", text: `⟲ compacted ${fmtTokens(k.pre_tokens)} → ${fmtTokens(k.post_tokens ?? 0)} tokens` });
        draw();
      } else if (m.type === "system" && m.subtype === "api_retry") {
        say(`retrying (${m.attempt}/${m.max_retries})${m.error_status ? ` after ${m.error_status}` : ""}…`, m.retry_delay_ms + 1000);
      } else if (m.type === "rate_limit_event") {
        const st = m.rate_limit_info.status;
        if (st === "rejected") say("rate limited — waiting for the limit to reset", 15_000);
        else if (st === "allowed_warning") say("close to your usage limit", 8000);
      } else if (m.type === "system" && (m as any).subtype === "status") {
        if ((m as any).status === "compacting") setPhase("compacting");
        draw();
      }
    }
  }

  // "Opus 5.5 · Best for…" → "Opus 5.5"; falls back to the display name.
  const label = (m: ModelInfo) => {
    const head = m.description.split(" · ")[0]!;
    return /\d/.test(head) && head.length < 24 ? head : m.displayName;
  };
  const findModel = (id: string) =>
    models.find((x) => x.value === id || x.resolvedModel === id) ?? models.find((x) => x.value !== "default" && id.includes(x.value));
  const prettyModel = (id: string) => {
    const m = findModel(id);
    return m ? label(m) : id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2");
  };

  async function connect(resume?: string) {
    const mine = gen;
    const { openSession } = await import("../session.ts");
    const s = await openSession({
      ...opts,
      model: model || opts.model,
      effort,
      showThinking: true,
      integrations: true,
      connectors: settings.connectors,
      autoCompact: settings.autoCompact,
      provider: settings.provider,
      webSearch: settings.webSearch,
      resume,
      approve,
      onCheckpoint: (p) => (transcript.add({ kind: "note", text: `⟲ checkpoint saved to ${p}` }), draw()),
    });
    if (mine !== gen) return s.close();
    session = s;
    pump(s, mine).catch((e) => (transcript.add({ kind: "note", text: `session ended: ${e?.message ?? e}` }), draw()));
    // Spawning claude and the tool handshake happen now, while the user is still typing.
    s.ready()
      .then((init) => {
        models = (init.models as ModelInfo[]) ?? [];
        const current = (model && findModel(model)) || findModel(opts.model ?? "default");
        if (current) {
          modelLabel = model ? prettyModel(model) : label(current);
          if (current.supportedEffortLevels?.length) efforts = current.supportedEffortLevels;
        }
        draw();
      })
      .catch(() => {});
    if (phase === "starting") setPhase("idle");
    if (queue.length) dispatch(queue.shift()!);
    draw();
  }

  // ── actions ────────────────────────────────────────────────────────────────
  // `prompt`, when given, is what the model gets in place of the text shown (an expanded skill).
  function send(text: string, images: any[] = [], prompt?: string) {
    if (!session || busy()) queue.push({ text, images, prompt });
    else dispatch({ text, images, prompt });
  }

  function dispatch(p: { text: string; images: any[]; prompt?: string }) {
    transcript.add({ kind: "user", text: p.text, images: p.images });
    stopping = false;
    scroll = 0;
    sentAt = performance.now();
    firstToken = 0;
    setPhase("waiting");
    if (session!.send(p.prompt ?? p.text, p.images)) setPhase("compacting");
  }

  function submit() {
    const raw = editor.text.trim();
    if (!raw) return;
    if (raw.startsWith("/") && !raw.startsWith("//") && command(raw)) {
      editor.clear();
      return;
    }
    const { text, images } = editor.submit();
    if (text.startsWith("/") && skills.length) {
      expandSkill(text, skills).then((prompt) => send(text, images, prompt ?? undefined));
      return;
    }
    send(text, images);
  }

  function command(raw: string): boolean {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/exit":
      case "/quit":
        return quit(), true;
      case "/help":
        transcript.add({
          kind: "note",
          text: [
            "enter send · shift+enter, alt+enter or ctrl+j newline · esc stop · ctrl+c clear, twice to quit",
            "shift+tab effort · ctrl+b files drawer · ctrl+v paste image · drop image files into the prompt",
            "wheel or pgup/pgdn scroll · drag to select and copy · click a code block header to copy it · click a file to mention it",
            ...COMMANDS.map(([k, h]) => `${k}  ${h}`),
          ].join("\n"),
        });
        return true;
      case "/model":
        if (arg) return setModel(arg), true;
        return openModelPicker(), true;
      case "/effort":
        if (arg) return setEffort(arg as Effort), true;
        picker = {
          title: "Effort",
          items: efforts.map((e) => ({ label: e, value: e, hint: e === effort ? "current" : undefined })),
          index: Math.max(0, efforts.indexOf(effort)),
          pick: (v) => setEffort(v as Effort),
        };
        return true;
      case "/copy": {
        const what = arg === "code" ? findLastCode() : lastReply;
        if (!what) return say("nothing to copy yet"), true;
        copyText(what).then(() => say(`copied ${arg === "code" ? "code block" : "reply"} · ${what.split("\n").length} lines`));
        return true;
      }
      case "/files":
        toggleDrawer();
        return true;
      case "/mcp": {
        const on = settings.connectors;
        const status = servers.map((x) => `${x.name.replace(/^claude\.ai /, "")} ${x.status === "connected" ? "●" : x.status === "needs-auth" ? "○ needs auth" : "◌"}`).join("  ");
        picker = {
          title: `MCP · ${servers.length} servers   ${status ? c.dim(clipStatus(status)) : ""}`,
          items: [
            { label: on ? "Turn claude.ai connectors off" : "Turn claude.ai connectors on", value: "toggle", hint: on ? "saves ~30k tokens of tool definitions" : "adds ~30k tokens of tool definitions to the prompt" },
            { label: "Keep as is", value: "keep" },
          ],
          index: 0,
          pick: (v) => {
            if (v !== "toggle") return;
            settings.connectors = !on;
            remember({ connectors: settings.connectors });
            restartSession();
            say(`claude.ai connectors ${settings.connectors ? "on" : "off"}`);
          },
        };
        return true;
      }
      case "/clear":
        gen++;
        session?.interrupt().catch(() => {});
        session?.close();
        session = undefined;
        mdEntry = null;
        thinkEntry = null;
        running.clear();
        queue = [];
        transcript.entries = [];
        lastTurn = "";
        setPhase("starting");
        connect();
        return true;
      case "/compact":
        send("/compact");
        return true;
    }
    return false;
  }

  const clipStatus = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);

  // Restarts claude with the same conversation (integration changes need a new process).
  function restartSession() {
    const resume = session?.id || undefined;
    gen++;
    session?.close();
    session = undefined;
    setPhase("starting");
    connect(resume);
  }

  function findLastCode() {
    for (let i = transcript.entries.length - 1; i >= 0; i--) {
      const e = transcript.entries[i]!;
      if (e.kind === "md" && e.md.codeBlocks.length) return e.md.codeBlocks.at(-1)!.code;
    }
    return "";
  }

  function openModelPicker() {
    if (!models.length) return say("models are still loading");
    picker = {
      title: "Model",
      items: models.map((m) => ({ label: m.displayName, value: m.value, hint: m.description })),
      index: Math.max(0, models.findIndex((m) => m.value === model || (model && m.value !== "default" && model.includes(m.value)))),
      pick: (v) => setModel(v),
    };
  }

  function setModel(v: string) {
    model = v;
    modelLabel = prettyModel(v);
    const info = findModel(v);
    if (info?.supportedEffortLevels?.length) {
      efforts = info.supportedEffortLevels;
      if (!efforts.includes(effort)) setEffort(efforts.includes("medium") ? "medium" : efforts[0]!);
    }
    session?.setModel(v).catch(() => say("model switch failed"));
    remember({ model: v });
    say(`model → ${modelLabel}`);
  }

  function setEffort(e: Effort) {
    effort = e;
    session?.setEffort(e).catch(() => say("effort change failed"));
    remember({ effort: e });
    say(`effort → ${e}`);
  }

  async function addImages(paths: string[]) {
    say(`attaching ${paths.length} image${paths.length > 1 ? "s" : ""}…`, 10_000);
    for (const p of paths) {
      try {
        editor.attach(await loadImage(p));
      } catch {
        say(`could not read ${basename(p)}`);
      }
    }
    say(`${editor.images.length} image${editor.images.length > 1 ? "s" : ""} attached`);
  }

  async function pasteClipboardImage() {
    const p = await clipboardImage();
    if (p) await addImages([p]);
    else say("no image on the clipboard");
  }

  function stop() {
    stopping = true;
    session?.interrupt().catch(() => {});
  }

  // Command palette: commands, models and effort levels, filtered by a fuzzy subsequence match.
  type PaletteItem = { label: string; hint?: string; run: () => void };
  function paletteItems(filter: string): PaletteItem[] {
    const all: PaletteItem[] = [
      ...COMMANDS.filter(([k]) => k !== "/help").map(([k, h]) => ({ label: k, hint: h, run: () => command(k) || undefined })),
      ...skills.map((sk) => ({ label: `/${sk.name}`, hint: "skill", run: () => (editor.clear(), editor.insert(`/${sk.name} `)) })),
      ...models.map((m) => ({ label: `model: ${label(m)}`, hint: m.value === model ? "current" : m.displayName, run: () => setModel(m.value) })),
      ...efforts.map((e) => ({ label: `effort: ${e}`, hint: e === effort ? "current" : undefined, run: () => setEffort(e) })),
      { label: "help", hint: "keys and commands", run: () => command("/help") },
    ];
    const f = filter.toLowerCase().replace(/\s+/g, "");
    if (!f) return all;
    const score = (s: string) => {
      let i = 0;
      let gaps = 0;
      for (const ch of s.toLowerCase()) {
        if (ch === f[i]) i++;
        else if (i) gaps++;
        if (i === f.length) return gaps;
      }
      return -1;
    };
    return all.map((it) => ({ it, s: score(it.label) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).map((x) => x.it);
  }

  // The session asks before any tool that is not loom's own (MCP servers, Chrome).
  function approve(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    if (alwaysAllow.has(serverOf(tool))) return Promise.resolve(true);
    return new Promise((done) => {
      const req = { tool, input, index: 0, resolve: (ok: boolean) => (approvals.splice(approvals.indexOf(req), 1), done(ok), draw()) };
      approvals.push(req);
      signal.addEventListener("abort", () => approvals.includes(req) && req.resolve(false));
      say(`${toolName(tool)} is waiting for your approval`, 4000);
    });
  }
  const serverOf = (tool: string) => /^mcp__(.+?)__/.exec(tool)?.[1] ?? tool;
  function answer(choice: number) {
    const a = approvals[0];
    if (!a) return;
    if (choice === 1) alwaysAllow.add(serverOf(a.tool));
    notice = "";
    a.resolve(choice !== 2);
  }

  function toggleDrawer() {
    drawer.open = !drawer.open;
    remember({ filesDrawer: drawer.open });
    draw();
  }

  async function revert(file: string) {
    if (await revertFile(resolve(opts.cwd, file))) {
      drawer.changes.delete(file);
      transcript.add({ kind: "note", text: `↺ reverted ${file} to how it was before this session` });
      say(`reverted ${file}`);
      drawer.refresh().then(draw);
    } else say(`${file} was changed outside loom's edit tool; revert it with git`, 4000);
  }

  // ── input ──────────────────────────────────────────────────────────────────
  function onMouse(m: Mouse) {
    const inBody = m.y >= HEADER && m.y < HEADER + view.bodyH;
    if (m.y === 0 && m.release && !m.wheel && m.x >= headerToggle.from && m.x < headerToggle.to) return toggleDrawer();
    if (m.wheel) {
      const step = m.wheel === "up" ? 3 : -3;
      if (m.x >= view.leftW) drawer.scroll = Math.max(0, drawer.scroll - step);
      else scroll = Math.max(0, scroll + step);
      return draw();
    }
    const line = view.top + Math.min(Math.max(m.y - HEADER, 0), view.bodyH - 1);
    const col = Math.max(0, Math.min(m.x, view.leftW - 1));
    if (!m.release && !m.drag) {
      sel = inBody && m.x < view.leftW ? { a: { line, col }, b: { line, col }, moved: false } : null;
      return draw();
    }
    if (m.drag && sel) {
      sel.b = { line, col };
      sel.moved = sel.moved || sel.a.line !== line || sel.a.col !== col;
      // Dragging past the top or bottom edge scrolls.
      if (m.y < HEADER) scroll = Math.min(scroll + 1, view.total);
      else if (m.y >= HEADER + view.bodyH) scroll = Math.max(0, scroll - 1);
      return draw();
    }
    if (!m.release) return;
    if (!sel) {
      // A click in the drawer: open or close a folder, or mention a file in the prompt.
      if (inBody && m.x >= view.leftW) {
        const a = view.drawerActions.get(m.y - HEADER);
        const col = m.x - view.leftW - 2; // past the border and its space
        const btn = a?.buttons?.find((b: any) => col >= b.col && col < b.col + b.w);
        if (btn?.keep) {
          drawer.changes.delete(btn.keep);
          say(`kept ${btn.keep}`);
          return draw();
        }
        if (btn?.revert) {
          if (drawer.confirm?.file === btn.revert && (drawer.confirm?.until ?? 0) > Date.now()) {
            drawer.confirm = null;
            void revert(btn.revert);
          } else {
            drawer.confirm = { file: btn.revert, until: Date.now() + 4000 };
            setTimeout(draw, 4100);
          }
          return draw();
        }
        if (a?.toggle) drawer.toggle(a.toggle);
        if (a?.insert) {
          editor.insert(`${a.insert} `);
          say(`mentioned ${a.insert}`);
        }
      }
      return draw();
    }
    if (sel.moved) {
      const text = selectedText();
      if (text.trim()) copyText(text).then(() => say(`copied ${text.length} chars`));
      return draw(); // the selection stays highlighted until the next key or click
    }
    const a = view.actions.get(sel.a.line);
    sel = null;
    if (a?.copy) {
      const code = a.copy();
      copyText(code).then(() => say(`copied code · ${code.split("\n").length} lines`));
    } else if (a?.toggle) a.toggle();
    draw();
  }

  function onKey(k: Key) {
    if (k.name !== "c" || !k.ctrl) ctrlCArmed = false;
    if (sel && !(k.ctrl && k.name === "c")) sel = null;
    const ask = approvals[0];
    if (ask) {
      if (k.name === "left" || k.name === "up") ask.index = (ask.index + 2) % 3;
      else if (k.name === "right" || k.name === "down" || k.name === "tab") ask.index = (ask.index + 1) % 3;
      else if (k.name === "enter") answer(ask.index);
      else if (k.name === "char" && /^[123yn]$/.test(k.text ?? "")) answer(k.text === "y" ? 0 : k.text === "n" ? 2 : Number(k.text) - 1);
      else if (k.name === "escape") answer(2);
      return draw();
    }
    if (palette) {
      const items = paletteItems(palette.filter);
      if (k.name === "up") palette.index = Math.max(0, palette.index - 1);
      else if (k.name === "down") palette.index = Math.min(items.length - 1, palette.index + 1);
      else if (k.name === "enter") {
        const it = items[palette.index];
        palette = null;
        it?.run();
      } else if (k.name === "escape" || (k.ctrl && (k.name === "c" || k.name === "k"))) palette = null;
      else if (k.name === "backspace") palette.filter = palette.filter.slice(0, -1);
      else if (k.name === "char" && k.text) {
        palette.filter += k.text;
        palette.index = 0;
      }
      return draw();
    }
    if (k.ctrl && k.name === "k") {
      palette = { filter: "", index: 0 };
      return draw();
    }
    if (picker) {
      if (k.name === "up") picker.index = (picker.index + picker.items.length - 1) % picker.items.length;
      else if (k.name === "down") picker.index = (picker.index + 1) % picker.items.length;
      else if (k.name === "enter") {
        const p = picker;
        picker = null;
        p.pick(p.items[p.index]!.value);
      } else if (k.name === "escape" || (k.ctrl && k.name === "c")) picker = null;
      return draw();
    }
    if (k.name === "enter" && !k.shift && !k.alt && !k.ctrl) {
      // A trailing backslash continues the line (works in every terminal).
      if (editor.text.endsWith("\\") && editor.pos === editor.text.length) {
        editor.key({ ...k, name: "backspace" });
        editor.insert("\n");
      } else submit();
      return draw();
    }
    if (k.name === "pageup" || k.name === "pagedown") {
      scroll = Math.max(0, scroll + (k.name === "pageup" ? 1 : -1) * Math.max(1, view.bodyH - 2));
      return draw();
    }
    if (k.name === "tab" && k.shift) return setEffort(efforts[(efforts.indexOf(effort) + 1) % efforts.length]!);
    if (k.name === "tab" && editor.text.startsWith("/")) {
      const hit = slashItems().find(([cmd]) => cmd.startsWith(editor.text));
      if (hit) {
        editor.clear();
        editor.insert(`${hit[0]} `);
      }
      return draw();
    }
    if (k.name === "escape") {
      if (busy()) stop();
      else if (scroll) scroll = 0;
      else editor.clear();
      return draw();
    }
    if (k.ctrl && k.name === "c") {
      if (sel) {
        const text = selectedText();
        sel = null;
        if (text) copyText(text).then(() => say(`copied ${text.length} chars`));
      } else if (editor.text) editor.clear();
      else if (busy()) stop();
      else if (ctrlCArmed) return quit();
      else {
        ctrlCArmed = true;
        say("press ctrl+c again to quit");
      }
      return draw();
    }
    if (k.ctrl && k.name === "d" && !editor.text) return quit();
    if (k.ctrl && k.name === "v") return void pasteClipboardImage();
    if (k.ctrl && k.name === "b") return toggleDrawer();
    if (k.ctrl && k.name === "l") {
      screen.invalidate();
      return draw();
    }
    if (editor.key(k)) draw();
  }

  function onInput(e: InputEvent) {
    if (e.type === "mouse") return onMouse(e);
    if (e.type === "paste") {
      sel = null;
      if (!e.text.trim()) return void pasteClipboardImage(); // ⌘V with only an image on the clipboard
      const imgs = droppedImages(e.text);
      if (imgs) return void addImages(imgs);
      editor.paste(e.text);
      return draw();
    }
    onKey(e);
  }

  // Leaving the alternate screen drops the view, so the conversation is printed into normal scrollback.
  function quit() {
    session?.close();
    screen.stop();
    process.stdin.setRawMode(false);
    const out: string[] = [];
    for (const e of transcript.entries) {
      if (e.kind === "user") out.push("", c.user(`❯ ${e.text}`), "");
      else if (e.kind === "md") out.push(e.raw.trim());
      else if (e.kind === "tool") out.push(c.dim(`  ${e.tool.status === "ok" ? "✓" : "✗"} ${e.tool.name} ${e.tool.summary}`));
    }
    if (out.length) process.stdout.write(`${out.join("\n")}\n\n`);
    process.exit(0);
  }

  // ── start: paint first, connect after ──────────────────────────────────────
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  const parser = new KeyParser(onInput);
  process.stdin.on("data", (d: string) => parser.feed(d));
  process.on("SIGTERM", quit);
  process.on("uncaughtException", (e) => {
    screen.stop();
    process.stdin.setRawMode(false);
    console.error(e);
    process.exit(1);
  });
  drawer.open = settings.filesDrawer;
  for (const w of opts.warnings) transcript.add({ kind: "note", text: `settings: ${w}` });
  // Anything printed directly would tear the frame; library warnings go to a log instead.
  const log = join(homedir(), ".loom", "tui.log");
  await mkdir(join(homedir(), ".loom"), { recursive: true }).catch(() => {});
  const toLog = (...a: unknown[]) => void appendFile(log, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`).catch(() => {});
  console.log = console.warn = console.error = console.info = console.debug = toLog;
  screen.start(() => frame());
  frame();
  preloadGrammars();
  drawer.refresh().then(draw);
  gitBranch(opts.cwd).then((b) => ((branch = b), draw()));
  loadSkills(opts.cwd).then((s) => ((skills = s), draw()));
  import("../update.ts")
    .then((u) => u.updateAvailable())
    .then((v) => v && say(`update available (${v}) · run loomcode --update`, 10_000))
    .catch(() => {});
  await connect();
  await new Promise(() => {}); // run until quit()
}
