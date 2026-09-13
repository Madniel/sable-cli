# Roadmap

What exists today is the spine: config → provider → agent loop → tools →
approval → terminal. Everything below hangs off that without redesigning it.

## Built

- [x] Provider abstraction with two working backends: Anthropic (SSE, prompt
      caching) and OpenAI (chat completions, `tool_calls`), sharing retry with
      backoff and `retry-after` handling
- [x] Agentic tool-use loop with a step ceiling and mid-turn interruption
- [x] Eight sandboxed tools, all confined to the workspace root
- [x] Atomic `multi_edit`: every hunk applies or none do
- [x] LCS-based unified diffs in approval prompts, coloured in the terminal
- [x] Staleness guard: an edit to a file that changed after the model read it is
      refused rather than silently clobbering the user's work
- [x] Four approval modes plus per-tool "always allow", and risk flagging for
      obviously destructive shell commands
- [x] Automatic context compaction past a token threshold, plus `/compact`
- [x] Session persistence with `--continue`, `--resume`, `/sessions`
- [x] Interactive REPL: streaming markdown, spinner, slash commands, history,
      completion
- [x] One-shot mode (`-p`) and a JSON event stream (`--json`) for scripting
- [x] Layered config and `SABLE.md` project context
- [x] 140 tests on `node:test`, none of which touch the network

## Next

**Better retrieval.** `grep` walks and reads every file itself. A persistent
index — or shelling out to `rg` when it is on PATH — would make searching a large
repository an order of magnitude faster.

**Sub-agents.** A `task` tool that spawns a nested loop with its own context and a
restricted tool set, returning only a summary. The cheapest way to keep noisy
exploration out of the main transcript.

**MCP client.** Speak the Model Context Protocol so any MCP server's tools appear
in the registry alongside the built-ins. The `Tool` interface is already the right
shape for it; what is missing is the transport and the schema translation.

**Streaming tool arguments to the UI.** The provider already emits
`tool_use_input_delta`; nothing displays it. Showing a command as it is typed out
would make approvals feel immediate rather than sudden.

**Smarter truncation.** Tool output is capped by characters. Capping by estimated
tokens, and trimming from the middle rather than the end, would keep the useful
parts of a long test run.

**Gemini adapter.** The third wire format, to prove the seam is not accidentally
shaped around two.

## Later

- `git`-aware tooling: stage a change set, propose a commit message, open a PR
- A real TUI: alternate screen, scrollback, side-by-side diffs
- Hooks: shell commands fired before or after a tool call, for lint or audit
- Permission profiles per directory (`~/work` prompts, `~/scratch` yolo)
- Resumable turns: pick up a session mid-tool-call after a crash
- Cost tracking against real provider pricing rather than a baked-in table
- `npx sable` distribution and a signed release

## Non-goals

- A plugin marketplace. Fork it; it is small enough to fork.
- Hosting, accounts, or telemetry. It talks to your provider with your key and to
  nothing else.
- Being a chatbot. It is for work in a repository.
