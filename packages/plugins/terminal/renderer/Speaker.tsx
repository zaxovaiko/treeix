import { useEffect } from 'react'
import { createStore, useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import type { HeardReply, HearMode } from '../shared/types'
import { sentenceAt } from './sentence'
import { focusSession, hearReply, type Session, transcriptRef } from './terminals'

type Hearing = { sessionId: string; title: string; reply: HeardReply | null; spoken: number; words: number }

/** The reply being read out; `reply` is null while it loads or is summarized */
const hearing = createStore<Hearing | null>(null)
/** Held here too: Chromium drops an utterance nothing references, and its end never fires */
let utterance: SpeechSynthesisUtterance | null = null

function stop(): void {
  const current = hearing.get()
  utterance = null
  speechSynthesis.cancel()
  hearing.set(null)
  // Back in the conversation, so dictation answers it
  if (current) focusSession(current.sessionId)
}

/** Reads the last reply of the session's agent aloud; called again while reading, stops */
export async function hearLastReply(session: Session | null, mode: HearMode, flash: (message: string) => void): Promise<void> {
  if (hearing.get()) return stop()
  const ref = transcriptRef(session ?? undefined)
  if (!session || !ref) return flash('No Claude or Codex conversation on screen')
  const loading: Hearing = { sessionId: session.id, title: session.title, reply: null, spoken: 0, words: 0 }
  hearing.set(loading)
  const reply = await hearReply(ref, mode)
  // Stopped meanwhile
  if (hearing.get() !== loading) return
  if (!reply?.text) {
    hearing.set(null)
    return flash('No reply in this conversation yet')
  }
  if (reply.error) flash("Couldn't summarize, reading it in full")
  const next = new SpeechSynthesisUtterance(reply.text)
  utterance = next
  let words = 0
  next.onboundary = (event) => {
    if (utterance === next && event.name === 'word') hearing.set({ ...loading, reply, spoken: event.charIndex + event.charLength, words: ++words })
  }
  next.onend = () => utterance === next && stop()
  hearing.set({ ...loading, reply })
  speechSynthesis.speak(next)
}

/** A ChatGPT-style orb: it turns while the reply loads and bounces with each spoken word */
function Orb({ words }: { words: number }): React.JSX.Element {
  return (
    <div className="voice-orb relative size-12 shrink-0">
      <div className="voice-orb-pulse absolute inset-0" style={{ scale: words === 0 ? 1 : words % 2 ? 1.1 : 0.94 }}>
        <div
          className="voice-orb-swirl absolute inset-0 rounded-full blur-[5px]"
          style={{ background: 'conic-gradient(from 0deg, var(--color-primary), #22d3ee, #a855f7, #f472b6, var(--color-primary))' }}
        />
        <div
          className="absolute inset-[3px] rounded-full"
          style={{ background: 'radial-gradient(circle at 35% 30%, rgb(255 255 255 / 0.9), rgb(255 255 255 / 0.15) 45%, transparent 70%)' }}
        />
      </div>
    </div>
  )
}

export function Speaker(): React.JSX.Element | null {
  const host = useHost()
  const current = hearing.useValue()
  const open = current !== null
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      stop()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  if (!current) return null
  const { reply, spoken, words, title } = current
  const { start, end } = reply ? sentenceAt(reply.text, spoken) : { start: 0, end: 0 }
  const sentence = reply?.text.slice(start, end).trimEnd() ?? ''
  const said = Math.max(0, Math.min(sentence.length, spoken - start))
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
      <div
        role="status"
        aria-label="Reading the reply aloud"
        className="pointer-events-auto flex w-[440px] items-center gap-4 rounded-2xl bg-popover py-3.5 pr-3 pl-4 shadow-2xl ring-1 ring-border"
      >
        <Orb words={words} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="truncate">{title}</span>
            <span className="shrink-0">· {!reply ? 'Summarizing…' : reply.summarized ? 'Summary' : 'Last reply'}</span>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug">
            {reply ? (
              <>
                {sentence.slice(0, said)}
                <span className="text-muted-foreground">{sentence.slice(said)}</span>
              </>
            ) : (
              <span className="text-muted-foreground">Reading the conversation</span>
            )}
          </p>
          <div className="mt-1 text-[11px] text-muted-foreground">Esc stops{host.isEnabled('dictation') ? ', then dictate to answer' : ''}</div>
        </div>
        <button
          title="Stop (Esc)"
          aria-label="Stop"
          onClick={stop}
          className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Icon name="close" className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
