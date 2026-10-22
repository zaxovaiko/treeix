import { lazy, Suspense, type CSSProperties, type PointerEvent } from 'react'
import { TerminalPane } from '../panes/terminal'
import { closeFileLeaf, isFileLeaf, leafRoot, resolvePath } from '../panes/file/open'
import { closeChat, isChatLeaf, leafChat } from '../panes/chat/open'
import { titleOf, useChatState } from '../panes/chat/store'
import { Icon } from '../lib/icons'
import { BrowserHead, closeBrowser, isBrowserLeaf } from '../features/browser/open'
import { closePlan, isPlanLeaf, PlanHead } from '../features/plans/open'
import { DOT_LABEL, KIND_ICON, statusDot } from './model'
import { withHint } from './shortcuts'
import { paneRects, splitHandles, type Handle, type Rect, type Tab } from './state'
import type { ShellView } from './Shell'

// Monaco and the diff renderer load with the first file view, not at startup
const FilePane = lazy(() => import('../panes/file').then((m) => ({ default: m.FilePane })))
const ChatPane = lazy(() => import('../panes/chat').then((m) => ({ default: m.ChatPane })))
const BrowserPane = lazy(() => import('../features/browser').then((m) => ({ default: m.BrowserPane })))
const PlanPane = lazy(() => import('../features/plans').then((m) => ({ default: m.PlanPane })))

/** A chat leaf's header: its agent and title */
function ChatHead({ leaf }: { leaf: string }) {
  const chat = useChatState(leafChat(leaf))
  return (
    <>
      <Icon name={chat.info?.agent ?? 'claude'} />
      <span className="trunc grow">{titleOf(chat)}</span>
    </>
  )
}

/** A path printed in a terminal: the file view when it's inside the session's checkout, else its default app */
function openPrinted(view: ShellView, session: string, { path, line }: { path: string; line: number | null }) {
  const home = path.startsWith('~/')
  const absolute = resolvePath(home ? view.home : (view.sessions[session]?.cwd ?? view.home), home ? path.slice(2) : path)
  const root = view.placeOf(session).key
  if (absolute.startsWith(`${root}/`)) view.openFile(root, absolute.slice(root.length + 1), line ?? undefined)
  else void view.api.openPath(absolute)
}

const pct = (n: number) => `${n * 100}%`
const box = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) })

function handleBox({ dir, ratio, rect }: Handle): CSSProperties {
  return dir === 'row'
    ? { left: pct(rect.x + rect.w * ratio), top: pct(rect.y), height: pct(rect.h) }
    : { top: pct(rect.y + rect.h * ratio), left: pct(rect.x), width: pct(rect.w) }
}

/**
 * One tab's panes, laid out flat by absolute rectangles so splitting or closing never remounts a terminal.
 * Every tab stays mounted; hidden ones detach their terminals
 */
export function TabPanes({ view, tab, active, epoch }: { view: ShellView; tab: Tab; active: boolean; epoch: number }) {
  const { api, sessions, dispatch } = view
  const rects = paneRects(tab.root)
  const multi = rects.size > 1

  const drag = (handle: Handle) => (e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const area = el.parentElement?.getBoundingClientRect()
    if (!area) return
    el.setPointerCapture(e.pointerId)
    el.classList.add('drag')
    const move = (ev: globalThis.PointerEvent) => {
      const at = handle.dir === 'row' ? ((ev.clientX - area.left) / area.width - handle.rect.x) / handle.rect.w : ((ev.clientY - area.top) / area.height - handle.rect.y) / handle.rect.h
      dispatch({ type: 'ratio', tabId: tab.id, path: handle.path, ratio: at })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', () => (el.classList.remove('drag'), el.removeEventListener('pointermove', move)), { once: true })
  }

  return (
    <div className="panes" hidden={!active}>
      {[...rects].sort(([a], [b]) => a.localeCompare(b)).map(([id, rect]) => {
        const info = sessions[id]
        const focused = id === tab.focus
        const dot = info ? statusDot(info.status) : 'idle'
        const file = isFileLeaf(id)
        const chat = isChatLeaf(id)
        const browser = isBrowserLeaf(id)
        const plan = isPlanLeaf(id)
        const close = () => (file ? closeFileLeaf(view, id) : chat ? closeChat(view, id) : browser ? closeBrowser(view, id) : plan ? closePlan(view, id) : view.closePane(id))
        return (
          <div key={id} className={`pane ${multi ? (focused ? 'focus' : 'dimmed') : ''}`} style={box(rect)}>
            {multi && (
              <div className="phd" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                {chat ? (
                  <ChatHead leaf={id} />
                ) : browser ? (
                  <BrowserHead leaf={id} />
                ) : plan ? (
                  <PlanHead leaf={id} />
                ) : (
                  <>
                    <Icon name={file ? 'folder' : KIND_ICON[info?.kind ?? 'shell']} />
                    <span className="trunc grow">{file ? leafRoot(id).split('/').pop() : (info?.title ?? 'zsh')}</span>
                  </>
                )}
                {dot !== 'idle' && <span className={`st-${dot} trunc`}>{DOT_LABEL[dot].toLowerCase()}</span>}
                <button className="icon sm" onClick={() => view.split('row', id)} title={withHint('Split right', 'split-right')}>
                  <Icon name="split" />
                </button>
                <button className="icon sm" onClick={() => view.split('col', id)} title={withHint('Split down', 'split-down')}>
                  <Icon name="splitDown" />
                </button>
                <button className="icon sm" onClick={close} title={withHint('Close pane', 'close-pane')}>
                  <Icon name="x" />
                </button>
              </div>
            )}
            {file ? (
              <div className="pterm" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <Suspense fallback={<div className="empty">Loading...</div>}>
                  <FilePane view={view} id={id} />
                </Suspense>
              </div>
            ) : chat ? (
              <div className="pterm" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <Suspense fallback={<div className="empty">Loading...</div>}>
                  <ChatPane key={`${id}:${epoch}`} view={view} leaf={id} focused={active && focused} />
                </Suspense>
              </div>
            ) : browser || plan ? (
              <div className="pterm" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <Suspense fallback={<div className="empty">Loading...</div>}>
                  {browser ? <BrowserPane view={view} leaf={id} focused={active && focused} /> : <PlanPane view={view} leaf={id} />}
                </Suspense>
              </div>
            ) : (
              <div className="pterm">
                <TerminalPane key={`${id}:${epoch}`} api={api} sessionId={id} visible={active} focused={active && focused} onFocus={() => dispatch({ type: 'focus', session: id })} onOpenFile={([target]) => target && openPrinted(view, id, target)} renderer={view.ui.renderer} />
              </div>
            )}
          </div>
        )
      })}
      {splitHandles(tab.root).map((handle) => (
        <div key={handle.path} className={`psz ${handle.dir}`} style={handleBox(handle)} onPointerDown={drag(handle)} />
      ))}
    </div>
  )
}
