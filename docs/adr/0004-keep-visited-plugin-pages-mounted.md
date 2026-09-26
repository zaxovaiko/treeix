# 4. Keep visited plugin pages mounted

Date: 2026-09-22
Status: Accepted

## Context

`App.tsx` rendered only the active plugin tab, so every switch unmounted one page and rebuilt the next, markdown parsing included. Measured over CDP in the dev build, returning to Pull requests blocked the main thread for 764-833 ms per visit. The packaged build showed 0 ms, but the rebuild work was still being paid on every switch.

## Decision

- Every plugin page visited in the current workspace stays mounted (`keptPages` in `apps/desktop/src/renderer/src/keepAlive.ts`). The page on screen is the only one with a layout box; the others sit behind the `hidden` attribute.
- Each kept page renders under its own `HostContext` whose `activePage` is that page's id, as the split pane already did. `host.activeTab` still names the tab actually on screen.
- Shared code learned about hidden pages: zone picking skips zones with no layout box, the bottom dock is drawn only around the page on screen, and a terminal revealed again is refitted to its pane.
- Bare keys go only to the page that holds the keyboard (`keyboardPage`), since hidden pages keep their window listeners.
- Scope is plugin tabs only. Worktrees, Settings and document tabs behave as before.

## Consequences

- Switching back to a page is instant in both builds. In dev, a switch dropped to 180-215 ms, the remainder being `jsxDEV` for the shell itself.
- Switching workspace clears the visited list, so pages rebuild with the new workspace's data.
- A plugin switched off while kept is dropped from the list. The split pane's page is not kept twice.
- Hidden pages keep their memory and listeners. Rollback is a one-line filter back to the active tab only.
