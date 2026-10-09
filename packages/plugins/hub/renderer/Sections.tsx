import { useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { timeAgo } from '@treeix/app/time'
import { errorMessage, IconButton } from '@treeix/app/ui'
import type { Workflow } from '../shared/workflow'
import { AgentAvatar } from './AgentEditor'
import { shownRun, StatusIcon } from './RunView'
import { asking, type HubChat, hubAgents, hubApi, hubEditing, hubRuns, hubSelection, hubSettings, hubWorkflows, isStale, setConversation, TAB_ID } from './store'

const ROW = 'group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent'

/** A run started by a command schedule is titled `jira:BF-7 BF-7 Fix it` or `notion:<id>`: the source becomes an icon, the key is not repeated */
const SOURCE = { jira: 'ticket', notion: 'bookOpen' } as const
function runTitle(title: string): React.JSX.Element {
  const [, source, key, rest] = /^(jira|notion):(\S+)\s*(.*)$/.exec(title) ?? []
  if (!source) return <span className="min-w-0 flex-1 truncate">{title}</span>
  return (
    <>
      <Icon name={SOURCE[source as keyof typeof SOURCE]} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{rest || key}</span>
    </>
  )
}

const newWorkflow = (): Workflow => ({
  id: crypto.randomUUID(),
  name: 'New workflow',
  nodes: [
    { id: 'input', kind: 'input' },
    { id: 'output', kind: 'output', template: '{{prev}}' }
  ],
  edges: [{ id: 'input-output', from: 'input', to: 'output', branch: null }],
  layout: { input: { x: 0, y: 0 }, output: { x: 520, y: 0 } },
  updatedAt: Date.now()
})

/** Shows the row's view in main; the hub's page is hidden from the title bar, so the sidebar is the only way in */
function useOpen(): (row: string) => void {
  const host = useHost()
  return (row) => {
    hubSelection.set(row)
    host.setActiveTab(TAB_ID)
  }
}

export function NewAgentButton(): React.JSX.Element {
  return (
    <IconButton label="New agent" onClick={() => hubEditing.set('new')}>
      <Icon name="plus" className="size-3.5" />
    </IconButton>
  )
}

export function AgentsSection(): React.JSX.Element {
  const agents = hubAgents.use()
  const selection = hubSelection.use()
  const open = useOpen()
  return (
    <>
      {agents.map((agent) => (
        <button key={agent.id} onClick={() => open(`agent:${agent.id}`)} className={`${ROW} h-8 ${selection === `agent:${agent.id}` ? 'bg-accent' : ''}`}>
          <AgentAvatar agent={agent} size={20} />
          <span className="min-w-0 flex-1 truncate">{agent.name}</span>
        </button>
      ))}
    </>
  )
}

export function NewWorkflowButton(): React.JSX.Element {
  const host = useHost()
  const create = (): void => {
    const workflow = newWorkflow()
    hubApi.saveWorkflow(workflow).then(
      () => {
        hubSelection.set(`workflow:${workflow.id}`)
        host.setActiveTab(TAB_ID)
      },
      (reason: unknown) => host.flash(errorMessage(reason))
    )
  }
  return (
    <IconButton label="New workflow" onClick={create}>
      <Icon name="plus" className="size-3.5" />
    </IconButton>
  )
}

export function WorkflowsSection(): React.JSX.Element {
  const host = useHost()
  const workflows = hubWorkflows.use()
  const selection = hubSelection.use()
  const open = useOpen()
  const remove = (workflow: Workflow): void =>
    void (window.confirm(`Delete ${workflow.name}?`) && hubApi.removeWorkflow(workflow.id).catch((reason: unknown) => host.flash(errorMessage(reason))))
  return (
    <>
      {workflows.map((workflow) => (
        <div key={workflow.id} className="group relative">
          <button onClick={() => open(`workflow:${workflow.id}`)} className={`${ROW} h-8 ${selection === `workflow:${workflow.id}` ? 'bg-accent' : ''}`}>
            <Icon name="layers" className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{workflow.name}</span>
          </button>
          <span className="absolute inset-y-0 right-0.5 hidden items-center group-hover:flex">
            <IconButton label={`Run ${workflow.name}`} onClick={() => asking.set({ target: `workflow:${workflow.id}`, openRun: false })}>
              <Icon name="play" className="size-3" />
            </IconButton>
            <IconButton label={`Delete ${workflow.name}`} onClick={() => remove(workflow)}>
              <Icon name="trash" className="size-3" />
            </IconButton>
          </span>
        </div>
      ))}
    </>
  )
}

/** Conversations and runs, newest first; a day of inactivity folds one into the closed Older group at the end */
export function HistorySection(): React.JSX.Element {
  const host = useHost()
  const agents = hubAgents.use()
  const { conversations, chats: allChats } = hubSettings.use()
  const selection = hubSelection.use()
  const open = useOpen()
  const [olderOpen, setOlderOpen] = useState({ chats: false, runs: false })
  const allRuns = hubRuns.use()
  const freshRuns = allRuns.filter((run) => run.endedAt === null || !isStale(run.startedAt))
  const olderRuns = allRuns.filter((run) => !freshRuns.includes(run))
  const runs = olderOpen.runs ? [...freshRuns, ...olderRuns] : freshRuns
  const knownChats = allChats.filter((entry) => agents.some((agent) => agent.id === entry.agentId))
  const freshChats = knownChats.filter((entry) => !isStale(entry.updatedAt))
  const olderChats = knownChats.filter((entry) => isStale(entry.updatedAt))
  const chats = olderOpen.chats ? [...freshChats, ...olderChats] : freshChats

  const removeChat = (entry: HubChat): void => {
    // The open conversation stays open; a new one replaces it next time the agent is picked
    if (conversations[entry.agentId] === entry.sessionId) setConversation(entry.agentId, null)
    hubSettings.update({ chats: hubSettings.get().chats.filter((other) => other.sessionId !== entry.sessionId) })
  }

  /** A history row with a × on hover; faded inside the Older group */
  const historyRow = (row: string, removeLabel: string, onRemove: (() => void) | null, at: number, older: boolean, children: React.ReactNode): React.JSX.Element => (
    <div key={row} className={`group relative ${older ? 'opacity-50 hover:opacity-100' : ''}`}>
      <button onClick={() => open(row)} className={`${ROW} h-8 ${row === selection ? 'bg-accent' : ''}`}>
        {children}
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums group-hover:invisible">{timeAgo(new Date(at).toISOString())}</span>
      </button>
      {onRemove && (
        <span className="absolute inset-y-0 right-0.5 hidden items-center group-hover:flex">
          <IconButton label={removeLabel} onClick={onRemove}>
            <Icon name="close" className="size-3" />
          </IconButton>
        </span>
      )}
    </div>
  )

  const olderToggle = (section: 'chats' | 'runs', count: number): React.ReactNode =>
    count > 0 && (
      <button
        key={`older:${section}`}
        onClick={() => setOlderOpen({ ...olderOpen, [section]: !olderOpen[section] })}
        aria-expanded={olderOpen[section]}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Icon name="chevron" className={`size-3 transition-transform ${olderOpen[section] ? 'rotate-90' : ''}`} />
        Older
        <span className="tabular-nums">{count}</span>
      </button>
    )

  return (
    <>
      {chats.map((entry, index) => {
        const agent = agents.find((candidate) => candidate.id === entry.agentId)
        return [
          index === freshChats.length && olderToggle('chats', olderChats.length),
          historyRow(
            `chat:${entry.sessionId}`,
            'Remove from history',
            () => removeChat(entry),
            entry.updatedAt,
            index >= freshChats.length,
            <>
              {agent && <AgentAvatar agent={agent} size={16} />}
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            </>
          )
        ]
      })}
      {!olderOpen.chats && olderToggle('chats', olderChats.length)}
      {runs.map((run, index) => [
        index === freshRuns.length && olderToggle('runs', olderRuns.length),
        historyRow(
          `run:${run.id}`,
          'Remove the run',
          run.endedAt === null ? null : () => void hubApi.removeRun(run.id).catch((reason: unknown) => host.flash(errorMessage(reason))),
          run.startedAt,
          index >= freshRuns.length,
          <>
            <StatusIcon status={shownRun(run)} />
            {runTitle(run.title)}
          </>
        )
      ])}
      {!olderOpen.runs && olderToggle('runs', olderRuns.length)}
    </>
  )
}
