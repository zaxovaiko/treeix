---
name: demo-screenshots
description: Retake the Treeix landing and store screenshots against the in-browser mock's fake data, so no real repositories or tickets show. Use on "retake the screenshots", "update the landing images", "new hero shot", "the screenshots are stale", "/demo-screenshots".
---

# Retake the screenshots

Every image in `apps/landing/assets` comes from the app running on its in-browser mock, which serves only seeded fake repositories,
worktrees, sessions, pull requests and tickets (`apps/desktop/src/ipc/mock*.ts`). Never screenshot the real app on your own machine -
branch names, ticket keys and file paths leak.

## Launch

```sh
cd apps/desktop && bun run dev    # http://127.0.0.1:1420, no daemon, no home folder read
```

Open it in a browser with a Mac user agent (the shortcuts and renderer follow the platform) and use a 1000x653 viewport at device scale
factor 2, which gives the 2000x1307 export below. The `ui-verify` skill covers driving the page. `?seed=empty` starts with no sessions.
Change what the mock shows in `src/ipc/mock*.ts`, not in a screenshot.

## What each asset shows

| File | Page | The moment to capture |
| --- | --- | --- |
| `hero.webp` | Worktrees | a worktree diff open (`feat/terminal-redo`), a comment being written on the changed lines |
| `terminal.webp` | Terminal | Sessions grouped by worktree in the sidebar, a dot on the session waiting for an answer, beside a shell |
| `browser.webp` | Terminal | A local app open in the browser pane beside the session that built it, console and network strip showing |
| `dependencies.webp` | Module graph | A monorepo's packages and the imports between them, a cycle or an unresolved import marked |
| `drawer.webp` | Any | The agent comments drawer holding three queued line comments |

Shoot at the same viewport for all of them, the landing lays them out at a single width. The alt text in
`apps/landing/index.html` describes the intended moment - match it, or update it.

## Save them

Capture at 2000x1307, convert to WebP, and keep the filenames. Anything else needs a matching edit in `apps/landing/index.html`.

```sh
cwebp -q 82 shot.png -o apps/landing/assets/<name>.webp
```

`og.png` is different: it comes from `marketing/og.html`, not the app. Re-render it whenever the landing's look changes, or the link
preview keeps showing the old design.

`social-preview.png` is the GitHub repository preview, which is cropped to 2:1 rather than the 1.91:1 of `og.png`, so it has its own
source in `marketing/social-preview.html`. Render it at 2x and halve it, which keeps the type crisp:

```sh
cd marketing && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --window-size=1280,640 --virtual-time-budget=6000 \
  --screenshot=/tmp/social-2x.png "file://$PWD/social-preview.html"
sips -z 640 1280 /tmp/social-2x.png --out ../apps/landing/assets/social-preview.png
```

Upload it in Settings, General, Social preview. GitHub caps the file at 1MB.

## Check the result

Serve the landing and look at the page, do not trust the file on its own:

```sh
python3 -m http.server 4321 --directory apps/landing
```
