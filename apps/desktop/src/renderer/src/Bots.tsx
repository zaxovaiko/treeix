import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type ClosedSessionSummary, ISLAND, type SessionSummary, type Services, updateShell, useHost } from '@treeix/sdk'
import { agentOr, chatAgent, useAgents } from './agents'
import { BotAvatar } from './BotAvatar'
import { Icon } from './Icon'
import { JOBS } from './jobs'
import { findService, usePlugins, useService, useSessions } from './plugins'
import { FolderPicker } from './FolderPicker'
import { useSettings } from './settings'
import { withKeys } from '../../shared/keymap'
import { CHANGES, PluginHost, PluginPage, type Side, TERMINAL } from './PluginHost'
import { StatusDot, worktreeLabel } from './sessionUi'
import { timeAgo } from './time'
import logo from './assets/treeix.webp'
import { errorMessage, IconButton, Popup, ResizeHandle, useActionKeys, useChromeless, usePersisted } from './ui'

type Bot = ReturnType<Services['bots']['list']>[number]

function BotRow({ bot, active, onClick }: { bot: Bot; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${active ? 'bg-foreground/8' : 'hover:bg-accent'}`}>
      <BotAvatar look={bot.look} attention={bot.status === 'attention'} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{bot.name}</span>
          {bot.updatedAt !== null && <span className="shrink-0 text-[11px] text-muted-foreground">{timeAgo(new Date(bot.updatedAt).toISOString())}</span>}
        </span>
        <span className={`block truncate text-xs ${bot.status === 'running' ? 'text-foreground/70 italic' : 'text-muted-foreground'}`}>{bot.preview}</span>
      </span>
    </button>
  )
}

function AgentMark({ kind, className = 'size-7 text-[15px]' }: { kind: string; className?: string }): React.JSX.Element {
  'use no memo' // agent mark is read from the agents list during render
  useAgents()
  const { mark, color } = agentOr(kind)
  return (
    <span style={{ color }} className={`grid shrink-0 place-items-center rounded-full bg-foreground/10 ${className}`}>
      {mark}
    </span>
  )
}

function ChatRow({ session, active, onClick }: { session: SessionSummary; active: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <div className={`group relative flex items-center rounded-lg ${active ? 'bg-foreground/8' : 'hover:bg-accent'}`}>
      {/* Room for the close button on hover, so it never sits on the title */}
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left group-hover:pr-9">
        <AgentMark kind={session.kind} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{session.title}</span>
            {(session.status === 'input' || session.status === 'running') && <StatusDot session={session} />}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{worktreeLabel(null, session.worktreePath)}</span>
        </span>
      </button>
      <span className="absolute right-1 hidden group-hover:block">
        <IconButton label="Close chat" onClick={() => findService('sessions')?.close(session.id)}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </span>
    </div>
  )
}

/** A chat closed earlier: opening it resumes its conversation */
function ClosedChatRow({ session, onOpen, onForget }: { session: ClosedSessionSummary; onOpen: () => void; onForget: () => void }): React.JSX.Element {
  return (
    <div className="group relative flex items-center rounded-lg hover:bg-accent">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left group-hover:pr-9">
        <AgentMark kind={session.kind} className="size-5 text-[11px] opacity-70" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground group-hover:text-foreground">{session.title}</span>
        <span className="shrink-0 text-[11px] text-muted-foreground group-hover:hidden">{timeAgo(new Date(session.endedAt).toISOString())}</span>
      </button>
      <span className="absolute right-1 hidden group-hover:block">
        <IconButton label="Remove from history" onClick={onForget}>
          <Icon name="close" className="size-3" />
        </IconButton>
      </span>
    </div>
  )
}

const noTitle = (): null => null
const NO_BOTS: Bot[] = []
const noBots = (): Bot[] => NO_BOTS
const noSubscription = (): (() => void) => () => undefined
const NO_CLOSED: ClosedSessionSummary[] = []
const noClosed = (): ClosedSessionSummary[] => NO_CLOSED

/** A plain chat with Claude, Codex or another agent, in the chat plugin's own view with its agent and model pickers */
function ChatThread({
  session,
  recent,
  side,
  onFolder,
  onTerminal,
  onPage,
  onSearch
}: {
  session: SessionSummary
  recent: string[]
  /** What the right panel shows, so its button reads as on */
  side: Side | null
  onFolder: (folder: string) => void
  /** Shows the terminal in the chat's folder, or hides it */
  onTerminal: () => void
  /** Toggles a plugin's page, like Schema, in the right panel */
  onPage: (id: string) => void
  onSearch: () => void
}): React.JSX.Element {
  const { loaded } = usePlugins()
  const pages = loaded.flatMap(({ plugin }) => plugin.tabs ?? []).filter((tab) => SIDE_PAGES.has(tab.id))
  const chat = useService('chat')
  // The chat's first message; until then the chat can still move to another folder
  const title = useSyncExternalStore(chat?.subscribe ?? noSubscription, chat ? () => chat.title(session.id) : noTitle)
  useEffect(() => void findService('sessions')?.wake(session.id), [session.id, chat])
  const folder = worktreeLabel(null, session.worktreePath)
  useActionKeys({
    'side.changes': () => onPage(CHANGES),
    ...Object.fromEntries(pages.map((tab) => [`side.${tab.id}`, () => onPage(tab.id)])),
    'panel.terminal': onTerminal
  })
  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-4 [-webkit-app-region:drag]">
        <AgentMark kind={session.kind} className="size-6 text-xs" />
        <span className="min-w-0 truncate text-[13px] font-medium">{session.title}</span>
        {title === null ? (
          <FolderPicker
            folder={session.worktreePath}
            recent={recent}
            title="Move this chat to another folder"
            className="flex h-6 min-w-0 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground ring-1 ring-border group-hover:bg-accent group-hover:text-foreground [-webkit-app-region:no-drag]"
            onPick={onFolder}
          />
        ) : (
          <span title={session.worktreePath} className="min-w-0 shrink truncate px-2 text-xs text-muted-foreground">
            {folder}
          </span>
        )}
        <span className="flex-1" />
        <IconButton label={withKeys('Search files', 'app.search')} onClick={onSearch}>
          <Icon name="search" />
        </IconButton>
        <IconButton label={withKeys('Changes', 'side.changes')} active={side === CHANGES} onClick={() => onPage(CHANGES)}>
          <Icon name="diff" />
        </IconButton>
        {pages.map((tab) => (
          <IconButton key={tab.id} label={withKeys(tab.label, `side.${tab.id}`)} active={side === tab.id} onClick={() => onPage(tab.id)}>
            <Icon name={tab.icon} />
          </IconButton>
        ))}
        <PullRequestsButton folder={session.worktreePath} />
        <IconButton label={withKeys('Terminal', 'panel.terminal')} active={side === TERMINAL} onClick={onTerminal}>
          <Icon name="terminal" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">{chat ? <chat.View chatId={session.id} /> : null}</div>
    </>
  )
}

/** Plugin pages that read the chat's folder, offered in the chat's header and shown in the right panel */
const SIDE_PAGES = new Set(['schema', 'dependencies'])

type PullRequestList = Awaited<ReturnType<Services['pullRequests']['refresh']>>

/** The open pull requests of the chat's repository, each opening in the right panel */
function PullRequestsButton({ folder }: { folder: string }): React.JSX.Element | null {
  const host = useHost()
  const pullRequests = useService('pullRequests')
  const [list, setList] = useState<PullRequestList | 'loading' | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const show = (): void => {
    if (!pullRequests) return
    if (list) return setList(null)
    setList(pullRequests.cached([folder]) ?? 'loading')
    pullRequests.refresh([folder]).then(setList, (error: unknown) => setList({ pullRequests: [], errors: [errorMessage(error)] }))
  }
  useActionKeys({ 'chat.pullRequests': show })
  if (!pullRequests) return null
  const open = list && list !== 'loading' ? list.pullRequests.filter((pr) => pr.state === 'open') : []
  return (
    <>
      <span ref={anchor} className="flex">
        <IconButton label={withKeys('Pull requests', 'chat.pullRequests')} active={list !== null} onClick={show}>
          <Icon name="pullRequest" />
        </IconButton>
      </span>
      {list && (
        <Popup anchor={anchor} align="end" onDismiss={() => setList(null)} className="max-h-80 w-80 overflow-y-auto rounded-lg border border-input bg-popover p-1 text-foreground">
          {list === 'loading' ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
          ) : open.length ? (
            open.map((pr) => (
              <button
                key={pr.url}
                onClick={() => {
                  setList(null)
                  pullRequests.open(pr, host)
                }}
                className="flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
                <span className="min-w-0 truncate">{pr.title}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{list.errors[0] ?? 'No open pull requests'}</p>
          )}
        </Popup>
      )}
    </>
  )
}

/** A worktree this window added for a chat that has no message yet, so going back to Local can take it away again */
type AddedWorktree = { repo: string; path: string; branch: string }

const PILL = 'flex h-7 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground ring-1 ring-border hover:bg-accent hover:text-foreground'
/** Like the composer's own pickers, for what sits in its toolbar */
const TOOL = 'flex h-7 max-w-40 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'

/** Local, or a new worktree off the folder's current branch, as T3 Code offers before a chat's first message */
function EnvironmentPicker({ worktree, onPick }: { worktree: string | null; onPick: (worktree: boolean) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const choices = [
    [false, 'Local', 'Work in the folder itself'],
    [true, 'New worktree', 'A branch and folder of its own, off the current branch']
  ] as const
  return (
    <>
      <button ref={anchor} onClick={() => setOpen((shown) => !shown)} className={TOOL}>
        <Icon name="branch" className="size-3 shrink-0" />
        <span className="truncate">{worktree ?? 'Local'}</span>
        <Icon name="chevron" className="size-3 shrink-0 rotate-90 opacity-65" />
      </button>
      {open && (
        <Popup anchor={anchor} onDismiss={() => setOpen(false)} className="w-64 rounded-lg border border-input bg-popover p-1 text-foreground">
          {choices.map(([value, label, description]) => (
            <button
              key={label}
              onClick={() => {
                setOpen(false)
                if (value !== (worktree !== null)) onPick(value)
              }}
              className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
            >
              <Icon name="check" className={`mt-0.5 size-3 shrink-0 ${value === (worktree !== null) ? '' : 'opacity-0'}`} />
              <span className="min-w-0">
                <span className="block">{label}</span>
                <span className="block text-[11px] text-muted-foreground">{description}</span>
              </span>
            </button>
          ))}
        </Popup>
      )}
    </>
  )
}

/** A new chat: its first message in the chat plugin's own composer, with the agent, model and thinking pickers and the context meter */
function Home({
  draft,
  bots,
  folder,
  recent,
  worktree,
  problem,
  onFolder,
  onWorktree,
  onSent,
  onPick
}: {
  draft: SessionSummary | null
  bots: Bot[]
  folder: string
  recent: string[]
  worktree: string | null
  problem: string
  onFolder: (folder: string) => void
  onWorktree: (worktree: boolean) => void
  onSent: () => void
  onPick: (botId: string) => void
}): React.JSX.Element {
  const chat = useService('chat')
  const [isRepo, setIsRepo] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const waiting = bots.filter((bot) => bot.status === 'attention')
  useEffect(() => {
    let live = true
    window.api.listBranches(folder).then(
      () => live && setIsRepo(true),
      () => live && setIsRepo(false)
    )
    return () => {
      live = false
    }
  }, [folder])
  const start = (prompt: string): void => {
    if (!draft || !chat) return
    chat.draft(draft.id, prompt)
    box.current?.querySelector('textarea')?.focus()
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-[12vh]">
      <img src={logo} alt="Treeix" className="size-10 rounded-xl" />
      <h1 className="text-[26px] font-medium tracking-tight">What are we working on?</h1>
      <div ref={box} className="w-full max-w-[720px]">
        {draft && chat ? (
          <chat.Composer
            key={draft.id}
            chatId={draft.id}
            onSent={onSent}
            tools={
              <>
                <FolderPicker folder={folder} recent={recent} title="Where the chat runs" className={TOOL} onPick={onFolder} />
                {isRepo && <EnvironmentPicker worktree={worktree} onPick={onWorktree} />}
              </>
            }
          />
        ) : (
          <div className="h-[90px]" />
        )}
        {problem && <p className="truncate px-4 pt-1.5 text-xs text-red-500">{problem}</p>}
      </div>
      <div className="flex max-w-[720px] flex-wrap justify-center gap-2">
        {JOBS.map((job) => (
          <button key={job.label} disabled={!draft} onClick={() => start(job.prompt)} className={`${PILL} px-3`}>
            <Icon name={job.icon} className="size-3" />
            {job.label}
          </button>
        ))}
      </div>
      {waiting.length > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Needs you:
          {waiting.map((bot) => (
            <button key={bot.id} onClick={() => onPick(bot.id)} className="flex items-center gap-1.5 rounded-full py-0.5 pr-2 pl-0.5 text-foreground hover:bg-accent">
              <BotAvatar look={bot.look} className="size-4" />
              {bot.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** The hub plugin's page for bots and workflows */
const CONFIGURE = 'hub.configure'

/** The terminal plugin names a chat so until its first message; such a chat is the new chat on Home, not one in the list */
const UNTITLED = /^New chat( \d+)?$/
const isDraft = (session: { title: string }): boolean => UNTITLED.test(session.title)

/** Bots listed like chats, each with its own thread, and plain chats below them; plugins run underneath for terminals and the hub */
export function Bots(): React.JSX.Element {
  const chromeless = useChromeless()
  const { islandUi } = useSettings()
  // Panels that float on their own, like the comments panel, read it from the shell
  useEffect(() => updateShell({ islandUi }), [islandUi])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [side, setSide] = useState<Side | null>(null)
  const [search, setSearch] = useState(false)
  const [sidebarWidth, setSidebarWidth] = usePersisted<number>('bots.sidebarWidth', 240)
  const [chatFolder, setChatFolder] = usePersisted<string>('bots.chatFolder', window.api.home)
  const [added, setAdded] = useState<AddedWorktree | null>(null)
  const [problem, setProblem] = useState('')
  const sessions = useService('sessions')
  const chat = useService('chat')
  const canChat = chat !== null && sessions !== null
  const hub = useService('bots')
  const bots = useSyncExternalStore(hub?.subscribe ?? noSubscription, hub?.list ?? noBots)
  const selected = bots.find((bot) => bot.id === selectedId)
  const matches = (text: string): boolean => text.toLowerCase().includes(query.trim().toLowerCase())
  const shown = bots.filter((bot) => matches(bot.name))
  const chats = useSessions()
    .filter((session) => session.view === 'chat')
    .toSorted((a, b) => b.startedAt - a.startedAt)
  const allClosed = useSyncExternalStore(sessions?.subscribe ?? noSubscription, sessions?.getClosed ?? noClosed).filter((session) => session.view === 'chat')
  const closed = allClosed.filter((session) => !isDraft(session) && matches(session.title))
  // Folders chats ran in, newest first, for the folder picker
  const recentFolders = [...new Set([...chats, ...allClosed].toSorted((a, b) => b.startedAt - a.startedAt).map((session) => session.worktreePath))].slice(0, 8)
  const [historyOpen, setHistoryOpen] = usePersisted<boolean>('bots.historyOpen', false)
  const selectedChat = chats.find((session) => session.id === selectedId)
  const drafts = chats.filter(isDraft)
  const draft = drafts[0] ?? null
  const onHome = selectedId === null
  const composer = selectedChat ?? draft
  const send = chat && composer ? (prompt: string): void => chat.draft(composer.id, prompt) : null

  // The panel shows its scope's active session, the chat itself until a shell in the chat's folder takes its place
  const openShell = (folder: string): void => {
    setSide(TERMINAL)
    if (!sessions) return
    const shell = sessions.getSessions().find((session) => session.kind === 'shell' && session.worktreePath === folder)
    if (shell) sessions.reveal(shell.id)
    else void sessions.start(folder, 'shell').then((id) => sessions.reveal(id))
  }

  // Home always has a new chat ready, so its pickers show the agent's own models and options before the first message
  const starting = useRef(false)
  const draftIds = drafts.map((session) => session.id).join(' ')
  useEffect(() => {
    // A chat moving to another folder is briefly two drafts, and starts its own
    if (!onHome || !sessions || !canChat || starting.current) return
    const [newest, ...stale] = draftIds ? draftIds.split(' ') : []
    if (newest) {
      void sessions.wake(newest)
      // Chats left untitled by an earlier launch
      for (const id of stale) sessions.close(id)
      return
    }
    const agent = chatAgent()
    if (!agent) return
    starting.current = true
    sessions.start(chatFolder, agent.id, undefined, 'chat').finally(() => (starting.current = false))
  }, [onHome, sessions, canChat, draftIds, chatFolder])

  /** Before its first message a chat moves by starting over in the new folder, with its draft and picked options */
  const moveChat = async (session: SessionSummary, cwd: string): Promise<string | null> => {
    if (!sessions || !chat) return null
    starting.current = true
    try {
      const id = await sessions.start(cwd, session.kind, undefined, 'chat')
      void chat.carryOver(session.id, id)
      sessions.close(session.id)
      return id
    } finally {
      starting.current = false
    }
  }
  const dropAdded = (): void => {
    if (!added) return
    setAdded(null)
    window.api
      .removeWorktree(added.path, false)
      .then(() => window.api.deleteBranch(added.repo, added.branch))
      .catch(() => undefined)
  }
  const pickFolder = (folder: string): void => {
    setChatFolder(folder)
    setProblem('')
    if (draft) void moveChat(draft, folder).then(dropAdded)
  }
  const pickWorktree = async (worktree: boolean): Promise<void> => {
    if (!draft) return
    setProblem('')
    if (!worktree) return void moveChat(draft, chatFolder).then(dropAdded)
    const branch = `chat-${crypto.randomUUID().slice(0, 6)}`
    try {
      const path = await window.api.addWorktree(chatFolder, branch)
      await moveChat(draft, path)
      dropAdded()
      setAdded({ repo: chatFolder, path, branch })
    } catch (reason) {
      setProblem(errorMessage(reason))
    }
  }
  const sent = (): void => {
    if (!draft) return
    // The chat owns its worktree now
    setAdded(null)
    setSelectedId(draft.id)
  }

  useActionKeys({ 'chat.new': () => setSelectedId(null) })
  // ⌘, is the menu's, which sends it here
  useEffect(() => window.api.onOpenSettings(() => setSelectedId(CONFIGURE)), [])

  // Keep awake's switch sits beside New chat, as it did in the old shell's title bar
  const { loaded } = usePlugins()
  const KeepAwake = loaded.find(({ manifest }) => manifest.id === 'keep-awake')?.plugin.titleBar?.[0]?.render

  const sidebar = (
    <aside style={{ width: sidebarWidth }} className={`relative flex shrink-0 flex-col ${islandUi ? '' : 'border-r border-border'}`}>
      <div className={`flex h-10 shrink-0 items-center justify-end gap-1 px-2 ${chromeless ? '' : 'pl-[80px] [-webkit-app-region:drag]'}`}>
        {KeepAwake && <KeepAwake />}
        <IconButton label={withKeys('Settings', 'app.settings')} active={selectedId === CONFIGURE} onClick={() => setSelectedId(CONFIGURE)}>
          <Icon name="settings" />
        </IconButton>
      </div>
      <label className="mx-2 mb-2 flex h-8 items-center gap-2 rounded-lg bg-foreground/5 px-2.5 text-muted-foreground">
        <Icon name="search" className="size-3" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </label>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2">
        {shown.map((bot) => (
          <BotRow key={bot.id} bot={bot} active={bot.id === selectedId} onClick={() => setSelectedId(bot.id)} />
        ))}
        {canChat && (
          <>
            <div className="mt-2 flex h-7 shrink-0 items-center justify-between pl-2 text-[11px] font-medium text-muted-foreground">
              Chats
              <IconButton label={withKeys('New chat', 'chat.new')} onClick={() => setSelectedId(null)}>
                <Icon name="plus" />
              </IconButton>
            </div>
            {chats
              .filter((session) => (session.id === selectedId || !isDraft(session)) && matches(session.title))
              .map((session) => (
                <ChatRow key={session.id} session={session} active={session.id === selectedId} onClick={() => setSelectedId(session.id)} />
              ))}
          </>
        )}
        {canChat && closed.length > 0 && (
          // At the foot of the list, as the Agents tab keeps its own
          <div className="mt-auto flex flex-col gap-0.5 pt-2">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              aria-expanded={historyOpen}
              className="flex h-7 shrink-0 items-center gap-1 pl-2 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
            >
              History
              <span className="font-normal opacity-70">{closed.length}</span>
              <Icon name="chevron" className={`size-3 ${historyOpen ? 'rotate-90' : ''}`} />
            </button>
            {historyOpen &&
              closed.map((session) => (
                <ClosedChatRow
                  key={session.id}
                  session={session}
                  onOpen={() => void sessions?.reopen(session.id).then((id) => id && setSelectedId(id))}
                  onForget={() => sessions?.forget(session.id)}
                />
              ))}
          </div>
        )}
      </nav>
      <ResizeHandle onResize={setSidebarWidth} />
    </aside>
  )
  return (
    <div className={`flex h-screen ${islandUi ? 'bg-canvas' : 'bg-background'} font-sans text-foreground antialiased select-none`}>
      {sidebar}
      <PluginHost
        page={selectedId ?? 'home'}
        folder={selectedChat?.worktreePath ?? chatFolder}
        side={side}
        onSide={setSide}
        send={send}
        search={search}
        onSearch={setSearch}
        onSettings={() => setSelectedId(CONFIGURE)}
      >
        <main className={`flex min-w-[300px] flex-1 flex-col ${islandUi ? `overflow-hidden ${ISLAND}` : ''}`}>
          {selectedId === CONFIGURE ? (
            <PluginPage id={CONFIGURE} />
          ) : selectedChat ? (
            <ChatThread
              key={selectedChat.id}
              session={selectedChat}
              recent={recentFolders}
              side={side}
              onFolder={(folder) => {
                setChatFolder(folder)
                void moveChat(selectedChat, folder).then((id) => id && setSelectedId(id))
              }}
              onTerminal={() => (side === TERMINAL ? setSide(null) : openShell(selectedChat.worktreePath))}
              onPage={(id) => setSide(side === id ? null : id)}
              onSearch={() => setSearch(true)}
            />
          ) : selected && hub ? (
            <hub.Thread key={selected.id} botId={selected.id} />
          ) : (
            <>
              <div className={`h-10 shrink-0 ${chromeless ? '' : '[-webkit-app-region:drag]'}`} />
              <Home
                draft={draft}
                bots={bots}
                folder={chatFolder}
                recent={recentFolders}
                worktree={draft && draft.worktreePath !== chatFolder ? (added?.path === draft.worktreePath ? added.branch : worktreeLabel(null, draft.worktreePath)) : null}
                problem={problem}
                onFolder={pickFolder}
                onWorktree={(worktree) => void pickWorktree(worktree)}
                onSent={sent}
                onPick={setSelectedId}
              />
            </>
          )}
        </main>
      </PluginHost>
    </div>
  )
}
