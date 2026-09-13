# Working in this repository

sable is its own first user: this file is loaded into the system prompt when the
agent runs here.

## Conventions

- TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess`. Relative imports end
  in `.js` — that is what NodeNext resolution requires from `.ts` sources.
- **No runtime dependencies.** This is a hard rule, not a preference. Adding one
  to `dependencies` is a design change to argue for, not a convenience. Dev
  tooling in `devDependencies` is fine.
- **No comments in `src/` or `tests/`.** The code carries its own explanation:
  name the thing, extract the helper, make the type say it. If a line needs a
  comment to be understood, that is a signal to restructure it. Explanation that
  genuinely belongs in prose goes in `README.md` or `ROADMAP.md`. Strings the
  model reads — tool descriptions, the system prompt, error messages — are
  documentation and deserve the same care as code.
- Errors thrown at the user are `SableError` subclasses with a `code`. A tool that
  fails for an expected reason returns `{ isError: true }` instead of throwing, so
  the model can correct itself.
- Prefer small functions with precise names over long ones with sections.

## Layout

`src/agent` is the loop, `src/providers` is the model backend, `src/tools` is what
the model can do, `src/cli` is what the user sees, `src/approval` decides what
runs unattended, `src/util` is shared machinery with no upward dependencies. Keep
those seams: a change to the terminal UI should never require touching the loop.

## Checks

```bash
npm run typecheck && npm test && npm run format:check
```

Tests use `node:test` and must never hit the network — use `ScriptedProvider`
from `tests/helpers.ts` or a fake `fetch`. Anything that writes to disk uses
`tempWorkspace()`, never the repository itself.
