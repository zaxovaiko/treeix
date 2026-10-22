import type { Place, SessionInfo, SessionKind, SessionStatus } from '../ipc/api'
import { Icon, type IconName } from '../lib/icons'
import { leaves, type Tab } from './state'
import { isChatLeaf, leafChat } from '../panes/chat/open'
import { getChat, titleOf } from '../panes/chat/store'

/** Dot classes from the prototype: run, need, done, err, exit; idle shows none. watch: an agent waiting on a background task */
export type Dot = 'run' | 'watch' | 'need' | 'done' | 'err' | 'exit' | 'idle'

const DOT: Record<SessionStatus, Dot> = { running: 'run', needs: 'need', done: 'done', idle: 'idle', exited: 'exit', error: 'err', restored: 'idle', crashed: 'err', watching: 'watch' }
export const statusDot = (status: SessionStatus): Dot => DOT[status]
export const DOT_LABEL: Record<Dot, string> = { run: 'Running', watch: 'Watching', need: 'Needs you', err: 'Crashed', done: 'Done', exit: 'Exited', idle: 'Idle' }

export const KIND_ICON: Record<SessionKind, IconName> = { shell: 'terminal', claude: 'claude', codex: 'codex', routine: 'terminal' }

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

export const tabKind = (tab: Tab, sessions: Sessions): SessionKind => lead(tab, sessions)?.kind ?? chatOf(tab)?.info?.agent ?? 'shell'
export const tabTitle = (tab: Tab, sessions: Sessions) => {
  const chat = chatOf(tab)
  return tab.title ?? lead(tab, sessions)?.title ?? (chat ? titleOf(chat) : 'zsh')
}

export function Ki({ kind, dot = 'idle', sm }: { kind: SessionKind; dot?: Dot; sm?: boolean }) {
  return (
    <span className={`ki ${kind} ${dot === 'idle' ? '' : dot} ${sm ? 'sm' : ''}`}>
      <Icon name={KIND_ICON[kind]} />
    </span>
  )
}

const COLORS = ['#8b5cf6', '#0ea5e9', '#10b981', '#f43f5e', '#14b8a6', '#f59e0b', '#ec4899']

/** Stable per place: checkouts on the base folder are slate, worktrees get a color from their path */
export function placeColor(place: Place): string {
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
