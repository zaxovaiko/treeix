import { useEffect, useRef, useState } from 'react'
import { Icon } from '@treeix/app/Icon'
import { Popup } from '@treeix/app/ui'

export type PickerOption = { id: string; label: string; section: string; render: React.ReactNode }


/**
 * A button that opens a searchable list, styled like the app's filter dropdowns. Open state belongs to the caller
 * so a key can open it; closing hands focus to the button. `onQuery` loads more options for what is typed.
 */
export function Picker({
  trigger,
  title,
  options,
  current,
  placeholder,
  open,
  onOpenChange,
  onPick,
  onQuery,
  width = 'w-64',
  align = 'left'
}: {
  trigger: React.ReactNode
  title: string
  options: PickerOption[]
  current: string | null
  placeholder: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (id: string) => void
  onQuery?: (query: string) => void
  width?: string
  align?: 'left' | 'right'
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const needle = query.trim().toLowerCase()
  useEffect(() => {
    if (open) onQuery?.(query.trim())
  }, [open, query])
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    input.current?.focus()
  }, [open])
  const shown = options.filter((option) => option.label.toLowerCase().includes(needle))
  const sections = [...new Set(shown.map((option) => option.section))].map((section) => ({ section, options: shown.filter((option) => option.section === section) }))
  // Sections reorder options, so the keyboard walks them in the order they are drawn
  const ordered = sections.flatMap((section) => section.options)
  const close = (): void => {
    onOpenChange(false)
    requestAnimationFrame(() => button.current?.focus({ preventScroll: true }))
  }
  const pick = (id: string): void => {
    close()
    if (id !== current) onPick(id)
  }
  return (
    <div className="relative min-w-0">
      <button ref={button} title={title} onClick={() => (open ? close() : onOpenChange(true))} className="flex max-w-full min-w-0 items-center rounded-md">
        {trigger}
      </button>
      {open && (
        <Popup
          anchor={button}
          align={align === 'right' ? 'end' : 'start'}
          onDismiss={close}
          // Esc anywhere in the list closes it, and only it: the shell must not also move focus to another zone
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            close()
          }}
          className={`flex flex-col rounded-lg border border-input bg-popover p-1 ${width}`}
        >
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
              if (step && ordered.length) {
                event.preventDefault()
                setActive((active + step + ordered.length) % ordered.length)
              }
              if (event.key === 'Enter' && ordered[active]) pick(ordered[active].id)
            }}
            placeholder={placeholder}
            className="mb-1 h-7 w-full shrink-0 rounded-md bg-muted px-2 text-xs ring-1 ring-border outline-none placeholder:text-muted-foreground/70"
          />
          <div className="max-h-80 min-h-0 overflow-y-auto">
            {sections.length === 0 && <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No matches</p>}
            {sections.map(({ section, options: sectionOptions }, index) => (
              <div key={section}>
                {index > 0 && <hr className="my-1 border-border" />}
                {section && <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{section}</div>}
                {sectionOptions.map((option) => {
                  const position = ordered.indexOf(option)
                  return (
                    <button
                      key={option.id}
                      onClick={() => pick(option.id)}
                      onMouseMove={() => setActive(position)}
                      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs ${position === active ? 'bg-accent' : ''}`}
                    >
                      {option.render}
                      <span className="flex-1" />
                      {option.id === current && <Icon name="check" className="size-3.5 shrink-0 text-foreground" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </Popup>
      )}
    </div>
  )
}
