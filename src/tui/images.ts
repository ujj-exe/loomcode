import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { Image } from "../session.ts";

export type Attachment = Image & { name: string; w: number; h: number; bytes: number };

const MEDIA: Record<string, Image["mediaType"]> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const CONVERT = new Set([".heic", ".heif", ".tif", ".tiff", ".bmp"]);
// Past ~1568px a side the model gains nothing but the upload and the token bill grow.
const MAX_SIDE = 1568;

let dir: string | undefined;
const tmp = (name: string) => join((dir ??= mkdtempSync(join(tmpdir(), "loom-img-"))), name);

const isImage = (p: string) => {
  const e = extname(p).toLowerCase();
  return (e in MEDIA || CONVERT.has(e)) && existsSync(p) && statSync(p).isFile();
};

// Terminals turn a dropped file into its path: shell-escaped (a\ b.png), quoted ('a b.png'), or a file:// URL.
// Returns the image paths when the pasted text is nothing but image paths, else null.
export function droppedImages(text: string): string[] | null {
  const t = text.trim();
  if (!t || t.length > 4096) return null;
  const tokens: string[] = [];
  const re = /'([^']+)'|"([^"]+)"|((?:\\.|[^\s\\])+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    let p = m[1] ?? m[2] ?? m[3]!.replace(/\\(.)/g, "$1");
    if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
    if (p.startsWith("~/")) p = join(process.env.HOME ?? "", p.slice(2));
    tokens.push(p);
  }
  return tokens.length && tokens.every(isImage) ? tokens : null;
}

async function sips(args: string[]) {
  const p = Bun.spawn(["sips", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out;
}

export async function loadImage(path: string): Promise<Attachment> {
  let src = path;
  let ext = extname(path).toLowerCase();
  const info = await sips(["-g", "pixelWidth", "-g", "pixelHeight", src]);
  let w = Number(/pixelWidth: (\d+)/.exec(info)?.[1] ?? 0);
  let h = Number(/pixelHeight: (\d+)/.exec(info)?.[1] ?? 0);
  if (CONVERT.has(ext) || Math.max(w, h) > MAX_SIDE) {
    const out = tmp(`${Date.now()}-${basename(path, extname(path))}.${ext === ".jpg" || ext === ".jpeg" ? "jpg" : "png"}`);
    const fmt = out.endsWith(".jpg") ? "jpeg" : "png";
    await sips(["-s", "format", fmt, ...(Math.max(w, h) > MAX_SIDE ? ["-Z", String(MAX_SIDE)] : []), src, "--out", out]);
    if (Math.max(w, h) > MAX_SIDE) [w, h] = w >= h ? [MAX_SIDE, Math.round((h * MAX_SIDE) / w)] : [Math.round((w * MAX_SIDE) / h), MAX_SIDE];
    src = out;
    ext = extname(out);
  }
  const bytes = await Bun.file(src).arrayBuffer();
  return { name: basename(path), mediaType: MEDIA[ext] ?? "image/png", data: Buffer.from(bytes).toString("base64"), w, h, bytes: bytes.byteLength };
}

// Reads an image from the macOS clipboard: PNG (screenshots), TIFF (images copied from most apps, converted
// on load), or an image file copied in Finder. Returns a file path, or null.
export async function clipboardImage(): Promise<string | null> {
  const out = tmp(`clipboard-${Date.now()}`);
  const script = `
    ObjC.import("AppKit");
    const pb = $.NSPasteboard.generalPasteboard;
    const urls = pb.readObjectsForClassesOptions($([$.NSURL]), $({}));
    let found = "";
    if (urls && urls.count > 0 && urls.objectAtIndex(0).isFileURL) found = "file:" + urls.objectAtIndex(0).path.js;
    for (const [type, ext] of [["public.png", "png"], ["public.tiff", "tiff"], ["public.jpeg", "jpg"]]) {
      if (found) break;
      const d = pb.dataForType(type);
      if (!d.isNil() && d.writeToFileAtomically("${out}." + ext, true)) found = "${out}." + ext;
    }
    found;`;
  const p = Bun.spawn(["osascript", "-l", "JavaScript", "-e", script], { stdout: "pipe", stderr: "ignore" });
  const res = (await new Response(p.stdout).text()).trim();
  await p.exited;
  if (res.startsWith("file:")) return isImage(res.slice(5)) ? res.slice(5) : null;
  return res && existsSync(res) && statSync(res).size > 0 ? res : null;
}

// Copies text to the clipboard: pbcopy locally, OSC 52 as well so it also works over ssh.
export async function copyText(text: string) {
  process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const p = Bun.spawn(["pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  p.stdin.write(text);
  p.stdin.end();
  await p.exited;
}
