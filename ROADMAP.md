# Roadmap

What exists today is the spine: config → provider → agent loop → tools →
approval → terminal. Everything below hangs off that without redesigning it.

## Built

- [x] Streaming Anthropic adapter (SSE parsed by hand, retries with backoff, prompt caching)
- [x] Agentic tool-use loop with a step ceiling and mid-turn interruption
- [x] Six built-in tools, all sandboxed to the workspace root
- [x] Four approval modes plus per-tool "always allow"
- [x] Interactive REPL: streaming markdown, spinner, slash commands, history, completion
- [x] One-shot mode (`-p`) and a JSON event stream (`--json`) for scripting
- [x] Layered config (defaults → user → project → env → flags) and `SABLE.md` project context
- [x] Session usage and cost estimate
- [x] Test suite with no network dependency

## Next

**Context management.** The session grows until the model refuses it. Needs
automatic compaction: summarise the oldest exchanges into a synthetic message
when the history crosses a token threshold, keeping tool-call pairs intact.
`Session.trimTo` is the placeholder to replace.

**Better editing.** `edit_file` is exact-string only. Worth adding: multi-edit in
one call (atomic — all hunks apply or none do), and a real unified diff in the
approval prompt instead of the current single-hunk preview.

**File watching / staleness.** If the user edits a file after the model read it,
the model is working from a stale copy. Track mtimes per read and warn on write.

**Sub-agents.** A `task` tool that spawns a nested loop with its own context and
a restricted tool set, returning only a summary. Cheap way to keep exploration
out of the main transcript.

**MCP client.** Speak the Model Context Protocol so any MCP server's tools appear
in the registry alongside the built-ins. The `Tool` interface is already the right
shape for it.

**More providers.** OpenAI and Gemini adapters. The interface is one method; the
work is in each one's streaming and tool-call format.

## Later

- Session persistence and `--resume`
- `git`-aware tooling: stage a change set, propose a commit message, open a PR
- A real TUI (alternate screen, scrollback, side-by-side diffs)
- Hooks: shell commands fired before/after a tool call, for lint or audit
- Permission profiles per directory (`~/work` prompts, `~/scratch` yolo)
- Structured output mode for CI use
- Token-aware truncation of tool results, instead of the current character cap
- `npx sable` distribution and a signed release

## Non-goals

- A plugin marketplace. Fork it; it is small enough to fork.
- Hosting, accounts, or telemetry. It talks to your provider with your key and to
  nothing else.
- Being a chatbot. It is for work in a repository.
