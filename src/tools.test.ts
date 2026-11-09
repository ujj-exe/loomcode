import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits } from "./edit.ts";
import { loomImpl, render } from "./tools.ts";
import { runScript } from "./script.ts";

const dir = mkdtempSync(join(tmpdir(), "loom-test-"));
const impl = loomImpl(dir);
const okText = (r: ReturnType<typeof applyEdits>) => (r.ok ? r.text : `ERR ${r.error}`);

test("edits are matched against the original, not each other's output", () => {
  const r = applyEdits("a\nb\nc\n", [
    { old_text: "a", new_text: "b" },
    { old_text: "b", new_text: "x" },
  ]);
  expect(okText(r)).toBe("b\nx\nc\n");
});

test("ambiguous and overlapping edits are rejected", () => {
  expect(applyEdits("x\nx\n", [{ old_text: "x", new_text: "y" }]).ok).toBe(false);
  const r = applyEdits("hello world\n", [
    { old_text: "hello wo", new_text: "A" },
    { old_text: "world", new_text: "B" },
  ]);
  expect(r.ok ? "" : r.error).toContain("overlap");
});

test("CRLF files stay CRLF and accept LF snippets", () => {
  const r = applyEdits("one\r\ntwo\r\nthree\r\n", [{ old_text: "two\nthree", new_text: "2\n3" }]);
  expect(okText(r)).toBe("one\r\n2\r\n3\r\n");
});

test("mixed line endings are left alone", () => {
  const r = applyEdits("a\r\nb\nc\n", [{ old_text: "b", new_text: "B" }]);
  expect(okText(r)).toBe("a\r\nB\nc\n");
});

test("BOM is preserved", () => {
  expect(okText(applyEdits("﻿const a = 1\n", [{ old_text: "a = 1", new_text: "a = 2" }]))).toBe("﻿const a = 2\n");
});

test("fuzzy: trailing whitespace and smart quotes still match, untouched lines keep their bytes", () => {
  const src = "keep  \nconst s = “hi”;   \nnext\t\n";
  const r = applyEdits(src, [{ old_text: 'const s = "hi";', new_text: 'const s = "bye";' }]);
  expect(r.ok && r.fuzzy).toBe(1);
  expect(okText(r)).toBe('keep  \nconst s = "bye";   \nnext\t\n');
});

test("fuzzy: multi-line snippet without the file's trailing spaces", () => {
  const r = applyEdits("if (x) {  \n  run()\n}\n", [{ old_text: "if (x) {\n  run()\n}", new_text: "if (x) run()" }]);
  expect(okText(r)).toBe("if (x) run()\n");
});

test("a miss points at the likely lines", () => {
  const r = applyEdits("function f() {\n  return 1\n}\n", [{ old_text: "function f() {\n  return 2\n}", new_text: "" }]);
  expect(r.ok ? "" : r.error).toContain("line 1");
});

test("edit tool creates, edits and reports lines", async () => {
  expect((await impl.edit({ path: "new.ts", edits: [{ old_text: "", new_text: "let a = 1\nlet b = 2\n" }] })).text).toBe("created new.ts");
  const r = await impl.edit({ path: "new.ts", edits: [{ old_text: "b = 2", new_text: "b = 3" }] });
  expect(r).toEqual({ text: "edited new.ts at line 2", isError: false });
  expect(await Bun.file(join(dir, "new.ts")).text()).toBe("let a = 1\nlet b = 3\n");
});

test("concurrent edits to one file both land", async () => {
  await Bun.write(join(dir, "c.txt"), "a\nb\n");
  await Promise.all([
    impl.edit({ path: "c.txt", edits: [{ old_text: "a", new_text: "A" }] }),
    impl.edit({ path: "c.txt", edits: [{ old_text: "b", new_text: "B" }] }),
  ]);
  expect(await Bun.file(join(dir, "c.txt")).text()).toBe("A\nB\n");
});

test("shell keeps the tail, interleaves stderr, and spills the full output", async () => {
  const r = await impl.shell({ command: "seq 1 5000; echo boom >&2; exit 3" });
  expect(r.isError).toBe(true);
  expect(r.text).toEndWith("4999\n5000\nboom");
  expect(render(r)).toEndWith("]\n[exit 3]");
  const path = render(r).match(/full output: (\S+)\]/)![1]!;
  expect((await Bun.file(path).text()).split("\n")).toHaveLength(5001);
});

test("shell timeout is reported", async () => {
  const r = await impl.shell({ command: "sleep 5", timeout_s: 1 });
  expect(r.isError).toBe(true);
  expect(render(r)).toContain("timeout 1s");
});

test("read caps big files and says where to continue", async () => {
  await Bun.write(join(dir, "big.txt"), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const r = await impl.read({ path: "big.txt" });
  expect(r.text).not.toContain("offset=");
  expect(render(r)).toContain("continue with offset=2001");
  expect((await impl.read({ path: "big.txt", offset: 2999 })).text).toBe("2999\tline 2999\n3000\tline 3000");
});

test("script batches tool calls and returns only what it prints", async () => {
  await Bun.write(join(dir, "s1.txt"), "alpha\n");
  await Bun.write(join(dir, "s2.txt"), "beta\n");
  const r = await runScript(
    `const files = (await tools.search({ pattern: "a$", files_only: true })).split("\\n").sort();
     for (const f of files) print(f, (await tools.read({ path: f })).split("\\t")[1]);
     return files.length;`,
    impl,
    30,
  );
  expect(r.isError).toBe(false);
  expect(r.text).toContain("s1.txt alpha");
  expect(r.text).toContain("s2.txt beta");
  expect(r.text).toContain("return: 2");
  expect(r.text).toContain("[3 tool calls]");
});

test("script tool errors throw inside the script and surface", async () => {
  const caught = await runScript(`try { await tools.read({ path: "nope" }) } catch (e) { print("caught", e.message) }`, impl, 30);
  expect(caught.text).toContain("caught not found: nope");
  const thrown = await runScript(`throw new Error("bad")`, impl, 30);
  expect(thrown.isError).toBe(true);
  expect(thrown.text).toContain("error: Error: bad");
});

test("script timeout kills the worker and keeps partial output", async () => {
  const r = await runScript(`print("started"); while (true) {}`, impl, 1);
  expect(r.isError).toBe(true);
  expect(r.text).toContain("started");
  expect(r.text).toContain("timed out after 1s");
});

test("scripts get clean shell data; failures throw with the exit status", async () => {
  const r = await runScript(
    `const names = (await tools.shell({ command: "ls s1.txt s2.txt" })).split("\\n");
     print(JSON.stringify(names));
     try { await tools.shell({ command: "echo nope; exit 2" }) } catch (e) { print("threw:", e.message) }`,
    impl,
    30,
  );
  expect(r.text).toContain('["s1.txt","s2.txt"]');
  expect(r.text).toContain("threw: nope\n[exit 2]");
});

test("scripts are told when a tool result was cut", async () => {
  const r = await runScript(`const t = await tools.read({ path: "big.txt" }); return t.split("\\n").length`, impl, 30);
  expect(r.text).toContain("[read: [showed lines 1-2000 of 3000; continue with offset=2001]]");
  expect(r.text).toContain("return: 2000");
});
