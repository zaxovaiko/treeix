import { useEffect, useState } from 'react'
import { useHost } from '@treeix/sdk'
import { Dialog, errorMessage } from '@treeix/app/ui'
import type { HubAgent } from '../shared/types'
import { asking, hubAgents, hubApi, hubSelection, TAB_ID } from './store'

/** Esc closes the dialog before anything behind it sees the key */
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [onClose])
}

function AskForm({ agent, onClose }: { agent: HubAgent; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const [message, setMessage] = useState('')
  useEscape(onClose)

  const send = (): void => {
    if (!message.trim()) return
    onClose()
    hubApi.ask(agent.id, message).then(
      (runId) => {
        hubSelection.set(`run:${runId}`)
        host.setActiveTab(TAB_ID)
      },
      (reason: unknown) => host.flash(errorMessage(reason))
    )
  }

  return (
    <Dialog onClose={onClose} offset="pt-[18vh]" className="flex w-[520px] max-w-[92vw] flex-col gap-2 p-3">
      <div className="text-sm font-medium">Ask {agent.name}</div>
      <textarea
        autoFocus
        rows={4}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
          event.preventDefault()
          send()
        }}
        placeholder="A one-off question; the answer is kept under Runs"
        className="resize-none rounded-md bg-background px-2.5 py-2 text-sm ring-1 ring-border outline-none focus:ring-primary"
      />
      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <span className="mr-auto">↵ ask · ⇧↵ new line</span>
        <button onClick={onClose} className="h-7 rounded-md px-3 text-foreground hover:bg-accent">
          Cancel
        </button>
        <button onClick={send} disabled={!message.trim()} className="h-7 rounded-md bg-primary px-3 font-medium text-white disabled:opacity-50">
          Ask
        </button>
      </div>
    </Dialog>
  )
}

export function AskDialog(): React.JSX.Element | null {
  const agentId = asking.use()
  const agent = hubAgents.use().find((candidate) => candidate.id === agentId)
  return agent ? <AskForm key={agent.id} agent={agent} onClose={() => asking.set(null)} /> : null
}
