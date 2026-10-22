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
   - The first launch after install shows a Gatekeeper "downloaded from the Internet" dialog; open Ghostty once by hand, then re-run. A locked screen also blocks it.
3. **Electron app**: `node bench/electron.mts <file> <runs>` drives the `electron-vite build` of apps/desktop with Playwright (the e2e launch, fake HOME, `TREEIX_HEADLESS=1`). Times Enter until xterm has parsed an OSC title printed right after the file (the title reaches the DOM), so it is parse throughput like Ghostty's, not just the pty drain.
4. **Reveal, frontend only**: `node bench/reveal.mts` times the TerminalPane reveal path (fresh xterm + WebGL, attach, 5000-line snapshot written, one frame) in headless Chromium and WebKit with an in-page attach. IPC comes on top in the app.

GUI runs are wrapped in `caffeinate -d -i`. With the display off or the screen locked, frames don't draw and numbers are parse-only.

## Tauri app numbers (lead, by hand)

`bench/run.sh` leaves `"tauri": {"pending": ...}`. To fill it:

1. `bun bench/gen.ts` (inputs in /tmp/treeix-bench).
2. Run the app in a debug build (`cd apps/next && bun run app`), or a release build with `localStorage.setItem('treeix.bench', '1')` and a reload.
3. In the webview inspector console: `await __treeixBench()`. It needs nothing on screen; it stages its own 960x600 terminals over the app.
   - throughput: `cat` of `mixed-100m.ans` and `plain-50m.txt` from the start signal until the session exited and every byte was drawn (xterm write callback + a frame), MB/s of file bytes.
   - keyToEcho: 300 samples (10 warm-up dropped) of one char written to a plain `cat`, until its tty echo is drawn and a frame passed; p50/p95/p99 ms.
   - reveal: 30 samples of a fresh xterm + WebGL + attach + 5000-line snapshot + a frame on a live session; p50/p95/p99 ms.
4. The result is logged and sent to `bench_report` (debug builds); paste it into the results file under `"tauri"`.

## Reveal policy

Hidden panes dispose their Terminal and WebGL context entirely. The plan's fallback (an LRU of 3 hidden instances kept without WebGL) applies only if reveal p95 > 50 ms; see the latest results file for the numbers behind the choice.
