import '@treeix/app/main.css'
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { applyTheme, THEMES } from '@treeix/app/themes'
import { isJson, isString, list, text } from '@treeix/shared/json'
import { sseReader } from '../../main/sse'
import { BOARD_COLUMNS, boardColumn, runLinks, runSummary } from '../../shared/board'
import { decisionText, isRun, isWaiting, KIND_LABEL, reviewText, type Run, SOURCED_TITLE, type WorkflowNode } from '../../shared/workflow'

/** The hub's web app on the tailnet, phone first: what needs you, what runs, and starting a workflow */

type Named = { id: string; name: string }
type Ask = { node: string; requestId: string; title: string; options: Named[] }

const isNamed = (value: unknown): value is Named => isJson(value) && isString(value.id) && isString(value.name)
const isAsk = (value: unknown): value is Ask => isJson(value) && isString(value.node) && isString(value.requestId) && isString(value.title) && Array.isArray(value.options)

const RECONNECT_MS = 3000
const ARCHIVED_AT = 'treeix.archivedAt'

/** Every API call carries X-Treeix, which the server requires and no cross-site form or image can send */
async function call(method: 'GET' | 'POST', path: string, body?: object): Promise<unknown> {
  const response = await fetch(
    `/api/${path}`,
    method === 'GET' ? { headers: { 'X-Treeix': '1' } } : { method, headers: { 'X-Treeix': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }
  )
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error((isJson(data) && text(data.error)) || `The Mac answered ${response.status}`)
  return data
}

const STATUS_DOT: Record<string, string> = {
  waiting: 'bg-amber-400',
  running: 'bg-sky-400 animate-pulse',
  done: 'bg-emerald-400',
  failed: 'bg-red-400',
  interrupted: 'bg-amber-400',
  cancelled: 'bg-muted-foreground',
  pending: 'bg-muted-foreground/40',
  skipped: 'bg-muted-foreground/40'
}
const STATUS_LABEL: Record<string, string> = {
  waiting: 'Needs you',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  pending: 'Not yet',
  skipped: 'Skipped'
}

const ago = (at: number): string => {
  const minutes = Math.round((Date.now() - at) / 60_000)
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : new Date(at).toLocaleDateString()
}

const button = 'h-11 rounded-xl px-4 text-sm font-medium ring-1 ring-border active:bg-accent disabled:opacity-50'
const primary = 'h-11 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50'

function Dot({ status }: { status: string }): React.JSX.Element {
  return <span className={`size-2.5 shrink-0 rounded-full ${STATUS_DOT[status] ?? 'bg-muted-foreground'}`} />
}

/** Runs as they change: loaded once, then kept up by the server's stream, reloaded whenever the page comes back */
function useRuns(): { runs: Run[]; error: string | null } {
  const [runs, setRuns] = useState<Run[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let stop = false
    let abort = new AbortController()
    const load = (): void =>
      void call('GET', 'runs')
        .then((data) => (setRuns(list(data, isRun)), setError(null)))
        .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
    const follow = async (): Promise<void> => {
      while (!stop) {
        abort = new AbortController()
        try {
          const response = await fetch('/api/stream', { headers: { 'X-Treeix': '1' }, signal: abort.signal })
          if (!response.body) throw new Error('No stream')
          load()
          const reader = sseReader((data) => {
            const message: unknown = JSON.parse(data)
            if (!isJson(message)) return
            if (message.type === 'run' && isRun(message.run)) {
              const run = message.run
              setRuns((current) => (current.some((entry) => entry.id === run.id) ? current.map((entry) => (entry.id === run.id ? run : entry)) : [run, ...current]))
            } else if (message.type === 'removed') setRuns((current) => current.filter((entry) => entry.id !== message.id))
          })
          // Safari's streams can't be iterated with for await
          const chunks = response.body.pipeThrough(new TextDecoderStream()).getReader()
          for (let next = await chunks.read(); !next.done; next = await chunks.read()) reader.push(next.value)
        } catch {
          // Dropped by the phone sleeping or the Mac going away; try again shortly
        }
        if (!stop) await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS))
      }
    }
    void follow()
    // iOS freezes a page in the background, so its stream may be stale when it's back
    const visible = (): void => void (document.visibilityState === 'visible' && abort.abort())
    document.addEventListener('visibilitychange', visible)
    return () => {
      stop = true
      abort.abort()
      document.removeEventListener('visibilitychange', visible)
    }
  }, [])
  return { runs, error }
}

function useHash(): string {
  const [hash, setHash] = useState(location.hash.slice(1))
  useEffect(() => {
    const changed = (): void => setHash(location.hash.slice(1))
    addEventListener('hashchange', changed)
    return () => removeEventListener('hashchange', changed)
  }, [])
  return hash
}

const shown = (run: Run): string => (isWaiting(run) ? 'waiting' : run.status)

const canPush = (): boolean => 'serviceWorker' in navigator && 'PushManager' in window

/** Subscribes this device and hands the subscription to the Mac */
async function subscribePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site')
  const registration = await navigator.serviceWorker.ready
  const key = await call('GET', 'push/key')
  if (!isString(key)) throw new Error('The Mac sent no key')
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
  })
  await call('POST', 'push', subscription.toJSON())
}

/** Push needs the app on the home screen on iPhone; this offers what this browser can do */
function Notifications(): React.JSX.Element | null {
  const [state, setState] = useState<'off' | 'on' | 'busy' | 'unsupported'>(() => (!canPush() ? 'unsupported' : Notification.permission === 'granted' ? 'on' : 'off'))
  const [error, setError] = useState<string | null>(null)
  // A granted page subscribes again on load, so a device the Mac forgot comes back
  useEffect(() => {
    if (!canPush()) return
    void navigator.serviceWorker.register('/sw.js')
    if (Notification.permission === 'granted') void subscribePush().catch(() => undefined)
  }, [])
  const subscribe = (): void => {
    setState('busy')
    subscribePush()
      .then(() => (setState('on'), setError(null)))
      .catch((reason: unknown) => (setError(reason instanceof Error ? reason.message : String(reason)), setState('off')))
  }
  if (state === 'on') return null
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-card p-4 ring-1 ring-border">
      {state === 'unsupported' ? (
        <p className="text-sm text-muted-foreground">To be told when a run needs you, add this page to the Home Screen (Share, Add to Home Screen) and open it from there.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Get a notification when a run needs you or fails.</p>
          <button onClick={subscribe} disabled={state === 'busy'} className={primary}>
            Turn on notifications
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}

/** A ticket run's title without its source prefix, and the ticket key on its own */
function titleOf(run: Run): { key: string | null; title: string } {
  const [, source, key, rest] = SOURCED_TITLE.exec(run.title) ?? []
  return source ? { key, title: rest || key } : { key: null, title: run.title }
}

const plain = (text: string): string => text.replace(/\*\*(.+?)\*\*/g, '$1')

function Card({ run }: { run: Run }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const approval = Object.entries(run.nodes).find(([, node]) => node.waiting === 'approval')?.[0]
  const { key, title } = titleOf(run)
  const summary = plain(runSummary(run))
  const decide = (approved: boolean): void => {
    setBusy(true)
    void call('POST', `runs/${encodeURIComponent(run.id)}/decide`, { node: approval, approved }).finally(() => setBusy(false))
  }
  return (
    <div className="rounded-2xl bg-card ring-1 ring-border">
      <a href={`#run=${run.id}`} className="flex flex-col gap-1 p-3.5 active:bg-accent">
        <span className="flex items-center gap-2">
          <span className="line-clamp-2 min-w-0 flex-1 text-[15px] leading-snug font-medium">{title}</span>
        </span>
        {summary && !run.title.includes(summary) && <span className="line-clamp-2 text-[13px] text-muted-foreground">{summary}</span>}
        <span className="flex items-center gap-2 pt-1 text-xs text-muted-foreground tabular-nums">
          <Dot status={shown(run)} />
          {STATUS_LABEL[shown(run)]}
          {key && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{key}</span>}
          <span className="flex-1 text-right">{ago(run.endedAt ?? run.startedAt)}</span>
        </span>
      </a>
      {runLinks(run).length > 0 && (
        <div className="flex gap-4 border-t border-border px-3.5">
          {runLinks(run).map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="flex h-11 items-center text-sm text-primary">
              {link.label}
            </a>
          ))}
        </div>
      )}
      {approval && (
        <div className="grid grid-cols-2 gap-2 border-t border-border p-2.5">
          <button disabled={busy} onClick={() => decide(false)} className={button}>
            Reject
          </button>
          <button disabled={busy} onClick={() => decide(true)} className={primary}>
            Approve
          </button>
        </div>
      )}
    </div>
  )
}

/** The Mac's board: one column a screen on a phone, swiped or picked from the tabs, side by side when there's room */
function Board({ runs }: { runs: Run[] }): React.JSX.Element {
  const [archivedAt, setArchivedAt] = useState(() => Number(localStorage.getItem(ARCHIVED_AT)) || 0)
  const [column, setColumn] = useState(0)
  const strip = useRef<HTMLDivElement>(null)
  const columns = BOARD_COLUMNS.map((entry) => ({
    ...entry,
    runs: runs
      .filter((run) => boardColumn(run) === entry.id && (entry.id !== 'done' || (run.endedAt ?? run.startedAt) > archivedAt))
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
  }))
  const archive = (): void => {
    localStorage.setItem(ARCHIVED_AT, String(Date.now()))
    setArchivedAt(Date.now())
  }
  const show = (index: number): void => strip.current?.children[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  return (
    <>
      <div className="sticky top-0 z-10 -mx-4 flex gap-1 bg-background/90 px-4 pb-2 backdrop-blur md:hidden">
        {columns.map((entry, index) => (
          <button
            key={entry.id}
            onClick={() => show(index)}
            className={`h-9 flex-1 rounded-full text-sm ${index === column ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground'}`}
          >
            {entry.label} <span className="tabular-nums">{entry.runs.length}</span>
          </button>
        ))}
      </div>
      <div
        ref={strip}
        onScroll={(event) => setColumn(Math.round(event.currentTarget.scrollLeft / event.currentTarget.clientWidth))}
        className="-mx-4 flex snap-x snap-mandatory items-start overflow-x-auto [scrollbar-width:none] md:mx-0 md:grid md:grid-cols-3 md:gap-3"
      >
        {columns.map((entry) => (
          <section key={entry.id} className="flex w-full shrink-0 snap-start flex-col gap-2 px-4 md:px-0">
            <h2 className="hidden items-center gap-2 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase md:flex">
              <span className="flex-1">{entry.label}</span>
              <span className="tabular-nums">{entry.runs.length}</span>
            </h2>
            {entry.runs.map((run) => (
              <Card key={run.id} run={run} />
            ))}
            {!entry.runs.length && <p className="py-10 text-center text-sm text-muted-foreground">Nothing here</p>}
            {entry.id === 'done' && entry.runs.length > 0 && (
              <button onClick={archive} className="py-2 text-sm text-muted-foreground">
                Archive done runs
              </button>
            )}
          </section>
        ))}
      </div>
    </>
  )
}

function Home({ runs }: { runs: Run[] }): React.JSX.Element {
  return (
    <>
      <Notifications />
      <Board runs={runs} />
    </>
  )
}

/** Approval prompts are written in markdown; bold is the only part worth keeping on a phone */
const withBold = (text: string): React.ReactNode[] => text.split(/\*\*(.+?)\*\*/g).map((part, index) => (index % 2 ? <strong key={index}>{part}</strong> : part))

function Output({ value }: { value: string }): React.JSX.Element {
  return <pre className="max-h-96 overflow-auto rounded-xl bg-muted p-3 font-sans text-[13px] whitespace-pre-wrap select-text">{value}</pre>
}

function RunDetail({ run, agents }: { run: Run; agents: Named[] }): React.JSX.Element {
  const [asks, setAsks] = useState<Ask[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const permissionWaits = Object.values(run.nodes).filter((node) => node.waiting === 'permission').length
  useEffect(() => {
    if (!permissionWaits) return setAsks([])
    void call('GET', `runs/${encodeURIComponent(run.id)}/asks`).then((data) => setAsks(list(data, isAsk)))
  }, [run.id, permissionWaits])
  const act = (path: string, body?: object): void => {
    setBusy(true)
    call('POST', `runs/${encodeURIComponent(run.id)}/${path}`, body ?? {})
      .then(() => setError(null))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false))
  }
  const steps = run.workflow.nodes.filter((step) => run.nodes[step.id] && step.kind !== 'input')
  const labelOf = (step: WorkflowNode): string => (step.kind === 'agent' ? (agents.find((agent) => agent.id === step.agent)?.name ?? 'Agent') : KIND_LABEL[step.kind])
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg leading-snug font-semibold">{titleOf(run).title}</h1>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Dot status={shown(run)} />
          {STATUS_LABEL[shown(run)]} · started {ago(run.startedAt)}
        </div>
      </div>
      {steps
        .filter((step) => run.nodes[step.id].waiting === 'approval')
        .map((step) => (
          <div key={step.id} className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-amber-400/40">
            <p className="text-[15px] whitespace-pre-wrap select-text">{withBold(run.nodes[step.id].prompt ?? 'Approve to go on')}</p>
            <div className="grid grid-cols-2 gap-2">
              <button disabled={busy} onClick={() => act('decide', { node: step.id, approved: true })} className={primary}>
                Approve
              </button>
              <button disabled={busy} onClick={() => act('decide', { node: step.id, approved: false })} className={button}>
                Reject
              </button>
            </div>
          </div>
        ))}
      {asks.map((ask) => (
        <div key={ask.requestId} className="flex flex-col gap-3 rounded-2xl bg-card p-4 ring-1 ring-amber-400/40">
          <p className="text-sm text-muted-foreground">An agent asks for permission</p>
          <p className="text-[15px] select-text">{ask.title}</p>
          <div className="flex flex-col gap-2">
            {ask.options.map((option) => (
              <button
                key={option.id}
                disabled={busy}
                onClick={() => act('answer', { node: ask.node, requestId: ask.requestId, optionId: option.id })}
                className={option.id === ask.options[0]?.id ? primary : button}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
      ))}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <section className="flex flex-col gap-1">
        <h2 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Steps</h2>
        <div className="rounded-2xl bg-card px-3 ring-1 ring-border">
          {steps.map((step) => {
            const state = run.nodes[step.id]
            const detail = state.error ?? state.output
            return (
              <div key={step.id} className="border-b border-border py-3 last:border-0">
                <button onClick={() => setOpen(open === step.id ? null : step.id)} disabled={!detail} className="flex w-full items-center gap-3 text-left">
                  <Dot status={state.waiting ? 'waiting' : state.status} />
                  <span className="min-w-0 flex-1 truncate text-[15px]">{labelOf(step)}</span>
                  <span className="text-xs text-muted-foreground">{STATUS_LABEL[state.waiting ? 'waiting' : state.status]}</span>
                </button>
                {state.review && <p className="mt-1 pl-5 text-sm text-muted-foreground select-text">{reviewText(state.review)}</p>}
                {state.decision && <p className="mt-1 pl-5 text-sm text-muted-foreground select-text">{decisionText(state.decision)}</p>}
                {open === step.id && detail && (
                  <div className="mt-2">
                    <Output value={detail} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
      {run.output && (
        <section className="flex flex-col gap-1">
          <h2 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Output</h2>
          <Output value={run.output} />
        </section>
      )}
      {run.status === 'running' && (
        <button disabled={busy} onClick={() => act('cancel')} className={button}>
          Cancel run
        </button>
      )}
      {run.status === 'interrupted' && (
        <button disabled={busy} onClick={() => act('resume')} className={primary}>
          Resume run
        </button>
      )}
    </>
  )
}

function Start(): React.JSX.Element {
  const [workflows, setWorkflows] = useState<Named[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void call('GET', 'workflows').then((data) => setWorkflows(list(data, isNamed))), [])
  const start = (): void => {
    if (!chosen) return
    setBusy(true)
    call('POST', `workflows/${encodeURIComponent(chosen)}/run`, { input })
      .then((id) => isString(id) && (location.hash = `run=${id}`))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <h1 className="text-lg font-semibold">Start a workflow</h1>
      <div className="rounded-2xl bg-card px-3 ring-1 ring-border">
        {workflows.map((workflow) => (
          <button
            key={workflow.id}
            aria-pressed={chosen === workflow.id}
            onClick={() => setChosen(workflow.id)}
            className="flex min-h-12 w-full items-center gap-3 border-b border-border text-left text-[15px] last:border-0 aria-pressed:font-semibold aria-pressed:text-primary"
          >
            {workflow.name}
          </button>
        ))}
        {!workflows.length && <p className="py-4 text-sm text-muted-foreground">No workflows yet; make one in Treeix on the Mac</p>}
      </div>
      {chosen && (
        <>
          <textarea
            name="input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Input, like a ticket key or what to do"
            rows={5}
            className="resize-none rounded-2xl bg-card p-3 text-base ring-1 ring-border outline-none focus:ring-primary"
          />
          <button disabled={busy} onClick={start} className={primary}>
            Start
          </button>
        </>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </>
  )
}

function App(): React.JSX.Element {
  const { runs, error } = useRuns()
  const hash = useHash()
  const [agents, setAgents] = useState<Named[]>([])
  useEffect(() => void call('GET', 'agents').then((data) => setAgents(list(data, isNamed))), [])
  const runId = hash.startsWith('run=') ? decodeURIComponent(hash.slice(4)) : null
  const run = runId ? runs.find((entry) => entry.id === runId) : undefined
  const waiting = runs.filter(isWaiting).length
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background text-foreground">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/90 px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-3 backdrop-blur">
        {hash === 'start' || runId ? (
          <a href="#runs" className="-my-2 -ml-2 flex h-11 items-center px-2 text-[15px] text-primary">
            ‹ Board
          </a>
        ) : (
          <span className="text-[17px] font-semibold">Agents{waiting > 0 && <span className="ml-2 text-sm text-amber-400">{waiting} need you</span>}</span>
        )}
        <span className="flex-1" />
        {hash !== 'start' && (
          <a href="#start" className="-my-2 -mr-2 flex h-11 items-center px-2 text-[15px] text-primary">
            Start
          </a>
        )}
      </header>
      <main className={`mx-auto flex w-full flex-col gap-5 px-4 ${hash === 'start' || runId ? 'max-w-xl' : 'max-w-5xl'} pt-4 pb-[max(env(safe-area-inset-bottom),1rem)]`}>
        {error && <p className="rounded-xl bg-red-400/10 p-3 text-sm text-red-400">{error}</p>}
        {hash === 'start' ? <Start /> : runId ? run ? <RunDetail run={run} agents={agents} /> : <p className="text-sm text-muted-foreground">Loading…</p> : <Home runs={runs} />}
      </main>
    </div>
  )
}

const dark = matchMedia('(prefers-color-scheme: dark)')
const theme = (): void => applyTheme(dark.matches ? 'neutral' : 'light', dark.matches ? THEMES.neutral : THEMES.light, 1)
theme()
dark.addEventListener('change', theme)

createRoot(document.getElementById('root') ?? document.body).render(
  <StrictMode>
    <App />
  </StrictMode>
)
