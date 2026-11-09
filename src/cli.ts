#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Effort } from "./session.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    verbose: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    plain: { type: "boolean" },
    setup: { type: "boolean" },
    update: { type: "boolean" },
  },
});

if (opts.update) process.exit((await (await import("./update.ts")).update()) ? 0 : 1);

const cwd = process.cwd();
const oneShot = positionals.length > 0;
const { EFFORT_LEVELS, loadSettings } = await import("./settings.ts");
if (opts.effort && !(EFFORT_LEVELS as readonly string[]).includes(opts.effort)) {
  console.error(`--effort must be one of: ${EFFORT_LEVELS.join(", ")}`);
  process.exit(2);
}

const interactive = !oneShot && !opts.json && !opts.plain && process.stdin.isTTY && process.stdout.isTTY;
let loaded = await loadSettings(cwd);
// Onboarding: on request, or on the first interactive run.
if (opts.setup || (interactive && !loaded.configured)) {
  const ok = await (await import("./setup.ts")).setup();
  if (!ok || opts.setup) process.exit(ok ? 0 : 1);
  loaded = await loadSettings(cwd);
}
// Flags win over the settings files.
const { settings, warnings } = loaded;
const effort = (opts.effort ?? settings.effort) as Effort;
const model = opts.model ?? settings.model;

// An interactive terminal gets the TUI; prompts on the command line, pipes and --json stay plain (benchmarks use these).
if (interactive) {
  const { runTui } = await import("./tui/app.ts");
  await runTui({ cwd, model, effort, settings, warnings });
} else {
  for (const w of warnings) console.error(`\x1b[2msettings: ${w}\x1b[0m`);
  await runPlain();
}

async function runPlain() {
  const { openSession } = await import("./session.ts");
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const session = await openSession({
    cwd,
    model,
    effort,
    autoCompact: settings.autoCompact,
    provider: settings.provider,
    webSearch: settings.webSearch,
    onCheckpoint: (p) => console.log(dim(`[checkpoint saved: ${p}]`)),
  });

  let sent = 0;
  const { expandSkill, loadSkills } = await import("./skills.ts");
  const skills = await loadSkills(cwd);
  // `/name request` runs that skill; anything else goes as typed.
  const send = async (text: string) => {
    const prompt = text.startsWith("/") ? await expandSkill(text, skills) : null;
    sent = performance.now();
    if (session.send(prompt ?? text)) console.log(dim(`[compacting: ${session.context} tokens in context]`));
  };
  const rl = oneShot ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  async function ask() {
    const line = await rl!.question("\n› ").catch(() => null);
    if (line === null || line.trim() === "/exit") {
      rl!.close();
      session.close();
    } else if (line.trim()) send(line);
    else await ask();
  }

  let started = false;
  if (oneShot) send(positionals.join(" "));
  else await ask();

  for await (const m of session.messages) {
    session.track(m);
    if (m.type === "system" && m.subtype === "init") {
      if (started) continue; // claude re-sends init on every prompt
      started = true;
      console.log(dim(`loom · ${m.model} · effort ${effort} · auth: ${m.apiKeySource} · tools: ${m.tools.join(", ")}`));
    } else if (m.type === "system" && m.subtype === "compact_boundary") {
      const c = m.compact_metadata;
      console.log(dim(`[compacted (${c.trigger}): ${c.pre_tokens} → ${c.post_tokens ?? "?"} tokens]`));
    } else if (m.type === "stream_event") {
      const e = m.event;
      if (e.type === "content_block_delta" && e.delta.type === "text_delta") process.stdout.write(e.delta.text);
    } else if (m.type === "assistant") {
      for (const b of m.message.content) {
        if (b.type === "tool_use") {
          const arg = JSON.stringify(b.input);
          console.log(dim(`\n· ${b.name.replace("mcp__loom__", "")} ${arg.length > 120 ? arg.slice(0, 117) + "..." : arg}`));
        }
      }
    } else if (m.type === "result") {
      const u = m.usage;
      if (opts.json) console.error(JSON.stringify(m));
      console.log(
        dim(
          `\n[${m.subtype} · ${m.num_turns} turns · ${((performance.now() - sent) / 1000).toFixed(1)}s · ttft ${(m.subtype === "success" && m.ttft_ms) || "?"}ms · ` +
            `in ${u.input_tokens} + cache read ${u.cache_read_input_tokens} + cache write ${u.cache_creation_input_tokens} · out ${u.output_tokens} · context ${session.context}]`,
        ),
      );
      if (session.inFlight > 0) continue; // a queued prompt (e.g. after /compact) is still running
      if (oneShot) session.close();
      else await ask();
    } else if (opts.verbose) {
      console.log(dim(JSON.stringify(m).slice(0, 300)));
    }
  }
}
