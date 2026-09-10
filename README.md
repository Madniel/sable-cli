# sable

An AI agent that lives in your terminal. Point it at a repository, describe what
you want, and it reads, edits, and runs things until the job is done — asking
before it touches anything.

Written in TypeScript with **zero runtime dependencies**: no SDK, no HTTP client,
no UI framework. The whole agent is about 2,500 lines you can read in a sitting,
which is the point — it is meant to be forked and rewired, not just installed.

```
› fix the failing test in src/parser

Reading the test first.

› shell npm test -- src/parser
  ✓ ran: npm test -- src/parser  2.4s
› read_file read src/parser/tokenize.ts (120 lines)
› edit_file edit src/parser/tokenize.ts

? Edit src/parser/tokenize.ts
  - if (char === '"') {
  + if (char === '"' || char === "'") {
  [y] yes   [a] always allow edit_file   [n] no
  › y

  ✓ edited src/parser/tokenize.ts
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

Then set a key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Use

```bash
sable                                  # interactive session in the current directory
sable "add a --verbose flag to the CLI"  # run a task, then keep the session open
sable -p "what does src/queue.ts do?"    # one-shot: answer to stdout, then exit
sable --json -p "list the TODOs"         # machine-readable event stream
cat build.log | sable -p                 # pipe the prompt in
```

Inside a session:

| Command | |
|---|---|
| `/help` | list commands |
| `/tools` | what the model can call |
| `/model [name]` | show or switch model |
| `/approval [mode]` | show or change how much it may do unattended |
| `/cost` | tokens and a local spend estimate |
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
rest of the session.

In `-p` mode there is nobody to ask, so anything needing approval is refused and
the model is told why — pass `--approval auto-edit` or `--yolo` if you mean it.

## Tools

| Tool | Kind | |
|---|---|---|
| `list_dir` | read | directory tree, skipping `node_modules`, `.git`, build output |
| `read_file` | read | line-numbered text, with `offset`/`limit` paging |
| `grep` | read | regex search with an optional glob filter |
| `edit_file` | write | exact-string replacement; refuses ambiguous matches |
| `write_file` | write | create or replace a whole file |
| `shell` | execute | run a command, with a timeout and output cap |

Every path is resolved against the workspace root and rejected if it escapes —
`../../etc/passwd` does not work, and neither does a symlink to it.

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
  "model": "claude-sonnet-4-5",
  "maxTokens": 8192,
  "approval": "auto-edit",
  "maxSteps": 40,
  "shellTimeoutMs": 120000,
  "contextFiles": ["SABLE.md", "AGENTS.md"]
}
```

Environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `SABLE_MODEL`,
`SABLE_APPROVAL`, `SABLE_MAX_TOKENS`, `SABLE_MAX_STEPS`, `SABLE_TEMPERATURE`,
`SABLE_LOG_LEVEL`.

### Project instructions

If a `SABLE.md` or `AGENTS.md` exists at the workspace root, its contents are
injected into the system prompt. Use it for the things you would otherwise repeat
every session: how to run the tests, which directories are generated, house style.

## Architecture

```
src/
  index.ts          entrypoint: parse args, resolve config, pick a mode
  cli/              args, REPL, one-shot runner, streaming renderer, slash commands
  agent/            the loop, system prompt, session state, cost accounting
  providers/        Provider interface + Anthropic adapter + SSE reader
  tools/            tool interface, JSON-schema validator, the six built-ins
  approval/         what may run without asking
  util/             ANSI, paths/sandboxing, errors, logging
```

The loop is the whole idea and it is short: send the conversation, stream the
reply, run whatever tools the model asked for, append the results as the next
user message, repeat until it stops asking or `maxSteps` runs out. Everything
else — the renderer, the approval policy, the provider — is a seam you can
replace without touching it.

### Adding a tool

Implement `Tool` and register it:

```ts
import { objectSchema, ok, type Tool } from './tools/index.js';

export const httpGetTool: Tool = {
  name: 'http_get',
  kind: 'read',
  description: 'Fetch a URL and return the response body as text.',
  schema: objectSchema({ url: { type: 'string', description: 'The URL.' } }, ['url']),
  summarize: (p) => `GET ${String(p['url'])}`,
  async run(params) {
    const response = await fetch(String(params['url']));
    return ok(await response.text());
  },
};
```

`kind` is what routes it through the approval policy, `description` is its real
user interface — the model has nothing else to go on — and `summarize` is what
the user sees before saying yes.

### Adding a provider

Implement `Provider` (one method: `complete`) and call `registerProvider('id', ...)`.
The loop only speaks the neutral message types in `providers/types.ts`, so a new
backend never touches agent code. `tests/loop.test.ts` has a scripted provider
worth copying.

## Development

```bash
npm run typecheck
npm test          # node:test, no network
npm run build
npm run dev -- -p "hello"
```

The test suite covers the schema validator, every tool, the SSE reader, the
Anthropic adapter (against a fake `fetch`), the agent loop (against a scripted
provider), and the approval policy. Nothing in it touches the network.

## Status

Early. It works end to end and the parts that matter are tested, but the
[roadmap](ROADMAP.md) is longer than what is built. Contributions welcome.

## License

MIT
