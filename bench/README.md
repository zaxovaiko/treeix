# Terminal bench (Phase 0 gate)

Gate: throughput >= 50% of Ghostty and >= 2x the Electron app on `cat` of 100 MB, key-to-echo p95 <= 10 ms, ptyd < 64 MB with 20 idle sessions.

`sh bench/run.sh` generates the inputs and writes `bench/results/<date>-<machine>.json`. Parts that can't run are recorded as `{"skipped": "..."}`.

## Inputs (`bun bench/gen.ts [dir]`, default `/tmp/treeix-bench`)

Deterministic (seeded PRNG), same bytes on every machine:

- `mixed-100m.ans`: 100 MB of SGR 16/256/truecolor, CJK, emoji (ZWJ, flags, skin tones), combining marks, 10% long wrapping lines, cursor-up/clear-line redraws.
- `plain-50m.txt`: 50 MB of printable ASCII lines.
- `scroll-5k.ans`: 5000 colored lines, the reveal bench's scrollback.

## What run.sh measures

1. **ptyd** (headless): `ptyd-bench --in-process mixed-100m.ans`, which crates/ptyd/src/bin/ptyd-bench.rs prints as JSON (attached/detached throughput, echo latency, RSS with 20 idle shells).
2. **Ghostty**: `open -na Ghostty.app --args -e timed-cat.sh`, wall time of `cat` inside a fresh window, median of `RUNS` (5). Ghostty parses on its IO thread as it reads the pty, so this is its parse throughput.
   - The first launch after install shows a Gatekeeper "downloaded from the Internet" dialog; open Ghostty once by hand, or run with `GHOSTTY_APP` pointing at a copy made with `cp -RX` (no quarantine xattr). A locked screen also blocks it.
3. **Electron app**: `node bench/electron.mts <file> <runs>` drives the `electron-vite build` of apps/desktop with Playwright (the e2e launch, fake HOME, `TREEIX_HEADLESS=1`). Times Enter until xterm has parsed an OSC title printed right after the file (the title reaches the DOM), so it is parse throughput like Ghostty's, not just the pty drain.
4. **Frontend only**: `node bench/reveal.mts`, in headless Chromium and WebKit: the TerminalPane reveal path (fresh xterm + WebGL, in-page attach, 5000-line snapshot written, one frame), and xterm parse + draw throughput on the inputs (64 KB frames, at most 1 MB unacked). The pty, ptyd and IPC come on top in the app.

GUI runs are wrapped in `caffeinate -d -i`. With the display off or the screen locked, frames don't draw and numbers are parse-only.

## Tauri app numbers

`bench/run.sh` leaves `"tauri": {"pending": ...}`. To fill it:

1. `bun bench/gen.ts` (inputs in /tmp/treeix-bench).
2. `cd apps/next && bun run tauri build --bundles app`, then start the bundle's binary with `TREEIX_AUTORUN=bench` and a scratch `TREEIX_DATA_DIR`. It runs the bench once the window has loaded, writes `bench-<millis>.json` to the data dir and quits; stop its `treeix-ptyd` after. In a dev build, `await __treeixBench()` in the webview console does the same and logs the JSON.
   - throughput: `cat` of `mixed-100m.ans` and `plain-50m.txt` from the start signal until the session exited and its final screen was drawn (xterm write callback + a frame), MB/s of file bytes. Under flood fast-forward (below) this measures ptyd, not xterm. It stages its own 960x600 terminals over the app.
   - keyToEcho: 300 samples (10 warm-up dropped) of one char written to a plain `cat`, until its tty echo is drawn and a frame passed; p50/p95/p99 ms.
   - reveal: 30 samples of a fresh xterm + WebGL + attach + 5000-line snapshot + a frame on a live session; p50/p95/p99 ms.
3. Paste the JSON into the results file under `"tauri"`.

## Reveal policy

Hidden panes dispose their Terminal and WebGL context entirely. The plan's fallback (an LRU of 3 hidden instances kept without WebGL) applies only if reveal p95 > 50 ms; see the latest results file for the numbers behind the choice.

## Floods

ptyd never waits for a slow pane. Each attached channel (a webview pane; the main window and the quick terminal are separate channels on one connection) counts unacked bytes on its own. Past `HIGH_WATER` (1 MB) the channel is marked lagging: ptyd keeps reading and parsing the PTY at full speed but stops sending it Data. Once its acks bring it to `LOW_WATER` (256 KB) or below, ptyd sends one Resync (the ANSI snapshot, as on attach, plus its seq) and live Data resumes from that seq. The pane resets, writes the snapshot and acks on from there, so a `cat` of a huge file finishes at detached speed and the pane jumps to the latest screen; intermediate output is in scrollback only up to the snapshot's history. The PTY is paused only when a lagging channel has made no ack progress for 5 s (a stuck client), as a memory guard. A reloaded webview drops its channels on page load.
