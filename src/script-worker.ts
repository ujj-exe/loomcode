declare var self: Worker;

const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));
const print = (...v: unknown[]) => postMessage({ type: "out", text: v.map(show).join(" ") });
console.log = console.info = console.warn = console.error = console.debug = print;
process.on("unhandledRejection", (e) => print(`unhandled rejection: ${e}`));

let seq = 0;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();
const call = (name: string) => (args: unknown) =>
  new Promise<string>((resolve, reject) => {
    pending.set(++seq, { resolve, reject });
    postMessage({ type: "call", id: seq, name, args });
  });
const tools = { read: call("read"), search: call("search"), edit: call("edit"), shell: call("shell") };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

self.onmessage = async ({ data }) => {
  if (data.type === "result") {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (data.isError) p?.reject(new Error(data.text));
    else p?.resolve(data.text);
  } else if (data.type === "run") {
    try {
      const value = await new AsyncFunction("tools", "print", data.code)(tools, print);
      postMessage({ type: "done", value: value === undefined ? undefined : show(value) });
    } catch (e) {
      const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      postMessage({ type: "done", error: err });
    }
  }
};
