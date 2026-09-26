# 5. Monaco for editable files

Date: 2026-09-25
Status: Accepted

## Context

Editable files used Pierre's `File` view, which has no autocomplete, signature help or error squiggles. Users wanted a VS Code feel when editing, without losing the app's comments, code navigation, autosave, theming and shortcuts. The app already runs a TypeScript language service in an Electron utility process for navigation.

## Decision

- Editable files open in Monaco (`apps/desktop/src/renderer/src/monaco/CodeEditor.tsx`). `FileView` keeps its load, save and conflict logic and swaps only the view. Read-only previews, diffs and PR review stay on Pierre.
- Monaco, its worker and shiki load lazily with dynamic `import()`, never in the initial renderer bundle.
- Language smarts come from the existing TypeScript language service, extended with an unsaved-text overlay and requests for completions, completion details, signature help and diagnostics, registered as Monaco providers over IPC. Closing a file drops its overlay so navigation reads disk again.
- Highlighting uses shiki with the Pierre themes through `@shikijs/monaco`, so the editor matches diff colours. The editor background stays transparent for translucent windows.
- App shortcuts (palette, leader, settings, tab digits, close) win over Monaco's own bindings.
- A file changed on disk while open without edits updates in place, keeping the cursor.

## Alternatives considered

- CodeMirror 6: lighter, but Monaco gives the VS Code feel directly.
- Extra language servers: rejected. Only TypeScript and JavaScript get smarts; other languages highlight only.

## Consequences

- Two code renderers now coexist: Monaco for editing, Pierre for reading and diffs.
- Brings in `monaco-editor` and `@shikijs/monaco`, loaded only when a file is edited.
- Comments and the gutter add button are reimplemented as Monaco view zones rather than shared with Pierre.
