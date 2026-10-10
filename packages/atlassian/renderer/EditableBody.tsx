import { useEffect, useRef, useState } from 'react'
import { Kbd } from '@treeix/sdk'
import { LazyMarkdown as Markdown } from '@treeix/app/LazyMarkdown'
import { Dialog, errorMessage } from '@treeix/app/ui'

type Draft = { original: string; text: string }

/**
 * Markdown that turns into a text box on double-click, with Save on top. Leaving the box with changes asks whether
 * to save them; clicking outside that question goes back to editing.
 */
export function EditableBody({
  markdown,
  label,
  empty,
  resolveImage,
  onSave
}: {
  markdown: string
  /** What is edited, e.g. "description" */
  label: string
  empty: string
  resolveImage: (src: string) => Promise<string> | null
  /** Resolves once saved and reloaded; `original` lets the save refuse a text changed meanwhile */
  onSave: (original: string, edited: string) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  // The saved text shows until the reload brings the stored one
  const [saved, setSaved] = useState<string | null>(null)
  useEffect(() => setSaved(null), [markdown])
  const box = useRef<HTMLTextAreaElement>(null)
  const bar = useRef<HTMLDivElement>(null)

  const close = (): void => {
    setDraft(null)
    setConfirming(false)
    setError(null)
  }
  const save = (): void => {
    if (!draft || saving) return
    if (draft.text === draft.original) return close()
    setSaving(true)
    setError(null)
    onSave(draft.original, draft.text)
      .then(
        () => {
          setSaved(draft.text)
          close()
        },
        (reason: unknown) => {
          setConfirming(false)
          setError(errorMessage(reason))
          box.current?.focus()
        }
      )
      .finally(() => setSaving(false))
  }
  const leave = (): void => {
    if (!draft || saving) return
    if (draft.text === draft.original) close()
    else setConfirming(true)
  }
  const keepEditing = (): void => {
    setConfirming(false)
    box.current?.focus()
  }

  if (!draft) {
    const shown = saved ?? markdown
    return (
      <div onDoubleClick={() => saved === null && setDraft({ original: markdown, text: markdown })} title={`Double-click to edit the ${label}`}>
        {shown ? <Markdown resolveImage={resolveImage}>{shown}</Markdown> : <p className="text-xs text-muted-foreground">{empty}</p>}
      </div>
    )
  }
  return (
    <div>
      <div ref={bar} className="sticky top-0 z-10 -mx-2 mb-2 flex items-center gap-2 border-b border-border bg-background px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">Editing the {label} as markdown; blocks you leave alone keep their formatting</span>
        <button onClick={close} disabled={saving} className="flex h-7 items-center rounded-md px-3 hover:bg-accent disabled:opacity-40">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 font-medium text-white disabled:bg-muted disabled:text-muted-foreground"
        >
          {saving ? 'Saving...' : 'Save'}
          <Kbd hint>⌘S</Kbd>
        </button>
      </div>
      {error && <p className="mb-2 text-xs break-words text-red-400 select-text">{error}</p>}
      <textarea
        ref={box}
        autoFocus
        value={draft.text}
        onChange={(event) => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'Enter')) {
            event.preventDefault()
            save()
          } else if (event.key === 'Escape') {
            event.stopPropagation()
            leave()
          }
        }}
        // Switching apps or pressing Save or Cancel is not leaving
        onBlur={(event) => !(event.relatedTarget instanceof Node && bar.current?.contains(event.relatedTarget)) && document.hasFocus() && leave()}
        className="field-sizing-content min-h-40 w-full resize-none rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-[13px] leading-5 outline-none focus:border-primary/60"
      />
      {confirming && (
        <Dialog
          onClose={keepEditing}
          offset="pt-[18vh]"
          className="w-[400px] max-w-[90vw] p-4"
          onKeyDown={(event) => {
            if (event.key === 'Escape') keepEditing()
          }}
        >
          <h2 className="text-sm font-medium">Save the {label}?</h2>
          <p className="mt-1 text-xs text-muted-foreground">Cancel drops your changes.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={close} className="h-7 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel
            </button>
            <button
              autoFocus
              onClick={save}
              disabled={saving}
              className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:bg-muted disabled:text-muted-foreground"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}
