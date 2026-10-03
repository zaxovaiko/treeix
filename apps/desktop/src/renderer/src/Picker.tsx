import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { Popup } from './ui'

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
  align = 'left',
  stretch = false,
  note
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
  /** The button fills its container, as a form field does */
  stretch?: boolean
  /** A line above the options, e.g. while they load */
  note?: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const button = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  // Every word somewhere in the label, in any order: "lobby openora" finds openora's lobby branch
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  useEffect(() => {
    if (open) onQuery?.(query.trim())
  }, [open, query])
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    input.current?.focus()
  }, [open])
  const shown = options.filter((option) => words.every((word) => option.label.toLowerCase().includes(word)))
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
    <div className={`relative min-w-0 ${stretch ? 'w-full' : ''}`}>
      <button
        ref={button}
        title={title}
        onClick={() => (open ? close() : onOpenChange(true))}
        className={`group flex max-w-full min-w-0 items-center rounded-md ${stretch ? 'w-full' : ''}`}
      >
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
            {(sections.length === 0 || note) && <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{note ?? 'No matches'}</p>}
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

export type SelectOption = { value: string; label: string; hint?: string; section?: string }

/**
 * A form field that picks one value from a searchable list, the app's stand-in for a native select. With `custom`
 * a typed value no option has can be picked too.
 */
export function Select({
  value,
  options,
  onChange,
  title,
  placeholder = 'Choose…',
  custom = false,
  width = 'w-72',
  note,
  onOpen
}: {
  value: string | null
  options: SelectOption[]
  onChange: (value: string) => void
  title: string
  placeholder?: string
  custom?: boolean
  width?: string
  /** A line above the options, e.g. while they load */
  note?: string
  /** Lets the caller load options only once someone looks */
  onOpen?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const typed = query.trim()
  const listed: SelectOption[] = [
    ...options,
    ...(value !== null && !options.some((option) => option.value === value) ? [{ value, label: value }] : []),
    ...(custom && typed && typed !== value && !options.some((option) => option.value === typed) ? [{ value: typed, label: typed, hint: 'Use this', section: 'Typed' }] : [])
  ]
  const current = listed.find((option) => option.value === value)
  return (
    <Picker
      stretch
      title={title}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
      current={value}
      placeholder={custom ? 'Search or type a value…' : 'Search…'}
      note={note}
      width={width}
      onPick={onChange}
      onQuery={custom ? setQuery : undefined}
      options={listed.map((option) => ({
        id: option.value,
        label: `${option.label} ${option.hint ?? ''} ${option.value}`,
        section: option.section ?? '',
        render: (
          <>
            <span className="truncate">{option.label}</span>
            {option.hint && <span className="ml-auto shrink-0 pl-3 text-muted-foreground">{option.hint}</span>}
          </>
        )
      }))}
      trigger={
        <span
          className={`flex h-8 w-full min-w-0 items-center gap-2 rounded-md border bg-muted px-2.5 text-left text-[13px] group-focus:border-foreground/22 ${open ? 'border-foreground/22' : 'border-input'}`}
        >
          <span className={`min-w-0 flex-1 truncate ${current ? 'text-foreground' : 'text-muted-foreground/60'}`}>{current?.label ?? placeholder}</span>
          {current?.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{current.hint}</span>}
          <Icon name="chevron" className="size-3 shrink-0 rotate-90 text-muted-foreground" />
        </span>
      }
    />
  )
}
