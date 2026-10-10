import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Dialog, errorMessage } from '@treeix/app/ui'
import { asking, hubAgents, hubApi, hubSelection, hubWorkflows, TAB_ID } from './store'

/** Esc closes the dialog before anything behind it sees the key, once no dropdown in it is open */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // An open dropdown inside the dialog closes first
      if (event.target instanceof Element && event.target.closest('[data-popup]')) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])
}

function PromptForm({
  title,
  placeholder,
  optional = false,
  onSend,
  onClose
}: {
  title: string
  placeholder: string
  optional?: boolean
  onSend: (text: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEscape(onClose)
  const ready = (optional || message.trim() !== '') && !sending

  // Stays open until the run starts, so a failure keeps what was typed
  const send = (): void => {
    if (!ready) return
    setSending(true)
    setError(null)
    onSend(message).then(onClose, (reason: unknown) => {
      setSending(false)
      setError(errorMessage(reason))
    })
  }

  return (
    <Dialog onClose={onClose} offset="pt-[18vh]" className="flex w-[520px] max-w-[92vw] flex-col gap-2 p-3">
      <div className="text-sm font-medium">{title}</div>
      <textarea
        autoFocus
        rows={4}
        value={message}
        onChange={(event) => {
          setMessage(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          send()
        }}
        placeholder={placeholder}
        className="resize-none rounded-md bg-background px-2.5 py-2 text-sm ring-1 ring-border outline-none focus:ring-primary"
      />
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        {error ? <span className="mr-auto text-red-400 select-text">{error}</span> : <span className="mr-auto">↵ {optional ? 'run' : 'ask'} · ⇧↵ new line</span>}
        <button onClick={onClose} className="h-7 rounded-md px-3 text-foreground hover:bg-accent">
          Cancel
        </button>
        <button onClick={send} disabled={!ready} className="h-7 rounded-md bg-primary px-3 font-medium text-white disabled:bg-muted disabled:text-muted-foreground">
          {optional ? 'Run' : 'Ask'}
        </button>
      </div>
    </Dialog>
  )
}

/** Asks an agent or runs a workflow with what the user types */
export function AskDialog(): React.JSX.Element | null {
  const host = useHost()
  const request = asking.use()
  const agents = hubAgents.use()
  const workflows = hubWorkflows.use()
  if (!request) return null
  const close = (): void => asking.set(null)
  const follow = (started: Promise<string>): Promise<void> =>
    started.then((runId) => {
      if (!request.openRun) return
      hubSelection.set(`run:${runId}`)
      host.setActiveTab(TAB_ID)
    })

  const agent = agents.find((candidate) => request.target === `agent:${candidate.id}`)
  if (agent)
    return (
      <PromptForm
        key={request.target}
        title={`Ask ${agent.name}`}
        placeholder="A one-off question; the answer is kept under Runs"
        onSend={(text) => follow(hubApi.ask(agent.id, text))}
        onClose={close}
      />
    )
  const workflow = workflows.find((candidate) => request.target === `workflow:${candidate.id}`)
  if (workflow)
    return (
      <PromptForm
        key={request.target}
        optional
        title={`Run ${workflow.name}`}
        placeholder="The input, {{input}} in its steps"
        onSend={(text) => follow(hubApi.runWorkflow(workflow.id, text))}
        onClose={close}
      />
    )
  return null
}
