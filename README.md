<div align="center">

<img src="apps/desktop/resources/icon.png" alt="Treeix" width="120" />

# Treeix

**Review what your coding agents did - worktrees, diffs, pull requests, tasks and terminals in one window.**

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey.svg)](#install)
[![Electron](https://img.shields.io/badge/Electron-39-47848F.svg?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB.svg?logo=react&logoColor=black)](https://react.dev/)
[![Bun](https://img.shields.io/badge/Bun-tests-000000.svg?logo=bun&logoColor=white)](https://bun.sh/)
[![Plugins](https://img.shields.io/badge/plugins-8-8b5cf6.svg)](packages/README.md)

[Download](https://treeix.dyvertex.com/download) · [Website](https://treeix.dyvertex.com) · [Plugin docs](packages/README.md) · [Architecture](docs/architecture.md)

<img src="apps/landing/assets/hero.webp" alt="Treeix reviewing a worktree diff" width="900" />

</div>

## Why

Agents write code faster than anyone can read it. The reading is the bottleneck, and it is spread across a terminal, a git client, a browser tab per pull request and a tracker. Treeix puts one worktree, its diff, its review comments, its pull request and the agent session that produced it on a single screen, and sends your comments straight back to the agent.

## What it does

- **Worktrees.** Every repository and checkout in your folders, with the diff against the base branch, split or unified.
- **Review in place.** Select lines, leave comments, then send them to a Claude or Codex session or copy them out.
- **Sessions that survive.** Claude, Codex and shell sessions keep running across reloads, docked next to the diff or in their own tab.
- **Pull requests.** GitHub and GitLab, through `gh` and `glab`: threads, viewed files, conflict and CI state.
- **Tasks and pages.** Jira work items and Confluence pages through the Atlassian CLI, with link previews anywhere a URL appears.
- **Markdown that behaves.** Foldable headings, mermaid diagrams, images from private uploads, full screen with zoom.
- **Everything is a plugin.** Each feature above can be switched off in Settings and stops loading its code entirely.

## Install

Download the DMG from [treeix.dyvertex.com/download](https://treeix.dyvertex.com/download). Apple silicon, macOS 14 or newer.

Build it yourself:

```sh
bun install
bun run dev
```

Optional command line tools, each feature degrades without its own: `gh`, `glab`, `acli`, `claude`, `codex`.

## Plugins

The host in `apps/desktop` owns workspaces, worktrees, diffs, the editor, comments and settings. Everything else ships as a plugin in [`packages/plugins`](packages/plugins).

| Plugin | Default | What it adds |
| --- | --- | --- |
| [`terminal`](packages/plugins/terminal) | on | Terminal tab, docked panel, Claude, Codex and shell sessions |
| [`pull-requests`](packages/plugins/pull-requests) | on | GitHub and GitLab pull requests, review threads, conflicts |
| [`plans`](packages/plugins/plans) | on | Claude plans in the palette and on sessions |
| [`usage-limits`](packages/plugins/usage-limits) | on | Claude and Codex 5-hour and weekly limits in the title bar |
| [`diagrams`](packages/plugins/diagrams) | on | Mermaid code blocks, loaded on the first diagram |
| [`keep-awake`](packages/plugins/keep-awake) | on | Keeps the Mac awake while an agent is working |
| [`jira`](packages/plugins/jira) | off | Jira work items, status changes, worktree per item |
| [`confluence`](packages/plugins/confluence) | off | Confluence pages, search, spaces, link previews |

Writing one takes a `package.json` and a `renderer/index.tsx`: see [packages/README.md](packages/README.md).

## Development

```sh
bun install        # installs both apps and links packages/node_modules
bun run dev        # electron-vite dev
bun run typecheck  # tsc, both projects
bun run test       # bun test, app and packages
```

Repository layout:

```
apps/desktop    the Electron app (main, preload, renderer)
apps/landing    static landing page for treeix.dyvertex.com
packages/sdk    the plugin contract
packages/plugins  the plugins
packages/atlassian  shared acli, Atlassian Document Format, credentials
```

More: [architecture](docs/architecture.md) · [releasing](docs/releasing.md) · [contributing](CONTRIBUTING.md) · [security](SECURITY.md)

## License

[Apache License 2.0](LICENSE). You may use, modify and redistribute Treeix, including commercially, as long as you keep the license and the [NOTICE](NOTICE) file and state your changes. Forks and derivative works must credit Treeix:

> Built on Treeix (https://treeix.dyvertex.com), Copyright 2026 Treeix contributors, licensed under the Apache License 2.0.

The name and the icons are trademarks and are not part of the license grant.
