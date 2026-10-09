import { useRef } from 'react'
import { definePluginSettings } from '@treeix/sdk'

/** The session whose name is being edited in place */
export const renaming = definePluginSettings('terminal-rename', () => ({ id: null as string | null }))
export const startRename = (id: string): void => renaming.update({ id })

/** Edits a name in place: ⏎ or leaving saves, esc cancels; `onDone` hands focus back */
export function NameInput({
  value,
  label,
  onSave,
  onDone
}: {
  value: string
  label: string
  onSave: (name: string) => void
  onDone: (input: HTMLInputElement) => void
}): React.JSX.Element {
  // Unmounting may blur the input after ⏎ or esc already finished
  const finished = useRef(false)
  const done = (name: string | null): void => {
    if (finished.current) return
    finished.current = true
    renaming.update({ id: null })
    if (name !== null) onSave(name)
  }
  return (
    <input
      autoFocus
      defaultValue={value}
      aria-label={label}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => done(event.currentTarget.value.trim())}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        const input = event.currentTarget
        done(event.key === 'Enter' ? input.value.trim() : null)
        onDone(input)
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="h-5 min-w-0 flex-1 rounded bg-foreground/10 px-1 text-xs text-foreground outline-none"
    />
  )
}
