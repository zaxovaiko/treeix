# Treeix plugins

The app in `apps/desktop` is the host: workspaces, worktrees, diffs, the editor, comments and settings. Everything else is a plugin in `plugins/<id>`, switched on and off under Settings → Plugins.

## Layout of a plugin

```
plugins/<id>/
  package.json        "treeix": { id, name, description, enabledByDefault, requires? }
  main/index.ts       optional, default export MainPlugin (Node side: CLIs, files, IPC handlers)
  renderer/index.tsx  optional, default export RendererPlugin (tabs, panels, title bar, settings, commands, services)
  shared/types.ts     types both sides use
```

The folder name must match `id`. The host finds plugins with `import.meta.glob`, so adding a folder is enough.

- **Main modules** are bundled into the main process, but `activate` only runs while the plugin is enabled. Handlers registered with `context.handle` are removed when it is disabled.
- **Renderer modules** are separate chunks. They are fetched only once the plugin is enabled, and heavy views inside them should use `React.lazy`.
- **Talking between the two sides:** `createBridge(id)` from `@treeix/sdk` calls the plugin's own main handlers.
- **Talking to other plugins:** plugins don't import each other. They offer and look up services (`services` in `RendererPlugin`, `host.service(name)`, `useService(name)`). A plugin adds its service to the `Services` interface with module augmentation.
- **Settings:** a plugin keeps its settings apart from the app's with `definePluginSettings`.
- **Link previews:** a plugin can recognise URLs (`linkPreviews`). Any view renders `<LinkPreviews urls>` from `@treeix/app/LinkPreviews`, and each link shows through whichever enabled plugin recognises it. Jira issues and Confluence pages preview this way in Jira items, Confluence pages and pull request descriptions.
- **Layout and keyboard:** a page renders `<PageLayout list main inspector>` so its panels follow the shell's keys (⌘⇧E list, ⌘⌥B inspector, ⌘⇧↵ zen) and are remembered per page; `usePanels()` gives toggles for buttons. Each part is a focus `<Zone>` that F6 cycles; `useZone()` tells which one has focus. Lists use `useListNav` for j/k, Enter and a cursor that is the selection. Keys a plugin handles go in `shortcuts` so the `?` sheet and Settings list them.
- **Shared code:** code several plugins need goes in a library package instead, like `atlassian/`. It holds acli, Atlassian Document Format, the API token and attachment images, and is used by `jira` and `confluence`.
- **Agent identity:** the built-in and user-defined coding agents (id, label, mark, colour, command) live in the host at `@treeix/app/agents`, not in `@treeix/sdk`. A plugin that needs to know which agents exist imports from there.

## Imports

- `@treeix/sdk`, `@treeix/sdk/main`: the plugin contract.
- `@treeix/app/*`: host UI building blocks (icons, `ui`, `settingsUi`, file views).
- `@treeix/shared/*`: types shared with the host.
- `@treeix/host/*`: main process helpers.
- `@treeix/atlassian/*`: the shared Atlassian library.

These are aliases in `apps/desktop/electron.vite.config.ts`, `apps/desktop/tsconfig.*.json` and `packages/tsconfig.json` (for bun tests).

`packages/node_modules` is a symlink to `apps/desktop/node_modules` so plugin files resolve the app's dependencies. The root `postinstall` creates it.
