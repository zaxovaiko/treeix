# Contributing

## Setup

```sh
bun install   # installs apps/desktop and apps/landing, links packages/node_modules
bun run dev
```

macOS 14 or newer, Apple silicon, [Bun](https://bun.sh). The optional command line tools (`gh`, `glab`, `acli`, `claude`, `codex`) are only needed for the plugins that use them.

## Before opening a pull request

```sh
bun run typecheck
bun run test
```

Both have to pass. UI changes need a screenshot of the change in the app.

## House style

- TypeScript with no `any`. `unknown` at trust boundaries, narrowed with a type guard.
- Single quotes, no semicolons, 180 column lines.
- Clear names and decomposition over comments. A comment explains why, never what.
- No speculative abstraction: no interface with one implementation, no option nobody sets.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`).

## Where code goes

A new feature is a plugin in `packages/plugins/<id>` unless it belongs to workspaces, worktrees, diffs, the editor, comments or settings, which are the host. Code two plugins need is a library package, not an import between plugins. See [packages/README.md](packages/README.md) and [docs/architecture.md](docs/architecture.md).

Logic worth testing lives in a plain module with a `*.test.ts` beside it, not inside a component: there is no renderer test runner.

## License of contributions

Contributions are licensed under the [Apache License 2.0](LICENSE), as stated in Section 5 of the license.
