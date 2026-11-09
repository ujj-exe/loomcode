// Code mode (idea from pi's codemode, MIT): the model writes a script that calls our tools, and only the
// script's printed output and return value enter the context. Runs in a Worker so a timeout can kill it.
// Not a sandbox: scripts can already run anything through tools.shell.
import type { Impl, ToolResult } from "./tools.ts";
import { cap, render } from "./tools.ts";

export function runScript(code: string, impl: Impl, timeoutS: number): Promise<ToolResult> {
  const worker = new Worker(new URL("./script-worker.ts", import.meta.url).href);
  const out: string[] = [];
  let calls = 0;
  return new Promise((done) => {
    const finish = (tail: string, isError: boolean) => {
      clearTimeout(timer);
      worker.terminate();
      const body = [...out, tail].filter(Boolean).join("\n") || "(no output)";
      const c = cap(body, "head");
      const text = c ? `${c.text}\n[output cut to ${c.shown} of ${c.total} lines; print less]` : body;
      done({ text: `${text}\n[${calls} tool call${calls === 1 ? "" : "s"}]`, isError });
    };
    const timer = setTimeout(() => finish(`[script timed out after ${timeoutS}s]`, true), timeoutS * 1000);
    worker.onmessage = async ({ data }) => {
      if (data.type === "out") out.push(data.text);
      else if (data.type === "call") {
        calls++;
        const fn = impl[data.name as keyof Impl] as ((a: unknown) => Promise<ToolResult>) | undefined;
        let r: ToolResult;
        try {
          r = fn ? await fn(data.args ?? {}) : { text: `unknown tool: ${data.name}`, isError: true };
        } catch (e) {
          r = { text: String(e), isError: true };
        }
        // Scripts get clean data; a failure throws with the full rendering (output + exit status).
        if (r.cut && r.raw === undefined) out.push(`[${data.name}: ${r.note}]`);
        worker.postMessage({ type: "result", id: data.id, isError: r.isError, text: r.isError ? render(r) : (r.raw ?? r.text) });
      } else if (data.type === "done") {
        if (data.error) finish(`error: ${data.error}`, true);
        else finish(data.value === undefined ? "" : `return: ${data.value}`, false);
      }
    };
    worker.onerror = (e) => finish(`error: ${e.message}`, true);
    worker.postMessage({ type: "run", code });
  });
}
