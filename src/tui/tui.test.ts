import { expect, test } from "bun:test";
import { fit, sliceCols, strip, width, wrap } from "./ansi.ts";
import { Editor } from "./editor.ts";
import { droppedImages } from "./images.ts";
import { type InputEvent, KeyParser } from "./keys.ts";
import { StreamMarkdown } from "./markdown.ts";

const parse = (...chunks: string[]) => {
  const out: InputEvent[] = [];
  const p = new KeyParser((e) => out.push(e));
  for (const ch of chunks) p.feed(ch);
  return out;
};
const names = (evs: InputEvent[]) =>
  evs.map((e) =>
    e.type === "paste" ? `paste:${e.text}` : e.type === "mouse" ? `mouse:${e.wheel ?? (e.release ? "up" : e.drag ? "drag" : "down")}@${e.x},${e.y}` : `${e.ctrl ? "C-" : ""}${e.alt ? "M-" : ""}${e.shift ? "S-" : ""}${e.name === "char" ? e.text : e.name}`,
  );

test("keys: legacy, xterm modifiers, kitty CSI u", () => {
  expect(names(parse("ab\r\x7f\x01\x1b[A\x1b[1;5D\x1b[3~"))).toEqual(["ab", "enter", "backspace", "C-a", "up", "C-left", "delete"]);
  expect(names(parse("\x1b[13;2u", "\x1b[118;5u", "\x1b[9;2u", "\x1b[Z"))).toEqual(["S-enter", "C-v", "S-tab", "S-tab"]);
  expect(names(parse("\x1b\r", "\x1bb", "\x1b[27;2;13~"))).toEqual(["M-enter", "M-left", "S-enter"]);
});

test("keys: bracketed paste survives being split across chunks", () => {
  expect(names(parse("\x1b[200~line1\r\nli", "ne2\x1b[20", "1~x"))).toEqual(["paste:line1\nline2", "x"]);
});

test("keys: lone escape resolves after a pause, split sequences wait", async () => {
  expect(names(parse("\x1b[", "1;5C"))).toEqual(["C-right"]);
  const out: InputEvent[] = [];
  new KeyParser((e) => out.push(e)).feed("\x1b");
  expect(out).toHaveLength(0);
  await Bun.sleep(50);
  expect(names(out)).toEqual(["escape"]);
});

test("wrap: words, hanging indent, styles carried, wide chars", () => {
  expect(wrap("aaa bbb ccc", 7)).toEqual(["aaa bbb", "ccc"]);
  expect(wrap("• one two three", 9, "  ").map(strip)).toEqual(["• one two", "  three"]);
  const styled = wrap("\x1b[1mbold words here\x1b[22m", 10);
  expect(styled[1]!.startsWith("\x1b[1m")).toBe(true);
  for (const l of wrap("日本語のテキストです とても長い", 8)) expect(width(l)).toBeLessThanOrEqual(8);
});

test("markdown: streams paragraphs, commits code lines as they complete", () => {
  const md = new StreamMarkdown(40);
  md.push("Hello **wor");
  expect(md.take()).toEqual([]);
  expect(strip(md.live().join())).toBe("Hello **wor");
  md.push("ld**\n\n```ts\nconst a = 1\n");
  const out = md.take().map(strip);
  expect(out[0]).toBe("Hello world");
  expect(out.at(-1)).toBe("const a = 1");
  md.push("const b = 2\n```\nafter");
  md.end();
  const rest = md.take().map(strip);
  expect(rest).toContain("const b = 2");
  expect(rest.at(-1)).toBe("after");
  expect(md.codeBlocks).toEqual([{ lang: "ts", code: "const a = 1\nconst b = 2" }]);
});

test("markdown: lists, headings, tables", () => {
  const md = new StreamMarkdown(60);
  md.push("# Title\n- one\n- two **b**\n\n| a | bb |\n|---|---|\n| 1 | 2 |\n");
  md.end();
  const out = md.take().map(strip);
  expect(out).toContain("Title");
  expect(out).toContain("• one");
  expect(out).toContain("• two b");
  expect(out.some((l) => /a\s+│ bb/.test(l))).toBe(true);
});

test("editor: insert, word delete, history, multi-line caret", () => {
  const e = new Editor();
  e.insert("hello world");
  e.key({ type: "key", name: "w", ctrl: true, alt: false, shift: false });
  expect(e.text).toBe("hello ");
  e.key({ type: "key", name: "enter", ctrl: false, alt: false, shift: true });
  e.insert("x");
  const r = e.render(40, "");
  expect(r.lines.map(strip)).toEqual(["› hello ", "  x"]);
  expect(r.cursor).toEqual({ row: 1, col: 3 });
  expect(e.submit().text).toBe("hello \nx");
  e.key({ type: "key", name: "up", ctrl: false, alt: false, shift: false });
  expect(e.text).toBe("hello \nx");
});

test("editor: big pastes collapse and expand on submit; deleting a marker removes it whole", () => {
  const e = new Editor();
  const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  e.paste(big);
  expect(e.text).toBe("[paste #1 · 20 lines]");
  e.insert(" go");
  expect(e.submit().text).toBe(`${big} go`);
  e.paste(big);
  e.key({ type: "key", name: "backspace", ctrl: false, alt: false, shift: false });
  expect(e.text).toBe("");
});

test("drag and drop: escaped, quoted and file:// image paths", async () => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/loom dd test`;
  await Bun.write(`${dir}/shot one.png`, "x");
  await Bun.write(`${dir}/b.jpg`, "x");
  expect(droppedImages(`${dir.replace(/ /g, "\\ ")}/shot\\ one.png`)).toEqual([`${dir}/shot one.png`]);
  expect(droppedImages(`'${dir}/shot one.png' '${dir}/b.jpg'`)).toEqual([`${dir}/shot one.png`, `${dir}/b.jpg`]);
  expect(droppedImages(`file://${encodeURI(`${dir}/b.jpg`)}`)).toEqual([`${dir}/b.jpg`]);
  expect(droppedImages("just some text")).toBeNull();
});

test("mouse: SGR press, drag, release, wheel; split reports wait", () => {
  expect(names(parse("\x1b[<0;5;3M", "\x1b[<32;6;3M", "\x1b[<0;6;3m", "\x1b[<64;1;1M", "\x1b[<65;1;1M"))).toEqual([
    "mouse:down@4,2", "mouse:drag@5,2", "mouse:up@5,2", "mouse:up@0,0", "mouse:down@0,0",
  ]);
  expect(names(parse("\x1b[<0;1", "0;2M"))).toEqual(["mouse:down@9,1"]);
});

test("sliceCols and fit keep styles and exact widths", () => {
  const s = "\x1b[1mhello\x1b[22m world";
  expect(strip(sliceCols(s, 2, 8))).toBe("llo wo");
  expect(sliceCols(s, 2, 4).startsWith("\x1b[1m")).toBe(true);
  expect(width(fit(s, 20))).toBe(20);
  expect(width(fit(s, 6))).toBe(6);
  expect(strip(sliceCols("日本語", 2, 4))).toBe("本");
});
