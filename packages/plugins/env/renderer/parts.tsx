import type { ReactNode } from 'react'
import { type IconName, useHost } from '@treeix/sdk'
import { CommentDraft } from '@treeix/app/Comments'
import { Icon } from '@treeix/app/Icon'
import type { ReviewComment } from '@treeix/shared/comments'
import { CLIENT_PREFIXES, type Kind } from '../shared/classify'

// Only exposed, secret and public get an icon; plain config stays plain
export const KIND: Record<Kind, { label: string; icon: IconName | null; text: string; note: string }> = {
  exposed: { label: 'Exposed', icon: 'alert', text: 'text-red-400', note: 'A secret behind a browser prefix: it ships in the client bundle.' },
  secret: { label: 'Secret', icon: 'lock', text: 'text-rose-300', note: 'Server only. Masked here, never pasted into agent comments.' },
  public: { label: 'Public', icon: 'globe', text: 'text-sky-300', note: 'Inlined into the browser bundle. Anyone can read it.' },
  config: { label: 'Config', icon: null, text: 'text-muted-foreground', note: 'Plain server config.' }
}

export function KindIcon({ kind, className = 'size-3' }: { kind: Kind; className?: string }): React.JSX.Element {
  const { icon, label, text } = KIND[kind]
  return icon ? (
    <span title={label} className={text}>
      <Icon name={icon} className={className} />
    </span>
  ) : (
    <span className={`${className} shrink-0`} />
  )
}

/** The name with a browser prefix tinted: sky when public, red when it exposes a secret */
export function VarName({ name, kind }: { name: string; kind: Kind }): React.JSX.Element {
  const prefix = (kind === 'public' || kind === 'exposed') && CLIENT_PREFIXES.find(([candidate]) => name.startsWith(candidate))?.[0]
  if (!prefix) return <>{name}</>
  return (
    <>
      <span className={kind === 'exposed' ? 'text-red-400' : 'text-sky-400'}>{prefix}</span>
      <span className={kind === 'exposed' ? 'text-red-200' : ''}>{name.slice(prefix.length)}</span>
    </>
  )
}

const PILL = { red: 'bg-red-400/12 text-red-400', amber: 'bg-amber-400/12 text-amber-400', sky: 'bg-sky-400/10 text-sky-400', plain: 'text-muted-foreground/70 ring-1 ring-border' }

export function Pill({ tone, title, children }: { tone: keyof typeof PILL; title?: string; children: ReactNode }): React.JSX.Element {
  return (
    <span title={title} className={`shrink-0 rounded px-1 text-[10.5px] leading-4 ${PILL[tone]}`}>
      {children}
    </span>
  )
}

/** A value edited in place: amber once it differs from the file, masked while secret and not revealed */
export function ValueInput({
  value,
  dirty,
  masked,
  placeholder,
  onChange
}: {
  value: string
  dirty: boolean
  masked: boolean
  placeholder?: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <input
      type={masked ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      className={`w-full rounded-[5px] px-1.5 py-0.5 font-mono text-[11.5px] text-foreground ring-1 outline-none placeholder:text-muted-foreground/60 focus:bg-primary/10 focus:ring-primary ${
        dirty ? 'bg-amber-400/5 ring-amber-400/50' : 'bg-transparent ring-transparent hover:ring-input'
      }`}
    />
  )
}

/** Small header button that stays highlighted while its mode is on */
export function ToggleButton({ label, on, onClick, children }: { label: string; on: boolean; onClick: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <button
      title={label}
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded-md px-1 ${on ? 'bg-foreground/8 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}
    >
      {children}
    </button>
  )
}

export const MASK = '••••••'

/** Agent comments queued on one variable, and the composer while `composing`; they carry file, line and name, never the value */
export function RowComments({
  worktreePath,
  file,
  line,
  name,
  secret,
  composing,
  prefill,
  onClose,
  indent = 'ml-[34px]'
}: {
  worktreePath: string
  file: string
  line: number
  name: string
  secret: boolean
  composing: boolean
  prefill: string
  onClose: () => void
  indent?: string
}): React.JSX.Element | null {
  const host = useHost()
  const queued = host.comments.filter((comment) => isAbout(comment, worktreePath, file, name))
  if (!queued.length && !composing) return null
  return (
    <div className={`mx-2 mb-1 flex flex-col gap-0.5 ${indent}`}>
      {queued.map((comment) => (
        <div key={comment.id} className="group/c flex h-7 items-center gap-2 rounded-md bg-primary/6 px-2.5 text-[12px] ring-1 ring-primary/15">
          <Icon name="comment" className="size-3 text-primary/80" />
          <span title={comment.text} className="min-w-0 flex-1 truncate text-foreground/85">
            {comment.text.slice(name.length + 2)}
          </span>
          <span className="shrink-0 text-[10.5px] text-muted-foreground">queued</span>
          <button title="Delete comment" onClick={() => host.deleteComment(comment)} className="text-muted-foreground opacity-0 group-hover/c:opacity-100 hover:text-foreground">
            <Icon name="close" className="size-3" />
          </button>
        </div>
      ))}
      {composing && (
        <CommentDraft
          label={`Note for the agent about ${name}: name and file only, no value${secret ? ' (secret)' : ''}`}
          placeholder={`What should change about ${name}`}
          allowAttachments={false}
          initialText={prefill}
          onCancel={onClose}
          onSave={(text) => {
            host.addComment({ id: crypto.randomUUID(), worktreePath, filePath: file, range: { start: line, end: line }, code: '', text: `${name}: ${text.trim()}`, kind: 'file' })
            onClose()
          }}
        />
      )}
    </div>
  )
}

/** Comments on a variable start with its name, which is also what tells the agent which line when the name is missing */
export const isAbout = (comment: ReviewComment, worktreePath: string, file: string, name: string): boolean =>
  comment.worktreePath === worktreePath && comment.filePath === file && comment.text.startsWith(`${name}: `)
