import { useEffect, useState } from 'react'
import { focusZone, PageLayout, useHost, useListNav } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { timeAgo } from '@treeix/app/time'
import { EmptyState, errorMessage, IconButton } from '@treeix/app/ui'
import type { HubAgent } from '../shared/types'
import { AgentAvatar, AgentEditor } from './AgentEditor'
import { RunView, StatusIcon } from './RunView'
import { asking, hubAgents, hubApi, hubRuns, hubSelection, hubSettings, registryId, runtimeLabel } from './store'

const ROW = 'flex w-full min-w-0 items-center gap-2 rounded-md text-left hover:bg-accent'
const HEADING = 'text-[11px] font-semibold tracking-wide text-muted-foreground uppercase'

const chatIdOf = (agent: HubAgent): string => `hub:${agent.id}`

const setConversation = (agentId: string, sessionId: string | null): void => {
  const others = Object.fromEntries(Object.entries(hubSettings.get().conversations).filter(([id]) => id !== agentId))
  hubSettings.update({ conversations: sessionId ? { ...others, [agentId]: sessionId } : others })
}

/** The agent's header and its chat, which picks up the last conversation */
function AgentChat({ agent, onEdit, onDelete }: { agent: HubAgent; onEdit: () => void; onDelete: () => void }): React.JSX.Element {
  const host = useHost()
  const chat = host.service('chat')
  const registry = useAgents()
  const persona = registry.find((entry) => entry.id === registryId(agent))
  const chatId = chatIdOf(agent)

  const open = (resume: string | null): void => {
    if (!chat || !persona?.chat) return
    // The chat shows a failed start itself
    chat
      .start(chatId, { agent: persona.id, ...persona.chat, cwd: agent.folder ?? host.defaultCwd, resume })
      .then((sessionId) => setConversation(agent.id, sessionId), () => undefined)
  }
  const ready = persona !== undefined
  useEffect(() => {
    if (ready && chat?.agent(chatId) === null) open(hubSettings.get().conversations[agent.id] ?? null)
  }, [ready])

  const restart = (): void => {
    chat?.stop(chatId)
    chat?.forget(chatId)
    setConversation(agent.id, null)
    open(null)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border pr-1.5 pl-3">
        <AgentAvatar agent={agent} className="size-7 text-sm" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{[runtimeLabel(agent.runtime), agent.model, agent.mode].filter(Boolean).join(' · ')}</div>
        </div>
        <IconButton label={`Ask ${agent.name}`} onClick={() => asking.set(agent.id)}>
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
  const runs = hubRuns.use()
  const selection = hubSelection.use()
  const [editing, setEditing] = useState<HubAgent | 'new' | null>(null)
  const rows = [...agents.map((agent) => `agent:${agent.id}`), ...runs.map((run) => `run:${run.id}`)]
  const selectedRow = selection !== null && rows.includes(selection) ? selection : (rows[0] ?? null)
  const selectedAgent = agents.find((agent) => `agent:${agent.id}` === selectedRow) ?? null
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
    hubApi.remove(agent.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }

  const list = (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pr-1.5 pl-3">
        <span className={HEADING}>Agents</span>
        <span className="flex-1" />
        <IconButton label="New agent" onClick={() => setEditing('new')}>
          <Icon name="plus" className="size-3.5" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {agents.map((agent, index) => (
          <button
            key={agent.id}
            {...nav.rowProps(index)}
            onClick={() => hubSelection.set(`agent:${agent.id}`)}
            className={`${ROW} h-9 px-2 text-xs ${agent === selectedAgent ? 'bg-accent' : ''}`}
          >
            <AgentAvatar agent={agent} className="size-6 text-[11px]" />
            <span className="min-w-0 flex-1 truncate">{agent.name}</span>
          </button>
        ))}
        {runs.length > 0 && <div className={`${HEADING} px-2 pt-4 pb-1.5`}>Runs</div>}
        {runs.map((run, index) => (
          <button
            key={run.id}
            {...nav.rowProps(agents.length + index)}
            onClick={() => hubSelection.set(`run:${run.id}`)}
            className={`${ROW} h-8 px-2 text-xs ${run === selectedRun ? 'bg-accent' : ''}`}
          >
            <StatusIcon status={run.status} />
            <span className="min-w-0 flex-1 truncate">{run.title}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{timeAgo(new Date(run.startedAt).toISOString())}</span>
          </button>
        ))}
      </div>
    </>
  )

  return (
    <>
      <PageLayout
        id="hub"
        list={list}
        main={
          selectedRun ? (
            <RunView key={selectedRun.id} run={selectedRun} />
          ) : selectedAgent ? (
            <AgentChat key={selectedAgent.id} agent={selectedAgent} onEdit={() => setEditing(selectedAgent)} onDelete={() => remove(selectedAgent)} />
          ) : (
            <EmptyState fill icon="star" title="Your own agents: a name, a look and instructions on top of Claude, Codex or any chat agent">
              <button onClick={() => setEditing('new')} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
                Create an agent
              </button>
            </EmptyState>
          )
        }
      />
      {editing && <AgentEditor agent={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={(id) => (hubSelection.set(`agent:${id}`), setEditing(null))} />}
    </>
  )
}
