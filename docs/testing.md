# Testing Treeix

Five layers, cheapest first. CI runs the first four and the bench on every PR or push that touches `crates/**`, `apps/desktop/**`, `Cargo.*`, `rust-toolchain.toml` or `bench/**` (`.github/workflows/`). The in-app e2e opens a window, so it runs on a Mac by hand.

## 1. Rust (`crates/*`, `apps/desktop/src-tauri`)

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

- `crates/ptyd/tests` start a daemon in process (`--in-process`) on a temp socket: real PTYs, no app.
- `cargo test -p treeix-app export_bindings` regenerates `apps/desktop/src/ipc/bindings.ts`. Never edit that file by hand; CI fails on macOS when the committed copy is stale.
- `tauri-build` wants the sidecar and the frontend dist to exist. A fresh checkout gets them from `sh apps/desktop/scripts/build-ptyd.sh` and `bun run build`; CI uses empty placeholders:

  ```sh
  mkdir -p apps/desktop/src-tauri/binaries apps/desktop/dist
  touch "apps/desktop/src-tauri/binaries/treeix-ptyd-$(rustc --print host-tuple)"
  ```

- Linux needs WebKitGTK 4.1 and friends: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`. CI checks on `ubuntu-22.04` and `macos-latest`.

## 2. Frontend unit tests (`apps/desktop`)

```sh
cd apps/desktop
bun run typecheck
bun test src
bun test ../../bench   # bench/compare.ts
```

Pure helpers only (`*.test.ts` beside the code): split tree state, shortcuts, palette search, terminal key and stream handling, the in-app e2e's step runner.

## 3. Headless e2e on the mock (`apps/desktop/e2e`)

```sh
cd apps/desktop
bunx playwright install webkit chromium   # once
bun run e2e                               # both engines
bun run e2e --project webkit e2e/shell.spec.ts
```

- `playwright.config.ts` starts Vite on port 5304 with file watching off (`e2e/vite.config.ts`), reusing a server already there outside CI.
- The page runs on the in-browser mock daemon (`src/ipc/mock.ts`): 10 seeded sessions, `?seed=empty` for first run, `window.treeixMock.restart()` for a daemon restart.
- WebKit first, it is the engine of WKWebView; Chromium second. Both get a Mac user agent, so the macOS shortcuts and renderer are the ones tested.
- Specs select by role, label, button title and stable class names (`.pane`, `.trow`, `.htab`, `.side`), never by layout order.
- `e2e/inapp.spec.ts` runs the in-app runner below on the mock, which keeps its selectors honest without a window.
- `bunx tsc --noEmit -p e2e` type-checks the specs.
- Failures keep a trace: `bunx playwright show-trace test-results/<test>/trace.zip`. CI uploads the Playwright report.

## 4. In-app e2e on the real daemon (`apps/desktop/src/e2e`)

```sh
cd apps/desktop
bun run tauri build --debug --bundles app
TREEIX_AUTORUN=e2e TREEIX_DATA_DIR=$(mktemp -d) "../../target/debug/bundle/macos/Treeix.app/Contents/MacOS/treeix-app"
```

Use the binary name inside `Contents/MacOS` if it differs. The app loads, runs the steps against the real UI and `treeix-ptyd`, writes the report next to the daemon's data (`e2e-<millis>.json` in the data dir) and quits with exit code 1 on any failure. Stop that data dir's `treeix-ptyd` after. The report:

```json
{ "passed": [{ "name": "split right and down", "ms": 41 }], "failed": [{ "name": "...", "error": "..." }] }
```

Steps: new shell, `echo` output in the pane, split right and down, focus moves, close pane, kill to exited, restart in place, detach and re-attach every pane with matching scrollback, 20 sessions re-attached in under 300 ms (the Phase 1 exit). What a pane shows is read by tapping `api.attach` and replaying its bytes into an off-screen xterm, because the WebGL renderer draws to a canvas.

## 5. Bench (`bench/`)

```sh
sh bench/run.sh   # everything: ptyd, Ghostty, frontend only; see bench/README.md
```

CI runs only the headless daemon part on `macos-latest`:

```sh
bun bench/gen.ts
cargo build --release -p treeix-ptyd --bin ptyd-bench
target/release/ptyd-bench --in-process /tmp/treeix-bench/mixed-100m.ans > result.json
bun bench/compare.ts bench/baseline/macos-latest.json result.json
```

- The result is uploaded as the `ptyd-bench-macos-latest` artifact.
- `compare.ts` fails on a regression above 10% in attached or detached throughput, echo p95 or idle daemon RSS.
- The comparison runs only once `bench/baseline/<runner>.json` exists. To set or move the baseline, commit a CI artifact from that runner there; a local machine's numbers are not comparable.
- The in-app numbers (`TREEIX_AUTORUN=bench`) stay manual, see `bench/README.md`.

## Releases

Pushes to `main` publish the release; see [releasing.md](releasing.md).
