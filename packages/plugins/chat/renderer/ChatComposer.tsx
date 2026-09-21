import { useEffect, useRef, useState } from 'react'
import type { ChatContent, ChatImage, ChatOption } from '@treeix/sdk'
import { useHost } from '@treeix/sdk'
import { Icon } from '@treeix/app/Icon'
import { errorMessage } from '@treeix/app/ui'
import { completion, formatTokens, IMAGE_TYPES, imageProblem, switchWarning } from './composer'
import { cancel, isBusy, send, setDraft, setOption, unqueue, useChat, whenIdle } from './store'

/** Worktree files for "@" completion, listed once per chat */
const fileLists = new Map<string, Promise<string[]>>()
const filesFor = (chatId: string, cwd: string): Promise<string[]> => {
  let files = fileLists.get(chatId)
  if (!files) {
    files = window.api.listFiles(cwd).then(
      (listing) => listing.files,
      () => []
    )
    fileLists.set(chatId, files)
  }
  return files
}

const readImage = (file: File): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ type: 'image', mimeType: file.type, data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

type PendingSwitch = { option: ChatOption; value: string; tokens: number | null }

const preview = (content: ChatContent[]): string =>
  content.map((item) => (item.type === 'text' ? item.text : '[image]')).join(' ')

export function Composer({ chatId, cwd }: { chatId: string; cwd: string }): React.JSX.Element {
  const host = useHost()
  const chat = useChat(chatId)
  const { feed, draft } = chat
  const busy = isBusy(chat)
  const [images, setImages] = useState<ChatImage[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [caret, setCaret] = useState(0)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void filesFor(chatId, cwd).then((list) => live && setFiles(list))
    return () => {
      live = false
    }
  }, [chatId, cwd])

  const suggestions = dismissed ? null : completion(draft, caret, feed.commands, files)
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
    const read = await Promise.all(valid.map(readImage))
    setImages((current) => [...current, ...read])
  }

  const submit = (): void => {
    const text = draft.trim()
    if (!text && images.length === 0) return
    send(chatId, [...images, ...(text ? [{ type: 'text' as const, text }] : [])])
    setDraft(chatId, '')
    setImages([])
    setProblem(null)
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

  const choose = (option: ChatOption, value: string): void => {
    const warning = option.category === 'model' ? switchWarning(feed.usage) : null
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
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.metaKey) {
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
    if (event.key === 'Enter' && (event.metaKey || !event.shiftKey)) {
      event.preventDefault()
      submit()
    }
  }

  const hint = busy
    ? 'Esc stops the agent'
    : fullness > 0.8 && hasCompact
      ? 'Context is 80% full: /compact summarizes'
      : 'Paste a screenshot to show the problem'

  return (
    <div className="shrink-0 px-4 pb-3">
      {chat.queue.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {chat.queue.map((content, index) => (
            <div key={index} className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-1 text-xs text-muted-foreground/70">
              <span className="min-w-0 flex-1 truncate">{preview(content)}</span>
              <button aria-label="Remove queued message" onClick={() => unqueue(chatId, index)} className="hover:text-foreground">
                <Icon name="close" className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingSwitch && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-400/5 px-3 py-2 text-xs ring-1 ring-amber-400/40">
          <span className="min-w-0 flex-1 text-foreground">
            Switching re-reads the whole chat without the cache
            {pendingSwitch.tokens !== null && <span className="text-muted-foreground">, about {formatTokens(pendingSwitch.tokens)} tokens</span>}
          </span>
          <button
            onClick={() => {
              setPendingSwitch(null)
              applyOption(pendingSwitch.option.id, pendingSwitch.value)
            }}
            className="h-6 rounded-md bg-primary px-2.5 font-medium text-white"
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
      <div
        className="relative rounded-lg bg-background ring-1 ring-border focus-within:ring-foreground/30"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          if (event.dataTransfer.files.length === 0) return
          event.preventDefault()
          void addImages(event.dataTransfer.files)
        }}
      >
        {suggestions && items.length > 0 && (
          <div className="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-md bg-popover py-1 text-xs shadow-lg ring-1 ring-border">
            {items.map((item, index) => (
              <button
                key={item.label}
                onMouseDown={(event) => {
                  event.preventDefault()
                  accept(index)
                }}
                className={`flex w-full items-baseline gap-3 px-3 py-1 text-left ${index === Math.min(selected, items.length - 1) ? 'bg-accent text-foreground' : 'text-foreground/85'}`}
              >
                <span className="shrink-0 font-mono">{item.label}</span>
                <span className="min-w-0 truncate text-muted-foreground">{item.detail}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {images.map((image, index) => (
              <div key={index} className="group relative">
                <img src={`data:${image.mimeType};base64,${image.data}`} alt="" className="h-12 rounded-md object-cover ring-1 ring-border" />
                <button
                  aria-label="Remove image"
                  onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
                  className="absolute -top-1.5 -right-1.5 hidden size-4 place-items-center rounded-full bg-foreground text-background group-hover:grid"
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
          placeholder="Message the agent"
          onChange={(event) => {
            setDraft(chatId, event.target.value)
            setCaret(event.target.selectionStart)
            setSelected(0)
            setDismissed(false)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            if (event.clipboardData.files.length === 0) return
            event.preventDefault()
            void addImages(event.clipboardData.files)
          }}
          className="block max-h-[calc(8lh+1rem)] w-full resize-none bg-transparent px-3 py-2 text-sm text-foreground outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2">
          {acceptsImages && (
            <>
              <button aria-label="Attach images" title="Attach images" onClick={() => picker.current?.click()} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <Icon name="paperclip" className="size-3.5" />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                accept={IMAGE_TYPES.join(',')}
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) void addImages(event.target.files)
                  event.target.value = ''
                }}
              />
            </>
          )}
          {feed.options.map((option) => (
            <select
              key={option.id}
              title={option.name}
              aria-label={option.name}
              value={option.currentValue}
              onChange={(event) => choose(option, event.target.value)}
              className="h-6 max-w-40 rounded-md bg-transparent px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {option.values.map((value) => (
                <option key={value.value} value={value.value} title={value.description ?? undefined}>
                  {value.name}
                </option>
              ))}
            </select>
          ))}
          <span className="flex-1" />
          {feed.usage && (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title="Context used">
              <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
                <span className={`block h-full ${fullness > 0.8 ? 'bg-amber-400' : 'bg-foreground/40'}`} style={{ width: `${Math.min(100, fullness * 100)}%` }} />
              </span>
              {formatTokens(feed.usage.used)} / {formatTokens(feed.usage.size)}
            </span>
          )}
          {busy ? (
            <button onClick={() => cancel(chatId)} className="h-6 rounded-md px-2.5 text-xs font-medium text-foreground ring-1 ring-border hover:bg-accent">
              Stop
            </button>
          ) : (
            <button onClick={submit} disabled={!draft.trim() && images.length === 0} className="h-6 rounded-md bg-primary px-2.5 text-xs font-medium text-white disabled:opacity-40">
              Send
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-muted-foreground">{problem ?? hint}</div>
    </div>
  )
}
