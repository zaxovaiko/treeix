import { createContext } from 'react'
import type { Place, SessionInfo, SessionKind, SessionStatus } from '../ipc/api'
import { Icon, type IconName } from '../lib/icons'
import { groupKey, leaves, type Tab } from './state'
import { isChatLeaf, leafChat } from '../panes/chat/open'
import { getChat, titleOf } from '../panes/chat/store'

/** Dot classes from the prototype: run, need, done, err, exit; idle shows none. watch: an agent waiting on a background task */
export type Dot = 'run' | 'watch' | 'need' | 'done' | 'err' | 'exit' | 'idle'

const DOT: Record<SessionStatus, Dot> = { running: 'run', needs: 'need', done: 'done', idle: 'idle', exited: 'exit', error: 'err', restored: 'idle', crashed: 'err', watching: 'watch' }
export const statusDot = (status: SessionStatus): Dot => DOT[status]
export const DOT_LABEL: Record<Dot, string> = { run: 'Running', watch: 'Watching', need: 'Needs you', err: 'Crashed', done: 'Done', exit: 'Exited', idle: 'Idle' }

/** Settings opens as a tab: this leaf in the pane tree */
export const SETTINGS_LEAF = 'settings:'

/** What a tab shows: its lead session's kind, or Settings */
export type TabKind = SessionKind | 'settings'

export const KIND_ICON: Record<TabKind, IconName> = { shell: 'terminal', claude: 'claude', codex: 'codex', routine: 'terminal', settings: 'gear' }

export type Sessions = Record<string, SessionInfo>

const isAgent = (s: SessionInfo | undefined) => s?.kind === 'claude' || s?.kind === 'codex'
const tabSessions = (tab: Tab, sessions: Sessions) => leaves(tab.root).flatMap((id) => sessions[id] ?? [])

/** The worst state among the tab's panes */
export function tabDot(tab: Tab, sessions: Sessions): Dot {
  const dots = tabSessions(tab, sessions).map((s) => DOT[s.status])
  return (['need', 'err', 'run', 'watch', 'done', 'exit'] as const).find((d) => dots.includes(d)) ?? 'idle'
}

/** An agent pane names the tab, else its first pane */
function lead(tab: Tab, sessions: Sessions): SessionInfo | undefined {
  const all = tabSessions(tab, sessions)
  return all.find(isAgent) ?? all[0]
}

const LIVE = new Set<SessionStatus>(['running', 'needs', 'done', 'idle', 'error'])

/** Panes with a live process across these tabs; the quick terminal's session has no tab here, so it isn't counted */
export const liveCount = (tabs: Tab[], sessions: Sessions) => tabs.flatMap((tab) => leaves(tab.root)).filter((id) => sessions[id] && LIVE.has(sessions[id].status)).length

/** A tab of chats only is named by its focused chat */
const chatOf = (tab: Tab) => (isChatLeaf(tab.focus) ? getChat(leafChat(tab.focus)) : null)

const isSettings = (tab: Tab) => tab.focus === SETTINGS_LEAF

export const tabKind = (tab: Tab, sessions: Sessions): TabKind => (isSettings(tab) ? 'settings' : (lead(tab, sessions)?.kind ?? chatOf(tab)?.info?.agent ?? 'shell'))
export const tabTitle = (tab: Tab, sessions: Sessions) => {
  const chat = chatOf(tab)
  return isSettings(tab) ? 'Settings' : (tab.title ?? lead(tab, sessions)?.title ?? (chat ? titleOf(chat) : 'zsh'))
}

export function Ki({ kind, dot = 'idle', sm }: { kind: TabKind; dot?: Dot; sm?: boolean }) {
  return (
    <span className={`ki ${kind} ${dot === 'idle' ? '' : dot} ${sm ? 'sm' : ''}`}>
      <Icon name={KIND_ICON[kind]} />
    </span>
  )
}

/** Colors a group can take; slate is the base checkout's */
export const GROUP_COLORS = [
  ['Slate', '#64748b'],
  ['Violet', '#8b5cf6'],
  ['Sky', '#0ea5e9'],
  ['Emerald', '#10b981'],
  ['Rose', '#f43f5e'],
  ['Teal', '#14b8a6'],
  ['Amber', '#f59e0b'],
  ['Pink', '#ec4899'],
] as const
const COLORS = GROUP_COLORS.slice(1).map(([, color]) => color)

/** Hand-picked group colors (`UiState.colors`) for components without the view */
export const GroupColors = createContext<Record<string, string>>({})

/** Where a folder group's picked color lives in `UiState.colors`, apart from its main checkout's, which shares the key */
export const groupColorKey = (key: string) => `group:${key}`

/** The place's picked color, else its group's, else stable per place: checkouts on the base folder are slate, worktrees get a color from their path */
export function placeColor(place: Place, colors: Record<string, string> = {}): string {
  const picked = colors[place.key] ?? colors[groupColorKey(groupKey(place))]
  if (picked) return picked
  if (place.kind === 'root' || place.kind === 'git') return '#64748b'
  if (place.kind === 'folder' || place.kind === 'scratch') return '#94a3b8'
  let hash = 0
  for (const ch of place.key) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return COLORS[Math.abs(hash) % COLORS.length]
}

export const placeIcon = (place: Place): IconName => (place.kind === 'scratch' ? 'home' : place.kind === 'folder' ? 'folder' : 'branch')

/** Display name inside a repo group: branch, or the short sha when detached */
export const placeName = (place: Place) => (place.kind === 'detached' ? (place.head ?? place.name) : place.name)

/** Until the daemon resolves a cwd, the session sits in a plain folder group */
export function fallbackPlace(cwd: string, home: string): Place {
  const scratch = cwd === home
  return { key: cwd, kind: scratch ? 'scratch' : 'folder', name: scratch ? '~' : (cwd.split('/').filter(Boolean).pop() ?? '/'), path: cwd, repoRoot: null, repoName: null, branch: null, head: null, missing: false }
}

export const tilde = (path: string, home: string) => (path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
