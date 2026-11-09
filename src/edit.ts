// Exact-replacement edits. Ideas from pi (MIT): every edit is located in the original text, never in the
// output of an earlier edit, and an exact miss falls back to a whitespace/punctuation-tolerant match.

export type Edit = { old_text: string; new_text: string };
export type EditResult = { ok: true; text: string; lines: number[]; fuzzy: number } | { ok: false; error: string };

// Characters models often swap for their ASCII look-alikes.
const LOOKALIKE: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "−": "-",
  " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
};

// Normalizes `s` (look-alikes to ASCII, trailing whitespace dropped on every line) and returns, for each
// kept character, its index in `s`, so a match in normalized text maps back to an exact span of `s`.
function normalize(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j < s.length && (s[j] === " " || s[j] === "\t" || LOOKALIKE[s[j]!] === " ")) j++;
    if (j > i && (j === s.length || s[j] === "\n")) {
      i = j; // trailing whitespace: drop it
      continue;
    }
    for (const end = Math.max(j, i + 1); i < end; i++) {
      text += LOOKALIKE[s[i]!] ?? s[i]!;
      at.push(i);
    }
  }
  return { text, at };
}

const count = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};
const lineOf = (s: string, index: number) => s.slice(0, index).split("\n").length;

// Where an exact and a fuzzy search both fail, point at lines that share the snippet's first line.
function nearMiss(content: string, oldText: string): string {
  const probe = oldText.split("\n").map((l) => l.trim()).find(Boolean);
  if (!probe) return "";
  const hits = content.split("\n").flatMap((l, i) => (l.includes(probe) ? [i + 1] : [])).slice(0, 5);
  return hits.length ? ` Its first line appears at line ${hits.join(", ")}; re-read there.` : " Re-read the file.";
}

// Applies `edits` to `original`. Line endings and a leading BOM are preserved; edits are matched in LF space.
export function applyEdits(original: string, edits: Edit[]): EditResult {
  const bom = original.startsWith("﻿") ? "﻿" : "";
  // Only a file that is CRLF throughout is converted; mixed endings are edited as-is.
  const crlf = original.includes("\r\n") && !/(^|[^\r])\n/.test(original);
  const src = crlf ? original.slice(bom.length).replace(/\r\n/g, "\n") : original.slice(bom.length);
  let fuzzySrc: ReturnType<typeof normalize> | undefined;

  const spans: { start: number; end: number; text: string; i: number }[] = [];
  let fuzzy = 0;
  for (const [i, e] of edits.entries()) {
    const old = e.old_text.replace(/\r\n/g, "\n");
    const text = e.new_text.replace(/\r\n/g, "\n");
    if (!old) return { ok: false, error: `edit ${i}: old_text is empty` };
    const n = count(src, old);
    if (n > 1) return { ok: false, error: `edit ${i}: old_text matches ${n} places; include more surrounding lines` };
    if (n === 1) {
      const start = src.indexOf(old);
      spans.push({ start, end: start + old.length, text, i });
      continue;
    }
    fuzzySrc ??= normalize(src);
    const needle = normalize(old).text;
    const m = needle ? count(fuzzySrc.text, needle) : 0;
    if (m === 0) return { ok: false, error: `edit ${i}: old_text not found.${nearMiss(src, old)}` };
    if (m > 1) return { ok: false, error: `edit ${i}: old_text matches ${m} places; include more surrounding lines` };
    const k = fuzzySrc.text.indexOf(needle);
    spans.push({ start: fuzzySrc.at[k]!, end: fuzzySrc.at[k + needle.length - 1]! + 1, text, i });
    fuzzy++;
  }

  spans.sort((a, b) => a.start - b.start);
  for (let k = 1; k < spans.length; k++) {
    if (spans[k]!.start < spans[k - 1]!.end) {
      return { ok: false, error: `edits ${spans[k - 1]!.i} and ${spans[k]!.i} overlap; merge them into one edit` };
    }
  }
  let out = src;
  for (const s of [...spans].reverse()) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  const lines = spans.map((s) => lineOf(src, s.start));
  return { ok: true, text: bom + (crlf ? out.replace(/\n/g, "\r\n") : out), lines, fuzzy };
}
