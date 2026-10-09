import { lazy, Suspense, useEffect, useState } from 'react'
import { focusZone, PageLayout, useHost, useListNav, usePanels } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { timeAgo } from '@treeix/app/time'
import { EmptyState, errorMessage, IconButton } from '@treeix/app/ui'
import type { HubAgent } from '../shared/types'
import type { Workflow } from '../shared/workflow'
import { AgentAvatar, AgentEditor } from './AgentEditor'
import { RunView, shownRun, StatusIcon } from './RunView'
import { asking, chatIdOf, type HubChat, hubAgents, hubApi, hubRuns, hubSelection, hubSettings, hubWorkflows, registryId, runtimeLabel, setConversation } from './store'

// The canvas library is big and only workflows need it
const WorkflowView = lazy(() => import('./WorkflowView').then((module) => ({ default: module.WorkflowView })))

const ROW = 'flex w-full min-w-0 items-center gap-2 rounded-md text-left hover:bg-accent'
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

const HEADING = 'text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'
const DAY_MS = 24 * 60 * 60 * 1000

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

/** The agent's header and its chat, on `conversation` (null for a new one) */
function AgentChat({ agent, conversation, onEdit, onDelete }: { agent: HubAgent; conversation: string | null; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  const host = useHost()
  const chat = host.service('chat')
  const registry = useAgents()
  const persona = registry.find((entry) => entry.id === registryId(agent))
  const chatId = chatIdOf(agent)

  const open = (resume: string | null): void => {
    if (!chat || !persona?.chat) return
    const options = { agent: persona.id, ...persona.chat, cwd: agent.folder ?? host.defaultCwd, resume }
    // The chat shows a failed start itself
    chat.start(chatId, options).then(
      (sessionId) => setConversation(agent.id, sessionId),
      () => undefined
    )
  }
  const ready = persona !== undefined
  useEffect(() => {
    if (!ready || !chat) return
    const live = chat.agent(chatId) !== null
    if (live && (conversation === null || chat.agentSessionId(chatId) === conversation)) return
    // Another conversation from the history takes the agent's chat
    if (live) {
      chat.stop(chatId)
      chat.forget(chatId)
    }
    open(conversation)
  }, [ready, conversation])

  const restart = (): void => {
    chat?.stop(chatId)
    chat?.forget(chatId)
    setConversation(agent.id, null)
    hubSelection.set(`agent:${agent.id}`)
    open(null)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-1.5 pl-3">
        <AgentAvatar agent={agent} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{[runtimeLabel(agent.runtime), agent.model, agent.mode].filter(Boolean).join(' · ')}</div>
        </div>
        <IconButton label={`Ask ${agent.name}`} onClick={() => asking.set({ target: `agent:${agent.id}`, openRun: true })}>
          <Icon name="comment" className="size-3.5" />
        </IconButton>
        <IconButton label="New conversation" onClick={restart}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
        <IconButton label="Edit agent" onClick={onEdit}>
          <Icon name="pencil" className="size-3.5" />
        </IconButton>
        <IconButton label="Delete agent" onClick={onDelete}>
          <Icon name="trash" className="size-3.5" />
        </IconButton>
      </header>
      {chat && persona ? (
        <chat.View chatId={chatId} />
      ) : (
        <EmptyState fill icon="alert" title={`${agent.name} runs on ${runtimeLabel(agent.runtime)}, which is gone`}>
          <button onClick={onEdit} className="text-xs text-foreground underline">
            Pick another runtime
          </button>
        </EmptyState>
      )}
    </div>
  )
}

export function HubPage(): React.JSX.Element {
  const host = useHost()
  const agents = hubAgents.use()
  const workflows = hubWorkflows.use()
  const { conversations, chats: allChats } = hubSettings.use()
  const panels = usePanels('hub')
  const selection = hubSelection.use()
  const [editing, setEditing] = useState<HubAgent | 'new' | null>(null)
  // Chats and done runs a day old fold into a closed Older group at the end of their section
  const [olderOpen, setOlderOpen] = useState({ chats: false, runs: false })
  const stale = (at: number): boolean => Date.now() - at > DAY_MS
  const allRuns = hubRuns.use()
  const freshRuns = allRuns.filter((run) => run.endedAt === null || !stale(run.startedAt))
  const olderRuns = allRuns.filter((run) => !freshRuns.includes(run))
  const runs = olderOpen.runs ? [...freshRuns, ...olderRuns] : freshRuns
  const knownChats = allChats.filter((entry) => agents.some((agent) => agent.id === entry.agentId))
  const freshChats = knownChats.filter((entry) => !stale(entry.updatedAt))
  const olderChats = knownChats.filter((entry) => stale(entry.updatedAt))
  const chats = olderOpen.chats ? [...freshChats, ...olderChats] : freshChats
  const rows = [
    ...agents.map((agent) => `agent:${agent.id}`),
    ...workflows.map((workflow) => `workflow:${workflow.id}`),
    ...chats.map((entry) => `chat:${entry.sessionId}`),
    ...runs.map((run) => `run:${run.id}`)
  ]
  const selectedRow = selection !== null && rows.includes(selection) ? selection : (rows[0] ?? null)
  const selectedChat = chats.find((entry) => `chat:${entry.sessionId}` === selectedRow) ?? null
  const selectedAgent = agents.find((agent) => `agent:${agent.id}` === selectedRow || agent.id === selectedChat?.agentId) ?? null
  const selectedWorkflow = workflows.find((workflow) => `workflow:${workflow.id}` === selectedRow) ?? null
  const selectedRun = runs.find((run) => `run:${run.id}` === selectedRow) ?? null
  const nav = useListNav({
    count: rows.length,
    index: selectedRow === null ? -1 : rows.indexOf(selectedRow),
    onSelect: (index) => hubSelection.set(rows[index]),
    onOpen: () => focusZone('main')
  })

  const remove = (agent: HubAgent): void => {
    if (!window.confirm(`Delete ${agent.name}?`)) return
    const chat = host.service('chat')
    chat?.stop(chatIdOf(agent))
    chat?.forget(chatIdOf(agent))
    setConversation(agent.id, null)
    hubSettings.update({ chats: hubSettings.get().chats.filter((entry) => entry.agentId !== agent.id) })
    hubApi.remove(agent.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }

  const removeChat = (entry: HubChat): void => {
    // The open conversation stays open; a new one replaces it next time the agent is picked
    if (conversations[entry.agentId] === entry.sessionId) setConversation(entry.agentId, null)
    hubSettings.update({ chats: hubSettings.get().chats.filter((other) => other.sessionId !== entry.sessionId) })
  }

  const removeWorkflow = (workflow: Workflow): void => {
    if (!window.confirm(`Delete ${workflow.name}?`)) return
    hubApi.removeWorkflow(workflow.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }

  const removeRun = (id: string): void => void hubApi.removeRun(id).catch((reason: unknown) => host.flash(errorMessage(reason)))

  /** A history row with a × on hover; faded inside the Older group */
  const historyRow = (row: string, index: number, removeLabel: string, onRemove: (() => void) | null, at: number, older: boolean, children: React.ReactNode) => (
    <div key={row} className={`group relative ${older ? 'opacity-50 hover:opacity-100' : ''}`}>
      <button {...nav.rowProps(index)} onClick={() => hubSelection.set(row)} className={`${ROW} h-8 px-2 text-xs ${row === selectedRow ? 'bg-accent' : ''}`}>
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

  const olderToggle = (section: 'chats' | 'runs', count: number) =>
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

  const createWorkflow = (): void => {
    const workflow = newWorkflow()
    hubApi.saveWorkflow(workflow).then(
      () => hubSelection.set(`workflow:${workflow.id}`),
      (reason: unknown) => host.flash(errorMessage(reason))
    )
  }

  const selectedView = selectedRun ? (
    <RunView key={selectedRun.id} run={selectedRun} />
  ) : selectedAgent ? (
    <AgentChat
      key={selectedAgent.id}
      agent={selectedAgent}
      conversation={selectedChat?.sessionId ?? conversations[selectedAgent.id] ?? null}
      onEdit={() => setEditing(selectedAgent)}
      onDelete={() => remove(selectedAgent)}
    />
  ) : (
    <EmptyState fill icon="star" title="Your own agents: a name, a look and instructions on top of Claude, Codex or any chat agent">
      <button onClick={() => setEditing('new')} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
        Create an agent
      </button>
    </EmptyState>
  )

  const list = (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className={HEADING}>Agents</span>
        <span className="flex-1" />
        <IconButton label="New agent" onClick={() => setEditing('new')}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
        <IconButton label="Hide the list (⌘B)" onClick={() => panels.toggle('list')}>
          <Icon name="panel" className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {agents.map((agent, index) => (
          <button
            key={agent.id}
            {...nav.rowProps(index)}
            onClick={() => hubSelection.set(`agent:${agent.id}`)}
            className={`${ROW} h-9 px-2 text-xs ${selectedRow === `agent:${agent.id}` ? 'bg-accent' : ''}`}
          >
            <AgentAvatar agent={agent} size={24} />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          </button>
        ))}
        <div className="flex items-center pt-3 pr-0 pb-0.5 pl-2">
          <span className={`${HEADING} flex-1`}>Workflows</span>
          <IconButton label="New workflow" onClick={createWorkflow}>
            <Icon name="plus" className="size-3.5" />
          </IconButton>
        </div>
        {workflows.map((workflow, index) => (
          <div key={workflow.id} className="group relative">
            <button
              {...nav.rowProps(agents.length + index)}
              onClick={() => hubSelection.set(`workflow:${workflow.id}`)}
              className={`${ROW} h-8 px-2 text-xs ${workflow === selectedWorkflow ? 'bg-accent' : ''}`}
            >
              <Icon name="layers" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{workflow.name}</span>
            </button>
            <span className="absolute inset-y-0 right-0.5 hidden items-center group-hover:flex">
              <IconButton label={`Run ${workflow.name}`} onClick={() => asking.set({ target: `workflow:${workflow.id}`, openRun: false })}>
                <Icon name="play" className="size-3" />
              </IconButton>
              <IconButton label={`Delete ${workflow.name}`} onClick={() => removeWorkflow(workflow)}>
                <Icon name="trash" className="size-3" />
              </IconButton>
            </span>
          </div>
        ))}
        {knownChats.length > 0 && <div className={`${HEADING} px-2 pt-4 pb-1.5`}>Chats</div>}
        {chats.map((entry, index) => {
          const agent = agents.find((candidate) => candidate.id === entry.agentId)
          return [
            index === freshChats.length && olderToggle('chats', olderChats.length),
            historyRow(
              `chat:${entry.sessionId}`,
              agents.length + workflows.length + index,
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
        {allRuns.length > 0 && <div className={`${HEADING} px-2 pt-4 pb-1.5`}>Runs</div>}
        {runs.map((run, index) => [
          index === freshRuns.length && olderToggle('runs', olderRuns.length),
          historyRow(
            `run:${run.id}`,
            agents.length + workflows.length + chats.length + index,
            'Remove the run',
            run.endedAt === null ? null : () => removeRun(run.id),
            run.startedAt,
            index >= freshRuns.length,
            <>
              <StatusIcon status={shownRun(run)} />
              {runTitle(run.title)}
            </>
          )
        ])}
        {!olderOpen.runs && olderToggle('runs', olderRuns.length)}
      </div>
    </>
  )

  return (
    <>
      <PageLayout
        id="hub"
        islands="Agents"
        ownInspector={selectedWorkflow !== null}
        list={list}
        main={
          selectedWorkflow ? (
            // The canvas runs under the islands; the other views keep clear of the list
            <Suspense fallback={<div className="flex-1" />}>
              <WorkflowView key={selectedWorkflow.id} workflow={selectedWorkflow} />
            </Suspense>
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-(--island-left)">{selectedView}</div>
          )
        }
      />
      {editing && <AgentEditor agent={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => (hubSelection.set(`agent:${id}`), setEditing(null))} />}
    </>
  )
}
