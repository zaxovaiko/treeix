import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ChatContent, ChatImage, ChatOption } from '@treeix/sdk'
import { useHost } from '@treeix/sdk'
import { useAgents } from '@treeix/app/agents'
import { Icon } from '@treeix/app/Icon'
import { updateSettings } from '@treeix/app/settings'
import { errorMessage, Popup } from '@treeix/app/ui'
import { ImageThumb } from './Blocks'
import type { Feed } from './feed'
import { builtinOf, completion, shellCommandOf, formatTokens, imageProblem, switchWarning, withBuiltins, withMentions } from './composer'
import { cancel, clear, filesFor, getChat, hasConversation, isBusy, runShell, send, setDraft, setImages, setOption, switchAgent, unqueue, useChat, whenIdle } from './store'
import { primaryKey } from '@treeix/shared/shortcut'

const readImage = (file: File): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ type: 'image', mimeType: file.type, data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** Values that read as nothing on their own, so the button names the option too: "Fast mode: Off" */
const BARE_VALUE = /^(on|off|default|none|auto)$/i

type PendingSwitch = { option: ChatOption; value: string; tokens: number | null }

/** What a picker's button says for an option: its value, with the option's name when the value is bare */
const valueName = (option: ChatOption): string => option.values.find((value) => value.value === option.currentValue)?.name ?? option.currentValue

const optionLabel = (option: ChatOption): string => {
  const shown = valueName(option)
  return BARE_VALUE.test(shown) ? `${option.name}: ${shown}` : shown
}

/** Session options (mode, model) behind one button opening the app's menu, a section each; j/k or arrows move, ⏎ picks, esc closes */
function OptionPicker({
  options,
  label,
  title,
  onChoose
}: {
  options: ChatOption[]
  label: React.ReactNode
  title: string
  onChoose: (option: ChatOption, value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const close = (): void => {
    setOpen(false)
    anchor.current?.querySelector('button')?.focus()
  }
  useEffect(() => {
    if (open) (menu.current?.querySelector<HTMLElement>('[data-current]') ?? menu.current?.querySelector('button'))?.focus()
  }, [open])
  const onKey = (event: React.KeyboardEvent): void => {
    event.stopPropagation()
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const at = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1
    const step = event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0
    if (step) {
      event.preventDefault()
      items[(at + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }
  return (
    <div ref={anchor} className="flex min-w-0">
      <button
        title={title}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex h-7 max-w-40 min-w-0 items-center gap-1 rounded-full px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {label}
        <Icon name="chevron" className="size-3 shrink-0 rotate-90 text-muted-foreground/65" />
      </button>
      {open && (
        <Popup
          ref={menu}
          anchor={anchor}
          onDismiss={close}
          onKeyDown={onKey}
          className="max-h-96 w-64 overflow-y-auto rounded-lg border border-input bg-popover p-1 text-foreground"
        >
          {options.map((option, index) => (
            <div key={option.id}>
              {index > 0 && <hr className="my-1 border-border" />}
              <div className="px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">{option.name}</div>
              {option.values.map((value) => (
                <button
                  key={value.value}
                  data-current={options.length === 1 && value.value === option.currentValue ? '' : undefined}
                  title={value.description ?? undefined}
                  onClick={() => {
                    close()
                    if (value.value !== option.currentValue) onChoose(option, value.value)
                  }}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs hover:bg-accent focus:bg-accent focus:outline-none"
                >
                  <Icon name="check" className={`size-3 shrink-0 ${value.value === option.currentValue ? '' : 'opacity-0'}`} />
                  <span className="truncate">{value.name}</span>
                </button>
              ))}
            </div>
          ))}
        </Popup>
      )}
    </div>
  )
}

/** One option on its own button, named by its value */
const SinglePicker = ({ option, onChoose }: { option: ChatOption; onChoose: (option: ChatOption, value: string) => void }): React.JSX.Element => (
  <OptionPicker options={[option]} label={<span className="truncate">{optionLabel(option)}</span>} title={option.name} onChoose={onChoose} />
)

/** The chat's agent; picking another starts the chat over with it, so only a chat without a conversation offers it, and a locked one shows nothing */
function AgentPicker({ chatId }: { chatId: string }): React.JSX.Element | null {
  const host = useHost()
  const chat = useChat(chatId)
  const allAgents = useAgents()
  const agents = allAgents.filter((agent) => agent.chat)
  const current = chat.options?.agent
  if (!current) return null
  // A plugin's agent, like an AI Hub persona, is the point of its chat
  if (hasConversation(chat) || agents.length < 2 || allAgents.find((agent) => agent.id === current)?.plugin) return null
  const option: ChatOption = {
    id: 'agent',
    name: 'Agent',
    category: 'other',
    currentValue: current,
    values: agents.map((agent) => ({ value: agent.id, name: agent.label, description: agent.chat?.command ?? null }))
  }
  const pick = (id: string): void => {
    const agent = agents.find((candidate) => candidate.id === id)
    if (!agent) return
    updateSettings({ chatAgent: id })
    switchAgent(chatId, agent).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }
  return <SinglePicker option={option} onChoose={(_, id) => pick(id)} />
}

function UsageRow({ label, tokens, total }: { label: string; tokens: number; total?: number }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">
        {formatTokens(tokens)}
        {total ? <span className="text-muted-foreground"> ({Math.round((tokens / total) * 100)}%)</span> : null}
      </span>
    </div>
  )
}

/** The context bar; clicking it splits the last turn's tokens into cached, new and generated */
function ContextMeter({ usage, turn, running }: { usage: NonNullable<Feed['usage']>; turn: Feed['turnUsage']; running: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const fullness = usage.size > 0 ? usage.used / usage.size : 0
  const prompt = turn ? turn.input + turn.cacheRead + turn.cacheWrite : 0
  return (
    <>
      <button
        ref={anchor}
        title="Context used"
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
          <span className={`block h-full ${fullness > 0.8 ? 'bg-amber-400' : 'bg-foreground/40'}`} style={{ width: `${Math.min(100, fullness * 100)}%` }} />
        </span>
        {formatTokens(usage.used)} / {formatTokens(usage.size)}
      </button>
      {open && (
        <Popup
          anchor={anchor}
          align="end"
          onDismiss={() => setOpen(false)}
          className="flex w-60 flex-col gap-1 rounded-lg border border-input bg-popover p-3 text-xs text-foreground"
        >
          <UsageRow label="Context" tokens={usage.used} total={usage.size} />
          {usage.cost && (
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-muted-foreground">Session cost</span>
              <span className="tabular-nums">{usage.cost.amount.toLocaleString(undefined, { style: 'currency', currency: usage.cost.currency })}</span>
            </div>
          )}
          <div className="mt-1.5 border-t border-border pt-1.5 font-medium">Last turn</div>
          {turn ? (
            <>
              <UsageRow label="Cache read" tokens={turn.cacheRead} total={prompt} />
              <UsageRow label="Cache write" tokens={turn.cacheWrite} total={prompt} />
              <UsageRow label="New input" tokens={turn.input} total={prompt} />
              <UsageRow label="Output" tokens={turn.output} />
              {turn.thought > 0 && <UsageRow label="Thinking" tokens={turn.thought} />}
            </>
          ) : (
            // Agents report a turn's tokens when it ends, so the first one has nothing to show yet
            <span className="text-muted-foreground">{running ? 'Counted when this turn ends' : "This agent doesn't report a turn's tokens"}</span>
          )}
        </Popup>
      )}
    </>
  )
}

const preview = (content: ChatContent[]): string => content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join(' ')

export function Composer({ chatId, cwd, onSent, tools }: { chatId: string; cwd: string; onSent: () => void; tools?: React.ReactNode }): React.JSX.Element {
  const host = useHost()
  const chat = useChat(chatId)
  const agents = useAgents()
  const { feed, draft, images } = chat
  const busy = isBusy(chat)
  const [problem, setProblem] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void filesFor(chatId, cwd).then((list) => live && setFiles(list))
    return () => {
      live = false
    }
  }, [chatId, cwd])

  const suggestions = dismissed ? null : completion(draft, caret, withBuiltins(feed.commands), files)
  const items = suggestions?.items ?? []
  const acceptsImages = chat.capabilities?.images === true
  const hasCompact = feed.commands.some((command) => command.name === 'compact')
  const fullness = feed.usage && feed.usage.size > 0 ? feed.usage.used / feed.usage.size : 0

  const addImages = async (list: FileList | File[]): Promise<void> => {
    const candidates = [...list].filter((file) => file.type.startsWith('image/'))
    if (candidates.length === 0) return
    if (!acceptsImages) return setProblem('This agent does not take images')
    const firstProblem = candidates.map(imageProblem).find((text) => text !== null)
    setProblem(firstProblem ?? null)
    const valid = candidates.filter((file) => imageProblem(file) === null)
    try {
      const read = await Promise.all(valid.map(readImage))
      setImages(chatId, [...getChat(chatId).images, ...read])
    } catch (reason) {
      setProblem(`Could not read the image: ${errorMessage(reason)}`)
    }
  }

  // Images the agent takes are attached; any other file goes in as an @ mention of its path, relative to the chat's folder when inside it
  const attachFiles = (list: FileList): void => {
    const all = [...list]
    const attached = acceptsImages ? all.filter((file) => file.type.startsWith('image/')) : []
    if (attached.length) void addImages(attached)
    const paths = all
      .filter((file) => !attached.includes(file))
      .map((file) => window.api.pathForFile(file))
      .filter(Boolean)
    if (paths.length) setDraft(chatId, withMentions(draft, paths, cwd))
    input.current?.focus()
  }
  const dropFiles = useEffectEvent(attachFiles)

  // Files drop anywhere in the page around the composer that marks itself data-drop-zone, else on the composer
  useEffect(() => {
    const zone = box.current?.closest<HTMLElement>('[data-drop-zone]') ?? box.current
    if (!zone) return
    let depth = 0
    const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') === true
    const over = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault()
    }
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (event: DragEvent): void => {
      depth = 0
      setDragging(false)
      if (!event.dataTransfer?.files.length) return
      event.preventDefault()
      dropFiles(event.dataTransfer.files)
    }
    zone.addEventListener('dragover', over)
    zone.addEventListener('dragenter', enter)
    zone.addEventListener('dragleave', leave)
    zone.addEventListener('drop', drop)
    return () => {
      zone.removeEventListener('dragover', over)
      zone.removeEventListener('dragenter', enter)
      zone.removeEventListener('dragleave', leave)
      zone.removeEventListener('drop', drop)
    }
  }, [])

  const submit = (): void => {
    const text = draft.trim()
    // A chat that lost its agent reconnects on send; one still connecting waits
    if ((!chat.connected && !chat.error) || (!text && images.length === 0)) return
    if (builtinOf(text, feed.commands) === 'clear') {
      setDraft(chatId, '')
      clear(chatId).catch((reason: unknown) => host.flash(errorMessage(reason)))
      return
    }
    const command = shellCommandOf(text)
    if (command && chat.connected) {
      setDraft(chatId, '')
      runShell(chatId, command).catch((reason: unknown) => host.flash(errorMessage(reason)))
      onSent()
      return
    }
    send(chatId, [...images, ...(text ? [{ type: 'text' as const, text }] : [])])
    setDraft(chatId, '')
    setImages(chatId, [])
    setProblem(null)
    onSent()
  }

  const accept = (index: number): void => {
    const item = items[index]
    if (!suggestions || !item) return
    const next = draft.slice(0, suggestions.start) + item.insert + draft.slice(caret)
    setDraft(chatId, next)
    const at = suggestions.start + item.insert.length
    requestAnimationFrame(() => input.current?.setSelectionRange(at, at))
    setCaret(at)
  }

  const applyOption = (id: string, value: string): void => {
    setOption(chatId, id, value).catch((reason: unknown) => host.flash(errorMessage(reason)))
  }

  // The model keeps its own button; mode, effort and the rest share one, which shows the mode
  const models = feed.options.filter((option) => option.category === 'model')
  const rest = feed.options.filter((option) => option.category !== 'model')
  const mode = rest.find((option) => option.category === 'mode')

  const choose = (option: ChatOption, value: string): void => {
    const warning = option.category === 'model' ? switchWarning(feed.usage, feed.blocks.length === 0) : null
    if (warning) setPendingSwitch({ option, value, tokens: warning.tokens })
    else applyOption(option.id, value)
  }

  const summarizeThenSwitch = async (pending: PendingSwitch): Promise<void> => {
    setPendingSwitch(null)
    send(chatId, [{ type: 'text', text: '/compact' }])
    await whenIdle(chatId)
    applyOption(pending.option.id, pending.value)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((index) => (index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !primaryKey(event)) {
        event.preventDefault()
        accept(Math.min(selected, items.length - 1))
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && (primaryKey(event) || !event.shiftKey)) {
      event.preventDefault()
      submit()
    }
  }

  // Only something worth reading; the composer stays quiet otherwise
  const hint = busy ? 'Esc stops the agent' : fullness > 0.8 && hasCompact ? 'Context is 80% full: /compact summarizes' : null

  return (
    <div className="shrink-0 px-4 pb-6">
      {chat.queue.length > 0 && (
        // Opaque down to the box, so the messages beneath show through none of the gaps
        <div className="-mx-2 flex flex-col gap-1 bg-background px-2 pb-2">
          {chat.queue.map((content, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md bg-popover px-3 py-1 text-xs text-muted-foreground/70 shadow-[inset_0_0_0_1px_var(--color-input)]">
              {content.map((item, at) => item.type === 'image' && <ImageThumb key={at} image={item} className="size-5" />)}
              <span className="min-w-0 flex-1 truncate">{preview(content)}</span>
              <button aria-label="Remove queued message" onClick={() => unqueue(chatId, index)} className="hover:text-foreground">
                <Icon name="close" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingSwitch && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-2xl bg-popover py-2 pr-2 pl-4 text-xs ring-1 ring-amber-400/40">
          <span className="min-w-0 flex-1 text-foreground">
            Switching re-reads the whole chat without the cache
            {pendingSwitch.tokens !== null && <span className="text-muted-foreground">, about {formatTokens(pendingSwitch.tokens)} tokens</span>}
          </span>
          <button
            onClick={() => {
              setPendingSwitch(null)
              applyOption(pendingSwitch.option.id, pendingSwitch.value)
            }}
            className="h-6 rounded-md bg-primary px-2.5 font-medium text-primary-foreground"
          >
            Switch
          </button>
          {hasCompact && (
            <button onClick={() => void summarizeThenSwitch(pendingSwitch)} className="h-6 rounded-md px-2.5 ring-1 ring-border hover:bg-accent">
              Summarize first
            </button>
          )}
          <button onClick={() => setPendingSwitch(null)} className="h-6 rounded-md px-2.5 text-muted-foreground hover:text-foreground">
            Cancel
          </button>
        </div>
      )}
      <div ref={box} className={`relative rounded-3xl bg-popover ${dragging ? 'shadow-[inset_0_0_0_2px_var(--color-primary)]' : 'shadow-[inset_0_0_0_1px_var(--color-input)]'}`}>
        {suggestions && items.length > 0 && (
          <div className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-lg bg-popover p-1 text-xs ring-1 ring-border">
            {items.map((item, index) => (
              <button
                key={item.label}
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(index)
                }}
                className={`flex w-full items-baseline gap-3 rounded-md px-2 py-1 text-left ${index === Math.min(selected, items.length - 1) ? 'bg-accent text-foreground' : 'text-foreground/85'}`}
              >
                <span className="shrink-0 font-mono">{item.label}</span>
                <span className="min-w-0 truncate text-muted-foreground">{item.detail}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pt-3">
            {images.map((image, index) => (
              <div key={index} className="group relative">
                <ImageThumb image={image} className="h-12" />
                <button
                  aria-label="Remove image"
                  onClick={() =>
                    setImages(
                      chatId,
                      images.filter((_, at) => at !== index)
                    )
                  }
                  className="absolute -top-1.5 -right-1.5 hidden size-4 place-items-center rounded-full bg-foreground text-on-foreground group-hover:grid"
                >
                  <Icon name="close" className="size-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          autoFocus
          rows={1}
          value={draft}
          placeholder={
            dragging
              ? 'Drop to attach'
              : chat.options?.agent
                ? `Message ${agents.find((agent) => agent.id === chat.options?.agent)?.label ?? chat.options.agent}`
                : 'Message the agent'
          }
          onChange={(event) => {
            setDraft(chatId, event.target.value)
            setCaret(event.target.selectionStart)
            setSelected(0)
            setDismissed(false)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (![...event.clipboardData.files].some((file) => file.type.startsWith('image/'))) return
            event.preventDefault()
            void addImages(event.clipboardData.files)
          }}
          className="block max-h-[calc(8lh+1.5rem)] w-full resize-none bg-transparent px-4 pt-3 pb-1.5 text-sm text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <button
            aria-label="Attach files"
            title="Attach files"
            onClick={() => picker.current?.click()}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground/6 text-muted-foreground hover:text-foreground"
          >
            <Icon name="plus" />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              if (event.target.files) attachFiles(event.target.files)
              event.target.value = ''
            }}
          />

          {tools}
          <AgentPicker chatId={chatId} />
          {models.map((option) => (
            <SinglePicker key={option.id} option={option} onChoose={choose} />
          ))}
          {rest.length > 0 && (
            <OptionPicker
              options={rest}
              title={rest.map((option) => `${option.name}: ${valueName(option)}`).join('\n')}
              label={
                <>
                  <Icon name="settings" className="size-3 shrink-0" />
                  {mode && <span className="truncate">{optionLabel(mode)}</span>}
                </>
              }
              onChoose={choose}
            />
          )}
          <span className="flex-1" />
          {feed.usage && <ContextMeter usage={feed.usage} turn={feed.turnUsage} running={feed.running} />}
          {busy ? (
            <button onClick={() => cancel(chatId)} aria-label="Stop" title="Stop" className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-on-foreground">
              <span className="size-2.5 rounded-[2px] bg-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={(!chat.connected && !chat.error) || (!draft.trim() && images.length === 0)}
              aria-label="Send"
              title={chat.connected || chat.error ? 'Send' : 'Connecting…'}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-on-foreground disabled:bg-foreground/10 disabled:text-muted-foreground"
            >
              <Icon name="arrowUp" />
            </button>
          )}
        </div>
      </div>
      {(problem ?? hint) && <div className="mt-1.5 w-fit rounded-full bg-background/90 px-3 py-0.5 text-[11px] text-muted-foreground backdrop-blur">{problem ?? hint}</div>}
    </div>
  )
}
