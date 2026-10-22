# treeix-ptyd: how the app runs the daemon

`treeix-ptyd` owns every PTY, so shells outlive the app. The app is a client over a Unix socket. Code: `apps/next/src-tauri/src/daemon.rs` (client) and `service.rs` (start).

## Finding it

- Data dir: `$TREEIX_DATA_DIR`, else `~/Library/Application Support/com.dyvertex.treeix.next` (macOS) or `$XDG_DATA_HOME/com.dyvertex.treeix.next` (Linux, default `~/.local/share/...`).
- Socket: `<data dir>/ptyd.sock`, or `$XDG_RUNTIME_DIR/com.dyvertex.treeix.next.sock` on Linux when that is set (and `TREEIX_DATA_DIR` is not). Mode 0600, the daemon checks the peer uid.
- Binary: the `treeix-ptyd` sidecar next to the app binary (`Contents/MacOS/` in the bundle, `target/<profile>/` in dev). `scripts/build-ptyd.sh` builds it into `src-tauri/binaries/` for tauri.

## Starting it

The app connects first. Only when nothing answers does it start one, then polls the socket for 5 s.

- macOS, installed bundle, default data dir: a LaunchAgent through `SMAppService` (plist in `Contents/Library/LaunchAgents`, `KeepAlive`).
  - Not registered: register it; launchd starts it.
  - Registered but silent (launchd throttling a crash loop): `launchctl kickstart gui/<uid>/com.dyvertex.treeix.next.ptyd`.
  - Switched off in System Settings > Login Items, or registration fails (unsigned bundle): spawn by hand.
- Linux, release build, default data dir: a systemd user unit `~/.config/systemd/user/treeix-ptyd.service` (`Restart=always`) pointing at the sidecar. The app rewrites it when the path changes, then `systemctl --user daemon-reload` and `enable --now`. No user systemd (containers, some WSL): spawn by hand.
- Everything else (dev builds, `TREEIX_DATA_DIR`): spawn by hand, `setsid` so it leaves the app's session. Its stderr goes to `<data dir>/ptyd.log`; the services log to launchd (nowhere) and the journal (`journalctl --user -u treeix-ptyd`).

A second daemon that finds the socket answering exits at once, so a race between launchd/systemd and a hand spawn is harmless.

## Upgrading it

The handshake carries `PROTO_VERSION` and the build id. On a mismatch the app sends `Shutdown`; the old daemon snapshots every session to `sessions/<id>.vt`, writes a clean `state.json` and exits. launchd or systemd starts the new binary (after an app update it is the new sidecar), or the app spawns it. Sessions come back as restored with their scrollback.

## Reconnecting

When the socket closes the app drops pending requests and stream channels, emits `daemon: disconnected`, and reconnects with backoff (100 ms doubling to 5 s), starting a daemon if needed. Panes attach again on `daemon: connected`. A daemon that crashed comes back via `KeepAlive` / `Restart=always`; its sessions show as crashed with the last snapshot.

One connection attaches a session once; the app fans its output out to every pane showing it (main window and quick terminal). Each pane gets its own snapshot and seq, and the daemon detach goes out when the last pane leaves.

## Resetting it during development

- Isolate: run the app with `TREEIX_DATA_DIR=/tmp/treeix-dev`; it never touches the installed daemon or registers a service. Delete the dir to start clean.
- Stop the running daemon: `pkill -x treeix-ptyd` (SIGTERM snapshots first). With a service it restarts; stop the service instead:
  - macOS: `launchctl bootout gui/$(id -u)/com.dyvertex.treeix.next.ptyd`, or remove it under System Settings > Login Items.
  - Linux: `systemctl --user disable --now treeix-ptyd && rm ~/.config/systemd/user/treeix-ptyd.service && systemctl --user daemon-reload`.
- Forget all sessions: stop the daemon, then delete `state.json` and `sessions/` in the data dir.
