import { expect, test } from "bun:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactThreshold, DEFAULTS, loadSettings, providerEnv, saveSettings, userFile } from "./settings.ts";

const temp = (p: string) => mkdtemp(join(tmpdir(), p));
const put = async (file: string, text: string) => {
  await mkdir(join(file, ".."), { recursive: true });
  await Bun.write(file, text);
};

test("no files: defaults, not configured", async () => {
  const r = await loadSettings(await temp("proj-"), await temp("home-"));
  expect(r).toEqual({ settings: DEFAULTS, warnings: [], configured: false });
});

test("project file overrides the user file key by key, autoCompact merged", async () => {
  const home = await temp("home-"), proj = await temp("proj-");
  await put(userFile(home), JSON.stringify({ model: "claude-opus-5-5", effort: "high", autoCompact: { atTokens: 120000 }, webSearch: "exa" }));
  await put(join(proj, ".loom", "settings.json"), JSON.stringify({ effort: "low", autoCompact: { enabled: false } }));
  const { settings, warnings, configured } = await loadSettings(proj, home);
  expect(configured).toBe(true);
  expect(warnings).toEqual([]);
  expect(settings).toEqual({ ...DEFAULTS, model: "claude-opus-5-5", effort: "low", autoCompact: { enabled: false, atTokens: 120000 }, webSearch: "exa" });
});

test("bad values and unknown keys warn and fall back; broken JSON is ignored", async () => {
  const home = await temp("home-"), proj = await temp("proj-");
  await put(userFile(home), JSON.stringify({ effort: "turbo", autoCompact: { atTokens: 5 }, colour: "red", filesDrawer: false }));
  await put(join(proj, ".loom", "settings.json"), "{ effort: low }");
  const { settings, warnings } = await loadSettings(proj, home);
  expect(settings).toEqual({ ...DEFAULTS, filesDrawer: false });
  expect(warnings).toHaveLength(4);
  expect(warnings[0]).toContain('"effort" must be low, medium, high, xhigh, max');
  expect(warnings[1]).toContain('"autoCompact" must be');
  expect(warnings[2]).toContain('unknown setting "colour"');
  expect(warnings[3]).toStartWith(".loom/settings.json: not valid JSON");
});

test("old code.json and tui.json become settings.json", async () => {
  const home = await temp("home-");
  await put(join(home, ".loom", "code.json"), JSON.stringify({ web: "firecrawl" }));
  await put(join(home, ".loom", "tui.json"), JSON.stringify({ drawer: false, connectors: true }));
  const { settings, configured } = await loadSettings(await temp("proj-"), home);
  expect(configured).toBe(true);
  expect(settings).toMatchObject({ webSearch: "firecrawl", filesDrawer: false, connectors: true });
  expect(await Bun.file(userFile(home)).json()).toEqual({ webSearch: "firecrawl", filesDrawer: false, connectors: true });
});

test("saveSettings keeps other keys, refuses to overwrite a broken file", async () => {
  const home = await temp("home-");
  await put(userFile(home), JSON.stringify({ effort: "high", myNote: "keep me", autoCompact: { atTokens: 90000 } }));
  expect(await saveSettings({ model: "claude-sonnet-5-5", autoCompact: { enabled: false } as never }, home)).toBe(true);
  expect(await Bun.file(userFile(home)).json()).toEqual({ effort: "high", myNote: "keep me", model: "claude-sonnet-5-5", autoCompact: { atTokens: 90000, enabled: false } });
  await Bun.write(userFile(home), "{ not json");
  expect(await saveSettings({ effort: "low" }, home)).toBe(false);
  expect(await Bun.file(userFile(home)).text()).toBe("{ not json");
});

test("compaction threshold and provider env", () => {
  expect(compactThreshold({ enabled: true, atTokens: 150000 }, 200000)).toBe(150000);
  expect(compactThreshold({ enabled: true, atTokens: 300000 }, 200000)).toBe(190000);
  expect(compactThreshold({ enabled: false, atTokens: 150000 }, 200000)).toBe(Infinity);
  expect(providerEnv("anthropic")).toEqual({});
  expect(providerEnv("bedrock")).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1" });
  expect(providerEnv("vertex")).toEqual({ CLAUDE_CODE_USE_VERTEX: "1" });
});
