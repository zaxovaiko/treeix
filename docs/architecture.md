# Architecture

Treeix is an Electron app with a small host and a set of plugins. The host knows about folders, repositories, worktrees, diffs, files and review comments. Everything a user would call a feature - terminals, pull requests, Jira, Confluence, diagrams - is a plugin that the host never imports directly.

## Processes

```
apps/desktop/src/main       Node: git, the file system, command line tools, plugin main modules
apps/desktop/src/preload    the only bridge, exposes window.api
apps/desktop/src/renderer   React 19, Tailwind 4, the plugin host UI
apps/desktop/src/shared     types and pure helpers both sides use
```

The renderer has no Node access. Everything that touches the disk or spawns a process goes through `window.api`, defined in `src/preload/index.ts` and typed in `src/preload/index.d.ts`.

## Plugins

A plugin is a folder in `packages/plugins/<id>` with a `package.json` holding a `treeix` manifest, an optional `main/index.ts` and an optional `renderer/index.tsx`. Authoring details live in [packages/README.md](../packages/README.md); this is how the host loads them.

- **Discovery** is static. `apps/desktop/src/renderer/src/plugins.ts` and `apps/desktop/src/main/plugins.ts` collect manifests and modules with `import.meta.glob`, so adding a folder is the whole registration step.
- **The renderer side is lazy.** Each `renderer/index.tsx` is its own chunk, fetched only once the plugin is enabled. Heavy views inside a plugin (xterm, mermaid) use `React.lazy` again, so enabling a plugin is cheap until you open its tab.
- **The main side is eager but inactive.** Main modules are bundled into the main process, but `activate(context)` runs only while the plugin is enabled, and the handlers it registered are removed when it is switched off.
- **IPC is namespaced.** `createBridge(id)` from `@treeix/sdk` calls the plugin's own handlers over `plugin:<id>:<channel>`, so two plugins cannot collide and a disabled plugin answers nothing.
- **Contributions, not hooks.** A renderer plugin returns data: `tabs`, `panels`, `titleBar`, `Root`, `Settings`, `commands`, `codeBlocks`, `linkPreviews`, `toolMarks`, `services`, `shortcuts`. The host sorts and renders them. There is no plugin that patches the host.
- **Plugins talk through services.** They never import each other. A plugin publishes a service (the terminal plugin publishes `sessions`) and others look it up with `host.service(name)`, typed by augmenting the `Services` interface in `@treeix/sdk`.
- **The host offers `HostApi`** through `HostContext`/`useHost()`: the current workspace and worktree, tabs, review comments, and render functions for the pieces a plugin should not rebuild (`renderFileView`, `renderExplorer`, `renderCommentsPanel`, `withDock`).

Shared code that several plugins need is a library package instead of a plugin: `packages/atlassian` holds the `acli` runner, the Atlassian Document Format converter, the encrypted API token and attachment downloads for both `jira` and `confluence`.

## Imports

| Alias | Points at |
| --- | --- |
| `@treeix/sdk`, `@treeix/sdk/main` | the plugin contract |
| `@treeix/app/*` | host UI building blocks (`Icon`, `ui`, `settingsUi`, file views) |
| `@treeix/shared/*` | types shared with the host |
| `@treeix/host/*` | main process helpers |
| `@treeix/atlassian/*` | the shared Atlassian library |

They are declared in `apps/desktop/electron.vite.config.ts`, `apps/desktop/tsconfig.node.json`, `apps/desktop/tsconfig.web.json` and `packages/tsconfig.json` (the last one so `bun test` resolves them). `packages/node_modules` is a symlink to `apps/desktop/node_modules`, created by the root `postinstall`.

## State and caching

Workspaces, settings and per-plugin settings live in `localStorage`; `definePluginSettings` keeps a plugin's own keys apart from the app's. Slow remote data (Jira items, Confluence pages) goes through `packages/atlassian/renderer/cache.ts`: a persistent cache with `useCached`, which shows the stored value immediately and revalidates when it is stale.

## Command line tools

Features are built on the tools you already have rather than on API tokens: `git`, `gh`, `glab`, `acli`, `claude`, `codex`. A plugin declares the tools it needs in its main module, and `apps/desktop/src/main/tools.ts` reports version, sign-in state and whether a newer release exists in Settings.

## Tests

`bun test` runs next to the code: pure logic in `*.test.ts` files beside the module. There is no renderer test runner, so logic worth testing is kept out of components (`buckets.ts`, `markdownSections.ts`, `fileTree.ts`, `adf.ts`, `search.ts`). CI commands are `bun run typecheck` and `bun run test`.
