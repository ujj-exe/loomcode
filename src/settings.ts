// User-editable settings: ~/.loom/settings.json, overridden key by key by the project's .loom/settings.json,
// and by command-line flags over both. Read once at startup, so they cost nothing per turn; none of them
// touches the system prompt, which stays cached.
//
// API keys never go here: the web search key lives in the system keychain (see web.ts).

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export const PROVIDER_NAMES = ["anthropic", "bedrock", "vertex"] as const;
export const WEB_NAMES = ["exa", "firecrawl", "context"] as const;

export type Settings = {
  model?: string; // unset: Claude Code's default
  effort: (typeof EFFORT_LEVELS)[number];
  autoCompact: { enabled: boolean; atTokens: number };
  provider: (typeof PROVIDER_NAMES)[number]; // where Claude runs: Anthropic's API, Amazon Bedrock or Google Vertex
  webSearch: (typeof WEB_NAMES)[number] | null;
  filesDrawer: boolean;
  connectors: boolean; // claude.ai connectors: ~30k tokens of tool definitions, so off by default
};

export const DEFAULTS: Settings = {
  effort: "medium",
  autoCompact: { enabled: true, atTokens: 150_000 },
  provider: "anthropic",
  webSearch: null,
  filesDrawer: true,
  connectors: false,
};

export const userFile = (home = homedir()) => join(home, ".loom", "settings.json");
export const projectFile = (cwd: string) => join(cwd, ".loom", "settings.json");

const oneOf = <T extends string>(list: readonly T[]) => (v: unknown) => (list as readonly unknown[]).includes(v);
const CHECKS: Record<keyof Settings, [(v: unknown) => boolean, string]> = {
  model: [(v) => typeof v === "string" && v.trim() !== "", "a model id such as claude-opus-5-5"],
  effort: [oneOf(EFFORT_LEVELS), EFFORT_LEVELS.join(", ")],
  autoCompact: [
    (v) => {
      const o = v as Settings["autoCompact"];
      return !!o && typeof o === "object" && (o.enabled === undefined || typeof o.enabled === "boolean") &&
        (o.atTokens === undefined || (Number.isInteger(o.atTokens) && o.atTokens >= 10_000));
    },
    `{ "enabled": true/false, "atTokens": 10000 or more }`,
  ],
  provider: [oneOf(PROVIDER_NAMES), PROVIDER_NAMES.join(", ")],
  webSearch: [(v) => v === null || oneOf(WEB_NAMES)(v), `${WEB_NAMES.join(", ")} or null`],
  filesDrawer: [(v) => typeof v === "boolean", "true or false"],
  connectors: [(v) => typeof v === "boolean", "true or false"],
};

// Valid keys of one file; anything else becomes a warning naming the file, the key and what it accepts.
function check(raw: unknown, file: string, warnings: string[]): Partial<Settings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`${file}: expected a JSON object, ignoring it`);
    return {};
  }
  const out: Partial<Settings> = {};
  for (const [k, v] of Object.entries(raw)) {
    const rule = CHECKS[k as keyof Settings];
    if (!rule) warnings.push(`${file}: unknown setting "${k}"`);
    else if (!rule[0](v)) warnings.push(`${file}: "${k}" must be ${rule[1]}`);
    else (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

async function readJson(file: string): Promise<{ value?: unknown; exists: boolean; error?: string }> {
  const f = Bun.file(file);
  if (!(await f.exists())) return { exists: false };
  try {
    return { value: JSON.parse(await f.text()), exists: true };
  } catch (e) {
    return { exists: true, error: (e as Error).message };
  }
}

// Settings from before settings.json: code.json held the web provider, tui.json the drawer and connectors.
async function migrate(home: string): Promise<boolean> {
  const code = await readJson(join(home, ".loom", "code.json"));
  const tui = await readJson(join(home, ".loom", "tui.json"));
  if (!code.exists && !tui.exists) return false;
  const c = (code.value ?? {}) as { web?: unknown };
  const t = (tui.value ?? {}) as { drawer?: unknown; connectors?: unknown };
  const s: Partial<Settings> = {};
  if (c.web === null || oneOf(WEB_NAMES)(c.web)) s.webSearch = c.web as Settings["webSearch"];
  if (typeof t.drawer === "boolean") s.filesDrawer = t.drawer;
  if (typeof t.connectors === "boolean") s.connectors = t.connectors;
  await write(userFile(home), s);
  return true;
}

async function write(file: string, value: object) {
  await mkdir(dirname(file), { recursive: true }).catch(() => {});
  await Bun.write(file, JSON.stringify(value, null, 2) + "\n");
}

// `configured` is false until a user settings file exists: the first interactive run then offers setup.
export async function loadSettings(cwd: string, home = homedir()): Promise<{ settings: Settings; warnings: string[]; configured: boolean }> {
  const warnings: string[] = [];
  const configured = (await Bun.file(userFile(home)).exists()) || (await migrate(home));
  const files: [string, string][] = [[userFile(home), "~/.loom/settings.json"]];
  // Run from the home folder, the project file is the user file: read it once.
  if (projectFile(cwd) !== userFile(home)) files.push([projectFile(cwd), ".loom/settings.json"]);
  const layers: Partial<Settings>[] = [];
  for (const [file, label] of files) {
    const r = await readJson(file);
    if (r.error) warnings.push(`${label}: not valid JSON (${r.error}), ignoring it`);
    else if (r.exists) layers.push(check(r.value, label, warnings));
  }
  const settings: Settings = { ...DEFAULTS, autoCompact: { ...DEFAULTS.autoCompact } };
  for (const l of layers) {
    const { autoCompact, ...rest } = l;
    Object.assign(settings, rest);
    if (autoCompact) Object.assign(settings.autoCompact, autoCompact);
  }
  return { settings, warnings, configured };
}

// Saves choices made inside loomcode (/model, /effort, the drawer) to the user file, keeping every other key
// and the user's own unknown keys as they are. A broken file is left alone rather than overwritten.
export async function saveSettings(patch: Partial<Settings>, home = homedir()): Promise<boolean> {
  const file = userFile(home);
  const r = await readJson(file);
  if (r.error || (r.exists && (typeof r.value !== "object" || r.value === null || Array.isArray(r.value)))) return false;
  const current = (r.value ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current, ...patch };
  if (patch.autoCompact) next.autoCompact = { ...(current.autoCompact as object), ...patch.autoCompact };
  await write(file, next);
  return true;
}

// Compact before a new prompt once the context passes this many tokens (Infinity: off). Every turn re-reads the
// whole context, so a bounded context bounds per-turn cost, not just the window. Never past 95% of the window.
export const compactThreshold = (s: Settings["autoCompact"], window: number) =>
  s.enabled ? Math.min(s.atTokens, Math.floor(window * 0.95)) : Infinity;

// Environment for claude when Claude runs somewhere other than Anthropic's API (the cloud's own credentials apply).
export const providerEnv = (p: Settings["provider"]): Record<string, string> =>
  p === "bedrock" ? { CLAUDE_CODE_USE_BEDROCK: "1" } : p === "vertex" ? { CLAUDE_CODE_USE_VERTEX: "1" } : {};
