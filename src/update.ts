// `loomcode --update` and the once-a-day "update available" check.
//
// Two ways loomcode gets installed:
// - a clone (`bun link`, or a shim pointing at src/cli.ts): updating is `git pull` + `bun install`.
// - `bun add -g github:ujj-exe/loomcode`: bun pins the commit in its global lockfile and re-running `add`
//   keeps that pin, even with a newer `#sha`. So an update removes the package and adds the latest commit.

import { $ } from "bun";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const REPO = "ujj-exe/loomcode";
const ROOT = dirname(import.meta.dir); // package root: src/..
const STATE = join(homedir(), ".loom", "update.json");
const DAY = 86_400_000;
const bun = process.execPath;

type Install = { kind: "clone"; dir: string } | { kind: "global"; dir: string; sha?: string } | { kind: "unknown" };

async function install(): Promise<Install> {
  if (existsSync(join(ROOT, ".git"))) return { kind: "clone", dir: ROOT };
  // Global installs live at <global dir>/node_modules/loomcode; the lockfile there records the commit.
  if (basename(dirname(ROOT)) !== "node_modules") return { kind: "unknown" };
  const dir = dirname(dirname(ROOT));
  const lock = await Bun.file(join(dir, "bun.lock")).text().catch(() => "");
  const sha = lock.match(/loomcode@github:ujj-exe\/loomcode#([0-9a-f]+)/)?.[1];
  return { kind: "global", dir, sha };
}

// Latest commit on main, or undefined when offline. The API's sha media type returns the bare hash.
async function latest(): Promise<string | undefined> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
    headers: { Accept: "application/vnd.github.sha", "User-Agent": "loomcode" },
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const sha = (await res.text()).trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export async function update(): Promise<boolean> {
  const at = await install();
  if (at.kind === "clone") {
    console.log(dim(`updating the clone at ${at.dir}`));
    const pull = await $`git -C ${at.dir} pull --ff-only`.nothrow();
    if (pull.exitCode !== 0) return console.error("git pull failed; commit or stash local changes and try again"), false;
    const deps = await $`${bun} install`.cwd(at.dir).nothrow();
    if (deps.exitCode !== 0) return console.error("bun install failed"), false;
    const head = (await $`git -C ${at.dir} rev-parse --short HEAD`.text()).trim();
    console.log(`loomcode is at ${head}`);
    return true;
  }
  if (at.kind === "unknown") {
    console.error(`loomcode was not installed with bun or from a clone. Reinstall with:\n  bun add -g github:${REPO}`);
    return false;
  }

  const sha = await latest();
  if (!sha) return console.error("couldn't reach GitHub to check for updates"), false;
  if (at.sha && same(sha, at.sha)) {
    console.log(`loomcode is up to date (${at.sha.slice(0, 7)})`);
    await remember(sha);
    return true;
  }
  const to = sha.slice(0, 7);
  console.log(dim(`updating loomcode ${at.sha?.slice(0, 7) ?? "?"} → ${to}`));
  await $`${bun} remove -g loomcode`.quiet().nothrow();
  const add = await $`${bun} add -g github:${REPO}#${to}`.nothrow();
  if (add.exitCode !== 0) {
    // Don't leave the user without a loomcode: put the previous commit back.
    if (at.sha) await $`${bun} add -g github:${REPO}#${at.sha}`.quiet().nothrow();
    console.error("update failed; the previous version is still installed");
    return false;
  }
  await remember(sha);
  console.log(`loomcode updated to ${to}`);
  return true;
}

async function remember(sha: string) {
  await mkdir(dirname(STATE), { recursive: true }).catch(() => {});
  await Bun.write(STATE, JSON.stringify({ checked: Date.now(), latest: sha })).catch(() => {});
}

// For global installs, the newer commit (short) if main has moved on. Hits GitHub at most once a day.
// Clones are skipped: a working copy is usually ahead of main, not behind it.
export async function updateAvailable(): Promise<string | undefined> {
  const at = await install();
  if (at.kind !== "global" || !at.sha) return undefined;
  const state = (await Bun.file(STATE).json().catch(() => ({}))) as { checked?: number; latest?: string };
  let sha = state.latest;
  if (!sha || !state.checked || Date.now() - state.checked > DAY) {
    sha = await latest();
    if (sha) await remember(sha);
  }
  return sha && !same(sha, at.sha) ? sha.slice(0, 7) : undefined;
}
