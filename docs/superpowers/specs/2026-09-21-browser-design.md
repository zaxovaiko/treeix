# Built-in browser

## Goal

An ordinary Chromium browser inside Treeix, good enough to browse in instead of switching to Chrome: open a dev
server, a PR preview or any site you are logged in to. On top of that, the page becomes agent input: comment on an
element, hand over a console error, a network request or a performance measurement, and send it to a session as part
of the existing review comments.

## Scope

In v1:

- A `browser` plugin with a **Browser** tab and a **Browser** side panel, the same way Terminal has both
- Browser tabs inside it: new tab, close, reopen closed, back, forward, reload, address bar that also searches
- Links from terminals (`setWebLinkHandler`) and `localhost` URLs open here instead of the system browser; a setting
  switches this off
- Full Chrome DevTools, docked under the page or in its own window
- A short **Console / Network / Performance** strip with a checkbox per row that adds the row to the agent context
- **Design mode**: hover outlines elements, a click opens a comment popover, the comment carries a selector, a short
  HTML excerpt and a cropped screenshot
- **Cookie import** from one installed browser: Chrome, Arc, Brave, Edge, Chromium, Vivaldi or Firefox
- Browser items land in the existing comments drawer and go out through `commentsPrompt`

Later, not in v1:

- Agent-driven browsing (an MCP server the agent calls to navigate, click, read network and profile)
- Safari cookies (needs Full Disk Access and the binary cookie format)
- Extensions, bookmarks, history search, downloads UI beyond the system default, multiple profiles
- Windows and Linux cookie decryption (DPAPI, libsecret)

## User experience

- **Browser tab**: a strip of browser tabs, then the toolbar (back, forward, reload, address bar, profile badge,
  design mode toggle, DevTools toggle), then the page, then the collapsible strip. Keys follow Chrome: ⌘L address bar,
  ⌘R reload, ⌘[ ⌘] history, ⌘⌥I DevTools, ⌘T and ⌘W for tabs while the browser has focus. ⌘⌥Z reopens a closed
  browser tab when the browser has focus, a closed terminal session otherwise.
- **Side panel**: the same view in the panel dock, next to a diff or a terminal. One set of browser tabs is shared
  by the page and the panel, the panel shows the active one.
- **Opening from elsewhere**: ⌘-click on a URL in a terminal, the palette command "Open URL", or a PR's preview link.
- **Profile badge**: shows which browser the cookies came from and when; clicking it re-imports or picks another.
- **Design mode** (toolbar toggle, ⌘⇧C like DevTools' inspect): outline on hover, click to select, ⌥-click selects
  the parent. The popover takes the note, ⌘↵ adds it. Esc leaves design mode.
- **Strip**: Console shows errors and warnings by default, Network shows fetch/XHR and failed requests by default with
  a filter for all, Performance shows LCP, INP, CLS and long tasks for the current page load. Ticking a row adds it
  to the drawer; unticking removes it.

## Architecture

A new plugin, `packages/plugins/browser`, with `main`, `renderer`, `shared` and one extra entry, `inject`, the preload
script that runs inside visited pages.

### `<webview>`, not `WebContentsView`

The page lives in a `<webview>` element in the plugin's React tree.

- It lays out like any element, so the tab, the side panel, resizing and zen mode need no bounds syncing.
- The palette, dialogs and popovers draw over it. A `WebContentsView` always sits above the renderer's DOM, which
  would hide the palette behind the page.
- Cost: `webviewTag: true` on the main window, and Electron recommends against `<webview>`. It is supported and
  stable in 39; if it is removed, the fallback is `WebContentsView` with overlays moved into their own views.

### Processes

```
renderer (plugin)            <webview partition="persist:browser">       main (plugin)
  tabs, toolbar, strip  <->    the site, plus inject/preload.ts     <->    will-attach-webview policy
  design mode popover           design mode outline, selection              CDP via webContents.debugger
  drawer items                  sendToHost(selection)                       cookie import, capturePage crops
```

- **Session**: every webview uses `session.fromPartition('persist:browser')`, apart from the app's own session, so
  site cookies never mix with the app's.
- **`will-attach-webview`** in main forces the partition, sets `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`, and replaces any preload with `inject/preload.js`. A page cannot ask for more.
- **Popups** (`target=_blank`, `window.open`) open as a new browser tab through `setWindowOpenHandler`; OAuth popups
  that need `window.opener` get a real child window.
- **Permissions**: camera, microphone, notifications and geolocation prompt through the app, per origin, remembered in
  settings.

### Design mode

`inject/preload.ts` runs in an isolated world in the page. On `design-mode on` from the host it draws a fixed
outline element over the hovered node and captures the click. The selection it sends back with `ipcRenderer.sendToHost`:

- a CSS selector (id if unique, else a short `nth-of-type` path)
- the tag, id, classes, text excerpt (200 characters) and outer HTML excerpt (1 KB)
- the bounding box in page coordinates and the device pixel ratio

The renderer shows the popover over the webview, and on submit asks main for `webContents.capturePage(rect)` with a
16px margin, saved through the existing `saveAttachment`.

### Console, Network, Performance

Main attaches `webContents.debugger` (CDP 1.3) to each browser tab's contents and enables `Runtime`, `Log`,
`Network` and `Performance`. DevTools can be open at the same time; Chrome allows several CDP clients.

- **Console**: `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`, with the stack.
- **Network**: `Network.requestWillBeSent`, `responseReceived`, `loadingFinished`, `loadingFailed`. Response bodies
  are fetched with `Network.getResponseBody` only when the row is ticked, capped at 32 KB.
- **Performance**: web vitals from a small observer in the inject script (`PerformanceObserver` for LCP, event timing
  for INP, layout shift for CLS), plus long tasks. A ticked row carries the numbers and the element that caused them.
  A full trace is DevTools' job.
- Main keeps a ring buffer per tab, 500 console entries and 500 requests, cleared on navigation to another origin, and
  streams batches to the renderer over the plugin bridge.

### Full DevTools

`webContents.openDevTools({ mode: 'detach' })` for its own window. Docked mode uses a second `<webview>` under the page
as the DevTools host through `setDevToolsWebContents`. The toggle remembers which one you used.

### Cookie import

Main only, never logged, never sent to the renderer beyond a count.

- **Chromium family** (macOS): copy the profile's `Cookies` SQLite file to a temp file (the browser holds a lock),
  read it with `node:sqlite`. The key comes from the Keychain item `<Browser> Safe Storage` through `security
  find-generic-password -w`; macOS asks the user once to allow it. Derive with PBKDF2-SHA1, salt `saltysalt`,
  1003 iterations, 16 bytes; decrypt `v10` values with AES-128-CBC and a 16-space IV. Databases at meta version 24
  and later prefix the plaintext with a 32-byte SHA-256 of the host, which is stripped.
- **Firefox**: `cookies.sqlite` of the default profile from `profiles.ini`, unencrypted.
- Each cookie goes into the partition with `session.cookies.set`, keeping domain, path, secure, httpOnly, sameSite and
  expiry. Expired and session cookies are skipped.
- The import is a one-off copy, not a sync. The profile badge shows the source and date; re-import replaces
  cookies for the same domains.
- Profiles found: every browser whose data folder exists, and each of its profiles (`Default`, `Profile 1`, ...),
  named from its `Local State`.

### Comments

`ReviewComment.kind` gains `'browser'`. A browser item sets:

- `filePath`: the page URL, `range`: `{ start: 0, end: 0 }`, `code`: empty
- `text`: the user's note (element comments) or a one-line summary (ticked rows)
- `body`: the details, always inlined: selector and HTML excerpt, stack, request and response, measurements
- `attachments`: the cropped screenshot for element comments

`commentsPrompt` puts browser items under one line per page, `Notes on <url> in the built-in browser:`, after
references and before code notes. The drawer shows them with a globe icon and the URL's path.

### Settings

- Open links from terminals in the built-in browser (on)
- Search engine for the address bar (Google)
- Cookie source and "Import again"
- Clear browsing data

### Packaging

- `webviewTag: true` on the main window.
- `inject/preload.ts` gets its own entry in `electron.vite.config.ts` so it ships as a file the policy can point to.
- **Mac App Store build**: its sandbox cannot read another app's files or Keychain items, so cookie import is hidden
  when `process.mas` is set. The rest of the browser works there.

## Error handling

- Keychain denied or the item missing: the import stops with "Treeix couldn't read <Browser>'s cookie key", nothing
  imported.
- A cookie that fails to decrypt or set is skipped and counted; the result says "Imported 1,204 cookies, skipped 3".
- Debugger detached (DevTools crashed, page process gone): the strip shows it and re-attaches on the next navigation.
- Page crash: the tab shows "This page crashed" with Reload.

## Testing

- Unit: cookie decryption against a fixture made with a known key (both with and without the host hash prefix),
  Firefox row mapping, selector builder, `commentsPrompt` with browser items, ring buffer trimming.
- Manual: import from the installed browser and open a site that needs login; comment on an element and send it to a
  Claude session; tick a failed request and a console error and send them; DevTools docked and detached; side panel
  and tab at once; ⌘-click a `localhost` link in a terminal.

## Risks

- `<webview>` deprecation risk, covered by the `WebContentsView` fallback above.
- Google sign-in may refuse embedded browsers. Imported cookies usually avoid the sign-in page altogether; if not, the
  user agent is the stock Chrome one, without the Electron token.
- Cookies copied from another browser are credentials at rest in Treeix's partition. They live in the Electron
  session store in the app's user data folder, like any browser's.
