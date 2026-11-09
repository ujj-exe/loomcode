import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import type { Effort } from "./session.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    effort: { type: "string", default: "medium" },
    verbose: { type: "boolean", short: "v" },
    json: { type: "boolean" },
    plain: { type: "boolean" },
  },
});

const cwd = process.cwd();
const effort = opts.effort as Effort;
const oneShot = positionals.length > 0;

// An interactive terminal gets the TUI; prompts on the command line, pipes and --json stay plain (benchmarks use these).
if (!oneShot && !opts.json && !opts.plain && process.stdin.isTTY && process.stdout.isTTY) {
  const { runTui } = await import("./tui/app.ts");
  await runTui({ cwd, model: opts.model, effort });
} else {
  await runPlain();
}

async function runPlain() {
  const { openSession } = await import("./session.ts");
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const session = await openSession({ cwd, model: opts.model, effort, onCheckpoint: (p) => console.log(dim(`[checkpoint saved: ${p}]`)) });

  let sent = 0;
  const send = (text: string) => {
    sent = performance.now();
    if (session.send(text)) console.log(dim(`[compacting: ${session.context} tokens in context]`));
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
