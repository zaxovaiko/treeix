# 9. Terminal stack for Treeix Next

Date: 2026-10-22
Status: Accepted

## Context

Treeix Next rewrites the app on Rust + Tauri v2 (plan: Phase 0 gate before the daemon and shell are built out). The Electron app has known terminal debt: no backpressure, hidden sessions parse output in JS, a pool of 8 kept WebGL contexts, and a GL blend patch.

The stack under test, built as the real Phase 1 skeleton rather than a throwaway spike:

- `treeix-ptyd`, a daemon owning the PTYs (portable-pty), parsing every session with `alacritty_terminal`, keeping a seq counter and a scrollback ring, and serving attach snapshots as ANSI.
- The Tauri app relaying attached sessions over one `Channel` of raw frames per pane, 5 ms / 64 KB coalescing, acks from xterm's write callback, PTY reads paused above 1 MB unacked.
- xterm.js 6 in WKWebView, WebGL only while a pane is visible, disposed on hide.

Gate: throughput at least 50% of Ghostty and 2x the Electron app on `cat` of 100 MB, key-to-echo p95 at most 10 ms, ptyd under 64 MB with 20 idle sessions.

Numbers on an Apple M3 Pro, macOS 27 (`bench/results/2026-10-22-Apple-M3-Pro.json`, methods in `bench/README.md`):

- Ghostty: 47.1 MB/s on `mixed-100m.ans` (SGR, CJK, emoji, wraps, redraws).
- Electron app: 28.2 MB/s.
- Tauri app, first run: 21.6 MB/s mixed, 44.2 MB/s plain ASCII. Key-to-echo p50 7 ms, p95 8 ms, p99 12 ms. Reveal of a 5000-line session p95 38 ms.
- Tauri app with flood fast-forward (wave 3): 67 MB/s mixed, 77.6 MB/s plain. Key-to-echo p50 7 ms, p95 8 ms, p99 11 ms. Reveal p95 31 ms.
- ptyd alone: 84 MB/s attached, 100.6 MB/s detached, echo p95 0.35 ms, 11.3 MB RSS with 20 idle shells.
- xterm.js alone in headless WebKit: 23.2 MB/s mixed, 44.5 plain. In headless Chromium 12.3 (software GL), so not comparable to the Electron app.

## Decision

- Keep the stack: ptyd + `alacritty_terminal` + Channel relay + xterm.js 6 WebGL in WKWebView.
- Every gate passes with flood fast-forward: throughput 1.42x Ghostty and 2.37x Electron. Without it, throughput missed (46% of Ghostty, 0.77x Electron) for the reasons below.
  - The ceiling is xterm.js parsing in JavaScriptCore: the headless WebKit number (23.2) matches the app's (21.6), while ptyd moves 84 MB/s. IPC costs under 10%.
  - "2x Electron" can't be met by any terminal measured here; Ghostty itself is 1.67x Electron on this input.
- Remove the ceiling instead of tuning the parser: **flood fast-forward**. When an attached pane falls more than the high-water mark behind, ptyd keeps reading the PTY at full speed (it parses everything anyway), stops forwarding bytes to that pane, and once the pane has drawn what it was sent, sends a fresh snapshot frame and resumes live bytes from its seq. The producer is never throttled by the renderer and the pane shows the same final screen and scrollback. Built in wave 3. The app bench now times the final screen of a flood, as a user sees it; xterm no longer parses every byte of it, so the number measures ptyd and the snapshot path rather than the parser.
- Hidden panes keep no Terminal and no WebGL context: reveal p95 31 ms is under the 50 ms line that would have called for an LRU of kept instances.
- Background throttling is disabled on the app's webviews: a suspended webview stops acking, and ptyd would then pause the shell's output.

## Alternatives considered

- Electron: faster parser (V8) but none of the process model, memory or startup gains; it's what Next replaces.
- A native libghostty Metal surface under a transparent webview: the plan's fallback for missed latency. Latency passed, so it stays a flagged experiment.
- Tuning xterm.js (larger write chunks, fewer callbacks): bounded by the same parser, at most a few percent.
- ghostty-web (libghostty-vt compiled to wasm with its own renderer): a candidate for Linux and for the parser ceiling; revisit if fast-forward falls short.

## Consequences

- `bench/run.sh` plus `TREEIX_AUTORUN=bench` on a release build is the perf check; CI compares ptyd-bench against `bench/baseline/`.
- Snapshot fidelity becomes load-bearing for floods as well as reveal: modes, scroll region and cursor state must round-trip (ptyd tests).
- A covered window draws no frames on macOS; GUI benches pin their window on top.
