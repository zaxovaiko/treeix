import { Fragment, useEffect, useMemo, useState } from 'react'
import { createBridge } from '@treeix/sdk'
import { errorMessage } from '@treeix/shared/errors'
import { Select } from '@treeix/app/Picker'
import { Card } from '@treeix/app/settingsUi'
import type { AgentUsage as Usage, UsageRow } from '../shared/types'

const bridge = createBridge('agent-usage')

// The last scan, shown at once when the page opens again while a fresh one runs
let lastUsage: Usage | null = null

const RANGES = [
  ['today', 'Today'],
  ['thisWeek', 'This week'],
  ['week', 'Last 7 days'],
  ['month', 'This month'],
  ['30days', 'Last 30 days'],
  ['all', 'All time']
] as const
type Range = (typeof RANGES)[number][0]

const AGENT_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  ollama: 'Ollama'
}
const agentName = (id: string): string => AGENT_NAMES[id] ?? id

const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumSignificantDigits: 3
}).format
const usd = (amount: number): string => (amount >= 100 ? `$${Math.round(amount).toLocaleString('en')}` : `$${amount.toFixed(2)}`)

/** Jun 24, 26 */
const shortDay = (day: string): string => new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })

const dayOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const daysAgo = (days: number): string => {
  const date = new Date()
  date.setDate(date.getDate() - days)
  return dayOf(date)
}

function rangeStart(range: Range, rows: UsageRow[]): string {
  if (range === 'today') return daysAgo(0)
  // Weeks start on Monday
  if (range === 'thisWeek') return daysAgo((new Date().getDay() + 6) % 7)
  if (range === 'week') return daysAgo(6)
  if (range === '30days') return daysAgo(29)
  if (range === 'month') return `${daysAgo(0).slice(0, 8)}01`
  return rows.reduce((first, row) => (row.day < first ? row.day : first), daysAgo(0))
}

function daysFrom(start: string): string[] {
  const days: string[] = []
  const date = new Date(`${start}T00:00:00`)
  for (const today = daysAgo(0); dayOf(date) <= today; date.setDate(date.getDate() + 1)) days.push(dayOf(date))
  return days
}

const tokensOf = (row: UsageRow): number => row.input + row.output + row.cacheRead + row.cacheWrite

type Group = { name: string; tokens: number; cost: number | null }

/** Tokens and cost per name, most tokens first; cost stays null when none of the name's models has a price */
function groupBy(rows: UsageRow[], nameOf: (row: UsageRow) => string, costOf: (row: UsageRow) => number | null): Group[] {
  const groups = new Map<string, Group>()
  for (const row of rows) {
    const group = groups.get(nameOf(row)) ?? {
      name: nameOf(row),
      tokens: 0,
      cost: null
    }
    const cost = costOf(row)
    group.tokens += tokensOf(row)
    if (cost !== null) group.cost = (group.cost ?? 0) + cost
    groups.set(group.name, group)
  }
  return [...groups.values()].sort((a, b) => b.tokens - a.tokens)
}

/** The app's searchable select, for a value from a fixed list */
function Filter<Value extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: Value
  options: readonly (readonly [Value, string])[]
  onChange: (value: Value) => void
}): React.JSX.Element {
  return (
    <div className="w-48 min-w-0">
      <Select
        title={label}
        value={value}
        options={options.map(([option, name]) => ({ value: option, label: name }))}
        onChange={(picked) => onChange(options.find(([option]) => option === picked)?.[0] ?? value)}
        width="w-60"
      />
    </div>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 rounded-lg px-3 py-2.5 ring-1 ring-border">
      <div className="truncate text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate text-lg tabular-nums">{value}</div>
      {note && <div className="text-[10.5px] text-muted-foreground">{note}</div>}
    </div>
  )
}

function DailyChart({ days, rows }: { days: string[]; rows: UsageRow[] }): React.JSX.Element {
  const byDay = new Map(days.map((day) => [day, { input: 0, output: 0 }]))
  for (const row of rows) {
    const totals = byDay.get(row.day)
    if (!totals) continue
    totals.input += row.input
    totals.output += row.output
  }
  const peak = Math.max(1, ...[...byDay.values()].map(({ input, output }) => input + output))
  return (
    <div className="px-2">
      <div className="mb-1.5 flex justify-end gap-3 text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-primary" /> output
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-sm bg-foreground/30" /> input
        </span>
        <span>cache excluded</span>
      </div>
      <div className="flex h-28 items-end justify-center gap-px border-b border-border">
        {[...byDay].map(([day, { input, output }]) => (
          <div key={day} title={`${shortDay(day)}\ninput ${compact(input)}\noutput ${compact(output)}`} className="flex h-full max-w-6 min-w-px flex-1 flex-col justify-end">
            <div style={{ height: `${(output / peak) * 100}%` }} className="rounded-t-[2px] bg-primary" />
            <div style={{ height: `${(input / peak) * 100}%` }} className="bg-foreground/30" />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span>{shortDay(days[0])}</span>
        <span>{shortDay(days.at(-1) ?? days[0])}</span>
      </div>
    </div>
  )
}

const BREAKDOWN_ROWS = 12

/** The biggest groups, then the rest behind a toggle */
function Breakdown({ title, groups }: { title: string; groups: Group[] }): React.JSX.Element {
  const [all, setAll] = useState(false)
  const most = Math.max(1, ...groups.map((group) => group.tokens))
  const hidden = groups.length - BREAKDOWN_ROWS
  return (
    <Card title={title}>
      <div className="grid grid-cols-[minmax(0,14rem)_1fr_auto_auto] items-center gap-x-3 gap-y-1.5 px-2 text-xs">
        {(all ? groups : groups.slice(0, BREAKDOWN_ROWS)).map(({ name, tokens, cost }, index) => (
          <Fragment key={index}>
            <span className="truncate" title={name}>
              {name}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
              <span style={{ width: `${(tokens / most) * 100}%` }} className="block h-full rounded-full bg-primary" />
            </span>
            <span className="text-right text-muted-foreground tabular-nums">{compact(tokens)}</span>
            <span className="w-14 text-right tabular-nums">{cost === null ? '-' : usd(cost)}</span>
          </Fragment>
        ))}
        {hidden > 0 && (
          <button onClick={() => setAll(!all)} className="col-span-full justify-self-start text-muted-foreground hover:text-foreground">
            {all ? 'Show less' : `${hidden} more`}
          </button>
        )}
      </div>
    </Card>
  )
}

function Dashboard(): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(lastUsage)
  const [error, setError] = useState('')
  const [agent, setAgent] = useState('all')
  const [project, setProject] = useState('all')
  const [range, setRange] = useState<Range>('month')

  useEffect(() => {
    bridge
      .invoke<Usage>('usage')
      .then((fresh) => {
        lastUsage = fresh
        setUsage(fresh)
      })
      .catch((reason: unknown) => {
        if (!lastUsage) setError(errorMessage(reason))
      })
  }, [])

  const view = useMemo(() => {
    if (!usage) return null
    const { rows, prices, titles } = usage
    const costOf = (row: UsageRow): number | null => {
      const price = prices[row.model]
      return price ? row.input * price[0] + row.output * price[1] + row.cacheRead * price[2] + row.cacheWrite * price[3] : null
    }
    const start = rangeStart(range, rows)
    const inRange = rows.filter((row) => row.day >= start)
    const shown = inRange.filter((row) => (agent === 'all' || row.agent === agent) && (project === 'all' || row.project === project))
    const sum = (pick: (row: UsageRow) => number, of = shown): number => of.reduce((total, row) => total + pick(row), 0)
    return {
      shown,
      costOf,
      sessionName: (id: string): string => titles[id] ?? `Untitled ${id.slice(0, 8)}`,
      days: daysFrom(start),
      agents: groupBy(rows, (row) => row.agent, costOf).map(({ name }) => [name, agentName(name)] as const),
      projects: groupBy(inRange, (row) => row.project, costOf).map(({ name }) => [name, name] as const),
      cost: sum((row) => costOf(row) ?? 0),
      unpriced: sum(
        tokensOf,
        shown.filter((row) => costOf(row) === null)
      ),
      input: sum((row) => row.input),
      output: sum((row) => row.output),
      cacheRead: sum((row) => row.cacheRead),
      cacheWrite: sum((row) => row.cacheWrite)
    }
  }, [usage, agent, project, range])

  if (error) return <p className="px-2 text-xs text-red-400">Couldn't read the session logs: {error}</p>
  if (!view) return <p className="px-2 text-xs text-muted-foreground">Reading Claude and Codex session logs. The first time takes a minute.</p>
  const { shown, costOf, sessionName, days, cost, unpriced, input, output, cacheRead, cacheWrite } = view
  // The costliest sessions first, since spend is what this list is read for
  const sessions = groupBy(shown, (row) => row.session, costOf)
    .map((group) => ({ ...group, name: sessionName(group.name) }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.tokens - a.tokens)

  return (
    <div>
      <Card title="Usage">
        <div className="mb-3 flex flex-wrap gap-2 px-2">
          <Filter label="Agent" value={agent} options={[['all', 'All agents'], ...view.agents]} onChange={setAgent} />
          <Filter label="Project" value={project} options={[['all', 'All projects'], ...view.projects]} onChange={setProject} />
          <Filter label="Period" value={range} options={RANGES} onChange={setRange} />
        </div>
        <div className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] gap-2 px-2">
          <Stat label="Est. cost" value={usd(cost)} note={unpriced > 0 ? `excl. ${compact(unpriced)} unpriced` : 'API list prices'} />
          <Stat label="Total tokens" value={compact(input + output + cacheRead + cacheWrite)} />
          <Stat label="Input" value={compact(input)} />
          <Stat label="Output" value={compact(output)} />
          <Stat label="Cache" value={compact(cacheRead + cacheWrite)} note={`${compact(cacheRead)} read · ${compact(cacheWrite)} write`} />
        </div>
      </Card>
      <Card title="Daily tokens">
        <DailyChart days={days} rows={shown} />
      </Card>
      <Breakdown title="By model" groups={groupBy(shown, (row) => row.model, costOf)} />
      {project === 'all' && <Breakdown title="By project" groups={groupBy(shown, (row) => row.project, costOf)} />}
      <Breakdown title="By session" groups={sessions} />
    </div>
  )
}

export function UsagePage(): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-4xl">
        <Dashboard />
      </div>
    </div>
  )
}
