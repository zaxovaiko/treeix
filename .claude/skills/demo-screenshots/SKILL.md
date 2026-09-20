---
name: demo-screenshots
description: Retake the Treeix landing and store screenshots against the fake demo home, so no real repositories or tickets show. Use on "retake the screenshots", "update the landing images", "new hero shot", "the screenshots are stale", "/demo-screenshots".
---

# Retake the screenshots

Every image in `apps/landing/assets` comes from the packaged app running against a throwaway home full of fake repositories. Never
screenshot your own machine - branch names, ticket keys and file paths leak.

## Build and launch

```sh
bun run dist:dmg                                            # apps/desktop/dist/mac-arm64/Treeix.app
sh apps/desktop/scripts/demo-home.sh /tmp/treeix-demo       # fake repos, worktrees, agent edits, plans
HOME=/tmp/treeix-demo apps/desktop/dist/mac-arm64/Treeix.app/Contents/MacOS/Treeix --user-data-dir=/tmp/treeix-demo/profile
```

The dev build is fine for a quick reshoot; the packaged one is what ships, so use it for anything published.

## What each asset shows

| File | Page | The moment to capture |
| --- | --- | --- |
| `hero.webp` | Worktrees | `feat/usage-invoices` diff open, a comment being written on the changed lines |
| `terminal.webp` | Terminal | One group per agent, a badge on the session waiting for an answer |
| `pr.webp` | Pull requests | A PR with its review threads and the Add to agent comments button |
| `tasks.webp` | Tasks | Jira work grouped by whose move it is, a ticket open beside the list |
| `drawer.webp` | Any | The agent comments drawer holding three queued line comments |
| `confluence.webp` | Confluence | A spec page beside the branch it describes |

Shoot at the same window size for all of them, the landing lays them out at a single width. The alt text in
`apps/landing/index.html` describes the intended moment - match it, or update it.

## Save them

Export at 2000x1307, convert to WebP, and keep the filenames. Anything else needs a matching edit in `apps/landing/index.html`.

```sh
cwebp -q 82 shot.png -o apps/landing/assets/<name>.webp
```

`og.png` is different: it comes from `marketing/og.html`, not the app. Re-render it whenever the landing's look changes, or the link
preview keeps showing the old design.

## Check the result

Serve the landing and look at the page, do not trust the file on its own:

```sh
python3 -m http.server 4321 --directory apps/landing
```
