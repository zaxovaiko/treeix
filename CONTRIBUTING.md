# Contributing

## Setup

```sh
bun install   # installs apps/desktop
bun run dev   # the UI in a browser, on a mock daemon
bun run app   # the Tauri app with the real daemon
```

macOS 13.3 or newer or Linux, [Bun](https://bun.sh) and the Rust toolchain in `rust-toolchain.toml`. The optional command line tools (`gh`, `glab`, `acli`, `claude`, `codex`, `tailscale`) are only needed for the features that use them.

## Before opening a pull request

```sh
bun run typecheck
bun run test
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

All have to pass; [docs/testing.md](docs/testing.md) covers the other layers and what CI runs. UI changes need a screenshot of the change in the app.

## House style

- TypeScript with no `any`. `unknown` at trust boundaries, narrowed with a type guard.
- Single quotes, no semicolons, 180 column lines in TypeScript; `cargo fmt` for Rust.
- Clear names and decomposition over comments. A comment explains why, never what.
- No speculative abstraction: no interface with one implementation, no option nobody sets.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `refactor:`).

## Where code goes

Terminals, chats, routines and anything that must outlive the window belong in `crates/ptyd`. Git, files, pull requests, agents and tickets are plain modules in `crates/core`, called through a command in `apps/desktop/src-tauri`. The UI is `apps/desktop/src`, and it reaches the Rust side only through `src/ipc/api.ts`. See [docs/architecture.md](docs/architecture.md).

`src/ipc/bindings.ts` is generated: change the Rust type and run `cargo test -p treeix-app export_bindings`.

Logic worth testing lives in a plain module with a `*.test.ts` beside it, not inside a component.

## License of contributions

Contributions are licensed under the [Apache License 2.0](LICENSE), as stated in Section 5 of the license.
