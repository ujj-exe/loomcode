import { tokenizeWith, type ShjLanguageData } from "@speed-highlight/core/tokenize";
import { tokenColor } from "./ansi.ts";

const ALIAS: Record<string, string> = {
  ts: "ts", tsx: "ts", typescript: "ts", mts: "ts", cts: "ts",
  js: "js", jsx: "js", javascript: "js", mjs: "js", cjs: "js",
  py: "py", python: "py", rs: "rs", rust: "rs", go: "go", golang: "go",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash", console: "bash", shellscript: "bash",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", hpp: "c", java: "java", kotlin: "java", swift: "java",
  sql: "sql", html: "html", xml: "xml", svg: "xml", css: "css", scss: "css",
  diff: "diff", patch: "diff", md: "md", markdown: "md", lua: "lua", docker: "docker", dockerfile: "docker",
  make: "make", makefile: "make", regex: "regex", log: "log", http: "http",
};

const loaded: Record<string, ShjLanguageData> = {};
const loading = new Set<string>();

function load(name: string) {
  if (loaded[name] || loading.has(name)) return;
  loading.add(name);
  import(`@speed-highlight/core/languages/${name}.js`)
    .then((m) => {
      loaded[name] = m.default;
      // Grammars embed others by name (ts uses js, md uses many); fetch those the moment they are asked for.
    })
    .catch(() => {})
    .finally(() => loading.delete(name));
}

// Warm the common grammars in the background so the first code block is already colored.
export function preloadGrammars() {
  for (const n of ["ts", "js", "bash", "json", "py", "diff", "md", "yaml", "rs", "go", "css", "html"]) load(n);
}

export const langOf = (tag: string) => ALIAS[tag.toLowerCase()] ?? (tag ? tag.toLowerCase() : "");

// Highlights a whole code block and returns its lines. Unknown or still-loading grammars render plain.
export function highlight(code: string, tag: string): string[] {
  const name = langOf(tag);
  const grammar = name ? loaded[name] : undefined;
  if (name && !grammar) load(name);
  if (!grammar) return code.split("\n");
  let out = "";
  try {
    tokenizeWith(code, grammar, (text, type) => {
      const paint = type ? tokenColor[type] : undefined;
      // Color per line so every output line stands alone (each is committed separately).
      out += paint ? text.split("\n").map((t) => (t ? paint(t) : t)).join("\n") : text;
    }, { languages: loaded });
  } catch {
    return code.split("\n");
  }
  return out.split("\n");
}
