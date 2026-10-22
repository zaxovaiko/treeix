# Prototype parity (Phase 2)

What the shell covers from the prototype. `[x]` done, `[ ]` missing.

## Window and tabs

- [x] Title bar with palette search, theme toggle, settings
- [x] Tabs in the title bar (horizontal + compact)
- [x] Sidebar with sessions grouped by place, collapsible groups
- [x] Horizontal tab strip (islands)
- [x] Sidebar filter, "No sessions yet" / "No sessions match"
- [x] Sidebar footer "Open folder..."
- [x] Groups by place, all 6 kinds (scratch, folder, repo, branch, worktree, detached), regroup on cd
- [x] Status dots and agent logos (shell, Claude, Codex)
- [x] "restored" tag on reattached sessions
- [x] "folder missing" tag on a tab whose cwd is gone (not visually checked: the mock can't produce a missing cwd)

## Panes

- [x] Splits right and down, resize handles, dimmed unfocused panes
- [x] Focus moves with Alt+Cmd+arrows (macOS)
- [x] Renderer setting (auto, WebGL, DOM) reaches every pane

## Commands

- [x] Palette: sessions plus actions, platform chord hints
- [x] Cmd+O / Ctrl+Shift+O open folder (system dialog in Tauri, demo folder in the mock), also in the palette
- [x] Linux Ctrl+Shift chords: T shell, O open folder, W close, P palette, D split right, E split down, B sidebar; Ctrl+, settings; Ctrl+PageUp/PageDown and Alt+1..9 tabs
- [ ] Linux focus-pane chords (none bound yet)

## Quick terminal

- [x] Global shortcut, recorded in Settings, registered on load
- [x] Follows the main window's theme, density and renderer live
- [x] Its session is left out of the status bar's live count

## First run and degraded states

- [x] Empty first run: "Start a session" with Shell in ~, Claude in ~, Open folder..., recent places
- [x] Host unreachable on load: message + Retry
- [x] Host lost while running: reconnect banner, then "Can't reach the terminal host" + Retry after 15s
- [x] Status bar: place, "not a git repo" / "detached" / "missing", live count

## Settings

- [x] Theme (light, dark), tab orientation, density
- [x] Renderer
- [x] Quick terminal shortcut recorder (Escape cancels, Backspace clears, error on a taken chord)

## Out of scope (Phase 3)

- [ ] Worktree and history buttons
- [ ] GitHub tags (PR, checks)
- [ ] Usage pills
- [ ] File explorer
- [ ] Settings search
- [ ] System theme mode
- [ ] Quick terminal position and hide options
