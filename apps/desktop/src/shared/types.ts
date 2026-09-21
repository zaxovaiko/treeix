import type { Shortcut } from './shortcut'

export type Worktree = {
  path: string
  head: string
  branch: string | null
  changedFiles: number
}

export type Repo = {
  path: string
  worktrees: Worktree[]
}

export type HistoryEntry = { id: string; savedAt: number; bytes: number }

export type Branch = {
  name: string
  /** Remote-only branches are named like origin/feat/x */
  remote: boolean
  ahead: number
  behind: number
  /** Upstream was deleted, typically after its PR merged */
  gone: boolean
  merged: boolean
  /** Unix seconds of the last commit */
  committedAt: number
}

export type FilePatch = {
  path: string
  patch: string
  additions: number
  deletions: number
}

export type CodeLocation = {
  path: string
  /** 1-based */
  line: number
  /** 0-based */
  column: number
  text: string
  isDefinition?: boolean
}

export type SearchOptions = { caseSensitive: boolean; wholeWord: boolean; regex: boolean }
export type SearchMatch = CodeLocation & { worktreePath: string }
export type SearchResult = { matches: SearchMatch[]; truncated: boolean }

export type SymbolTarget = { path: string; line: number; column: number; symbol: string }
export type NavigationKind = 'definition' | 'typeDefinition' | 'implementation' | 'references'
export type HoverInfo = { signature: string; documentation: string }
export type LanguageRequest =
  | { type: 'navigate'; worktreePath: string; kind: NavigationKind; target: SymbolTarget }
  | { type: 'hover'; worktreePath: string; target: SymbolTarget }

export type WorktreeFiles = {
  files: string[]
  /** Ignored paths; folders end with a slash and are not expanded */
  ignored: string[]
}

export type ToolStatus = {
  name: string
  purpose: string
  version: string | null
  /** Newer released version, null when up to date or the check failed */
  update: string | null
  /** Command that installs the update, null when we can't tell how it was installed */
  updateCommand: string | null
  /** Signed-in accounts for CLIs that need auth, null when not applicable */
  accounts: string[] | null
  error: string | null
}

export type HotkeyOptions = {
  /** Recorded key combination, null turns the hotkey window off */
  shortcut: Shortcut | null
  hideOnBlur: boolean
  /** No normal window: it always stays the borderless drop-down, only shown and hidden */
  only: boolean
}

export type ContextMenuItem =
  | { type: 'separator' }
  | { type?: 'item'; id: string; label: string; enabled?: boolean; accelerator?: string }

/**
 * Where the app is in getting its next version. `unsupported` covers builds that update elsewhere:
 * a dev run, the Mac App Store, or an unsigned build macOS would refuse to replace.
 */
export type UpdateStatus = {
  /** The running version, for Settings */
  current: string
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'unsupported' | 'error'
  /** The version being downloaded or waiting to be installed */
  version?: string
  /** 0-100 while downloading */
  percent?: number
  /** Why the check failed, or why updates are unsupported here */
  message?: string
}

export type Api = {
  home: string
  scan: () => Promise<Repo[]>
  diff: (worktreePath: string) => Promise<FilePatch[]>
  listFiles: (worktreePath: string) => Promise<WorktreeFiles>
  listDirectory: (root: string, folder: string) => Promise<string[]>
  /** Native folder picker; null when cancelled */
  pickFolder: () => Promise<string | null>
  readFile: (worktreePath: string, filePath: string) => Promise<string | null>
  /** Language service answers for TS/JS, text search for everything else */
  navigate: (worktreePath: string, kind: NavigationKind, target: SymbolTarget) => Promise<CodeLocation[]>
  hover: (worktreePath: string, target: SymbolTarget) => Promise<HoverInfo | null>
  /** Rejects with git's message when the pattern is not a valid regex */
  searchText: (worktreePaths: string[], query: string, options: SearchOptions) => Promise<SearchResult>
  checkTools: () => Promise<ToolStatus[]>
  /** Whether a command's first word is on the user's login shell PATH */
  commandExists: (name: string) => Promise<boolean>
  plugins: {
    /** Tells the main process which plugins are enabled, activating or disposing their main modules */
    setEnabled: (ids: string[]) => Promise<void>
    invoke: <T>(pluginId: string, channel: string, ...args: unknown[]) => Promise<T>
    send: (pluginId: string, channel: string, ...args: unknown[]) => void
    /** Returns the unsubscribe */
    on: (pluginId: string, channel: string, listener: (...args: unknown[]) => void) => () => void
  }
  showContextMenu: (items: ContextMenuItem[]) => Promise<string | null>
  /** Existing branches are checked out; new ones start from `base` (default HEAD) */
  addWorktree: (repoPath: string, branch: string, base?: string) => Promise<string>
  /** Local branches plus remote-only ones, newest commit first */
  listBranches: (repoPath: string) => Promise<Branch[]>
  createBranch: (repoPath: string, name: string, base: string) => Promise<void>
  /** Safe delete: refuses branches with unmerged commits */
  deleteBranch: (repoPath: string, name: string) => Promise<void>
  removeWorktree: (worktreePath: string, force: boolean) => Promise<void>
  discardChanges: (worktreePath: string, filePath: string) => Promise<void>
  revealInFinder: (path: string) => void
  openPath: (path: string) => void
  /** Blurs the desktop behind the window's see-through backgrounds, or turns that off */
  /** `background` is the opaque theme color, used when not translucent */
  setTranslucent: (translucent: boolean, background: string, appearance: 'dark' | 'light' | 'system') => void
  /** Resolves with an error message when the shortcut cannot be registered */
  configureHotkey: (options: HotkeyOptions) => Promise<string | null>
  /** Fires with true while the window has no title bar buttons: full screen or the hotkey window */
  onWindowChromeless: (listener: (chromeless: boolean) => void) => () => void
  /** ⌘W, routed through the page so it can close a terminal pane instead of the window */
  onCloseShortcut: (listener: () => void) => () => void
  /** Settings… in the app menu */
  onOpenSettings: (listener: () => void) => () => void
  /** The actions the native menu should offer; sent again whenever a plugin loads or a key is rebound */
  setMenuActions: (actions: { id: string; label: string; section: string; accelerator?: string }[]) => void
  /** A native menu item was picked; the id names an action with a registered runner */
  onRunAction: (listener: (id: string) => void) => () => void
  /** Copies an attachment into app data and returns its absolute path */
  saveAttachment: (name: string, data: Uint8Array) => Promise<string>
  /**
   * Snapshots the previous on-disk version into the edit history first. Rejects with SAVE_CONFLICT in the message
   * when the file no longer matches `expected`; pass null to overwrite regardless
   */
  saveFile: (worktreePath: string, filePath: string, contents: string, expected: string | null) => Promise<void>
  /** Calls back when the file changes on disk, including our own saves; returns the unsubscribe */
  watchFile: (worktreePath: string, filePath: string, listener: () => void) => () => void
  listHistory: (worktreePath: string, filePath: string) => Promise<HistoryEntry[]>
  readHistory: (worktreePath: string, filePath: string, id: string) => Promise<string>
  /** A path ending in / creates a folder */
  createPath: (worktreePath: string, filePath: string) => Promise<void>
  renamePath: (worktreePath: string, from: string, to: string) => Promise<void>
  /** Moves to the system Trash */
  trashPath: (worktreePath: string, filePath: string) => Promise<void>
  updates: {
    /** The status right now; the app checks on its own, this is for Settings opening mid-check */
    status: () => Promise<UpdateStatus>
    /** Asks GitHub now; resolves with the status the check ended on */
    check: () => Promise<UpdateStatus>
    /** Quits and installs the downloaded version */
    install: () => void
    /** Fires on every change; returns the unsubscribe */
    on: (listener: (status: UpdateStatus) => void) => () => void
  }
}

/** The app's own version, baked in at build time; unpackaged Electron reports its own from `app.getVersion()` */
declare global {
  const __APP_VERSION__: string
}
