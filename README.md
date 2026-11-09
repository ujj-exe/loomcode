# loomcode

A small, fast terminal coding agent built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and Bun.

It replaces Claude Code's built-in tools with five lean ones and adds a hand-written TUI, so you can get more done with fewer tokens.

## Features

- **Five tools** (served over an in-process MCP server):
  - `read`: numbered file lines
  - `search`: ripgrep
  - `edit`: batched exact-text replacements
  - `shell`: zsh
  - `script`: JavaScript that chains the other tools and returns only what it prints
- **Native TUI** that renders:
  - streamed thinking
  - markdown and tables
  - syntax highlighting
  - a files drawer
  - pasted or dropped images
- **Your integrations**: MCP servers from `~/.claude.json` and `.mcp.json`, plus Claude in Chrome. claude.ai connectors are opt-in.
- **Compaction** with checkpoints saved to disk, so long sessions keep going.
- **Plain and JSON modes** for scripts and benchmarks.

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`brew install ripgrep`)
- One of these for auth:
  - a Claude login (`claude` CLI)
  - `ANTHROPIC_API_KEY`
- macOS or Linux. Image paste uses macOS `sips`.

## Install

```sh
bun add -g github:ujj-exe/loomcode   # puts `loomcode` on your PATH
loomcode                             # first run walks you through setup
```

Setup checks that Claude Code is installed and signed in (loomcode runs on that login), then offers web
search through [Exa](https://exa.ai), [Firecrawl](https://firecrawl.dev) or [Context.dev](https://context.dev).
Paste a key and it is tested with one search, then saved to the system keychain (macOS Keychain, service
`loomcode`), never to a file. Skipping is fine: loomcode works without web access, and `loomcode --setup`
changes this later. With a provider set, the agent gets `web_search` and `web_fetch`.

## Usage

```sh
loomcode                            # interactive TUI in the current directory
loomcode "fix the failing test"     # one-shot, plain output
loomcode --json "…"                 # final result as JSON on stderr, for benchmarks
```

From a clone: `bun install`, then `bun src/cli.ts` in place of `loomcode`.

Options:

| Flag | |
|---|---|
| `--model <id>` | model to use |
| `--effort low\|medium\|high\|xhigh\|max` | thinking effort (default `medium`) |
| `--plain` | no TUI, even in a terminal |
| `--json` | also print the final result message as JSON (stderr) |
| `-v, --verbose` | print every SDK message in plain mode |
| `--setup` | check Claude Code and choose a web search provider |

### In the TUI

**Commands:**

| Command | |
|---|---|
| `/model` | switch model |
| `/effort` | set thinking effort |
| `/copy` | copy the last reply (`/copy code` copies its last code block) |
| `/files` | show or hide the files drawer |
| `/mcp` | MCP servers and claude.ai connectors |
| `/compact` | summarize the conversation to free context |
| `/clear` | start a fresh conversation |
| `/help` | keys and commands |
| `/exit` | quit |

**Keys:**

| Key | |
|---|---|
| `enter` | send |
| `shift+enter`, `alt+enter`, `ctrl+j` | newline |
| `esc` | stop |
| `shift+tab` | cycle effort |
| `ctrl+b` | files drawer |
| `ctrl+v` | paste image |
| `ctrl+c` | clear; press twice to quit |

## Layout

```
src/
  cli.ts            entry: TUI or plain mode
  session.ts        Agent SDK session, MCP servers, approvals
  tools.ts          read / search / edit / shell / script
  script*.ts        script runner (a Worker, so timeouts can kill it; not a sandbox)
  edit.ts           exact-text edit engine
  compact.ts        compaction + checkpoints
  prompt.ts         system prompt
  tui/              renderer, editor, markdown, highlight, drawer, images
```

## Development

```sh
bun test     # tools + TUI tests
bunx tsc --noEmit   # type check
```
