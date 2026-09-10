# Working in this repository

sable is its own first user: this file is loaded into the system prompt when the
agent runs here.

## Conventions

- TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess`. Relative imports end
  in `.js` — that is what NodeNext resolution requires from `.ts` sources.
- **No runtime dependencies.** This is a hard rule, not a preference. Adding one
  to `dependencies` is a design change to argue for, not a convenience. Dev
  tooling in `devDependencies` is fine.
- Errors thrown at the user are `SableError` subclasses with a `code`. A tool that
  fails for an expected reason returns `{ isError: true }` instead of throwing, so
  the model can correct itself.
- Comments explain *why*. The code already says what.

## Layout

`src/agent` is the loop, `src/providers` is the model backend, `src/tools` is what
the model can do, `src/cli` is what the user sees, `src/approval` decides what
runs unattended. Keep those seams: a change to the terminal UI should never
require touching the loop.

## Checks

```bash
npm run typecheck && npm test && npm run format:check
```

Tests use `node:test` and must never hit the network — use the scripted provider
in `tests/loop.test.ts` or a fake `fetch`.
