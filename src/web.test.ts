import { afterEach, expect, test } from "bun:test";
import { MAX_LINES, webPage } from "./tools.ts";
import { formatHits, PROVIDERS } from "./web.ts";

// Each provider's request shape and response parsing, against a fake fetch that records the call.
const real = globalThis.fetch;
afterEach(() => (globalThis.fetch = real));
function fake(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test("exa: search and fetch", async () => {
  let calls = fake(200, { results: [{ title: "T", url: "https://a", highlights: ["one", "two"] }] });
  expect(await PROVIDERS.exa.search("q", 3, "K")).toEqual([{ title: "T", url: "https://a", text: "one … two" }]);
  expect(calls[0]).toMatchObject({ url: "https://api.exa.ai/search", headers: { "x-api-key": "K" }, body: { query: "q", numResults: 3 } });
  calls = fake(200, { results: [{ text: "# page" }] });
  expect(await PROVIDERS.exa.fetch("https://a", "K")).toBe("# page");
  expect(calls[0]).toMatchObject({ url: "https://api.exa.ai/contents", body: { urls: ["https://a"] } });
});

test("firecrawl: search and fetch", async () => {
  let calls = fake(200, { success: true, data: { web: [{ title: "T", url: "https://a", description: "d" }] } });
  expect(await PROVIDERS.firecrawl.search("q", 2, "K")).toEqual([{ title: "T", url: "https://a", text: "d" }]);
  expect(calls[0]).toMatchObject({ url: "https://api.firecrawl.dev/v2/search", headers: { authorization: "Bearer K" }, body: { query: "q", limit: 2 } });
  calls = fake(200, { success: true, data: { markdown: "# page" } });
  expect(await PROVIDERS.firecrawl.fetch("https://a", "K")).toBe("# page");
  expect(calls[0]!.url).toBe("https://api.firecrawl.dev/v2/scrape");
});

test("context.dev: search falls back to the description; fetch reads markdown.data", async () => {
  let calls = fake(200, { results: [{ title: "T", url: "https://a", description: "d", highlights: null }] });
  expect(await PROVIDERS.context.search("q", 4, "K")).toEqual([{ title: "T", url: "https://a", text: "d" }]);
  expect(calls[0]).toMatchObject({ url: "https://api.context.dev/v1/web/search", headers: { authorization: "Bearer K" }, body: { query: "q", numResults: 4 } });
  calls = fake(200, { markdown: { data: "# page" } });
  expect(await PROVIDERS.context.fetch("https://a", "K")).toBe("# page");
  expect(calls[0]).toMatchObject({ url: "https://api.context.dev/v1/web/scrape", body: { formats: { markdown: true } } });
});

test("a rejected key surfaces the status and the provider's message", async () => {
  fake(401, { error: "invalid api key" });
  await expect(PROVIDERS.exa.search("q", 1, "bad")).rejects.toThrow(/api\.exa\.ai answered 401: .*invalid api key/);
});

test("results format compactly; long pages are capped and saved whole", async () => {
  expect(formatHits([])).toBe("(no results)");
  expect(formatHits([{ title: "", url: "https://a", text: "x\n  y" }])).toBe("1. https://a\n   https://a\n   x y");
  const page = Array.from({ length: MAX_LINES + 50 }, (_, i) => `line ${i + 1}`).join("\n");
  const r = await webPage(page);
  expect(r.text.split("\n")).toHaveLength(MAX_LINES);
  const saved = /full page: (\S+)/.exec(r.note!)![1]!;
  expect(await Bun.file(saved).text()).toBe(page);
});
