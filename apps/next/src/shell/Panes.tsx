import type { CSSProperties, PointerEvent } from 'react'
import { TerminalPane } from '../panes/terminal'
import { Icon } from '../lib/icons'
import { DOT_LABEL, KIND_ICON, statusDot } from './model'
import { paneRects, splitHandles, type Handle, type Rect, type Tab } from './state'
import type { ShellView } from './Shell'

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
        return (
          <div key={id} className={`pane ${multi ? (focused ? 'focus' : 'dimmed') : ''}`} style={box(rect)}>
            {multi && (
              <div className="phd" onMouseDown={() => dispatch({ type: 'focus', session: id })}>
                <Icon name={KIND_ICON[info?.kind ?? 'shell']} />
                <span className="trunc grow">{info?.title ?? 'zsh'}</span>
                {dot !== 'idle' && <span className={`st-${dot}`}>{DOT_LABEL[dot].toLowerCase()}</span>}
                <button className="icon sm" onClick={() => view.split('row', id)} title="Split right (⌘D)">
                  <Icon name="split" />
                </button>
                <button className="icon sm" onClick={() => view.split('col', id)} title="Split down (⇧⌘D)">
                  <Icon name="splitDown" />
                </button>
                <button className="icon sm" onClick={() => view.closePane(id)} title="Close pane (⌘W)">
                  <Icon name="x" />
                </button>
              </div>
            )}
            <div className="pterm">
              <TerminalPane key={`${id}:${epoch}`} api={api} sessionId={id} visible={active} focused={active && focused} onFocus={() => dispatch({ type: 'focus', session: id })} />
            </div>
          </div>
        )
      })}
      {splitHandles(tab.root).map((handle) => (
        <div key={handle.path} className={`psz ${handle.dir}`} style={handleBox(handle)} onPointerDown={drag(handle)} />
      ))}
    </div>
  )
}
