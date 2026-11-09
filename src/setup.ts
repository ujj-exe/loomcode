import { findClaude } from "./session.ts";
import { type Config, loadConfig, type Provider, PROVIDERS, saveConfig, saveKey } from "./web.ts";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const good = (s: string) => `\x1b[32m${s}\x1b[0m`;
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`;
const out = (s = "") => process.stdout.write(s + "\n");

// Reads one line from the terminal. `hidden` echoes nothing, for API keys. Ctrl+C quits.
export function ask(question: string, hidden = false): Promise<string> {
  process.stdout.write(question);
  return new Promise((done) => {
    let line = "";
    const { stdin } = process;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (b: Buffer) => {
      for (const ch of b.toString("utf8").replace(/\x1b\[20[01]~/g, "")) { // drop bracketed-paste markers
        if (ch === "\x03") {
          stdin.setRawMode(false);
          out();
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          out(hidden && line ? dim(`(${line.length} characters)`) : "");
          return done(line.trim());
        } else if (ch === "\x7f" || ch === "\b") {
          if (!line) continue;
          line = line.slice(0, -1);
          if (!hidden) process.stdout.write("\b \b");
        } else if (ch >= " ") {
          line += ch;
          if (!hidden) process.stdout.write(ch);
        }
      }
    };
    stdin.on("data", onData);
  });
}

// Claude Code does the model calls on the user's own login, so it must be installed and signed in.
async function checkClaude(): Promise<boolean> {
  const claude = findClaude();
  if (!claude) {
    out(`${bad("✗")} Claude Code not found. loomcode runs on your Claude Code login. Install it, then run ${dim("claude")} once to sign in:`);
    out(`  curl -fsSL https://claude.ai/install.sh | bash`);
    return false;
  }
  const run = (args: string[]) => Bun.spawnSync([claude, ...args], { stdout: "pipe", stderr: "pipe", timeout: 20_000 }).stdout.toString().trim();
  const version = run(["--version"]).split(" ")[0] || "?";
  let auth: { loggedIn?: boolean; authMethod?: string } = {};
  try {
    auth = JSON.parse(run(["auth", "status"]));
  } catch {} // older claude without `auth status`: the first session will tell
  if (auth.loggedIn === false) {
    out(`${bad("✗")} Claude Code ${version} is installed but not signed in. Run ${dim("claude")} and sign in, then run loomcode again.`);
    return false;
  }
  out(`${good("✓")} Claude Code ${version}${auth.authMethod ? ` · signed in (${auth.authMethod})` : ""} ${dim(claude)}`);
  return true;
}

async function chooseWeb(current: Config | null): Promise<Provider | null> {
  const ids = Object.keys(PROVIDERS) as Provider[];
  out(`\nWeb search ${dim("(optional)")} — loomcode can't search the web unless you pick a provider:`);
  ids.forEach((id, i) => out(`  ${i + 1}  ${PROVIDERS[id].label.padEnd(12)}${dim(PROVIDERS[id].keys)}`));
  const keep = current?.web ? `, or k to keep ${PROVIDERS[current.web].label}` : "";
  while (true) {
    const a = (await ask(`Pick 1-${ids.length}, Enter to skip${keep}: `)).toLowerCase();
    if (!a) return null;
    if (a === "k" && current?.web) return current.web;
    const p = ids[Number(a) - 1];
    if (!p) continue;
    const api = PROVIDERS[p];
    // The key is tested with one real search before it is saved, so a typo shows up now, not mid-task.
    while (true) {
      const key = await ask(`Paste your ${api.label} API key ${dim("(hidden; Enter to go back)")}: `, true);
      if (!key) break;
      process.stdout.write(dim("checking… "));
      try {
        await api.search("Claude Code", 1, key);
      } catch (e: any) {
        out(`${bad("✗")} ${String(e?.message ?? e).slice(0, 200)}`);
        continue;
      }
      await saveKey(p, key);
      out(`${good("✓")} works · saved to your keychain (service "loomcode", account "${p}")`);
      return p;
    }
  }
}

// First run (no ~/.loom/code.json) or `loomcode --setup`. Returns false when loomcode can't run yet.
export async function setup(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    out("loomcode --setup needs an interactive terminal.");
    return false;
  }
  out(`\n\x1b[1mloomcode setup\x1b[0m\n`);
  if (!(await checkClaude())) return false;
  const current = await loadConfig();
  const web = await chooseWeb(current);
  await saveConfig({ ...current, web });
  out(web ? `\nWeb search: ${PROVIDERS[web].label}.` : `\nNo web search. Run ${dim("loomcode --setup")} any time to add it.`);
  out("");
  return true;
}
