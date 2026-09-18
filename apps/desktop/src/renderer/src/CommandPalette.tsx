import { useEffect, useRef, useState } from 'react'
import { FileIcon, Icon, type IconName } from './Icon'
import { EmptyState } from './ui'


export type Command = {
  id: string
  /** Actions come first, Worktrees and Files last, plugin groups in between */
  group: string
  label: string
  detail?: string
  shortcut?: string
  icon?: IconName
  filePath?: string
  run: () => void
}

const GROUP_LIMITS: Record<string, number> = { Actions: 20, Worktrees: 30, Files: 50 }
const PLUGIN_GROUP_LIMIT = 6

const matches = (command: Command, terms: string[]): boolean => {
  const haystack = `${command.label} ${command.detail ?? ''}`.toLowerCase()
  return terms.every((term) => haystack.includes(term))
}

export function CommandPalette({
  commands,
  onClose,
  placeholder,
  browseFiles = false
}: {
  commands: Command[]
  onClose: () => void
  placeholder?: string
  /** List files before anything is typed, for short lists like a pull request's changed files */
  browseFiles?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // A pasted path like ./src/a.ts still matches src/a.ts
  const terms = query.trim().replace(/^\.\//, '').toLowerCase().split(/\s+/).filter(Boolean)
  const pluginGroups = [...new Set(commands.map((command) => command.group))].filter((group) => !(group in GROUP_LIMITS))
  const results = ['Actions', ...pluginGroups, 'Worktrees', 'Files'].flatMap((group) =>
    commands
      // Files only show once you type, the full list is too long to browse
      .filter((command) => command.group === group && (group !== 'Files' || browseFiles || terms.length > 0) && matches(command, terms))
      .slice(0, GROUP_LIMITS[group] ?? PLUGIN_GROUP_LIMIT)
  )

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const run = (command: Command | undefined): void => {
    if (!command) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') setActive((active + 1) % Math.max(results.length, 1))
    else if (event.key === 'ArrowUp') setActive((active - 1 + results.length) % Math.max(results.length, 1))
    else if (event.key === 'Enter') run(results[active])
    else if (event.key === 'Escape') onClose()
    else return
    event.preventDefault()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 backdrop-blur-[2px] pt-[12vh]" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[60vh] w-[600px] max-w-[90vw] flex-col overflow-hidden rounded-xl border border-border bg-popover backdrop-blur-2xl shadow-2xl shadow-black/60"
      >
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4 text-muted-foreground">
          <Icon name="search" className="size-4" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? "Type a command, worktree or file"}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="rounded border border-border px-1.5 font-sans text-[10px]">esc</kbd>
        </label>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && <EmptyState icon="search" title="No results" />}
          {results.map((command, index) => (
            <div key={command.id}>
              {command.group !== results[index - 1]?.group && (
                <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{command.group}</div>
              )}
              <button
                data-index={index}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
                className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ${
                  index === active ? 'bg-accent text-foreground' : 'text-foreground/80'
                }`}
              >
                {command.filePath ? (
                  <FileIcon path={command.filePath} />
                ) : (
                  <Icon name={command.icon ?? 'chevron'} className="size-3.5 text-muted-foreground" />
                )}
                <span className="truncate">{command.label}</span>
                {command.detail && <span className="min-w-0 truncate text-xs text-muted-foreground">{command.detail}</span>}
                <span className="flex-1" />
                {command.shortcut && <kbd className="shrink-0 font-sans text-[11px] text-muted-foreground">{command.shortcut}</kbd>}
              </button>
            </div>
          ))}
        </div>

        <div className="flex h-8 shrink-0 items-center gap-3 border-t border-border px-3 text-[11px] text-muted-foreground">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="flex-1" />
          <span>⌘K</span>
        </div>
      </div>
    </div>
  )
}
