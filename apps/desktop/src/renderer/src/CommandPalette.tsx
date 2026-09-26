import { useEffect, useRef, useState } from 'react'
import { KeyHintLabel, Keys } from '@treeix/sdk'
import { FileIcon, Icon, type IconName } from './Icon'
import { EmptyState } from './ui'
import { revealSetting, useSettingEntries } from './SettingsView'
import { paletteResults, PREFIXES, type Result } from './paletteSearch'

export type Command = {
  id: string
  /**
   * Actions come first, Worktrees and Files last, others in between. Prefixes search one group: > Actions,
   * # Pull requests, ! Tasks, @ Sessions, / Files, : Settings; use those names so they apply
   */
  group: string
  label: string
  detail?: string
  shortcut?: string
  icon?: IconName
  filePath?: string
  run: () => void
}

function Marked({ text, marks }: { text: string; marks: Set<number> }): React.JSX.Element {
  if (marks.size === 0) return <>{text}</>
  return <>{[...text].map((char, index) => (marks.has(index) ? <b key={index} className="font-semibold text-foreground">{char}</b> : char))}</>
}

/** Key hints show as keycaps; anything else in the slot, like "3 changed", as plain text */
const isKeyHint = (shortcut: string): boolean => !/[a-z]{2}/.test(shortcut)

export function CommandPalette({
  commands,
  onClose,
  placeholder,
  browseFiles = false
}: {
  commands: Command[]
  onClose: () => void
  placeholder?: string
  /** A picker over just the given files, like a pull request's changed files: listed before typing, no settings or prefixes */
  browseFiles?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const settingEntries = useSettingEntries()
  const openSettings = commands.find((command) => command.id === 'settings')?.run
  const settingCommands: Command[] =
    browseFiles || !openSettings
      ? []
      : settingEntries.map((entry) => ({
          id: `setting:${entry.card}:${entry.label}:${entry.keys ?? ''}`,
          group: 'Settings',
          label: entry.label,
          detail: `${entry.section} / ${entry.card}`,
          icon: 'settings',
          shortcut: entry.keys,
          run: () => {
            revealSetting(entry)
            openSettings()
          }
        }))
  const results = paletteResults([...commands, ...settingCommands], query, browseFiles)

  useEffect(() => setActive(0), [query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Closing without running anything puts focus back where it was; a command moves it itself
  const close = (): void => {
    previousFocus.current?.focus({ preventScroll: true })
    onClose()
  }

  const run = (result: Result | undefined): void => {
    if (!result) return
    onClose()
    result.command.run()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const down = event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
    const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
    if (down) setActive((active + 1) % Math.max(results.length, 1))
    else if (up) setActive((active - 1 + results.length) % Math.max(results.length, 1))
    else if (event.key === 'Enter') run(results[active])
    // First Esc clears the query, the next one closes
    else if (event.key === 'Escape') {
      if (query) setQuery('')
      else close()
    } else return
    event.preventDefault()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-[2px]" onClick={close}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[70vh] w-[660px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-input bg-popover shadow-2xl shadow-black/60 backdrop-blur-2xl"
      >
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4 text-muted-foreground">
          <Icon name="search" className="size-4 shrink-0" />
          <input
            autoFocus
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder ?? 'Search commands, files, pull requests, tasks, sessions, settings'}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <Keys combo="esc" />
        </label>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {results.length === 0 && <EmptyState icon="search" title="No matches" />}
          {results.map(({ command, marks }, index) => (
            <div key={command.id}>
              {command.group !== results[index - 1]?.command.group && (
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">{command.group}</div>
              )}
              <button
                data-index={index}
                tabIndex={-1}
                onMouseMove={() => setActive(index)}
                onClick={() => run(results[index])}
                className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] ${index === active ? 'bg-foreground/[.08] text-foreground' : 'text-foreground/85'}`}
              >
                {command.filePath ? <FileIcon path={command.filePath} /> : <Icon name={command.icon ?? 'chevron'} className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 truncate">
                  <Marked text={command.label} marks={marks} />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{command.detail}</span>
                {command.shortcut &&
                  (isKeyHint(command.shortcut) ? (
                    <span className="shrink-0">
                      <Keys combo={command.shortcut} />
                    </span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-muted-foreground">{command.shortcut}</span>
                  ))}
              </button>
            </div>
          ))}
        </div>

        <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
          <KeyHintLabel hint={['↑ ↓', 'move']} />
          <KeyHintLabel hint={['⏎', 'open']} />
          <KeyHintLabel hint={['esc', query ? 'clear' : 'close']} />
          {!browseFiles && (
            <>
              <span className="flex-1" />
              {PREFIXES.map(([prefix, name]) => (
                <span key={prefix} className="whitespace-nowrap">
                  <b className="font-mono text-foreground/80">{prefix}</b> {name}
                </span>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
