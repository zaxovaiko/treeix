import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { Icon } from '@treeix/app/Icon'
import { createBridge, useHost } from '@treeix/sdk'
import { usePersisted } from '@treeix/app/ui'
import { toUrl } from './address'
import { getDesign, pageOf, setDesign, useDesign, useSlot } from './pages'
import { importLabel } from './SettingsPage'
import { browserSettings } from './settings'
import { Strip } from './Strip'
import { type Suggestion, SuggestionRow, Suggestions, sectionLabel, useRunning, useSuggestions } from './Suggestions'
import { activeTab, closeTab, getBrowser, openTab, patchTab, reopenTab, selectTab, tabLabel, updateBrowser, useBrowser } from './tabs'
import type { BrowserAction } from '../shared/keys'
import type { ImportInfo } from '../shared/types'
import { httpProblem, loadError } from './loadErrors'

const bridge = createBridge('browser')

let focusAddress = (): void => undefined
let toggleDevtools = (): void => undefined

export function navigate(input: string): void {
  const url = toUrl(input, browserSettings.get().searchEngine)
  const tab = activeTab()
  if (!tab) return updateBrowser((state) => openTab(state, url))
  const page = pageOf(tab.id)
  // A blank tab shows the loader from the start rather than its empty page until the server answers
  if (tab.url === 'about:blank') updateBrowser((state) => patchTab(state, tab.id, { url, committed: false, error: null }))
  if (page) void page.loadURL(url).catch(() => undefined)
}

export function runBrowserAction(action: BrowserAction): void {
  const tab = activeTab()
  const page = tab && pageOf(tab.id)
  if (action === 'newTab') {
    updateBrowser((state) => openTab(state, 'about:blank'))
    setTimeout(() => focusAddress(), 50)
  } else if (action === 'reopenTab') updateBrowser(reopenTab)
  else if (action === 'closeTab' && tab) updateBrowser((state) => closeTab(state, tab.id))
  else if (action === 'focusAddress') focusAddress()
  else if (action === 'back') page?.goBack()
  else if (action === 'forward') page?.goForward()
  else if (action === 'reload') page?.reload()
  else if (action === 'designMode') setDesign(!getDesign().on)
  else if (action === 'devtools') toggleDevtools()
}

const EMPTY_PAGE_ROWS = 6

function EmptyPageSection({ title, items }: { title: string; items: Suggestion[] }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div>
      <div className={sectionLabel}>{title}</div>
      {items.slice(0, EMPTY_PAGE_ROWS).map((item) => (
        <SuggestionRow key={item.url} item={item} active={false} onOpen={navigate} />
      ))}
    </div>
  )
}

/** A blank tab: what the browser is for and how to start */
function EmptyPage({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const running = useRunning()
  const { saved } = browserSettings.use()
  return (
    <div className="flex h-full flex-col items-center justify-center-safe gap-4 overflow-y-auto px-6 text-center">
      <div className="flex h-16 w-22 flex-col rounded-xl text-muted-foreground ring-[1.5px] ring-foreground/15">
        <div className="flex gap-1 px-2 pt-2">
          <span className="size-1.5 rounded-full bg-foreground/25" />
          <span className="size-1.5 rounded-full bg-foreground/25" />
          <span className="size-1.5 rounded-full bg-foreground/25" />
        </div>
        <div className="flex flex-1 items-center justify-center pb-1">
          <Icon name="globe" className="size-6" />
        </div>
      </div>
      <div>
        <div className="text-sm font-medium text-foreground">Open a page</div>
        <div className="mt-1 max-w-64 text-xs text-muted-foreground">A dev server, a pull request preview or any site. Links you ⌘-click in a terminal open here too.</div>
      </div>
      {(running.length > 0 || saved.length > 0) && (
        <div className="w-full max-w-80 text-left">
          <EmptyPageSection title="Running now" items={running} />
          <EmptyPageSection title="Saved" items={saved.map(({ name, url }) => ({ url, label: name, detail: url.replace(/^https?:\/\//, '') }))} />
        </div>
      )}
      <button onClick={onOpen} className="flex h-7 items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        Type an address
        <kbd className="rounded bg-muted px-1 font-sans text-[10.5px]">⌘L</kbd>
      </button>
    </div>
  )
}

const toolButton = 'flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40'

function ProfileBadge(): React.JSX.Element | null {
  const host = useHost()
  const [info, setInfo] = useState<ImportInfo>(null)
  useEffect(() => void bridge.invoke<ImportInfo>('importInfo').then(setInfo), [])
  if (!info) return null
  return (
    <button
      title={`Cookies from ${importLabel(info)}. Import again in Settings`}
      onClick={() => host.openSettings('plugin:browser')}
      className="h-5 shrink-0 rounded bg-emerald-400/12 px-1.5 text-[10.5px] text-emerald-400"
    >
      {info.browser}
    </button>
  )
}

function DevtoolsDock({ guestId }: { guestId: number }): React.JSX.Element {
  const ref = useRef<WebviewTag | null>(null)
  useEffect(() => {
    const dock = ref.current
    if (!dock) return
    const ready = (): void => {
      dock.removeEventListener('dom-ready', ready)
      void bridge.invoke('devtools', guestId, dock.getWebContentsId())
    }
    dock.addEventListener('dom-ready', ready)
    return () => {
      dock.removeEventListener('dom-ready', ready)
      void bridge.invoke('closeDevtools', guestId)
    }
  }, [guestId])
  return <webview ref={ref} src="about:blank" style={{ height: 280, borderTop: '1px solid var(--border)' }} />
}

export function BrowserView({ place }: { place: 'tab' | 'panel' }): React.JSX.Element {
  const host = useHost()
  const { tabs, activeId } = useBrowser()
  const tab = tabs.find((candidate) => candidate.id === activeId)
  const designOn = useDesign().on
  const { ref, shown, elsewhere } = useSlot()
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [devtools, setDevtools] = usePersisted<'docked' | 'window'>('browser.devtools', 'docked')
  const [dockOpen, setDockOpen] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const sections = useSuggestions(draft ?? '')
  const rows = sections.flatMap((section) => section.items)
  const rowUrls = rows.map((row) => row.url).join('\n')
  // A poll can reorder rows; Enter must not open a row other than the one highlighted
  useEffect(() => setHighlighted(-1), [rowUrls])
  const running = useRunning()
  const openAddress = (text: string): void => {
    navigate(text)
    setDraft(null)
    input.current?.blur()
  }
  useEffect(() => {
    if (!getBrowser().tabs.length) updateBrowser((state) => openTab(state, 'about:blank'))
  }, [])
  useEffect(() => {
    if (!shown) return
    focusAddress = () => {
      input.current?.focus()
      input.current?.select()
    }
    toggleDevtools = () => {
      const current = activeTab()
      if (!current?.guestId) return
      if (devtools === 'window') void bridge.invoke('devtools', current.guestId, null)
      else {
        if (dockOpen) void bridge.invoke('closeDevtools', current.guestId)
        setDockOpen((open) => !open)
      }
    }
  }, [shown, devtools, dockOpen])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [stripSlot, setStripSlot] = useState<HTMLDivElement | null>(null)
  // An empty name goes back to the page's own title
  const renameTab = (id: string, name: string): void => {
    setRenaming(null)
    updateBrowser((state) => patchTab(state, id, { name: name.trim() || undefined }))
  }
  const address = draft ?? (tab?.url === 'about:blank' ? '' : (tab?.url ?? ''))
  const problem = httpProblem(tab?.status ?? null)
  const failure = tab?.error ? loadError(tab.error.code, tab.error.url) : null
  return (
    <div data-browser className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1">
        {tabs.map((candidate) => (
          <div
            key={candidate.id}
            onMouseDown={() => updateBrowser((state) => selectTab(state, candidate.id))}
            className={`group flex h-6 max-w-44 min-w-24 items-center gap-1.5 rounded px-2 text-xs ${candidate.id === activeId ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'}`}
          >
            {candidate.loading && !candidate.favicon ? (
              <Icon name="loader" className="size-3.5 animate-spin text-muted-foreground" />
            ) : candidate.favicon ? (
              // A declared icon can 404; the globe stands in rather than a broken image
              <img src={candidate.favicon} alt="" className="size-3.5" onError={() => updateBrowser((state) => patchTab(state, candidate.id, { favicon: null }))} />
            ) : (
              <Icon name="globe" className="size-3.5" />
            )}
            {renaming === candidate.id ? (
              <input
                autoFocus
                defaultValue={tabLabel(candidate)}
                aria-label="Tab name"
                onFocus={(event) => event.currentTarget.select()}
                onBlur={(event) => (event.currentTarget.dataset.cancelled ? setRenaming(null) : renameTab(candidate.id, event.currentTarget.value))}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== 'Escape') return
                  if (event.key === 'Escape') event.currentTarget.dataset.cancelled = 'true'
                  event.currentTarget.blur()
                }}
                onMouseDown={(event) => event.stopPropagation()}
                className="h-5 min-w-0 flex-1 rounded bg-foreground/10 px-1 text-xs text-foreground outline-none"
              />
            ) : (
              <span title="Double-click to rename" onDoubleClick={() => setRenaming(candidate.id)} className="min-w-0 flex-1 truncate">
                {tabLabel(candidate)}
              </span>
            )}
            <button
              aria-label="Close tab"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => updateBrowser((state) => closeTab(state, candidate.id))}
              className="invisible grid size-4 shrink-0 place-items-center rounded group-hover:visible hover:bg-foreground/10"
            >
              <Icon name="close" className="size-3" />
            </button>
          </div>
        ))}
        <button aria-label="New tab" title="New tab (⌘T)" className={toolButton} onClick={() => runBrowserAction('newTab')}>
          <Icon name="plus" className="size-3.5" />
        </button>
      </div>
      <div className="relative flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5">
        {tab?.loading && <span className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 animate-pulse bg-primary" />}
        <button aria-label="Back" title="Back (⌘[)" className={toolButton} disabled={!tab?.canGoBack} onClick={() => runBrowserAction('back')}>
          <Icon name="arrowLeft" className="size-3.5" />
        </button>
        <button aria-label="Forward" title="Forward (⌘])" className={toolButton} disabled={!tab?.canGoForward} onClick={() => runBrowserAction('forward')}>
          <Icon name="arrowRight" className="size-3.5" />
        </button>
        <button aria-label="Reload" title="Reload (⌘R)" className={toolButton} onClick={() => runBrowserAction('reload')}>
          <Icon name={tab?.loading ? 'loader' : 'refresh'} className={`size-3.5 ${tab?.loading ? 'animate-spin' : ''}`} />
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            ref={input}
            value={address}
            placeholder="Search or type an address"
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value)
              setHighlighted(-1)
            }}
            onFocus={(event) => {
              event.target.select()
              setSuggesting(true)
              setHighlighted(-1)
            }}
            onBlur={() => {
              setDraft(null)
              setSuggesting(false)
            }}
            onKeyDown={(event) => {
              if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && rows.length) {
                event.preventDefault()
                setHighlighted((index) => (event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : Math.max(-1, index - 1)))
              }
              if (event.key === 'Enter') openAddress(rows[highlighted]?.url ?? address)
              if (event.key === 'Escape') {
                setDraft(null)
                event.currentTarget.blur()
              }
            }}
            className="h-6 w-full rounded-md border border-border bg-muted/40 px-2 font-mono text-xs outline-none focus:border-primary"
          />
          {problem && !suggesting && (
            <span
              title={`${problem.title} ${problem.hint}`}
              className={`pointer-events-none absolute top-1/2 right-1.5 flex h-4 -translate-y-1/2 items-center gap-1 rounded px-1 text-[10.5px] ${tab?.status && tab.status >= 500 ? 'bg-red-400/15 text-red-400' : 'bg-amber-400/15 text-amber-400'}`}
            >
              <Icon name={problem.icon} className="size-3" />
              {problem.title} {problem.hint}
            </span>
          )}
          {suggesting && rows.length > 0 && <Suggestions sections={sections} highlighted={highlighted} onOpen={openAddress} onHighlight={setHighlighted} />}
        </div>
        {place === 'tab' && <ProfileBadge />}
        {running.length > 0 && (
          <button
            aria-label="Servers started by your sessions"
            title="Servers started by your sessions"
            onClick={() => input.current?.focus()}
            className="flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-[11px] text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
          >
            <span className="size-1.5 rounded-full bg-emerald-400" />
            {running.length}
          </button>
        )}
        <button
          aria-label="Design mode"
          title="Design mode: click an element to comment on it (⌘⇧C)"
          aria-pressed={designOn}
          className={`${toolButton} ${designOn ? 'bg-primary/15 text-primary' : ''}`}
          onClick={() => runBrowserAction('designMode')}
        >
          <Icon name="pointer" className="size-3.5" />
        </button>
        <button
          aria-label="Developer tools"
          title="Developer tools (⌥⌘I)"
          aria-pressed={dockOpen}
          className={`${toolButton} ${dockOpen ? 'bg-primary/15 text-primary' : ''}`}
          onClick={() => runBrowserAction('devtools')}
          onContextMenu={(event) => {
            event.preventDefault()
            const next = devtools === 'docked' ? 'window' : 'docked'
            setDevtools(next)
            host.flash(next === 'window' ? 'DevTools open in a window' : 'DevTools dock under the page')
          }}
        >
          <Icon name="code" className="size-3.5" />
        </button>
        {place === 'tab' && host.service('sessions') && (
          <button
            aria-label="Terminal"
            title="Terminal beside the page; move it to a side from its title bar button"
            aria-pressed={host.isPanelVisible('terminal')}
            className={`${toolButton} ${host.isPanelVisible('terminal') ? 'bg-primary/15 text-primary' : ''}`}
            onClick={() => (host.isPanelVisible('terminal') ? host.hidePanel('terminal') : host.showPanel('terminal'))}
          >
            <Icon name="terminal" className="size-3.5" />
          </button>
        )}
        {host.renderSendButton(host.selectedWorktree ?? host.defaultCwd, 'pill')}
        {place === 'tab' && <div ref={setStripSlot} className="flex shrink-0 items-center gap-0.5 border-l border-border pl-1" />}
      </div>
      <div ref={ref} className="relative min-h-0 flex-1">
        {elsewhere && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {place === 'tab' ? 'Showing in the Browser panel' : 'Showing in the Browser tab'}
          </div>
        )}
        {shown && (!tab || tab.url === 'about:blank') && <EmptyPage onOpen={() => runBrowserAction('focusAddress')} />}
        {shown && tab && tab.url !== 'about:blank' && !tab.committed && !tab.error && (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted-foreground">
            <Icon name="loader" className="size-5 animate-spin" />
            <span className="max-w-80 truncate font-mono">{tab.url.replace(/^https?:\/\//, '')}</span>
          </div>
        )}
        {shown && tab?.error && failure && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="grid size-12 place-items-center rounded-xl bg-foreground/5 text-muted-foreground">
              <Icon name={failure.icon} className="size-6" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">{failure.title}</div>
              {failure.hint && <div className="mt-1 text-xs text-muted-foreground">{failure.hint}</div>}
              <div className="mt-2 font-mono text-[11px] text-muted-foreground/70">{tab.error.description}</div>
            </div>
            <button onClick={() => runBrowserAction('reload')} className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent">
              <Icon name="refresh" className="size-3.5" />
              Reload
            </button>
          </div>
        )}
        {shown && tab?.crashed && (
          <div className="relative z-20 flex h-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            This page crashed
            <button onClick={() => runBrowserAction('reload')} className="rounded border border-border px-2 py-1 hover:bg-accent">
              Reload
            </button>
          </div>
        )}
      </div>
      {tab && place === 'tab' && <Strip tab={tab} slot={stripSlot} />}
      {tab?.guestId && place === 'tab' && dockOpen && devtools === 'docked' && <DevtoolsDock key={tab.guestId} guestId={tab.guestId} />}
    </div>
  )
}
