import { type CanUseTool, type McpServerConfig, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { COMPACT_INSTRUCTIONS, compactAt, saveSummary } from "./compact.ts";
import { systemPrompt } from "./prompt.ts";
import { loomTools, TOOL_NAMES } from "./tools.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export type Image = { mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string };
// `showThinking` streams summarized thinking (the TUI shows it live). `integrations` adds the user's own MCP
// servers, their claude.ai connectors and Claude in Chrome, with tool search so their schemas stay out of the
// prompt until needed; `approve` decides each call to a tool that is not loom's. Plain and benchmark runs use neither.
export type Approve = (tool: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
export type SessionOptions = {
  cwd: string;
  model?: string;
  effort: Effort;
  showThinking?: boolean;
  integrations?: boolean;
  connectors?: boolean; // the user's claude.ai connectors: ~30k tokens of tool definitions, so opt-in
  resume?: string; // session id to continue (switching integrations restarts claude mid-conversation)
  approve?: Approve;
  onCheckpoint?: (path: string) => void;
};

// MCP servers the user configured for Claude Code: user scope and this project's local scope in
// ~/.claude.json, and the project's shared .mcp.json.
async function userMcpServers(cwd: string): Promise<Record<string, McpServerConfig>> {
  const read = async (p: string) => {
    try {
      return await Bun.file(p).json();
    } catch {
      return null;
    }
  };
  const global = await read(join(homedir(), ".claude.json"));
  const shared = await read(join(cwd, ".mcp.json"));
  return { ...(global?.mcpServers ?? {}), ...(global?.projects?.[cwd]?.mcpServers ?? {}), ...(shared?.mcpServers ?? {}) };
}

// One long-lived claude process driven by a prompt stream: only the first turn pays startup, and model and
// effort switch in place. The user's own unmodified claude binary signs in with their own login.
export async function openSession(opts: SessionOptions) {
  const claude = Bun.which("claude");
  if (!claude) throw new Error("claude not found on PATH — install Claude Code and sign in first");

  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* prompts(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (pending.length) yield pending.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  const push = (content: SDKUserMessage["message"]["content"]) => {
    pending.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    wake?.();
  };

  const q = query({
    prompt: prompts(),
    options: {
      cwd: opts.cwd,
      pathToClaudeCodeExecutable: claude,
      systemPrompt: { type: "custom", prompt: await systemPrompt(opts.cwd) },
      tools: opts.integrations ? ["ToolSearch"] : [],
      mcpServers: { ...(opts.integrations ? await userMcpServers(opts.cwd) : {}), loom: loomTools(opts.cwd) },
      strictMcpConfig: !opts.integrations,
      // With an approver, loom's own tools are allowed inside it; listing them here too would bypass the callback.
      ...(opts.approve ? { canUseTool: approver(opts.approve) } : { allowedTools: TOOL_NAMES }),
      ...(opts.integrations && { extraArgs: { chrome: null } }),
      ...(opts.integrations && !opts.connectors && { env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" } }),
      ...(opts.resume && { resume: opts.resume }),
      settingSources: [],
      includePartialMessages: true,
      ...(opts.showThinking && { thinking: { type: "adaptive" as const, display: "summarized" as const } }),
      effort: opts.effort,
      ...(opts.model && { model: opts.model }),
      hooks: {
        PostCompact: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === "PostCompact") opts.onCheckpoint?.(await saveSummary(input.session_id, input.compact_summary));
                return {};
              },
            ],
          },
        ],
      },
    },
  });

  const s = {
    id: opts.resume ?? "", // claude's session id, known after the first init
    context: 0, // tokens in the latest request
    window: 200_000,
    inFlight: 0, // prompts sent whose result has not arrived
    messages: q as AsyncIterable<SDKMessage>,
    // Sends a prompt, compacting first when the context has grown past the threshold. Returns true if it compacted.
    send(text: string, images: Image[] = []): boolean {
      let compacted = false;
      if (text.trim() === "/compact") text = `/compact ${COMPACT_INSTRUCTIONS}`;
      else if (s.context > compactAt(s.window)) {
        s.inFlight++;
        push(`/compact ${COMPACT_INSTRUCTIONS}`);
        compacted = true;
      }
      s.inFlight++;
      if (!images.length) push(text);
      else
        push([
          ...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.data } })),
          { type: "text" as const, text },
        ]);
      return compacted;
    },
    // Keeps context/window/inFlight current; call for every message.
    track(m: SDKMessage) {
      if (m.type === "system" && m.subtype === "init") s.id = m.session_id;
      if (m.type === "assistant") {
        const u = m.message.usage;
        if (u) s.context = u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + u.output_tokens;
      } else if (m.type === "system" && m.subtype === "compact_boundary") {
        s.context = m.compact_metadata.post_tokens ?? 0;
      } else if (m.type === "result") {
        s.inFlight = Math.max(0, s.inFlight - 1);
        const w = Object.values(m.modelUsage ?? {})[0]?.contextWindow;
        if (w) s.window = w;
      }
    },
    interrupt: () => q.interrupt(),
    setModel: (model: string) => q.setModel(model),
    setEffort: (effort: Effort) => q.applyFlagSettings({ effortLevel: effort }),
    models: () => q.supportedModels(),
    ready: () => q.initializationResult(),
    close() {
      closed = true;
      wake?.();
    },
  };
  return s;
}

export type Session = Awaited<ReturnType<typeof openSession>>;

const OWN = new Set([...TOOL_NAMES, "ToolSearch"]);
function approver(approve: Approve): CanUseTool {
  return async (tool, input, { signal }) =>
    OWN.has(tool) || (await approve(tool, input, signal))
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: "The user declined this tool call." };
}
