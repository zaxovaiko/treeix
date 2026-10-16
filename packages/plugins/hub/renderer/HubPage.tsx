import { lazy, Suspense, useEffect } from 'react'
import { useHost, PANE_HEADER } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { EmptyState, IconButton, ResizeHandle, usePersisted } from '@treeix/app/ui'
import type { HubAgent } from '../shared/types'
import { AgentAvatar, AgentEditor } from './AgentEditor'
import { Board } from './Board'
import { RunView } from './RunView'
import { EvalView } from './EvalView'
import { AgentsSection, EvalsSection, HistorySection, NewAgentButton, NewSuiteButton, NewWorkflowButton, WorkflowsSection } from './Sections'
import {
  asking,
  chatIdOf,
  deleteAgent,
  hubAgents,
  hubEditing,
  hubRuns,
  hubSelection,
  hubSettings,
  hubSuites,
  hubWorkflows,
  registryId,
  runtimeLabel,
  setConversation,
  TAB_ID
} from './store'

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
    const options = {
      agent: persona.id,
      ...persona.chat,
      cwd: agent.folder ?? host.defaultCwd,
      resume
    }
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
      <header className={`${PANE_HEADER} gap-2.5 pr-1.5 pl-3`}>
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

/** The tab's own column: the board, agents and workflows, with history at the bottom */
function Rail({ selection }: { selection: string | null }): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = usePersisted<boolean>('hub.historyOpen', false)
  const [width, setWidth] = usePersisted<number>('hub.rail.width', 240)
  const group = (id: string, label: React.ReactNode, actions: React.ReactNode, list: React.ReactNode): React.JSX.Element => (
    <section data-rail={id} className="flex flex-col gap-0.5">
      <h3 className="flex h-7 items-center justify-between pr-0.5 pl-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
        {actions}
      </h3>
      {list}
    </section>
  )
  return (
    <div className="relative flex shrink-0" style={{ width }}>
      <nav className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto border-r border-border p-2">
        <button
          onClick={() => hubSelection.set(null)}
          className={`flex h-8 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent ${selection === null ? 'bg-accent' : ''}`}
        >
          <Icon name="layers" className="size-3.5 text-muted-foreground" />
          Board
        </button>
        {group('agents', 'Agents', <NewAgentButton />, <AgentsSection />)}
        {group('workflows', 'Workflows', <NewWorkflowButton />, <WorkflowsSection />)}
        {group('evals', 'Evals', <NewSuiteButton />, <EvalsSection />)}
        <div className="mt-auto">
          {group(
            'history',
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              aria-expanded={historyOpen}
              className="flex h-full flex-1 items-center gap-1 text-left uppercase hover:text-foreground"
            >
              History
              <Icon name="chevron" className={`size-3 ${historyOpen ? 'rotate-90' : ''}`} />
            </button>,
            null,
            historyOpen && <HistorySection />
          )}
        </div>
      </nav>
      <ResizeHandle edge="right" onResize={setWidth} />
    </div>
  )
}

/** The Agents tab: its column of lists, and the board or whatever the column picked */
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
  const suite = hubSuites.use().find((candidate) => `eval:${candidate.id}` === selection) ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <Rail selection={run || workflow || agent || suite ? selection : null} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {run ? (
          <RunView key={run.id} run={run} />
        ) : suite ? (
          <EvalView key={suite.id} suite={suite} />
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
            onDelete={() => deleteAgent(host, agent)}
          />
        ) : (
          <Board />
        )}
      </div>
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
