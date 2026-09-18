import { createContext, type ComponentType, type ReactNode, useContext, useSyncExternalStore } from 'react'
import type { Command } from '@treeix/app/CommandPalette'
import type { IconName } from '@treeix/app/Icon'
import type { ReviewComment } from '@treeix/shared/comments'
import type { Repo } from '@treeix/shared/types'

/** The `treeix` field of a plugin's package.json */
export type PluginManifest = {
  id: string
  name: string
  description: string
  enabledByDefault: boolean
  /** Plugins that must be enabled for this one to load */
  requires?: string[]
}

export type { Command, IconName }

/** A tab in the title bar that always exists while the plugin is enabled */
export type TabContribution = {
  id: string
  label: string
  icon: IconName
  /** Lower comes first; Worktrees is 0 */
  order: number
  render: ComponentType
  /** Small indicator next to the label, e.g. sessions waiting for input */
  Badge?: ComponentType
  /** Dock panels whose toggles show in the title bar while this tab is active */
  panels?: string[]
}

/** A tab opened on demand, like one pull request or one plan; closing it returns to `parent` */
export type DocumentTab = {
  key: string
  title: string
  icon: ReactNode
  parent: string
  content: ReactNode
  /** Dock panels whose toggles show in the title bar while this tab is active */
  panels?: string[]
}

/**
 * Rich previews for links found in text, e.g. a Confluence page or a Jira issue. Views call `<LinkPreviews urls>`
 * from the app; each plugin that recognises a URL renders it, so previews appear only while that plugin is enabled.
 */
export type LinkPreview = {
  /** Section heading for the links this preview handles, e.g. "Confluence" */
  label: string
  /** A stable identity when several URLs point at the same thing (page id, issue key), else null when not handled */
  keyOf: (url: string) => string | null
  render: ComponentType<{ url: string }>
}

/** A panel that docks left, right or bottom of the Worktrees tab */
export type PanelContribution = {
  id: string
  label: string
  icon: IconName
  shortcut: string
  render: ComponentType<{ side: 'left' | 'right' | 'bottom' }>
  Badge?: ComponentType
}

export type SessionKind = 'claude' | 'codex' | 'shell'
export type SessionStatus = 'running' | 'input' | 'idle' | 'exited'

export const SESSION_KINDS: Record<SessionKind, { label: string; mark: string; color: string; command: string | null }> = {
  claude: { label: 'Claude', mark: '✳', color: '#d97757', command: 'claude' },
  codex: { label: 'Codex', mark: '◎', color: 'var(--color-foreground)', command: 'codex' },
  shell: { label: 'Shell', mark: '$', color: '#34d399', command: null }
}

/** What the app knows about a terminal or agent session, without the terminal itself */
export type SessionSummary = {
  id: string
  kind: SessionKind
  title: string
  status: SessionStatus
  exitCode: number | null
  worktreePath: string
  workspaceId: string
  startedAt: number
}

/** Agent and terminal sessions, provided by the terminal plugin */
export type SessionsService = {
  subscribe: (listener: () => void) => () => void
  /** Same array until something changes, as React's useSyncExternalStore needs */
  getSessions: () => SessionSummary[]
  /** Resolves with the session id once its process started */
  start: (cwd: string, kind: SessionKind, promptArgument?: string) => Promise<string>
  /** Resolves once the agent is ready for input */
  whenReady: (id: string) => Promise<void>
  /** Bracketed paste, optionally followed by Enter */
  sendText: (id: string, text: string, submit: boolean) => void
  /** Runs a command in a new shell session, so its output is visible */
  runCommand: (cwd: string, command: string) => Promise<string>
  /** Shows the session in the terminal area and focuses it */
  reveal: (id: string) => void
}

/**
 * Services plugins offer each other, looked up by name. Plugins add their own entries with
 * `declare module '@treeix/sdk' { interface Services { name: Type } }`.
 */
export interface Services {
  sessions: SessionsService
}

/** Everything a plugin's renderer module can contribute; all optional */
export type RendererPlugin = {
  tabs?: TabContribution[]
  panels?: PanelContribution[]
  /** Always mounted while enabled: background work, dialogs, global listeners */
  Root?: ComponentType
  /** Title bar items left of the command palette button, lower order first */
  titleBar?: { order: number; render: ComponentType }[]
  /** Rendered under the plugin's switch in Settings while enabled */
  Settings?: ComponentType
  /** Palette commands, built when the palette opens */
  commands?: (host: HostApi) => Command[]
  /** Called before the app's own shortcuts; return true when handled */
  onKeyDown?: (event: KeyboardEvent, host: HostApi) => boolean
  /** ⌘W; return true when the plugin closed something */
  onCloseShortcut?: (host: HostApi) => boolean
  services?: Partial<Services>
  /** Renderers for fenced code blocks in markdown, by language */
  codeBlocks?: Record<string, ComponentType<{ code: string }>>
  linkPreviews?: LinkPreview[]
  /** Icons for command line tools the plugin's main module checks, by tool name */
  toolMarks?: Record<string, ComponentType>
}

/** What the app offers plugins in the renderer */
export type HostApi = {
  repos: Repo[] | null
  workspaceId: string
  /** Repository paths in the current workspace and sidebar scope; null until the first scan */
  scopeRepoPaths: string[] | null
  scopeLabel: string
  selectedWorktree: string | null
  /** Branch of the selected worktree, for headers */
  selectedWorktreeLabel: string | null
  /** Where new sessions start: the selected worktree, else the workspace folder */
  defaultCwd: string
  diffStyle: 'split' | 'unified'
  activeTab: string
  setActiveTab: (id: string) => void
  openTab: (tab: DocumentTab) => void
  closeTab: (key: string) => void
  openWorktree: (path: string) => void
  createWorktree: (repoPath: string, branch: string, base?: string, session?: SessionKind | null) => Promise<void>
  openSettings: () => void
  flash: (message: string) => void
  comments: ReviewComment[]
  addComment: (comment: ReviewComment) => void
  deleteComment: (comment: ReviewComment) => void
  clearComments: (worktreePath: string) => void
  /** Send or copy the comments collected for a checkout; null when it has none */
  renderSendButton: (worktreePath: string, variant: 'pill' | 'panel') => ReactNode
  /** The Comments panel for a checkout */
  renderCommentsPanel: (worktreePath: string, openFile: (path: string) => void) => ReactNode
  /** The editor for a file in a checkout, with its comments and code navigation */
  renderFileView: (worktreePath: string, path: string, line: number | null) => ReactNode
  /** File tree of the selected worktree, with the app's file menus */
  renderExplorer: (activePath: string | null, open: (path: string) => void) => ReactNode
  /** While registered, files opened from search or code navigation on this tab go to `open` instead of the Worktrees editor */
  registerFileOpener: (tabId: string, open: (path: string, line: number | null) => void) => () => void
  /** Wraps a view so docked bottom and side panels (the terminal) show around it */
  withDock: (content: ReactNode) => ReactNode
  showPanel: (id: string) => void
  hidePanel: (id: string) => void
  isPanelVisible: (id: string) => boolean
  isEnabled: (pluginId: string) => boolean
  service: <K extends keyof Services>(name: K) => Services[K] | null
  /** Called after sending comments to a session, shows the message and the terminal */
  onSent: (message: string) => void
}

export const HostContext = createContext<HostApi | null>(null)

export function useHost(): HostApi {
  const host = useContext(HostContext)
  if (!host) throw new Error('useHost outside the plugin host')
  return host
}

/** Typed calls into the plugin's main module, namespaced by plugin id */
export function createBridge(pluginId: string): {
  invoke: <T>(channel: string, ...args: unknown[]) => Promise<T>
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: (...args: unknown[]) => void) => () => void
} {
  return {
    invoke: (channel, ...args) => window.api.plugins.invoke(pluginId, channel, ...args),
    send: (channel, ...args) => window.api.plugins.send(pluginId, channel, ...args),
    on: (channel, listener) => window.api.plugins.on(pluginId, channel, listener)
  }
}

/**
 * Settings owned by a plugin, stored apart from the app's. Before anything is stored, `parse` sees the app's
 * settings object, so values from when the feature was built in carry over.
 */
export function definePluginSettings<T extends object>(
  pluginId: string,
  parse: (stored: Record<string, unknown>) => T
): { get: () => T; update: (patch: Partial<T>) => void; use: () => T } {
  const key = `plugin.${pluginId}.settings`
  const read = (raw: string | null): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(raw ?? 'null')
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  const storage = typeof localStorage === 'undefined' ? null : localStorage
  let current = parse(read(storage?.getItem(key) ?? null) ?? read(storage?.getItem('settings') ?? null) ?? {})
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => current,
    update: (patch) => {
      current = { ...current, ...patch }
      storage?.setItem(key, JSON.stringify(current))
      listeners.forEach((listener) => listener())
    },
    use: () => useSyncExternalStore(subscribe, () => current)
  }
}
