# 2. Built-in browser on `<webview>`

Date: 2026-09-21
Status: Accepted

## Context

Users switched to Chrome to check a dev server, a PR preview or a logged-in site, and had no way to hand what they saw on a page (an element, a console error, a failed request, a slow load) to an agent. The browser needed to sit in the Treeix layout like any other view, with the palette and popovers drawn over it, and to feed the existing review comments.

## Decision

- A `browser` plugin with a Browser tab and a Browser panel, plus an `inject` preload that runs inside visited pages.
- Pages are `<webview>` elements, not `WebContentsView`. A webview lays out like a DOM element, so tabs, panels, resizing and zen mode need no bounds syncing, and overlays can draw over it. A `WebContentsView` always sits above the renderer's DOM. Cost: `webviewTag: true` on the main window, which Electron discourages.
- The webviews live in one fixed layer laid over whichever slot is showing, so moving between the tab and the panel never reloads a page. Only one slot shows the page at a time.
- Main hardens every webview in `will-attach-webview` (`apps/desktop/src/main/webviewPolicy.ts`): the renderer's preferences are replaced wholesale with a `persist:browser` partition, sandbox, context isolation, no Node, and the inject script as the only preload.
- Main attaches CDP (`webContents.debugger`) per page for the Console and Network strip, with 500-entry ring buffers and response bodies fetched only when a row is ticked, capped at 32 KB. Web vitals and design mode selections come from the inject script via `sendToHost`.
- Element comments carry a selector, HTML excerpt and a `capturePage` crop. Ticked rows and element comments become `ReviewComment`s with `kind: 'browser'`, grouped per page in `commentsPrompt`.
- Cookie import is a one-off copy from Chrome, Arc, Brave, Edge, Chromium, Vivaldi or Firefox on macOS, decrypted in main with the Keychain key. Values never reach the renderer or logs. It is hidden in the Mac App Store build (`process.mas`).
- Full DevTools, docked in a second webview or detached.

## Alternatives considered

- `WebContentsView`: kept as the fallback if `<webview>` is removed; overlays would then need their own views.

## Consequences

- Site cookies never mix with the app's session. Imported cookies are credentials at rest in that partition.
- Browser keys are fixed, Chrome style, and not rebindable, since main forwards them from the page. Reopen closed tab is ⌘⇧T, not ⌘⌥Z as first specced, because a native menu accelerator reaches AppKit before the page.
- INP is approximated by the slowest event timing entry of the page load.
- On recent macOS, some browsers' folders need the user to allow access to other apps' data before import.

Changes since the spec:

- Permissions are not prompted per origin. Pages get only `fullscreen` and `clipboard-sanitized-write`; everything else is denied.
- Pages see the stock Chrome user agent with the Electron and app tokens stripped, for sites that refuse embedded browsers.
- The palette offers "New browser tab" instead of "Open URL".
