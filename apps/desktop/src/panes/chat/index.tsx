import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Api } from '../../ipc/api'
import type { Chats } from '../../ipc/bindings'
import { Icon } from '../../lib/icons'
import { IS_MAC } from '../../shell/shortcuts'
import type { ShellView } from '../../shell/Shell'
import '../../styles/chat.css'
import { type BlockHost, firstAllow, firstReject, formatElapsed, pendingOf, PRIMARY, TurnBlocks, useElapsed } from './Blocks'
import { Composer } from './ChatComposer'
import { formatTokens } from './composer'
import { leafChat } from './open'
import { activityOf, answer, cancel, type ChatState, dismissError, initChats, isBusy, retry, useChat } from './store'

const STICK_PX = 40
const DEFAULT_CHATS: Chats = { defaultView: 'terminal', width: 760, showThinking: true, notify: true }

/** Settings > Chats, live */
function useChatSettings(api: Api): Chats {
  const [chats, setChats] = useState(DEFAULT_CHATS)
  useEffect(() => {
    let live = true
    void api.getSettings().then((settings) => live && setChats(settings.chats), () => undefined)
    const off = api.onSettings((settings) => setChats(settings.chats))
    return () => {
      live = false
      off()
    }
  }, [api])
  return chats
}

function Activity({ chat }: { chat: ChatState }) {
  const seconds = useElapsed(chat.feed.turnStartedAt, true)
  if (chat.feed.waiting)
    return (
      <div className="cwork ask-wait">
        <Icon name="alert" />
        Waiting for your approval
        <span className="dim">
          {PRIMARY}↵ allow · Esc deny
        </span>
      </div>
    )
  return (
    <div className="cwork" role="status">
      <i />
      <span className="trunc">{activityOf(chat)}...</span>
      {chat.feed.turnStartedAt !== null && <span className="dim">{formatElapsed(seconds)}</span>}
    </div>
  )
}

function EmptyState({ chat }: { chat: ChatState }) {
  if (!chat.info) return null
  const { agent, cwd, status } = chat.info
  const name = agent === 'codex' ? 'Codex' : 'Claude'
  if (status === 'starting')
    return (
      <div className="cempty" role="status">
        <Icon name={agent} />
        <b>Starting {name}...</b>
        <span className="dim">The first start downloads the adapter and can take a while</span>
      </div>
    )
  return (
    <div className="cempty">
      <Icon name={agent} />
      <b>Chat with {name}</b>
      <span className="dim mono">{cwd.split('/').slice(-2).join('/')}</span>
    </div>
  )
}

/** The prototype's footer: agent and context used; the composer's menu shows the model */
function Footer({ chat }: { chat: ChatState }) {
  const { feed, info } = chat
  const usage = feed.usage
  const pct = usage && usage.size > 0 ? Math.min(100, Math.round((usage.used / usage.size) * 100)) : null
  return (
    <div className="tfoot">
      {info && <Icon name={info.agent} />}
      {info?.agent === 'codex' ? 'Codex' : 'Claude'}
      {usage && pct !== null && (
        <>
          <span>· context</span>
          <span className="ctxm" style={{ width: 60 }} title={`${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens`}>
            <b style={{ width: `${pct}%` }} className={pct > 80 ? 'full' : ''} />
          </span>
          <span className="num">{pct}%</span>
        </>
      )}
      {usage?.cost && <span>· {usage.cost.amount.toLocaleString(undefined, { style: 'currency', currency: usage.cost.currency })}</span>}
      {info?.status === 'disconnected' && <span className="dis">· disconnected, sending starts it again</span>}
      <span className="grow" />
      <span className="hint">↵ send · ⇧↵ newline</span>
    </div>
  )
}

export function ChatPane({ view, leaf, focused }: { view: ShellView; leaf: string; focused: boolean }) {
  const { api } = view
  initChats(api)
  const id = leafChat(leaf)
  const chat = useChat(id)
  const settings = useChatSettings(api)
  const { feed } = chat
  const cwd = chat.info?.cwd ?? view.home
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const lastTop = useRef(0)

  const host = useMemo<BlockHost>(
    () => ({ cwd, showThinking: settings.showThinking, openFile: view.openFile, openUrl: (url) => void api.openUrl(url) }),
    [cwd, settings.showThinking, view.openFile, api],
  )

  const toBottom = () => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }
  useLayoutEffect(() => {
    if (atBottom.current) toBottom()
  }, [feed, chat.queue, chat.error])
  // Diffs and markdown settle after rendering; follow their growth while at the bottom
  useEffect(() => {
    const el = scroller.current?.firstElementChild
    if (!el) return
    const observer = new ResizeObserver(() => atBottom.current && toBottom())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Stable, so typing (which changes the chat) doesn't rerender the transcript
  const reply = useCallback(
    (requestId: string, optionId: string) => {
      answer(id, requestId, optionId)
      root.current?.querySelector('textarea')?.focus()
    },
    [id],
  )

  const newest = feed.blocks.map(pendingOf).findLast((permission) => permission !== null) ?? null

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!newest) return
    // Esc with the completion list open closes the list
    if (e.key === 'Escape' && e.target instanceof HTMLElement && e.target.getAttribute('aria-expanded') === 'true') return
    const primary = IS_MAC ? e.metaKey : e.ctrlKey
    const option = e.key === 'Enter' && primary ? firstAllow(newest.options) : e.key === 'Escape' ? firstReject(newest.options) : undefined
    if (!option) return
    e.preventDefault()
    e.stopPropagation()
    reply(newest.requestId, option.id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !isBusy(chat)) return
    e.preventDefault()
    cancel(id)
  }

  const fixed = settings.width > 0
  return (
    <div ref={root} className="chatp" tabIndex={-1} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown}>
      <div
        ref={scroller}
        className="pbody chat"
        onScroll={(e) => {
          const el = e.currentTarget
          // Only scrolling up lets go of the end, so content growing before a scroll event keeps it
          if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX) atBottom.current = true
          else if (el.scrollTop < lastTop.current) atBottom.current = false
          lastTop.current = el.scrollTop
        }}
      >
        <div className="cin" style={fixed ? { maxWidth: settings.width } : undefined}>
          {feed.blocks.length === 0 ? <EmptyState chat={chat} /> : <TurnBlocks host={host} blocks={feed.blocks} newest={newest} onAnswer={reply} live={feed.running} />}
          {isBusy(chat) && <Activity chat={chat} />}
          {feed.running && feed.plan.length > 0 && (
            <ul className="cplan">
              {feed.plan.map((entry, index) => (
                <li key={index} className={entry.status}>
                  <i />
                  <span className="trunc">{entry.content}</span>
                </li>
              ))}
            </ul>
          )}
          {chat.error && (
            <div className="cerr">
              <Icon name="alert" />
              <span className="grow">{chat.error}</span>
              <button className="btn sm" onClick={() => retry(id)}>
                Retry
              </button>
              <button className="icon sm" aria-label="Dismiss" onClick={() => dismissError(id)}>
                <Icon name="x" />
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="cdock" style={fixed ? { maxWidth: settings.width + 24 } : undefined}>
        <Composer
          id={id}
          chat={chat}
          cwd={cwd}
          home={view.home}
          focused={focused}
          onSent={() => {
            atBottom.current = true
            requestAnimationFrame(toBottom)
          }}
        />
      </div>
      <Footer chat={chat} />
    </div>
  )
}
