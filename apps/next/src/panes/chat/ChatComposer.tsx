import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ChatAgent, ChatContent, ChatOption } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import { imageSrc } from './Blocks'
import { browsedFolder, completion, folderPath, formatTokens, imageProblem, switchWarning } from './composer'
import { ChatIcon } from './icons'
import { cancel, type ChatImage, type ChatState, errorText, filesFor, getChat, isBusy, listFolder, send, setDraft, setImages, setOption, unqueue } from './store'

const AGENT_LABEL: Record<ChatAgent, string> = { claude: 'Claude', codex: 'Codex' }

const readImage = (file: File): Promise<ChatImage> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ type: 'image', mimeType: file.type, data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

const preview = (content: ChatContent[]): string => content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join(' ')

const valueName = (option: ChatOption): string => option.values.find((value) => value.value === option.currentValue)?.name ?? option.currentValue

/** An agent option (model, mode, effort) as a native menu */
const OptionSelect = ({ option, onChoose }: { option: ChatOption; onChoose: (option: ChatOption, value: string) => void }) => (
  <label className="copt" title={option.name}>
    {valueName(option)}
    <Icon name="down" />
    <select value={option.currentValue} onChange={(e) => onChoose(option, e.target.value)} aria-label={option.name}>
      {option.values.map((value) => (
        <option key={value.value} value={value.value} title={value.description ?? undefined}>
          {value.name}
        </option>
      ))}
    </select>
  </label>
)

type PendingSwitch = { option: ChatOption; value: string; tokens: number | null }

export function Composer({ id, chat, cwd, home, focused, onSent }: { id: string; chat: ChatState; cwd: string; home: string; focused: boolean; onSent: () => void }) {
  const { feed, draft, images, info } = chat
  const busy = isBusy(chat)
  const [problem, setProblem] = useState<string | null>(null)
  const [files, setFiles] = useState<string[]>([])
  const [caret, setCaret] = useState(draft.length)
  const [selected, setSelected] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [listing, setListing] = useState<{ path: string; entries: string[] } | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let live = true
    void filesFor(cwd).then((list) => live && setFiles(list))
    return () => void (live = false)
  }, [cwd])

  useEffect(() => {
    if (focused) input.current?.focus()
  }, [focused])

  // Grows with the text up to eight lines; field-sizing is not in every WebKit yet
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft])

  // A mention like @../ lists that folder, read again as the mention moves into another
  const browsed = browsedFolder(draft, caret)
  const browsedPath = browsed === null ? null : folderPath(browsed, cwd, home)
  useEffect(() => {
    if (browsedPath === null) return
    let live = true
    void listFolder(browsedPath).then((entries) => live && setListing({ path: browsedPath, entries }))
    return () => void (live = false)
  }, [browsedPath])

  const entries = listing?.path === browsedPath ? listing.entries : []
  const suggestions = dismissed ? null : completion(draft, caret, feed.commands, files, entries)
  const items = suggestions?.items ?? []
  const acceptsImages = info?.capabilities.images !== false
  const starting = info?.status === 'starting'
  const empty = !draft.trim() && images.length === 0

  const addImages = async (list: FileList | File[]) => {
    const candidates = [...list].filter((file) => file.type.startsWith('image/'))
    if (candidates.length === 0) return
    if (!acceptsImages) return setProblem('This agent does not take images')
    setProblem(candidates.map(imageProblem).find((text) => text !== null) ?? null)
    try {
      const read = await Promise.all(candidates.filter((file) => imageProblem(file) === null).map(readImage))
      setImages(id, [...getChat(id).images, ...read])
    } catch (reason) {
      setProblem(`Could not read the image: ${errorText(reason)}`)
    }
  }

  const submit = () => {
    const text = draft.trim()
    if (starting || (!text && images.length === 0)) return
    send(id, [...images, ...(text ? [{ type: 'text' as const, text }] : [])])
    setDraft(id, '')
    setImages(id, [])
    setProblem(null)
    onSent()
  }

  const accept = (index: number) => {
    const item = items[index]
    if (!suggestions || !item) return
    setDraft(id, draft.slice(0, suggestions.start) + item.insert + draft.slice(caret))
    const at = suggestions.start + item.insert.length
    requestAnimationFrame(() => input.current?.setSelectionRange(at, at))
    setCaret(at)
    setSelected(0)
  }

  const choose = (option: ChatOption, value: string) => {
    const warning = option.category === 'model' ? switchWarning(feed.usage, feed.blocks.length === 0) : null
    if (warning) setPendingSwitch({ option, value, tokens: warning.tokens })
    else setOption(id, option, value)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setSelected((index) => (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        accept(Math.min(selected, items.length - 1))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const models = feed.options.filter((option) => option.category === 'model')
  const rest = feed.options.filter((option) => option.category !== 'model')
  const agent = info ? AGENT_LABEL[info.agent] : 'the agent'

  return (
    <div
      className="ccomp"
      onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        void addImages(e.dataTransfer.files)
      }}
    >
      {chat.queue.length > 0 && (
        <div className="cqueue">
          {chat.queue.map((content, index) => (
            <div key={index} className="cqi">
              <span className="dim">Queued</span>
              <span className="grow trunc">{preview(content) || 'Image'}</span>
              <button className="icon sm" aria-label="Remove queued message" onClick={() => unqueue(id, index)}>
                <Icon name="x" />
              </button>
            </div>
          ))}
        </div>
      )}
      {pendingSwitch && (
        <div className="cswitch">
          <span className="grow">
            Switching re-reads the whole chat without the cache
            {pendingSwitch.tokens !== null && <span className="dim">, about {formatTokens(pendingSwitch.tokens)} tokens</span>}
          </span>
          <button
            className="btn sm pri"
            onClick={() => {
              setPendingSwitch(null)
              setOption(id, pendingSwitch.option, pendingSwitch.value)
            }}
          >
            Switch
          </button>
          <button className="btn sm ghost" onClick={() => setPendingSwitch(null)}>
            Cancel
          </button>
        </div>
      )}
      <div className="cbox2" onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
        {suggestions && items.length > 0 && (
          <div className="ccompl" role="listbox">
            {items.map((item, index) => (
              <button
                key={item.label}
                role="option"
                aria-selected={index === Math.min(selected, items.length - 1)}
                className={index === Math.min(selected, items.length - 1) ? 'on' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(index)
                }}
              >
                <span className="mono">{item.label}</span>
                <span className="dim trunc">{item.detail}</span>
              </button>
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="cimgs">
            {images.map((image, index) => (
              <span key={index} className="cthumb">
                <img src={imageSrc(image)} alt="" />
                <button aria-label="Remove image" onClick={() => setImages(id, images.filter((_, at) => at !== index))}>
                  <Icon name="x" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          rows={1}
          value={draft}
          aria-expanded={items.length > 0}
          placeholder={busy ? 'Queue a message' : `Ask ${agent} anything`}
          onChange={(e) => {
            setDraft(id, e.target.value)
            setCaret(e.target.selectionStart)
            setSelected(0)
            setDismissed(false)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (![...e.clipboardData.files].some((file) => file.type.startsWith('image/'))) return
            e.preventDefault()
            void addImages(e.clipboardData.files)
          }}
        />
        <div className="crow2">
          <button className="icon sm" aria-label="Attach images" title="Attach images" onClick={() => picker.current?.click()}>
            <ChatIcon name="attach" />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addImages(e.target.files)
              e.target.value = ''
            }}
          />
          {models.map((option) => (
            <OptionSelect key={option.id} option={option} onChoose={choose} />
          ))}
          {rest.map((option) => (
            <OptionSelect key={option.id} option={option} onChoose={choose} />
          ))}
          <span className="grow" />
          {problem && <span className="dim trunc">{problem}</span>}
          {busy ? (
            <button className="icon sm pri" aria-label="Stop" title="Stop (Esc)" onClick={() => cancel(id)}>
              <ChatIcon name="stop" />
            </button>
          ) : (
            <button className="icon sm pri" aria-label="Send" title={starting ? 'Starting...' : 'Send'} disabled={starting || empty} onClick={submit}>
              <ChatIcon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
