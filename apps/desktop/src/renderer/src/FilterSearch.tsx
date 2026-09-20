import { useRef, useState } from 'react'
import { Icon } from './Icon'
import { Popup } from './ui'

export type FilterToken = { kind: string; value: string }

/** One row of suggestions, e.g. People or Projects, over whatever the view lists */
export type FilterGroup<T> = {
  kind: string
  label: string
  /** The item's value for this group; null when it has none */
  valueOf: (item: T) => string | null
  /** Shown instead of the raw value, e.g. a repository's folder name */
  labelOf?: (value: string) => string
  /** Avatar or icon beside the value; `sample` is an item carrying it */
  mark?: (value: string, sample: T | undefined) => React.ReactNode
  /** Matches free text typed into the box instead of listing options */
  freeText?: (item: T, needle: string) => boolean
}

const OPTIONS_PER_GROUP = 8

/** Filters saved from an earlier session; anything malformed is dropped */
export const parseTokens = (stored: unknown, kinds: string[]): FilterToken[] =>
  Array.isArray(stored)
    ? stored.filter((entry): entry is FilterToken => typeof entry === 'object' && entry !== null && kinds.includes(entry.kind) && typeof entry.value === 'string')
    : []

/** Values of one group are alternatives; different groups must all match */
export function matchesTokens<T>(item: T, tokens: FilterToken[], groups: FilterGroup<T>[]): boolean {
  return groups.every((group) => {
    const values = tokens.filter((token) => token.kind === group.kind).map((token) => token.value)
    if (values.length === 0) return true
    if (group.freeText) return values.every((value) => group.freeText?.(item, value.toLowerCase()))
    return values.includes(group.valueOf(item) ?? '')
  })
}

type Option<T> = FilterToken & { count: number; sample: T | undefined }

/** Token filter box with suggestions, as in the pull request list */
export function FilterSearch<T>({
  items,
  groups,
  tokens,
  onChange,
  placeholder,
  freeTextHint = 'Press ↵ to filter by this text'
}: {
  items: T[]
  groups: FilterGroup<T>[]
  tokens: FilterToken[]
  onChange: (tokens: FilterToken[]) => void
  placeholder: string
  /** Shown when typed text matches no option and Enter turns it into a text filter */
  freeTextHint?: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLLabelElement>(null)
  const needle = query.trim().toLowerCase()
  const groupOf = (kind: string): FilterGroup<T> | undefined => groups.find((group) => group.kind === kind)
  const labelFor = ({ kind, value }: FilterToken): string => groupOf(kind)?.labelOf?.(value) ?? value
  const sampleFor = ({ kind, value }: FilterToken): T | undefined => items.find((item) => groupOf(kind)?.valueOf(item) === value)

  const sections = groups
    .filter((group) => !group.freeText)
    .map((group) => {
      const options = new Map<string, Option<T>>()
      for (const item of items) {
        const value = group.valueOf(item)
        if (!value || tokens.some((token) => token.kind === group.kind && token.value === value)) continue
        const existing = options.get(value)
        if (existing) existing.count++
        else options.set(value, { kind: group.kind, value, count: 1, sample: item })
      }
      const shown = [...options.values()]
        .filter((option) => (group.labelOf?.(option.value) ?? option.value).toLowerCase().includes(needle))
        .sort((a, b) => b.count - a.count)
        .slice(0, OPTIONS_PER_GROUP)
      return { label: group.label, items: shown }
    })
    .filter((section) => section.items.length > 0)
  const flat = sections.flatMap((section) => section.items)
  const textGroup = groups.find((group) => group.freeText)

  const pick = (option: Option<T> | undefined): void => {
    if (option) onChange([...tokens, { kind: option.kind, value: option.value }])
    // Nothing matched: keep the words as a text filter, like typing in a search box
    else if (textGroup && needle) onChange([...tokens, { kind: textGroup.kind, value: query.trim() }])
    else return
    setQuery('')
    setActive(0)
  }
  const remove = (removed: FilterToken): void => onChange(tokens.filter((token) => token !== removed))

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') setActive((active + 1) % Math.max(flat.length, 1))
    else if (event.key === 'ArrowUp') setActive((active - 1 + flat.length) % Math.max(flat.length, 1))
    else if (event.key === 'Enter') pick(flat[active])
    else if (event.key === 'Backspace' && !query && tokens.length > 0) remove(tokens[tokens.length - 1])
    else if (event.key === 'Escape') setOpen(false)
    else return
    event.preventDefault()
  }

  let index = -1
  return (
    <div className="relative min-w-0 flex-1">
      <label ref={box} className="flex min-h-8 flex-wrap items-center gap-1 rounded-lg bg-muted py-1 pr-1.5 pl-2.5 text-muted-foreground ring-1 ring-border">
        <Icon name="search" className="mr-0.5 size-3.5" />
        {tokens.map((token) => (
          <span key={`${token.kind}:${token.value}`} className="flex h-6 max-w-40 items-center gap-1.5 rounded-md bg-accent pr-1 pl-1.5 text-xs text-foreground ring-1 ring-border">
            {groupOf(token.kind)?.mark?.(token.value, sampleFor(token))}
            <span className="truncate">{labelFor(token)}</span>
            <button title="Remove filter" onClick={() => remove(token)} className="grid size-4 place-items-center rounded text-muted-foreground hover:text-foreground">
              <Icon name="close" className="size-2.5" />
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          placeholder={tokens.length ? '' : placeholder}
          className="h-6 min-w-16 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </label>

      {open && (
        <Popup anchor={box} align="stretch" className="max-h-96 overflow-y-auto rounded-lg border border-input bg-popover p-1">
          {sections.length === 0 && <p className="px-2.5 py-3 text-center text-xs text-muted-foreground">{textGroup && needle ? freeTextHint : 'No matching filters'}</p>}
          {sections.map((section, sectionIndex) => (
            <div key={section.label}>
              {sectionIndex > 0 && <hr className="my-1 border-border" />}
              <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">{section.label}</div>
              {section.items.map((option) => {
                index++
                const optionIndex = index
                return (
                  <button
                    key={option.value}
                    // Keep focus in the input so the list stays open for picking several filters
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => pick(option)}
                    onMouseMove={() => setActive(optionIndex)}
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] ${optionIndex === active ? 'bg-accent text-foreground' : 'text-foreground/85'}`}
                  >
                    {groupOf(option.kind)?.mark?.(option.value, option.sample)}
                    <span className="min-w-0 flex-1 truncate">{groupOf(option.kind)?.labelOf?.(option.value) ?? option.value}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">{option.count}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </Popup>
      )}
    </div>
  )
}
