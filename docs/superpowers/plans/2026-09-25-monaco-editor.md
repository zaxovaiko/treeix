# Monaco File Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editable files open in Monaco (VS Code's editor) with TypeScript autocomplete, auto-imports, signature help, hovers and error squiggles, keeping the app's comments, navigation, autosave and theming.

**Architecture:** `FileView` keeps its load/save/conflict logic and swaps only the view: editable files render a new `CodeEditor` (Monaco), read-only previews (peek lists, plans, chat links) keep Pierre's `File`. Diffs and PR review stay on Pierre. Language smarts come from the existing TypeScript language service in the Electron utility process, extended with an unsaved-text overlay and four new requests (completions, completion details, signature help, diagnostics), exposed through IPC and registered as Monaco providers. Highlighting uses shiki with the Pierre themes via `@shikijs/monaco`, so the editor matches diff colors.

**Tech Stack:** Electron + electron-vite, React 19, TypeScript, bun test, `monaco-editor@0.57.0`, `@shikijs/monaco@4.4.3`, `shiki@4.4.3`, `@pierre/theme@2.0.0`.

**Spec:** None written; decisions agreed in chat on 2026-09-25: Monaco over CodeMirror 6 for a VS Code feel, Monaco only for the editable file view, Pierre stays for diffs, TypeScript smarts from our own language service, other languages highlight only.

## Global Constraints

- Never `any`. `unknown` only at trust boundaries, narrowed with a type guard. `as const` over `enum`.
- No new language servers besides TypeScript; non-JS/TS files get highlighting only.
- Monaco loads lazily (dynamic `import()`), never in the initial renderer bundle.
- App shortcuts (`app.palette` ⌘K, `app.paletteAlt` ⌘⇧P, `app.leader` ⌘G, `app.settings` ⌘,, tab digits, ⌘W) must keep working with the editor focused.
- Window transparency (`opacity < 100`) must show through the editor, like the rest of the app.
- Commits: conventional messages, no AI attribution.
- CI before done: `bun run typecheck` and `bun run test` from the repo root.

## Review Focus

1. **App shortcuts with the editor focused.** ⌘K opens the palette, ⌘G starts the leader, not Monaco's chord or find-next. Pinned by `runnableActionFor` test (Task 4) and manual check (Task 8).
2. **File changes on disk while open without edits** (agent writes the file). The editor shows the new text without remounting and keeps the cursor. Pinned by `applyExternalText` test (Task 5).
3. **Unsaved text leaking into navigation after close.** Closing the file drops the overlay, so go-to-definition from other files reads disk. Pinned by the `closeDocument` assertion (Task 1).
4. **Non-TS files and huge files.** `.md`, `.json`, `.py` highlight and never call the language service; no IPC errors. Pinned by the `null` result assertions (Task 1) and `languageFor` test (Task 3).
5. **Translucent window.** At 90% opacity the editor background is transparent, not a solid block. Pinned by `editorThemeColors` test (Task 3).

---

## File Structure

- `apps/desktop/src/shared/types.ts` (modify): editor request/response types.
- `apps/desktop/src/main/languageService.ts` (modify): overlay + `completions`, `completionDetails`, `signatureHelp`, `diagnostics`, `closeDocument`.
- `apps/desktop/src/main/languageService.test.ts` (modify): tests for the above.
- `apps/desktop/src/main/languageProcess.ts`, `main/language.ts`, `main/index.ts`, `preload/index.ts`, `preload/index.d.ts` (modify): plumbing.
- `apps/desktop/src/renderer/src/monaco/setup.ts` (create): lazy Monaco + shiki + workers + theme.
- `apps/desktop/src/renderer/src/monaco/theme.ts` (create): pure theme/language helpers, testable without Monaco.
- `apps/desktop/src/renderer/src/monaco/theme.test.ts` (create).
- `apps/desktop/src/renderer/src/monaco/providers.ts` (create): TS providers backed by IPC; pure converters.
- `apps/desktop/src/renderer/src/monaco/providers.test.ts` (create).
- `apps/desktop/src/renderer/src/monaco/CodeEditor.tsx` (create): the React component.
- `apps/desktop/src/renderer/src/monaco/text.ts` + `text.test.ts` (create): external-change helper.
- `apps/desktop/src/renderer/src/monaco/comments.tsx` (create): view zones for comment cards, gutter +.
- `apps/desktop/src/renderer/src/actionRunners.ts` + test (modify): `runnableActionFor`.
- `apps/desktop/src/renderer/src/codeNavigation.tsx` (modify): export `setActiveTarget`, `openSymbolMenu`.
- `apps/desktop/src/renderer/src/FileView.tsx` (modify): use `CodeEditor` when editable.
- `apps/desktop/src/renderer/src/main.css` (modify): editor transparency + gutter + glyph.

---

### Task 1: Language service overlay and editor requests

**Files:**
- Modify: `apps/desktop/src/shared/types.ts:51-56`
- Modify: `apps/desktop/src/main/languageService.ts`
- Test: `apps/desktop/src/main/languageService.test.ts`

**Interfaces:**
- Produces (shared/types.ts):
  ```ts
  /** 1-based line, 0-based column, like SymbolTarget */
  export type CodePosition = { line: number; column: number }
  export type CodeRange = { start: CodePosition; end: CodePosition }
  export type CompletionItem = { name: string; kind: string; sortText: string; insertText: string; range: CodeRange | null; source: string | null; data: string | null }
  export type CompletionDetails = { detail: string; documentation: string; edits: { range: CodeRange; text: string }[] }
  export type SignatureHelp = { signatures: { label: string; documentation: string; parameters: { label: string; documentation: string }[] }[]; activeSignature: number; activeParameter: number }
  export type CodeDiagnostic = { range: CodeRange; message: string; severity: 'error' | 'warning' | 'info'; code: number }
  ```
- Produces (languageService.ts), all return `null` for files TypeScript does not handle:
  ```ts
  completions(worktreePath: string, path: string, text: string, position: CodePosition): CompletionItem[] | null
  completionDetails(worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null): CompletionDetails | null
  signatureHelp(worktreePath: string, path: string, text: string, position: CodePosition): SignatureHelp | null
  diagnostics(worktreePath: string, path: string, text: string): CodeDiagnostic[] | null
  closeDocument(worktreePath: string, path: string): void
  ```

- [ ] **Step 1: Add the types** to `shared/types.ts` after `HoverInfo` (the block above), and extend `LanguageRequest`:

```ts
export type LanguageRequest =
  | { type: 'navigate'; worktreePath: string; kind: NavigationKind; target: SymbolTarget }
  | { type: 'hover'; worktreePath: string; target: SymbolTarget }
  | { type: 'completions'; worktreePath: string; path: string; text: string; position: CodePosition }
  | { type: 'completionDetails'; worktreePath: string; path: string; text: string; position: CodePosition; name: string; source: string | null; data: string | null }
  | { type: 'signatureHelp'; worktreePath: string; path: string; text: string; position: CodePosition }
  | { type: 'diagnostics'; worktreePath: string; path: string; text: string }
  | { type: 'closeDocument'; worktreePath: string; path: string }
```

- [ ] **Step 2: Write the failing test** (append to `languageService.test.ts`, extend the import to `closeDocument, completionDetails, completions, diagnostics, hover, navigate, signatureHelp`):

```ts
test('answers from unsaved text: completions, auto-imports, signatures, diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'treeix-ls-'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' }, include: ['*.ts'] }))
  writeFileSync(join(root, 'grant.ts'), 'export function grant(id: string, days: number): void {}\n')
  writeFileSync(join(root, 'use.ts'), '')

  const members = completions(root, 'use.ts', 'const list = [1, 2]\nlist.ma', { line: 2, column: 7 }) ?? []
  expect(members.some((item) => item.name === 'map')).toBe(true)

  const imported = (completions(root, 'use.ts', 'gran', { line: 1, column: 4 }) ?? []).find((item) => item.name === 'grant')
  expect(imported?.source).not.toBeNull()
  const details = completionDetails(root, 'use.ts', 'gran', { line: 1, column: 4 }, 'grant', imported?.source ?? null, imported?.data ?? null)
  expect(details?.edits.map((edit) => edit.text).join('')).toContain('import { grant } from "./grant"')

  const signature = signatureHelp(root, 'use.ts', 'import { grant } from "./grant"\ngrant("a", ', { line: 2, column: 11 })
  expect(signature?.signatures[0].label).toBe('grant(id: string, days: number): void')
  expect(signature?.activeParameter).toBe(1)

  const errors = diagnostics(root, 'use.ts', 'const count: number = "x"\n') ?? []
  expect(errors.map((error) => [error.code, error.range.start.line, error.severity])).toEqual([[2322, 1, 'error']])

  // Closing drops the unsaved text: navigation reads the empty file on disk again
  closeDocument(root, 'use.ts')
  expect(diagnostics(root, 'use.ts', '')).toEqual([])
  expect(completions(root, 'notes.md', '', { line: 1, column: 0 })).toBeNull()
  expect(diagnostics(root, 'notes.md', '')).toBeNull()
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/main/languageService.test.ts`
Expected: FAIL, `completions` is not exported.

- [ ] **Step 4: Implement.** In `languageService.ts`:

Add after `const projects = ...`:
```ts
/** Unsaved editor text by absolute file name; its version makes the program re-read the file */
const overlays = new Map<string, { text: string; version: number }>()
let overlayVersion = 0

function setOverlay(fileName: string, text: string | null): void {
  if (text === null) overlays.delete(fileName)
  else if (overlays.get(fileName)?.text !== text) overlays.set(fileName, { text, version: ++overlayVersion })
}

const PREFERENCES: ts.UserPreferences = {
  includeCompletionsForModuleExports: true,
  includeCompletionsWithInsertText: true,
  includeCompletionsWithSnippetText: false,
  importModuleSpecifierPreference: 'shortest'
}
```

In `createProject`'s host, overlays win over disk:
```ts
    getScriptVersion: (fileName) => {
      const overlay = overlays.get(fileName)
      return overlay ? `overlay:${overlay.version}` : version(fileName)
    },
    getScriptSnapshot: (fileName) => {
      const text = overlays.get(fileName)?.text ?? ts.sys.readFile(fileName)
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
    },
```

Change `positionOf`'s parameter type from `SymbolTarget` to `CodePosition` (SymbolTarget still fits structurally). Then add at the end of the file:

```ts
type OpenDocument = { service: ts.LanguageService; fileName: string; sourceFile: ts.SourceFile; offset: number }

/** Applies the editor's text, then resolves the position in it */
function openDocument(worktreePath: string, path: string, text: string, position: CodePosition): OpenDocument | null {
  const fileName = resolve(worktreePath, path)
  if (!supportsLanguageService(fileName)) return null
  setOverlay(fileName, text)
  const project = projectFor(worktreePath, fileName)
  const sourceFile = project.service.getProgram()?.getSourceFile(fileName)
  const offset = positionOf(project, fileName, position)
  return sourceFile && offset !== null ? { service: project.service, fileName, sourceFile, offset } : null
}

function rangeOf(sourceFile: ts.SourceFile, start: number, length: number): CodeRange {
  const from = sourceFile.getLineAndCharacterOfPosition(start)
  const to = sourceFile.getLineAndCharacterOfPosition(start + length)
  return { start: { line: from.line + 1, column: from.character }, end: { line: to.line + 1, column: to.character } }
}

export function completions(worktreePath: string, path: string, text: string, position: CodePosition): CompletionItem[] | null {
  const document = openDocument(worktreePath, path, text, position)
  if (!document) return null
  const result = document.service.getCompletionsAtPosition(document.fileName, document.offset, PREFERENCES)
  return (result?.entries ?? []).map((entry) => ({
    name: entry.name,
    kind: entry.kind,
    sortText: entry.sortText,
    insertText: entry.insertText ?? entry.name,
    range: entry.replacementSpan ? rangeOf(document.sourceFile, entry.replacementSpan.start, entry.replacementSpan.length) : null,
    source: entry.source ?? null,
    data: entry.data ? JSON.stringify(entry.data) : null
  }))
}

export function completionDetails(worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null): CompletionDetails | null {
  const document = openDocument(worktreePath, path, text, position)
  if (!document) return null
  // data is what completions() serialized from TypeScript's own CompletionEntryData
  const entryData = data ? (JSON.parse(data) as ts.CompletionEntryData) : undefined
  const details = document.service.getCompletionEntryDetails(document.fileName, document.offset, name, {}, source ?? undefined, PREFERENCES, entryData)
  if (!details) return null
  const edits = (details.codeActions ?? [])
    .flatMap((action) => action.changes)
    .filter((change) => change.fileName === document.fileName)
    .flatMap((change) => change.textChanges)
    .map((change) => ({ range: rangeOf(document.sourceFile, change.span.start, change.span.length), text: change.newText }))
  return { detail: ts.displayPartsToString(details.displayParts), documentation: ts.displayPartsToString(details.documentation), edits }
}

export function signatureHelp(worktreePath: string, path: string, text: string, position: CodePosition): SignatureHelp | null {
  const document = openDocument(worktreePath, path, text, position)
  const help = document && document.service.getSignatureHelpItems(document.fileName, document.offset, {})
  if (!help) return null
  const parts = ts.displayPartsToString
  return {
    signatures: help.items.map((item) => {
      const parameters = item.parameters.map((parameter) => ({ label: parts(parameter.displayParts), documentation: parts(parameter.documentation) }))
      return {
        label: parts(item.prefixDisplayParts) + parameters.map((parameter) => parameter.label).join(parts(item.separatorDisplayParts)) + parts(item.suffixDisplayParts),
        documentation: parts(item.documentation),
        parameters
      }
    }),
    activeSignature: help.selectedItemIndex,
    activeParameter: help.argumentIndex
  }
}

const SEVERITY = { [ts.DiagnosticCategory.Error]: 'error', [ts.DiagnosticCategory.Warning]: 'warning', [ts.DiagnosticCategory.Suggestion]: 'info', [ts.DiagnosticCategory.Message]: 'info' } as const

export function diagnostics(worktreePath: string, path: string, text: string): CodeDiagnostic[] | null {
  const document = openDocument(worktreePath, path, text, { line: 1, column: 0 })
  if (!document) return supportsLanguageService(path) ? [] : null
  const { service, fileName, sourceFile } = document
  return [...service.getSyntacticDiagnostics(fileName), ...service.getSemanticDiagnostics(fileName)].flatMap((diagnostic) =>
    diagnostic.start === undefined
      ? []
      : [{ range: rangeOf(sourceFile, diagnostic.start, diagnostic.length ?? 0), message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'), severity: SEVERITY[diagnostic.category], code: diagnostic.code }]
  )
}

export function closeDocument(worktreePath: string, path: string): void {
  setOverlay(resolve(worktreePath, path), null)
}
```
Update the `../shared/types` import to include `CodeDiagnostic, CodePosition, CodeRange, CompletionDetails, CompletionItem, SignatureHelp`.

Note: `diagnostics` on an empty file resolves position `{line:1,column:0}` fine; it returns `[]` rather than `null` for a TS file whose program failed to load.

- [ ] **Step 5: Run the tests**

Run: `cd apps/desktop && bun test src/main/languageService.test.ts`
Expected: both tests PASS. If the auto-import text uses single quotes, TypeScript inferred quote style from the file; set `quotePreference: 'double'` in `PREFERENCES` only if the test file has no quotes to infer from, and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/types.ts apps/desktop/src/main/languageService.ts apps/desktop/src/main/languageService.test.ts
git commit -m "feat(editor): completions, signatures and diagnostics from unsaved text"
```

---

### Task 2: IPC plumbing

**Files:**
- Modify: `apps/desktop/src/main/languageProcess.ts`
- Modify: `apps/desktop/src/main/language.ts`
- Modify: `apps/desktop/src/main/index.ts:95-97`
- Modify: `apps/desktop/src/preload/index.ts:16-17`, `apps/desktop/src/preload/index.d.ts`

**Interfaces:**
- Consumes: Task 1 functions and types.
- Produces on `window.api`:
  ```ts
  completions: (worktreePath: string, path: string, text: string, position: CodePosition) => Promise<CompletionItem[]>
  completionDetails: (worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null) => Promise<CompletionDetails | null>
  signatureHelp: (worktreePath: string, path: string, text: string, position: CodePosition) => Promise<SignatureHelp | null>
  diagnostics: (worktreePath: string, path: string, text: string) => Promise<CodeDiagnostic[]>
  closeDocument: (worktreePath: string, path: string) => void
  ```

- [ ] **Step 1: Dispatch in the utility process.** Replace the `result` expression in `languageProcess.ts`:

```ts
import { closeDocument, completionDetails, completions, diagnostics, hover, navigate, signatureHelp } from './languageService'
import type { LanguageRequest } from '../shared/types'

function answer(request: LanguageRequest): unknown {
  switch (request.type) {
    case 'hover':
      return hover(request.worktreePath, request.target)
    case 'navigate':
      return navigate(request.worktreePath, request.kind, request.target)
    case 'completions':
      return completions(request.worktreePath, request.path, request.text, request.position)
    case 'completionDetails':
      return completionDetails(request.worktreePath, request.path, request.text, request.position, request.name, request.source, request.data)
    case 'signatureHelp':
      return signatureHelp(request.worktreePath, request.path, request.text, request.position)
    case 'diagnostics':
      return diagnostics(request.worktreePath, request.path, request.text)
    case 'closeDocument':
      return closeDocument(request.worktreePath, request.path)
  }
}

// Runs in an Electron utility process so building programs for big repos never blocks the main process
process.parentPort.on('message', ({ data }: { data: { id: number; request: LanguageRequest } }) => {
  const { id, request } = data
  try {
    process.parentPort.postMessage({ id, result: answer(request) })
  } catch (error: unknown) {
    process.parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
})
```

- [ ] **Step 2: Main-process wrappers** in `language.ts` (after `hover`). Each skips the process for non-TS files and swallows failures, since a missing suggestion must never break typing:

```ts
const forTypeScript = <T>(path: string, request: LanguageRequest, fallback: T): Promise<T> =>
  supportsLanguageService(path) ? ask<T>(request).then((result) => result ?? fallback, () => fallback) : Promise.resolve(fallback)

export const completions = (worktreePath: string, path: string, text: string, position: CodePosition): Promise<CompletionItem[]> =>
  forTypeScript(path, { type: 'completions', worktreePath, path, text, position }, [])
export const completionDetails = (worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null): Promise<CompletionDetails | null> =>
  forTypeScript(path, { type: 'completionDetails', worktreePath, path, text, position, name, source, data }, null)
export const signatureHelp = (worktreePath: string, path: string, text: string, position: CodePosition): Promise<SignatureHelp | null> =>
  forTypeScript(path, { type: 'signatureHelp', worktreePath, path, text, position }, null)
export const diagnostics = (worktreePath: string, path: string, text: string): Promise<CodeDiagnostic[]> =>
  forTypeScript(path, { type: 'diagnostics', worktreePath, path, text }, [])
/** Only a running process holds overlays, so there is nothing to close otherwise */
export function closeDocument(worktreePath: string, path: string): void {
  if (child && supportsLanguageService(path)) void ask({ type: 'closeDocument', worktreePath, path }).catch(() => null)
}
```

- [ ] **Step 3: IPC handlers** in `main/index.ts` next to `hover`:

```ts
  ipcMain.handle('completions', (_, worktreePath: string, path: string, text: string, position: CodePosition) => completions(worktreePath, path, text, position))
  ipcMain.handle('completionDetails', (_, worktreePath: string, path: string, text: string, position: CodePosition, name: string, source: string | null, data: string | null) =>
    completionDetails(worktreePath, path, text, position, name, source, data)
  )
  ipcMain.handle('signatureHelp', (_, worktreePath: string, path: string, text: string, position: CodePosition) => signatureHelp(worktreePath, path, text, position))
  ipcMain.handle('diagnostics', (_, worktreePath: string, path: string, text: string) => diagnostics(worktreePath, path, text))
  ipcMain.on('closeDocument', (_, worktreePath: string, path: string) => closeDocument(worktreePath, path))
```

- [ ] **Step 4: Preload** in `preload/index.ts` next to `hover`, and the matching signatures (Interfaces block above) in `preload/index.d.ts`:

```ts
  completions: (worktreePath, path, text, position) => ipcRenderer.invoke('completions', worktreePath, path, text, position),
  completionDetails: (worktreePath, path, text, position, name, source, data) => ipcRenderer.invoke('completionDetails', worktreePath, path, text, position, name, source, data),
  signatureHelp: (worktreePath, path, text, position) => ipcRenderer.invoke('signatureHelp', worktreePath, path, text, position),
  diagnostics: (worktreePath, path, text) => ipcRenderer.invoke('diagnostics', worktreePath, path, text),
  closeDocument: (worktreePath, path) => ipcRenderer.send('closeDocument', worktreePath, path),
```

- [ ] **Step 5: Typecheck and test**

Run: `bun run typecheck && bun run test` (repo root)
Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main apps/desktop/src/preload
git commit -m "feat(editor): expose editor language requests over IPC"
```

---

### Task 3: Monaco setup, theme and language mapping

**Files:**
- Modify: `apps/desktop/package.json` (deps)
- Create: `apps/desktop/src/renderer/src/monaco/theme.ts`
- Create: `apps/desktop/src/renderer/src/monaco/theme.test.ts`
- Create: `apps/desktop/src/renderer/src/monaco/setup.ts`

**Interfaces:**
- Produces (`theme.ts`, no Monaco import so bun can test it):
  ```ts
  export const languageFor = (path: string): string   // shiki language id, 'text' when unknown
  export const editorThemeColors = (theme: Theme, opacity: number): Record<string, string>
  ```
- Produces (`setup.ts`):
  ```ts
  export type Monaco = typeof import('monaco-editor')
  export function loadMonaco(): Promise<Monaco>          // cached; workers, themes, providers registered once
  export function ensureLanguage(monaco: Monaco, language: string): Promise<void>
  export function applyEditorTheme(monaco: Monaco): void // re-run when theme or opacity changes
  ```

- [ ] **Step 1: Install**

```bash
cd apps/desktop && bun add monaco-editor@0.57.0 @shikijs/monaco@4.4.3 shiki@4.4.3 @pierre/theme@2.0.0
ls node_modules/monaco-editor/esm/vs/editor/editor.main.js node_modules/monaco-editor/esm/vs/editor/editor.worker.js
```
Expected: both listed. 0.57 has no `editor.all.js`; `editor.main.js` is the full editor including the TypeScript/CSS/JSON/HTML language modes. Their workers only start when a model of that language asks for one, so Step 5 turns the TypeScript mode off and `getWorker` only ever returns the base editor worker.

- [ ] **Step 2: Write the failing test** `monaco/theme.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { THEMES } from '../themes'
import { editorThemeColors, languageFor } from './theme'

test('maps paths to shiki languages, plain text when unknown', () => {
  expect(languageFor('src/App.tsx')).toBe('tsx')
  expect(languageFor('a/b.mts')).toBe('typescript')
  expect(languageFor('README.md')).toBe('markdown')
  expect(languageFor('Dockerfile')).toBe('docker')
  expect(languageFor('notes.unknownext')).toBe('text')
})

test('a translucent window makes the editor see-through', () => {
  expect(editorThemeColors(THEMES.neutral, 100)['editor.background']).toBe('#000000')
  expect(editorThemeColors(THEMES.neutral, 90)['editor.background']).toBe('#00000000')
  expect(editorThemeColors(THEMES.neutral, 90)['editorGutter.background']).toBe('#00000000')
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/desktop && bun test src/renderer/src/monaco/theme.test.ts`
Expected: FAIL, module `./theme` not found.

- [ ] **Step 4: Implement `monaco/theme.ts`:**

```ts
import type { Theme } from '../themes'

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc', md: 'markdown', mdx: 'mdx', css: 'css', scss: 'scss', html: 'html', vue: 'vue', svelte: 'svelte',
  py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp',
  cs: 'csharp', sql: 'sql', prisma: 'prisma', graphql: 'graphql', sh: 'shellscript', zsh: 'shellscript', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', xml: 'xml', svg: 'xml'
}
const BY_NAME: Record<string, string> = { dockerfile: 'docker', makefile: 'makefile' }

export function languageFor(path: string): string {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  const extension = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return BY_NAME[name] ?? BY_EXTENSION[extension] ?? 'text'
}

const CLEAR = '#00000000'

/** Overrides on top of the Pierre syntax theme so the editor sits on the app's surface */
export function editorThemeColors(theme: Theme, opacity: number): Record<string, string> {
  const background = opacity < 100 ? CLEAR : theme.background
  return {
    'editor.background': background,
    'editorGutter.background': background,
    'minimap.background': background,
    'editorWidget.background': theme.popover,
    'editorSuggestWidget.background': theme.popover,
    'editorHoverWidget.background': theme.popover,
    'editorLineNumber.foreground': theme.mutedForeground,
    'editorCursor.foreground': theme.foreground,
    focusBorder: theme.primary
  }
}
```

- [ ] **Step 5: Implement `monaco/setup.ts`:**

```ts
import { activeTheme, getSettings } from '../settings'
import { THEMES } from '../themes'
import { editorThemeColors } from './theme'

export type Monaco = typeof import('monaco-editor')

type Shiki = Awaited<ReturnType<typeof import('shiki').createHighlighter>>
let loading: Promise<{ monaco: Monaco; shiki: Shiki }> | null = null

async function load(): Promise<{ monaco: Monaco; shiki: Shiki }> {
  const [monaco, { default: EditorWorker }, { createHighlighter }, { shikiToMonaco }, { default: pierreDark }, { default: pierreLight }] = await Promise.all([
    // editor.main: the whole editor, find, suggest, hover, folding and the rest
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('shiki'),
    import('@shikijs/monaco'),
    import('@pierre/theme/pierre-dark'),
    import('@pierre/theme/pierre-light')
  ])
  // Only the base worker: TypeScript smarts come from the app's own language service, not Monaco's
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
  // Monaco's own TypeScript mode would start its 7 MB worker and duplicate our providers; turn every feature of it off
  const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false }
  monaco.languages.typescript.typescriptDefaults.setModeConfiguration(off)
  monaco.languages.typescript.javascriptDefaults.setModeConfiguration(off)
  const shiki = await createHighlighter({ themes: [pierreDark, pierreLight], langs: [] })
  shikiToMonaco(shiki, monaco)
  const { registerTypeScriptProviders } = await import('./providers')
  registerTypeScriptProviders(monaco)
  return { monaco, shiki }
}

const loaded = (): Promise<{ monaco: Monaco; shiki: Shiki }> => (loading ??= load())

export const loadMonaco = async (): Promise<Monaco> => (await loaded()).monaco

/** Grammars load on first use; shikiToMonaco re-registers tokenizers for everything loaded so far */
export async function ensureLanguage(monaco: Monaco, language: string): Promise<void> {
  const { shiki } = await loaded()
  if (language === 'text' || shiki.getLoadedLanguages().includes(language)) return
  await shiki.loadLanguage(language as Parameters<Shiki['loadLanguage']>[0]).catch(() => undefined)
  monaco.languages.register({ id: language })
  const { shikiToMonaco } = await import('@shikijs/monaco')
  shikiToMonaco(shiki, monaco)
}

/** Pierre's syntax colors with the app's surface; defined as `treeix` and applied to every editor */
export function applyEditorTheme(monaco: Monaco): void {
  const theme = THEMES[activeTheme()]
  const syntax = theme.mode === 'light' ? 'pierre-light' : 'pierre-dark'
  monaco.editor.setTheme(syntax)
  monaco.editor.defineTheme('treeix', { base: theme.mode === 'light' ? 'vs' : 'vs-dark', inherit: true, rules: [], colors: editorThemeColors(theme, getSettings().opacity) })
  // shiki paints tokens through its own theme; defineTheme only swaps editor chrome colors on top of it
  monaco.editor.setTheme(syntax)
}
```

Note for the implementer: `@shikijs/monaco` tokenizes through the active shiki theme name, so the editor must use `pierre-dark`/`pierre-light` as its Monaco theme. To apply `editorThemeColors`, patch the colors into the theme shiki registered: after `shikiToMonaco`, call `monaco.editor.defineTheme(syntax, { base, inherit: true, rules: <shiki rules>, colors })`. If that loses token colors, keep `setTheme(syntax)` and apply the transparent background with the CSS in Task 5 Step 4 instead; the `editorThemeColors` test still pins the intended colors. Verify visually in Task 8 either way.

Our models use shiki language ids (`typescript`, `tsx`, ...). Monaco's built-in `typescript` id overlaps; with its mode configuration all off it contributes nothing, and shiki's tokenizer replaces its Monarch one. In Task 8 confirm in DevTools (Network/Sources) that no `ts.worker` is ever loaded. If `monaco.languages.typescript` is missing or deprecated in 0.57's types, look it up in `node_modules/monaco-editor/monaco.d.ts` (it may live at `monaco.typescript`) and use that path.

If TypeScript rejects `?worker`, add `apps/desktop/src/renderer/src/monaco/modules.d.ts`:
```ts
declare module 'monaco-editor/esm/vs/editor/editor.worker?worker' {
  const EditorWorker: new () => Worker
  export default EditorWorker
}
```
and declare `interface Window { MonacoEnvironment?: { getWorker: () => Worker } }` only if `monaco-editor`'s types don't already.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd apps/desktop && bun test src/renderer/src/monaco && cd ../.. && bun run typecheck`
Expected: PASS. (`providers.ts` does not exist yet; create it as `export function registerTypeScriptProviders(_monaco: Monaco): void {}` so this task compiles; Task 6 fills it.)

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/bun.lock apps/desktop/src/renderer/src/monaco
git commit -m "feat(editor): load Monaco lazily with shiki and the Pierre themes"
```

---

### Task 4: App shortcuts win over Monaco's

**Files:**
- Modify: `apps/desktop/src/renderer/src/actionRunners.ts`
- Test: `apps/desktop/src/renderer/src/actionRunners.test.ts`

**Interfaces:**
- Produces: `export function runnableActionFor(event: KeyboardEvent): string | undefined` — the id of a registered app action matching a ⌘/⌃ chord, `undefined` for plain typing keys.

- [ ] **Step 1: Write the failing test** (append):

```ts
import { runnableActionFor } from './actionRunners'

test('an editor hands ⌘ chords with a runner back to the app, never plain keys', () => {
  const drop = registerActionRunner('test.zen', () => undefined)
  const dropLine = registerActionRunner('test.line', () => undefined)
  const press = (code: string, modifiers: Partial<Record<'metaKey' | 'shiftKey', boolean>> = {}) =>
    ({ code, key: code, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...modifiers }) as KeyboardEvent
  expect(runnableActionFor(press('Enter', { metaKey: true, shiftKey: true }))).toBe('test.zen')
  expect(runnableActionFor(press('KeyJ'))).toBeUndefined()
  drop()
  dropLine()
  expect(runnableActionFor(press('Enter', { metaKey: true, shiftKey: true }))).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/desktop && bun test src/renderer/src/actionRunners.test.ts`
Expected: FAIL, `runnableActionFor` not exported.

- [ ] **Step 3: Implement** in `actionRunners.ts` (add `actionForEvent` to the keymap import):

```ts
/** A registered action for a ⌘ or ⌃ chord; editors with their own keymaps pass these back to the app */
export function runnableActionFor(event: KeyboardEvent): string | undefined {
  if (!event.metaKey && !event.ctrlKey) return undefined
  return actionForEvent(event, [...runners.keys()])
}
```

- [ ] **Step 4: Run to verify it passes**, then **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/actionRunners.ts apps/desktop/src/renderer/src/actionRunners.test.ts
git commit -m "feat(editor): let editors hand app shortcuts back"
```

---

### Task 5: CodeEditor component in FileView

**Files:**
- Create: `apps/desktop/src/renderer/src/monaco/text.ts`, `monaco/text.test.ts`
- Create: `apps/desktop/src/renderer/src/monaco/CodeEditor.tsx`
- Modify: `apps/desktop/src/renderer/src/FileView.tsx:333-380`
- Modify: `apps/desktop/src/renderer/src/main.css`

**Interfaces:**
- Consumes: `loadMonaco`, `ensureLanguage`, `applyEditorTheme`, `languageFor` (Task 3); `runnableActionFor`, `runAction` (Task 4).
- Produces:
  ```ts
  // text.ts
  export function applyExternalText(current: string, next: string): { start: number; end: number; text: string } | null
  // CodeEditor.tsx
  export type CodeEditorHandle = { editor: import('monaco-editor').editor.IStandaloneCodeEditor; monaco: Monaco }
  export function CodeEditor(props: {
    worktreePath: string
    path: string
    contents: string
    line: number | null
    onChange: (text: string) => void
    onReady?: (handle: CodeEditorHandle) => void
  }): React.JSX.Element
  ```

- [ ] **Step 1: Write the failing test** `monaco/text.test.ts`. The editor applies disk changes as one minimal edit so the cursor and undo history survive:

```ts
import { expect, test } from 'bun:test'
import { applyExternalText } from './text'

test('a disk change becomes the smallest single edit', () => {
  expect(applyExternalText('a\nb\nc', 'a\nb\nc')).toBeNull()
  expect(applyExternalText('a\nb\nc', 'a\nB\nc')).toEqual({ start: 2, end: 3, text: 'B' })
  expect(applyExternalText('abc', 'abXc')).toEqual({ start: 2, end: 2, text: 'X' })
  expect(applyExternalText('abc', '')).toEqual({ start: 0, end: 3, text: '' })
})
```

- [ ] **Step 2: Run to verify it fails** (`bun test src/renderer/src/monaco/text.test.ts`, module missing).

- [ ] **Step 3: Implement `monaco/text.ts`:**

```ts
/** The changed middle between two texts, as offsets into `current` */
export function applyExternalText(current: string, next: string): { start: number; end: number; text: string } | null {
  if (current === next) return null
  let start = 0
  while (start < current.length && start < next.length && current[start] === next[start]) start++
  let fromEnd = 0
  while (fromEnd < current.length - start && fromEnd < next.length - start && current[current.length - 1 - fromEnd] === next[next.length - 1 - fromEnd]) fromEnd++
  return { start, end: current.length - fromEnd, text: next.slice(start, next.length - fromEnd) }
}
```

Run the test: PASS.

- [ ] **Step 4: Implement `monaco/CodeEditor.tsx`:**

```tsx
import type { editor as MonacoEditor } from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import { runAction, runnableActionFor } from '../actionRunners'
import { fontStack, getSettings, MONO_STACK, useSettings } from '../settings'
import { EmptyState } from '../ui'
import { applyEditorTheme, ensureLanguage, loadMonaco, type Monaco } from './setup'
import { applyExternalText } from './text'
import { languageFor } from './theme'

export type CodeEditorHandle = { editor: MonacoEditor.IStandaloneCodeEditor; monaco: Monaco }

export function CodeEditor({ worktreePath, path, contents, line, onChange, onReady }: {
  worktreePath: string
  path: string
  contents: string
  line: number | null
  onChange: (text: string) => void
  onReady?: (handle: CodeEditorHandle) => void
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<CodeEditorHandle | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const settings = useSettings()

  useEffect(() => {
    let disposed = false
    let created: MonacoEditor.IStandaloneCodeEditor | null = null
    void loadMonaco().then(async (monaco) => {
      const language = languageFor(path)
      await ensureLanguage(monaco, language)
      if (disposed || !host.current) return
      applyEditorTheme(monaco)
      const uri = monaco.Uri.file(`${worktreePath}/${path}`)
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(contents, language, uri)
      created = monaco.editor.create(host.current, {
        model,
        automaticLayout: true,
        fontFamily: fontStack(getSettings().editorFont, MONO_STACK),
        fontSize: getSettings().editorFontSize,
        glyphMargin: true,
        contextmenu: false,
        scrollBeyondLastLine: false,
        fixedOverflowWidgets: true,
        quickSuggestions: { other: true, comments: false, strings: false },
        suggest: { showStatusBar: true, preview: true },
        tabSize: 2
      })
      // App chords (palette, leader, tab digits) reach the app instead of Monaco's chords and find-next
      created.onKeyDown((event) => {
        const id = runnableActionFor(event.browserEvent)
        if (!id) return
        event.preventDefault()
        event.stopPropagation()
        runAction(id)
      })
      created.onDidChangeModelContent(() => onChangeRef.current(model.getValue()))
      const next = { editor: created, monaco }
      setHandle(next)
      onReady?.(next)
    })
    return () => {
      disposed = true
      const model = created?.getModel()
      created?.dispose()
      model?.dispose()
      window.api.closeDocument(worktreePath, path)
    }
  }, [worktreePath, path])

  // Disk changes FileView accepted (no unsaved edits) arrive as new contents
  useEffect(() => {
    const model = handle?.editor.getModel()
    if (!handle || !model) return
    const change = applyExternalText(model.getValue(), contents)
    if (!change) return
    const from = model.getPositionAt(change.start)
    const to = model.getPositionAt(change.end)
    model.pushEditOperations([], [{ range: new handle.monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: change.text }], () => null)
  }, [handle, contents])

  useEffect(() => {
    if (!handle || !line) return
    handle.editor.revealLineInCenter(line)
    handle.editor.setPosition({ lineNumber: line, column: 1 })
    const decorations = handle.editor.createDecorationsCollection([{ range: new handle.monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'code-editor-target-line' } }])
    return () => decorations.clear()
  }, [handle, line])

  useEffect(() => {
    if (!handle) return
    applyEditorTheme(handle.monaco)
    handle.editor.updateOptions({ fontFamily: fontStack(settings.editorFont, MONO_STACK), fontSize: settings.editorFontSize })
  }, [handle, settings.theme, settings.opacity, settings.editorFont, settings.editorFontSize])

  return (
    <div className="code-editor relative min-h-0 flex-1">
      <div ref={host} className="absolute inset-0" />
      {!handle && <EmptyState fill title="Loading editor..." />}
    </div>
  )
}
```

Check `fontStack`'s signature in `settings.ts` before use; it is `fontStack(custom: string, fallback: string)` as used in `packages/plugins/terminal/renderer/terminals.ts:377`.

- [ ] **Step 5: CSS** (append to `main.css`):

```css
/* Monaco paints opaque surfaces of its own; a translucent window shows the panel behind */
html[data-translucent] .code-editor .monaco-editor,
html[data-translucent] .code-editor .monaco-editor-background,
html[data-translucent] .code-editor .monaco-editor .margin {
  background-color: transparent !important;
}
.code-editor-target-line {
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
}
.code-editor-comment-glyph::before {
  content: '+';
  display: grid;
  place-items: center;
  height: 100%;
  border-radius: 4px;
  background: var(--color-primary);
  color: white;
  font-weight: 600;
  cursor: pointer;
}
```

Set the attribute where translucency is applied, in `apps/desktop/src/renderer/src/main.tsx` next to `window.api.setTranslucent(...)`:
```ts
  document.documentElement.toggleAttribute('data-translucent', opacity < 100)
```

- [ ] **Step 6: Use it in FileView.** In `FileView.tsx`, render `CodeEditor` instead of the `Virtualizer`/`File` block when `editable`; keep the Pierre block for read-only. Replace the `<Virtualizer>...</Virtualizer>` element with:

```tsx
        {editable ? (
          <CodeEditor
            worktreePath={worktreePath}
            path={path}
            contents={contents}
            line={line}
            onChange={(text) => {
              if (text === (latest.current ?? onDisk.current)) return
              latest.current = text
              setStatus('pending')
              clearTimeout(timer.current)
              timer.current = setTimeout(() => flushRef.current(), AUTOSAVE_DELAY_MS)
            }}
            onReady={setEditor}
          />
        ) : (
          <Virtualizer className="min-h-0 flex-1 overflow-auto">
            {/* the existing <File ... /> unchanged */}
          </Virtualizer>
        )}
```
Add `const [editor, setEditor] = useState<CodeEditorHandle | null>(null)` near the other state (Task 7 uses it), and import `CodeEditor, type CodeEditorHandle` from `./monaco/CodeEditor`. `onChange` ignores the echo of `applyExternalText` (text equals disk) so a disk reload does not mark the file unsaved. Skip the "scroll to line" effect (`useEffect` polling `findLineElement`) when `editable`: add `if (editable) return` at its top.

- [ ] **Step 7: Typecheck, tests, commit**

```bash
bun run typecheck && bun run test
git add apps/desktop/src/renderer/src
git commit -m "feat(editor): edit files in Monaco"
```

---

### Task 6: TypeScript providers

**Files:**
- Modify: `apps/desktop/src/renderer/src/monaco/providers.ts`
- Create: `apps/desktop/src/renderer/src/monaco/providers.test.ts`

**Interfaces:**
- Consumes: `window.api.completions/completionDetails/signatureHelp/diagnostics/hover` (Task 2).
- Produces:
  ```ts
  export function registerTypeScriptProviders(monaco: Monaco): void
  export function watchDiagnostics(monaco: Monaco, model: editor.ITextModel, worktreePath: string, path: string): { dispose: () => void }
  // pure, tested:
  export const completionKind: (kind: string) => keyof typeof CompletionKindName
  export const toMonacoRange: (range: CodeRange) => { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }
  export const toCodePosition: (position: { lineNumber: number; column: number }) => CodePosition
  ```

- [ ] **Step 1: Write the failing test** `monaco/providers.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { completionKind, toCodePosition, toMonacoRange } from './providers'

test('converts between TypeScript and Monaco coordinates', () => {
  expect(toCodePosition({ lineNumber: 3, column: 5 })).toEqual({ line: 3, column: 4 })
  expect(toMonacoRange({ start: { line: 1, column: 0 }, end: { line: 2, column: 3 } })).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 4 })
})

test('maps TypeScript completion kinds to Monaco icons', () => {
  expect(completionKind('method')).toBe('Method')
  expect(completionKind('const')).toBe('Constant')
  expect(completionKind('interface')).toBe('Interface')
  expect(completionKind('something new')).toBe('Property')
})
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement `providers.ts`.** Only the pure helpers import nothing from Monaco at runtime (types only), so bun can test them:

```ts
import type { editor, languages } from 'monaco-editor'
import type { CodePosition, CodeRange } from '../../../shared/types'
import type { Monaco } from './setup'

const KINDS = {
  method: 'Method', function: 'Function', 'local function': 'Function', constructor: 'Constructor', property: 'Property', getter: 'Property', setter: 'Property',
  var: 'Variable', let: 'Variable', 'local var': 'Variable', parameter: 'Variable', const: 'Constant', class: 'Class', 'local class': 'Class',
  interface: 'Interface', type: 'TypeParameter', alias: 'Reference', enum: 'Enum', 'enum member': 'EnumMember', module: 'Module', keyword: 'Keyword',
  string: 'Value', 'primitive type': 'Keyword', directory: 'Folder', script: 'File', 'external module name': 'Module'
} as const
export type CompletionKindName = (typeof KINDS)[keyof typeof KINDS] | 'Property'

export const completionKind = (kind: string): CompletionKindName => (Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : 'Property')
export const toCodePosition = (position: { lineNumber: number; column: number }): CodePosition => ({ line: position.lineNumber, column: position.column - 1 })
export const toMonacoRange = (range: CodeRange) => ({ startLineNumber: range.start.line, startColumn: range.start.column + 1, endLineNumber: range.end.line, endColumn: range.end.column + 1 })

/** worktree and path of an editor model, whose URI is file://<worktree>/<path> */
const documents = new Map<string, { worktreePath: string; path: string }>()
export const registerDocument = (model: editor.ITextModel, worktreePath: string, path: string): void => void documents.set(model.uri.toString(), { worktreePath, path })
export const forgetDocument = (model: editor.ITextModel): void => void documents.delete(model.uri.toString())

const LANGUAGES = ['typescript', 'tsx', 'javascript', 'jsx']

export function registerTypeScriptProviders(monaco: Monaco): void {
  for (const language of LANGUAGES) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: ['.', '"', "'", '/', '@', '<'],
      provideCompletionItems: async (model, position) => {
        const document = documents.get(model.uri.toString())
        if (!document) return { suggestions: [] }
        const text = model.getValue()
        const items = await window.api.completions(document.worktreePath, document.path, text, toCodePosition(position))
        const word = model.getWordUntilPosition(position)
        const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        return {
          suggestions: items.map((item) => ({
            label: item.source ? { label: item.name, description: item.source } : item.name,
            kind: monaco.languages.CompletionItemKind[completionKind(item.kind)],
            sortText: item.sortText,
            insertText: item.insertText,
            range: item.range ? toMonacoRange(item.range) : wordRange,
            // resolveCompletionItem reads these back
            data: { uri: model.uri.toString(), name: item.name, source: item.source, data: item.data, position: toCodePosition(position), text }
          }))
        }
      },
      resolveCompletionItem: async (item: languages.CompletionItem & { data?: { uri: string; name: string; source: string | null; data: string | null; position: CodePosition; text: string } }) => {
        const document = item.data && documents.get(item.data.uri)
        if (!document || !item.data) return item
        const details = await window.api.completionDetails(document.worktreePath, document.path, item.data.text, item.data.position, item.data.name, item.data.source, item.data.data)
        if (!details) return item
        return {
          ...item,
          detail: details.detail,
          documentation: details.documentation ? { value: details.documentation } : undefined,
          // Auto-imports: the import line lands with the completion, like VS Code
          additionalTextEdits: details.edits.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.text }))
        }
      }
    })
    monaco.languages.registerSignatureHelpProvider(language, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      provideSignatureHelp: async (model, position) => {
        const document = documents.get(model.uri.toString())
        const help = document && (await window.api.signatureHelp(document.worktreePath, document.path, model.getValue(), toCodePosition(position)))
        if (!help) return null
        return {
          value: {
            signatures: help.signatures.map((signature) => ({
              label: signature.label,
              documentation: signature.documentation,
              parameters: signature.parameters.map((parameter) => ({ label: parameter.label, documentation: parameter.documentation }))
            })),
            activeSignature: help.activeSignature,
            activeParameter: help.activeParameter
          },
          dispose: () => undefined
        }
      }
    })
    monaco.languages.registerHoverProvider(language, {
      provideHover: async (model, position) => {
        const document = documents.get(model.uri.toString())
        const word = model.getWordAtPosition(position)
        if (!document || !word) return null
        const info = await window.api.hover(document.worktreePath, { path: document.path, line: position.lineNumber, column: word.startColumn - 1, symbol: word.word })
        if (!info) return null
        return { contents: [{ value: `\`\`\`typescript\n${info.signature}\n\`\`\`` }, ...(info.documentation ? [{ value: info.documentation }] : [])] }
      }
    })
  }
}

const DIAGNOSTIC_DELAY_MS = 300

/** Squiggles, refreshed after typing pauses; also keeps the service's copy of the unsaved text current for hovers */
export function watchDiagnostics(monaco: Monaco, model: editor.ITextModel, worktreePath: string, path: string): { dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const severity = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning, info: monaco.MarkerSeverity.Info }
  const check = async (): Promise<void> => {
    const version = model.getVersionId()
    const found = await window.api.diagnostics(worktreePath, path, model.getValue())
    if (model.isDisposed() || model.getVersionId() !== version) return
    monaco.editor.setModelMarkers(model, 'typescript', found.map((diagnostic) => ({ ...toMonacoRange(diagnostic.range), message: diagnostic.message, severity: severity[diagnostic.severity], code: String(diagnostic.code) })))
  }
  void check()
  const listener = model.onDidChangeContent(() => {
    clearTimeout(timer)
    timer = setTimeout(() => void check(), DIAGNOSTIC_DELAY_MS)
  })
  return { dispose: () => (clearTimeout(timer), listener.dispose()) }
}
```

- [ ] **Step 4: Wire into CodeEditor.** In `CodeEditor.tsx` after creating the editor:

```ts
      registerDocument(model, worktreePath, path)
      const diagnosticsWatch = supportsLanguageService(path) ? watchDiagnostics(monaco, model, worktreePath, path) : null
```
and in the cleanup, before `model?.dispose()`: `diagnosticsWatch?.dispose()` and `if (model) forgetDocument(model)`. Hold `diagnosticsWatch` in a variable next to `created`. Import `supportsLanguageService` from `../../../shared/languages`.

- [ ] **Step 5: Run tests, typecheck, commit**

```bash
bun run typecheck && bun run test
git add apps/desktop/src/renderer/src/monaco
git commit -m "feat(editor): TypeScript completions, auto-imports, signatures, hovers and squiggles"
```

---

### Task 7: Navigation and comments in the editor

**Files:**
- Modify: `apps/desktop/src/renderer/src/codeNavigation.tsx:44-47, 188-200`
- Create: `apps/desktop/src/renderer/src/monaco/comments.tsx`
- Modify: `apps/desktop/src/renderer/src/FileView.tsx`

**Interfaces:**
- Consumes: `CodeEditorHandle` (Task 5), `CommentCard`, `CommentDraft` (`Comments.tsx`), `Navigate`.
- Produces:
  ```ts
  // codeNavigation.tsx
  export const setActiveTarget: (target: SymbolTarget, worktreePath: string) => void
  export function openSymbolMenu(event: MouseEvent | React.MouseEvent, target: SymbolTarget, worktreePath: string, path: string, onNavigate: Navigate): void
  // comments.tsx
  export function useEditorNavigation(handle: CodeEditorHandle | null, worktreePath: string, path: string, onNavigate: Navigate): void
  export function EditorComments(props: { handle: CodeEditorHandle; zones: { line: number; key: string; node: React.ReactNode }[]; onGutterComment: (range: LineRange) => void }): React.JSX.Element
  ```

- [ ] **Step 1: Export the navigation helpers.** In `codeNavigation.tsx`:

```ts
export const setActiveTarget = (target: SymbolTarget, worktreePath: string): void => void (activeTarget = { target, worktreePath })

/** The right-click menu of a symbol: the navigation actions and copy */
export function openSymbolMenu(event: MouseEvent | React.MouseEvent, target: SymbolTarget, worktreePath: string, path: string, onNavigate: Navigate): void {
  openMenu(event, [
    ...NAVIGATION_ACTIONS.map(({ kind, label }) => ({
      label,
      accelerator: acceleratorFor(kind),
      enabled: kind === 'definition' || kind === 'references' || supportsLanguageService(path),
      run: () => onNavigate(kind, target, worktreePath)
    })),
    null,
    { label: `Copy "${target.symbol}"`, run: () => copyText(target.symbol) }
  ])
}
```
and make `useSymbolNavigation`'s `onContextMenu` call `openSymbolMenu(event, target, worktreePath, path, onNavigate)` after `setCard(null)`. Check `openMenu`'s first parameter type; widen it to `MouseEvent | React.MouseEvent` if it only takes the React event (it needs only `clientX/clientY`/`preventDefault`).

- [ ] **Step 2: Implement `monaco/comments.tsx`:**

```tsx
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LineRange } from '../../../shared/comments'
import type { SymbolTarget } from '../../../shared/types'
import { type Navigate, openSymbolMenu, setActiveTarget } from '../codeNavigation'
import type { CodeEditorHandle } from './CodeEditor'

const targetAt = (handle: CodeEditorHandle, path: string, position: { lineNumber: number; column: number } | null): SymbolTarget | null => {
  const word = position && handle.editor.getModel()?.getWordAtPosition(position)
  return word && position ? { path, line: position.lineNumber, column: word.startColumn - 1, symbol: word.word } : null
}

/** ⌘-click goes to the definition, F12 and friends act on the cursor's symbol, right-click opens the symbol menu */
export function useEditorNavigation(handle: CodeEditorHandle | null, worktreePath: string, path: string, onNavigate: Navigate): void {
  useEffect(() => {
    if (!handle) return
    const { editor, monaco } = handle
    const subscriptions = [
      editor.onDidChangeCursorPosition(({ position }) => {
        const target = targetAt(handle, path, position)
        if (target) setActiveTarget(target, worktreePath)
      }),
      editor.onMouseDown(({ event, target }) => {
        if (!event.metaKey || target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return
        const symbol = targetAt(handle, path, target.position)
        if (symbol) onNavigate('definition', symbol, worktreePath)
      }),
      editor.onContextMenu(({ event, target }) => {
        const symbol = targetAt(handle, path, target.position)
        if (symbol) openSymbolMenu(event.browserEvent, symbol, worktreePath, path, onNavigate)
      })
    ]
    return () => subscriptions.forEach((subscription) => subscription.dispose())
  }, [handle, worktreePath, path, onNavigate])
}

/** Comment cards and the draft sit between lines as view zones, like VS Code's review comments */
export function EditorComments({ handle, zones, onGutterComment }: {
  handle: CodeEditorHandle
  zones: { line: number; key: string; node: React.ReactNode }[]
  onGutterComment: (range: LineRange) => void
}): React.JSX.Element {
  const [nodes, setNodes] = useState<Map<string, HTMLDivElement>>(new Map())
  const heights = useRef(new Map<string, { id: string; zone: { heightInPx: number } }>())

  useEffect(() => {
    const { editor } = handle
    const created = new Map<string, HTMLDivElement>()
    const observers: ResizeObserver[] = []
    editor.changeViewZones((accessor) => {
      for (const zone of zones) {
        const domNode = document.createElement('div')
        const content = document.createElement('div')
        domNode.appendChild(content)
        const spec = { afterLineNumber: zone.line, heightInPx: 80, domNode }
        const id = accessor.addZone(spec)
        heights.current.set(zone.key, { id, zone: spec })
        created.set(zone.key, content)
        // Cards grow as text wraps or the draft editor expands; the zone follows
        const observer = new ResizeObserver(() => {
          spec.heightInPx = content.offsetHeight + 8
          editor.changeViewZones((layout) => layout.layoutZone(id))
        })
        observer.observe(content)
        observers.push(observer)
      }
    })
    setNodes(created)
    return () => {
      observers.forEach((observer) => observer.disconnect())
      editor.changeViewZones((accessor) => heights.current.forEach(({ id }) => accessor.removeZone(id)))
      heights.current.clear()
    }
  }, [handle, zones.map((zone) => `${zone.key}@${zone.line}`).join()])

  // + in the glyph margin on the hovered line; a line-number drag comments on the selected lines
  useEffect(() => {
    const { editor, monaco } = handle
    const hover = editor.createDecorationsCollection()
    let fromLineNumbers = false
    const subscriptions = [
      editor.onMouseMove(({ target }) => {
        const line = target.position?.lineNumber
        hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'code-editor-comment-glyph' } }] : [])
      }),
      editor.onMouseLeave(() => hover.clear()),
      editor.onMouseDown(({ target }) => {
        fromLineNumbers = target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
        if (target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && target.position) onGutterComment({ start: target.position.lineNumber, end: target.position.lineNumber })
      }),
      editor.onMouseUp(() => {
        const selection = editor.getSelection()
        if (!fromLineNumbers || !selection) return
        fromLineNumbers = false
        // Dragging line numbers selects whole lines; a selection ending at column 1 stops on the line before
        const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber
        onGutterComment({ start: selection.startLineNumber, end })
      })
    ]
    return () => {
      hover.clear()
      subscriptions.forEach((subscription) => subscription.dispose())
    }
  }, [handle, onGutterComment])

  return <>{zones.map((zone) => { const node = nodes.get(zone.key); return node ? createPortal(zone.node, node, zone.key) : null })}</>
}
```

Plain line-number clicks (no drag) also select one line; that opens a draft on it, matching the old gutter behavior. If that feels too eager in Task 8, require `selection.startLineNumber !== end` for the drag path and rely on the glyph for single lines.

- [ ] **Step 3: Use them in FileView** (editable branch only):

```tsx
  useEditorNavigation(editor, worktreePath, path, onNavigate)
  const zones = editable
    ? [
        ...comments.map((comment) => ({ line: comment.range.end, key: comment.id, node: <CommentCard comment={comment} onDelete={() => onDeleteComment(comment)} /> })),
        ...(draft
          ? [{
              line: draft.end,
              key: 'draft',
              node: (
                <CommentDraft
                  label={`Comment on line ${rangeLabel(draft)}`}
                  onCancel={() => setDraft(null)}
                  onSave={(text, attachments) => {
                    onAddComment(draft, extractFileLines(latest.current ?? contents, draft), text, attachments)
                    setDraft(null)
                  }}
                />
              )
            }]
          : [])
      ]
    : []
```
Place `useEditorNavigation` above the early `return`s (hooks rule) and compute `zones` after them. Render `{editor && <EditorComments handle={editor} zones={zones} onGutterComment={setDraft} />}` right after `<CodeEditor .../>`. `onContextMenu={symbols.onContextMenu}` on the wrapper stays for the Pierre branch only: `onContextMenu={editable ? undefined : symbols.onContextMenu}`. `setDraft` from `useState` is stable, which keeps `EditorComments`' effect from re-subscribing.

- [ ] **Step 4: Typecheck, tests, commit**

```bash
bun run typecheck && bun run test
git add apps/desktop/src/renderer/src
git commit -m "feat(editor): navigation and line comments in Monaco"
```

---

### Task 8: Verify in the app

**Files:** none unless a check fails.

- [ ] **Step 1: Start the app** with the `dev` configuration in `.claude/launch.json` (repo root `bun run dev`) and open a TypeScript file from the Worktrees explorer and from the Terminal page's Files panel.

- [ ] **Step 2: Walk the checklist**, fixing and committing (`fix(editor): ...`) any failure:
  - Type `useSt` in a `.tsx` file: suggestion list shows `useState` with the `react` source; accepting adds the import line.
  - Type `foo(` on a known function: parameter hints show; `,` moves the active parameter.
  - Type `const n: number = "x"`: red squiggle within ~0.5s; fixing clears it.
  - Hover a symbol: signature and docs card.
  - ⌘-click a symbol in another file: that file opens at the definition. F12 on the cursor symbol does the same. Right-click shows Go to Definition / Find All References.
  - With the editor focused: ⌘K opens the palette, ⌘G starts the leader, ⌘1 switches tab, ⌘S saves at once, ⌘W closes the file tab, ⌘F opens Monaco's find.
  - Click the glyph +: draft opens under the line; save it: the card stays between lines and grows with text. Drag line numbers 3-6: draft for 3-6.
  - In a terminal: `echo "// changed" >> <file>` with no unsaved edits: text updates, cursor stays, status stays Saved. With unsaved edits: the conflict banner appears (existing behavior).
  - Settings: transparency 10%: editor background shows the blurred desktop like other panels, no solid block, no flicker when opening files. Switch light/dark theme: editor recolors.
  - Open `README.md`, `package.json`, a `.py` file: highlighted, no errors in the console (`read_console_messages` / preview logs).
  - Peek list (Find All References) previews and plan views still render with Pierre.

- [ ] **Step 3: CI**

Run: `bun run typecheck && bun run test` (repo root)
Expected: clean.
