import { lazy, Suspense, useEffect } from 'react'
import { useHost } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { EmptyState, errorMessage, IconButton } from '@treeix/app/ui'
import type { HubAgent } from '../shared/types'
import { AgentAvatar, AgentEditor } from './AgentEditor'
import { RunView } from './RunView'
import { asking, chatIdOf, hubAgents, hubApi, hubEditing, hubRuns, hubSelection, hubSettings, hubWorkflows, registryId, runtimeLabel, setConversation, TAB_ID } from './store'

// The canvas library is big and only workflows need it
const WorkflowView = lazy(() => import('./WorkflowView').then((module) => ({ default: module.WorkflowView })))

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

/** The hub's page: whatever the sidebar picked, full width. The lists live in the sidebar's own sections */
export function HubPage(): React.JSX.Element {
  const host = useHost()
  const agents = hubAgents.use()
  const workflows = hubWorkflows.use()
  const { conversations, chats } = hubSettings.use()
  const selection = hubSelection.use()
  const runs = hubRuns.use()
  const chat = chats.find((entry) => `chat:${entry.sessionId}` === selection) ?? null
  const agent = agents.find((candidate) => `agent:${candidate.id}` === selection || candidate.id === chat?.agentId) ?? null
  const workflow = workflows.find((candidate) => `workflow:${candidate.id}` === selection) ?? null
  const run = runs.find((candidate) => `run:${candidate.id}` === selection) ?? null

  const remove = (target: HubAgent): void => {
    if (!window.confirm(`Delete ${target.name}?`)) return
    const service = host.service('chat')
    service?.stop(chatIdOf(target))
    service?.forget(chatIdOf(target))
    setConversation(target.id, null)
    hubSettings.update({ chats: hubSettings.get().chats.filter((entry) => entry.agentId !== target.id) })
    hubApi.remove(target.id).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {run ? (
        <RunView key={run.id} run={run} />
      ) : workflow ? (
        <Suspense fallback={<div className="flex-1" />}>
          <WorkflowView key={workflow.id} workflow={workflow} />
        </Suspense>
      ) : agent ? (
        <AgentChat
          key={agent.id}
          agent={agent}
          conversation={chat?.sessionId ?? conversations[agent.id] ?? null}
          onEdit={() => hubEditing.set(agent)}
          onDelete={() => remove(agent)}
        />
      ) : (
        <EmptyState fill icon="star" title="Your own agents: a name, a look and instructions on top of Claude, Codex or any chat agent">
          <button onClick={() => hubEditing.set('new')} className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white">
            Create an agent
          </button>
        </EmptyState>
      )}
    </div>
  )
}

/** The agent editor, mounted by the plugin's Root so the sidebar can open it with the page closed */
export function HubEditor(): React.JSX.Element | null {
  const host = useHost()
  const editing = hubEditing.use()
  if (!editing) return null
  return (
    <AgentEditor
      agent={editing === 'new' ? null : editing}
      onClose={() => hubEditing.set(null)}
      onSaved={(id) => {
        hubSelection.set(`agent:${id}`)
        hubEditing.set(null)
        host.setActiveTab(TAB_ID)
      }}
    />
  )
}
