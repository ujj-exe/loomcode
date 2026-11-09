
// Web search and page reading through the provider the user picked in setup. The API key lives in the
// system keychain (macOS Keychain via Bun.secrets), never in a file; the choice lives in settings (webSearch).
export type Provider = "exa" | "firecrawl" | "context";
export type Hit = { title: string; url: string; text: string };
type Api = {
  label: string;
  keys: string; // where to get a key
  search(query: string, n: number, key: string): Promise<Hit[]>;
  fetch(url: string, key: string): Promise<string>;
};

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export const PROVIDERS: Record<Provider, Api> = {
  exa: {
    label: "Exa",
    keys: "https://dashboard.exa.ai/api-keys",
    search: async (query, n, key) =>
      (await post("https://api.exa.ai/search", { "x-api-key": key }, { query, type: "auto", numResults: n, contents: { highlights: true } })).results.map(
        (r: any) => ({ title: r.title ?? "", url: r.url, text: (r.highlights ?? []).join(" … ") }),
      ),
    fetch: async (url, key) => (await post("https://api.exa.ai/contents", { "x-api-key": key }, { urls: [url], text: true })).results?.[0]?.text ?? "",
  },
  firecrawl: {
    label: "Firecrawl",
    keys: "https://www.firecrawl.dev/app/api-keys",
    search: async (query, n, key) =>
      ((await post("https://api.firecrawl.dev/v2/search", bearer(key), { query, limit: n })).data?.web ?? []).map((r: any) => ({
        title: r.title ?? "",
        url: r.url,
        text: r.description ?? "",
      })),
    fetch: async (url, key) =>
      (await post("https://api.firecrawl.dev/v2/scrape", bearer(key), { url, formats: ["markdown"], onlyMainContent: true })).data?.markdown ?? "",
  },
  context: {
    label: "Context.dev",
    keys: "https://www.context.dev/signup",
    search: async (query, n, key) =>
      (await post("https://api.context.dev/v1/web/search", bearer(key), { query, numResults: n, highlightsOptions: { enabled: true } })).results.map(
        (r: any) => ({ title: r.title ?? "", url: r.url, text: (r.highlights?.highlights ?? []).join(" … ") || (r.description ?? "") }),
      ),
    fetch: async (url, key) => (await post("https://api.context.dev/v1/web/scrape", bearer(key), { url, formats: { markdown: true } })).markdown?.data ?? "",
  },
};

export const formatHits = (hits: Hit[]) =>
  hits.map((h, i) => `${i + 1}. ${h.title || h.url}\n   ${h.url}${h.text ? `\n   ${h.text.replace(/\s+/g, " ").trim()}` : ""}`).join("\n\n") || "(no results)";

const SERVICE = "loomcode";
export const getKey = (p: Provider) => Bun.secrets.get({ service: SERVICE, name: p });
export const saveKey = (p: Provider, value: string) => Bun.secrets.set({ service: SERVICE, name: p, value });

// The chosen provider (settings' webSearch) with its key, or null when web access is off or the key is gone.
export async function webAccess(p: Provider | null | undefined): Promise<{ provider: Provider; key: string } | null> {
  if (!p || !PROVIDERS[p]) return null;
  const key = await getKey(p).catch(() => null);
  return key ? { provider: p, key } : null;
}
