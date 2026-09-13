# sable

An AI agent that lives in your terminal. Point it at a repository, describe what
you want, and it reads, edits, and runs things until the job is done — asking
before it touches anything.

Written in TypeScript with **zero runtime dependencies**: no SDK, no HTTP client,
no UI framework. The streaming clients, the SSE reader, the diff engine, the JSON
Schema validator and the terminal UI are all here, in about 4,500 readable lines.
That is the point — it is meant to be forked and rewired, not just installed.

```
› fix the failing test in src/parser

Reading the test first.

› shell npm test -- src/parser
  ✓ ran: npm test -- src/parser  2.4s
› grep /tokenize/ in src
  ✓ grep: 4 matches
› read_file read src/parser/tokenize.ts (120 lines)
› edit_file edit src/parser/tokenize.ts

? Edit src/parser/tokenize.ts (+1 -1)
  @@ -41,3 +41,3 @@
     while (index < input.length) {
  -    if (char === '"') {
  +    if (char === '"' || char === "'") {
         const start = index;
  [y] yes   [a] always allow edit_file   [n] no
  › y

  ✓ edited src/parser/tokenize.ts (+1 -1)
› shell npm test -- src/parser
  ✓ ran: npm test -- src/parser  2.1s

The tokenizer only closed on double quotes, so a single-quoted string ran to the
end of input. It now accepts both. All 14 tests pass.
```

## Install

Requires Node 20.11 or newer.

```bash
git clone https://github.com/<you>/sable-cli.git
cd sable-cli
npm install          # dev tooling only — there are no runtime dependencies
npm run build
npm link             # puts `sable` on your PATH
```

Then set a key for whichever backend you want:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # default
export OPENAI_API_KEY=sk-...          # for --provider openai
```

## Use

```bash
sable                                    # interactive session in the current directory
sable "add a --verbose flag to the CLI"  # run a task, then keep the session open
sable -p "what does src/queue.ts do?"    # one-shot: answer to stdout, then exit
sable --json -p "list the TODOs"         # machine-readable event stream
cat build.log | sable -p                 # pipe the prompt in
sable --continue                         # pick up where you left off here
sable --provider openai -m gpt-4.1       # a different backend
```

Inside a session:

| Command | |
|---|---|
| `/help` | list commands |
| `/tools` | what the model can call |
| `/model [name]` | show or switch model |
| `/approval [mode]` | show or change how much it may do unattended |
| `/cost` | tokens, context size, and a local spend estimate |
| `/compact` | summarise the conversation to free up context |
| `/sessions` | list recent sessions |
| `/resume <id>` | load a previous session into this one |
| `/save <file>` | dump the transcript as JSON |
| `/clear` | forget the conversation |

`Ctrl+C` interrupts the current turn without killing the session. `Ctrl+D` exits.

## Approval modes

Every tool is classified `read`, `write`, or `execute`, and the mode decides what
happens without you.

| Mode | Reads | File writes | Shell commands |
|---|---|---|---|
| `readonly` | yes | never | never |
| `prompt` *(default)* | yes | asks | asks |
| `auto-edit` | yes | automatic | asks |
| `yolo` | yes | automatic | automatic |

`readonly` also removes the write tools from the model's tool list entirely, so it
never even proposes an edit. Answering `a` at a prompt allows that tool for the
rest of the session. Commands that look destructive — `rm -rf`, `sudo`, a force
push, a download piped into a shell — are flagged in the prompt.

In `-p` mode there is nobody to ask, so anything needing approval is refused and
the model is told why. Pass `--approval auto-edit` or `--yolo` if you mean it.

## Tools

| Tool | Kind | |
|---|---|---|
| `list_dir` | read | directory tree, skipping `node_modules`, `.git`, build output |
| `glob` | read | find files by pattern (`src/**/*.{ts,tsx}`), newest first |
| `read_file` | read | line-numbered text, with `offset`/`limit` paging |
| `grep` | read | regex search with glob filtering and optional context lines |
| `edit_file` | write | exact-string replacement; refuses ambiguous matches |
| `multi_edit` | write | several edits to one file, applied all-or-nothing |
| `write_file` | write | create or replace a whole file |
| `shell` | execute | run a command, with a timeout and output cap |

Two guarantees worth knowing about:

**Nothing escapes the workspace.** Every path is resolved against the root and
rejected if it lands outside — `../../etc/passwd` does not work, and neither does
an absolute path or a `..` buried mid-string.

**Edits cannot silently clobber your work.** Every read is fingerprinted by mtime
and size. If a file changes after the model reads it — because you edited it in
your own editor — the next edit to that file is refused, and the model is told to
read it again rather than writing over you.

## Context

Long sessions run out of context. Rather than failing at the worst moment, sable
watches the estimated token count and, past `compactAtTokens` (120k by default),
summarises the older part of the conversation into a single message before the
next turn, keeping recent exchanges verbatim. You will see a `context compacted`
notice when it happens; `/compact` does it on demand.

Sessions are saved to `~/.sable/sessions` after every turn, so `--continue` picks
up the last one for the current directory and `--resume <id>` picks a specific
one. `--no-persist` turns that off.

## Configuration

Later sources win:

1. built-in defaults
2. `~/.sable/config.json`
3. `<workspace>/.sable/config.json`
4. environment variables
5. command-line flags

```jsonc
// .sable/config.json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "maxTokens": 8192,
  "approval": "auto-edit",
  "maxSteps": 40,
  "shellTimeoutMs": 120000,
  "compactAtTokens": 120000,
  "persistSessions": true,
  "contextFiles": ["SABLE.md", "AGENTS.md"]
}
```

Environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_BASE_URL`,
`OPENAI_BASE_URL`, `SABLE_PROVIDER`, `SABLE_MODEL`, `SABLE_APPROVAL`,
`SABLE_MAX_TOKENS`, `SABLE_MAX_STEPS`, `SABLE_TEMPERATURE`, `SABLE_COMPACT_AT`,
`SABLE_CONFIG_DIR`, `SABLE_LOG_LEVEL`.

### Project instructions

If a `SABLE.md` or `AGENTS.md` exists at the workspace root, its contents are
injected into the system prompt. Use it for the things you would otherwise repeat
every session: how to run the tests, which directories are generated, house style.
This repository has one.

## Architecture

```
src/
  index.ts          entrypoint: parse args, resolve config, pick a mode
  cli/              args, REPL, one-shot runner, streaming renderer, slash commands
  agent/            the loop, system prompt, session state, compaction, persistence
  providers/        Provider interface, Anthropic and OpenAI adapters, SSE reader
  tools/            tool interface, schema validator, the eight built-ins
  approval/         what may run without asking
  util/             ANSI, paths and sandboxing, diff, errors, logging
```

The loop is the whole idea and it is short: send the conversation, stream the
reply, run whatever tools the model asked for, append the results as the next
user message, repeat until it stops asking or `maxSteps` runs out. Everything
else — the renderer, the approval policy, the provider, the compactor — is a seam
you can replace without touching it.

### Adding a tool

Implement `Tool` and register it:

```ts
import { objectSchema, ok, type Tool } from './tools/index.js';

export const httpGetTool: Tool = {
  name: 'http_get',
  kind: 'read',
  description: 'Fetch a URL and return the response body as text.',
  schema: objectSchema({ url: { type: 'string', description: 'The URL.' } }, ['url']),
  summarize: (params) => `GET ${String(params['url'])}`,
  async run(params) {
    const response = await fetch(String(params['url']));
    return ok(await response.text());
  },
};
```

`kind` routes it through the approval policy, `description` is its real user
interface — the model has nothing else to go on — and `summarize` is what the
person sees before saying yes.

### Adding a provider

Implement `Provider` (one method: `complete`) and call `registerProvider('id', ...)`.
The loop only speaks the neutral message types in `providers/types.ts`, so a new
backend never touches agent code. `src/providers/openai.ts` is the worked example:
a completely different wire format — `tool_calls` accumulated by index, tool
results on their own `tool` role — behind the same interface, sharing the retry
and error handling in `providers/http.ts`.

## Development

```bash
npm run typecheck
npm test          # node:test, no network
npm run build
npm run dev -- -p "hello"
```

The suite covers the schema validator, the diff engine, every tool, the SSE
reader, both provider adapters (against a fake `fetch`), the agent loop (against a
scripted provider), the approval policy, compaction, and the session store.
Nothing in it touches the network or the repository working tree.

## Status

Early, but real: it works end to end against both backends, and the parts that
matter are tested. The [roadmap](ROADMAP.md) is still longer than what is built.
Contributions welcome.

## License

MIT
