import { lazy, Suspense, type CSSProperties, type PointerEvent } from 'react'
import { TerminalPane } from '../panes/terminal'
import { filesEndingWith } from '../panes/terminal/fileLinks'
import { closeFileLeaf, isFileLeaf, leafRoot, resolvePath } from '../panes/file/open'
import { closeChat, isChatLeaf, leafChat } from '../panes/chat/open'
import { titleOf, useChatState } from '../panes/chat/store'
import { Icon } from '../lib/icons'
import { useContextMenu, type MenuItem } from '../panels/common'
import { BrowserHead, closeBrowser, isBrowserLeaf } from '../features/browser/open'
import { closePlan, isPlanLeaf, PlanHead } from '../features/plans/open'
import { DOT_LABEL, KIND_ICON, SETTINGS_LEAF, statusDot } from './model'
import { SettingsPage } from '../pages/settings'
import { withHint } from './shortcuts'
import { settingsNow } from '../features/agents/settings'
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

/**
 * A file in the file view, under its own checkout (`root` when inside it); a folder, or any file with `external`, in Finder
 * or its default app. False when nothing is there
 */
export async function openAbsolute(view: Pick<ShellView, 'api' | 'openFile'>, absolute: string, { line, root, external = false }: { line?: number; root?: string; external?: boolean } = {}): Promise<boolean> {
  const { api } = view
  const cut = absolute.lastIndexOf('/')
  const dir = absolute.slice(0, cut) || '/'
  const names = await api.listDirectory(dir, '').catch((): string[] => [])
  const name = absolute.slice(cut + 1)
  if (names.includes(`${name}/`) || (external && names.includes(name))) return api.openPath(absolute).then(() => true)
  if (!names.includes(name)) return false
  const [place] = root && absolute.startsWith(`${root}/`) ? [{ key: root }] : await api.places([dir]).catch(() => [])
  const base = place && absolute.startsWith(`${place.key}/`) ? place.key : dir
  view.openFile(base, absolute.slice(base.length + 1), line)
  return true
}

/**
 * A path printed in a terminal, in the file view or, per Settings, its default app: the first target that exists. One that
 * resolves to nothing (cut short, relative to another folder) is looked up in the session's checkout
 */
async function openPrinted(view: ShellView, session: string, targets: { path: string; line: number | null }[]) {
  const { api, home } = view
  const root = view.placeOf(session).key
  const cwd = view.sessions[session]?.cwd ?? home
  const external = settingsNow()?.terminal.openFilesInApp === false
  for (const { path, line } of targets) {
    const absolute = path.startsWith('~/') ? resolvePath(home, path.slice(2)) : resolvePath(cwd, path)
    if (await openAbsolute(view, absolute, { line: line ?? undefined, root, external })) return
  }
  const files = (await api.listFiles(root).catch(() => null))?.files ?? []
  for (const { path, line } of targets) {
    const [file] = filesEndingWith(files, path)
    if (file) return external ? api.openPath(`${root}/${file}`) : view.openFile(root, file, line ?? undefined)
  }
}

const pct = (n: number) => `${n * 100}%`
export const box = (r: Rect): CSSProperties => ({ left: pct(r.x), top: pct(r.y), width: pct(r.w), height: pct(r.h) })

export function handleBox({ dir, ratio, rect }: Handle): CSSProperties {
  return dir === 'row'
    ? { left: pct(rect.x + rect.w * ratio), top: pct(rect.y), height: pct(rect.h) }
    : { top: pct(rect.y + rect.h * ratio), left: pct(rect.x), width: pct(rect.w) }
}

/** Drags a split handle; `onRatio` gets the handle's new ratio */
export const dragHandle = (handle: Handle, onRatio: (ratio: number) => void) => (e: PointerEvent<HTMLDivElement>) => {
  const el = e.currentTarget
  const area = el.parentElement?.getBoundingClientRect()
  if (!area) return
  el.setPointerCapture(e.pointerId)
  el.classList.add('drag')
  const move = (ev: globalThis.PointerEvent) =>
    onRatio(handle.dir === 'row' ? ((ev.clientX - area.left) / area.width - handle.rect.x) / handle.rect.w : ((ev.clientY - area.top) / area.height - handle.rect.y) / handle.rect.h)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', () => (el.classList.remove('drag'), el.removeEventListener('pointermove', move)), { once: true })
}

/**
 * One tab's panes, laid out flat by absolute rectangles so splitting or closing never remounts a terminal.
 * Every tab stays mounted; hidden ones detach their terminals
 */
export function TabPanes({ view, tab, active, epoch }: { view: ShellView; tab: Tab; active: boolean; epoch: number }) {
  const { api, sessions, dispatch } = view
  const rects = paneRects(tab.root)
  const multi = rects.size > 1
  const [menu, openMenu] = useContextMenu()

  return (
    <div className="panes" hidden={!active}>
      {menu}
      {[...rects].sort(([a], [b]) => a.localeCompare(b)).map(([id, rect]) => {
        const info = sessions[id]
        const focused = id === tab.focus
        const dot = info ? statusDot(info.status) : 'idle'
        const file = isFileLeaf(id)
        const chat = isChatLeaf(id)
        const browser = isBrowserLeaf(id)
        const plan = isPlanLeaf(id)
        const settings = id === SETTINGS_LEAF
        const close = () => (file ? closeFileLeaf(view, id) : chat ? closeChat(view, id) : browser ? closeBrowser(view, id) : plan ? closePlan(view, id) : settings ? dispatch({ type: 'remove', session: id }) : view.closePane(id))
        const paneMenu: MenuItem[] = [
          { label: 'Split right', icon: 'split', run: () => view.split('row', id) },
          { label: 'Split down', icon: 'splitDown', run: () => view.split('col', id) },
          { label: 'Close pane', icon: 'x', danger: true, run: close },
        ]
        return (
          <div key={id} className={`pane ${multi ? (focused ? 'focus' : 'dimmed') : ''}`} style={box(rect)}>
            {multi && (
              <div className="phd" onMouseDown={() => dispatch({ type: 'focus', session: id })} onContextMenu={openMenu(paneMenu)}>
                {chat ? (
                  <ChatHead leaf={id} />
                ) : browser ? (
                  <BrowserHead leaf={id} />
                ) : plan ? (
                  <PlanHead leaf={id} />
                ) : settings ? (
                  <>
                    <Icon name="gear" />
                    <span className="trunc grow">Settings</span>
                  </>
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
            ) : settings ? (
              <div className="pterm" style={{ background: 'var(--background)' }} onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <SettingsPage view={view} />
              </div>
            ) : browser || plan ? (
              <div className="pterm" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <Suspense fallback={<div className="empty">Loading...</div>}>
                  {browser ? <BrowserPane view={view} leaf={id} focused={active && focused} /> : <PlanPane view={view} leaf={id} />}
                </Suspense>
              </div>
            ) : (
              <div className="pterm">
                <TerminalPane key={`${id}:${epoch}`} api={api} sessionId={id} visible={active} focused={active && focused} onFocus={() => dispatch({ type: 'focus', session: id })} onOpenFile={(targets) => void openPrinted(view, id, targets)} renderer={view.ui.renderer} menu={paneMenu} />
              </div>
            )}
          </div>
        )
      })}
      {splitHandles(tab.root).map((handle) => (
        <div key={handle.path} className={`psz ${handle.dir}`} style={handleBox(handle)} onPointerDown={dragHandle(handle, (ratio) => dispatch({ type: 'ratio', tabId: tab.id, path: handle.path, ratio }))} />
      ))}
    </div>
  )
}
