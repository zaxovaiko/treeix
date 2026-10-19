/** Building blocks for the settings page, also used by plugins' settings */
import { createContext, useContext, useState } from 'react'
import { errorMessage } from '../../shared/errors'

/** Settings search; '' shows everything */
const SettingsQuery = createContext('')
export const SettingsSearch = SettingsQuery.Provider

/** Every word of the query appears somewhere in the texts */
export function settingMatches(query: string, ...texts: string[]): boolean {
  const haystack = texts.join(' ').toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word))
}

export const useSettingMatch = (...texts: string[]): boolean => settingMatches(useContext(SettingsQuery), ...texts)

/** While searching, hides a group whose entries all filtered out; entries mark themselves with data-setting */
export const HIDE_WHEN_EMPTY = '[&:not(:has([data-setting]))]:hidden'

/**
 * A group that matches by its own title shows everything in it; otherwise, while searching,
 * it hides once all its entries have filtered out
 */
export function SearchGroup({ title, className = '', children }: { title: string; className?: string; children: React.ReactNode }): React.JSX.Element {
  const query = useContext(SettingsQuery)
  const titleMatch = query.trim() !== '' && settingMatches(query, title)
  return <div className={`${className} ${query.trim() && !titleMatch ? HIDE_WHEN_EMPTY : ''}`}>{titleMatch ? <SettingsSearch value="">{children}</SettingsSearch> : children}</div>
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full ${checked ? 'bg-primary' : 'bg-foreground/15'}`}
    >
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

/** Options side by side; ← and → on its settings row step through them */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }): React.JSX.Element {
  return (
    <div data-segmented className="flex max-w-full shrink-0 flex-wrap gap-0.5">
      {options.map(([option, label]) => (
        <button
          key={option}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={`h-6 rounded-md px-2.5 text-xs whitespace-nowrap ${value === option ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

/** The rows' keyboard cursor is focus; focus itself draws nothing */
/** A score out of `of` as filled steps, like a model's quality */
export function Steps({ label, value, of = 5 }: { label: string; value: number; of?: number }): React.JSX.Element {
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={of}
      title={`${label} ${value}/${of}`}
      className="flex items-center gap-2 text-[11px] text-muted-foreground"
    >
      <span className="w-11">{label}</span>
      <span className="flex gap-0.5">
        {Array.from({ length: of }, (_, step) => (
          <span key={step} className={`h-1.5 w-2.5 rounded-full ${step < value ? 'bg-primary' : 'bg-foreground/15'}`} />
        ))}
      </span>
    </span>
  )
}

export const SETTING_ROW = 'rounded-md outline-none'

/** One setting: label and description, its control beside them, or wrapped under them when the page is narrow */
export function Row({
  label,
  description,
  preview,
  children
}: {
  label: string
  description: string
  preview?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element | null {
  if (!useSettingMatch(label, description)) return null
  return (
    <div data-setting={label} tabIndex={-1} className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-2 py-3 last:border-b-0 *:max-w-full ${SETTING_ROW}`}>
      {preview}
      <span className="min-w-48 flex-1 break-words">
        <span className="block text-[13px]">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      {/* A control that wraps under its label stays on the right */}
      <div className="ml-auto flex min-w-0 justify-end">{children}</div>
    </div>
  )
}

/** The section a search result sits under; a card named the same skips its title instead of repeating it */
const ResultSection = createContext('')
export const SearchSection = ResultSection.Provider

export const Card = ({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element => (
  <SearchGroup title={title} className="mb-6">
    {useContext(ResultSection) !== title && <h2 className="mb-1.5 text-[11px] font-semibold text-foreground">{title}</h2>}
    <div data-card={title} className="-mx-2">
      {children}
    </div>
  </SearchGroup>
)

/** A token kept by main: who it connects as once saved, else a password box; saving checks it first and shows why it was refused */
export function SecretRow({
  label,
  description,
  saved,
  placeholder,
  onSave,
  onRemove
}: {
  label: string
  description: string
  saved: string | null
  placeholder: string
  onSave: (secret: string) => Promise<void>
  onRemove: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState('')
  const save = (): void => {
    if (!draft.trim()) return
    onSave(draft.trim()).then(
      () => (setDraft(''), setProblem('')),
      (reason: unknown) => setProblem(errorMessage(reason))
    )
  }
  return (
    <Row label={label} description={problem || description}>
      {saved !== null ? (
        <span className="flex items-center gap-2 text-xs">
          <span className="text-emerald-400">{saved}</span>
          <button className="h-7 rounded-md border border-border px-2.5 hover:bg-accent" onClick={onRemove}>
            Remove
          </button>
        </span>
      ) : (
        <form className="flex gap-2" onSubmit={(event) => (event.preventDefault(), save())}>
          <input
            type="password"
            aria-label={label}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            className="h-7 w-56 rounded-md bg-muted px-2 font-mono text-xs ring-1 ring-border outline-none focus:ring-primary"
          />
          <button type="submit" disabled={!draft.trim()} className="h-7 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-50">
            Save
          </button>
        </form>
      )}
    </Row>
  )
}
