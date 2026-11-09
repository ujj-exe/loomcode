import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Structured checkpoint (shape inspired by pi's compaction, MIT). Sent as `/compact <instructions>` so
// claude's own compactor writes our format. Exact strings survive; narrative gets squeezed.
export const COMPACT_INSTRUCTIONS = `Write a checkpoint another agent will continue from. Use exactly these headings, terse bullets, and keep exact file paths, symbols, commands and error text verbatim:
## Goal — what the user wants, in their words where it matters
## Constraints — requirements and preferences the user stated
## Done — changes made (file: what changed)
## In progress — the step underway and its state
## Failed attempts — what was tried and why it did not work
## Decisions — choice: one-line reason
## Next — ordered steps
## Facts — anything else needed to continue (values, outputs, test names); "(none)" if nothing`;

export async function saveSummary(sessionId: string, summary: string): Promise<string> {
  const dir = join(homedir(), ".loom", "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `compact-${Date.now()}.md`);
  await Bun.write(path, summary);
  return path;
}
