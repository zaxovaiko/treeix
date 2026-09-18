import { useEffect, useState } from 'react'
import { Icon } from '@treeix/app/Icon'

export type PickerOption = { id: string; label: string; section: string; render: React.ReactNode }

/**
 * A button that opens a searchable list, styled like the app's filter dropdowns. `onQuery` lets the caller
 * load more options for what is typed, e.g. people from Jira.
 */
export function Picker({
  trigger,
  options,
  current,
  placeholder,
  onPick,
  onQuery,
  width = 'w-64'
}: {
  trigger: (open: boolean) => React.ReactNode
  options: PickerOption[]
  current: string | null
  placeholder: string
  onPick: (id: string) => void
  onQuery?: (query: string) => void
  width?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  useEffect(() => {
    if (open) onQuery?.(query.trim())
  }, [open, query])
  const shown = options.filter((option) => option.label.toLowerCase().includes(needle))
  const sections = [...new Set(shown.map((option) => option.section))].map((section) => ({ section, options: shown.filter((option) => option.section === section) }))
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }
  const pick = (id: string): void => {
    close()
    if (id !== current) onPick(id)
  }
  return (
    <div className="relative">
      <button onClick={() => (open ? close() : setOpen(true))} className="flex items-center">
        {trigger(open)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} />
          <div className={`absolute top-full left-0 z-40 mt-1 rounded-lg border border-input bg-popover p-1 ${width}`}>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close()
                if (event.key === 'Enter' && shown[0]) pick(shown[0].id)
              }}
              placeholder={placeholder}
              className="mb-1 h-7 w-full rounded-md bg-muted px-2 text-xs ring-1 ring-border outline-none placeholder:text-muted-foreground/70 focus:ring-primary/60"
            />
            <div className="max-h-80 overflow-y-auto">
              {sections.length === 0 && <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">No matches</p>}
              {sections.map(({ section, options: sectionOptions }, index) => (
                <div key={section}>
                  {index > 0 && <hr className="my-1 border-border" />}
                  {section && <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{section}</div>}
                  {sectionOptions.map((option) => (
                    <button key={option.id} onClick={() => pick(option.id)} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent">
                      {option.render}
                      <span className="flex-1" />
                      {option.id === current && <Icon name="check" className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
