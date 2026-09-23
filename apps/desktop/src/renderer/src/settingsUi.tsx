/** Building blocks for the settings page, also used by plugins' settings */
import { createContext, useContext } from 'react'

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

export const useSettingsQuery = (): string => useContext(SettingsQuery)

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
  return (
    <div className={`${className} ${query.trim() && !titleMatch ? HIDE_WHEN_EMPTY : ''}`}>
      {titleMatch ? <SettingsSearch value="">{children}</SettingsSearch> : children}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} onClick={onChange} className={`relative h-5 w-9 shrink-0 rounded-full ${checked ? 'bg-primary' : 'bg-foreground/15'}`}>
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

/** Options side by side; ← and → on its settings row step through them */
export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: [T, string][]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div data-segmented className="flex max-w-full shrink-0 flex-wrap gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
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
export const SETTING_ROW = 'outline-none first:rounded-t-lg last:rounded-b-lg'

/** One setting: label and description, its control beside them, or wrapped under them when the page is narrow */
export function Row({ label, description, children }: { label: string; description: string; children: React.ReactNode }): React.JSX.Element | null {
  if (!useSettingMatch(label, description)) return null
  return (
    <div data-setting={label} tabIndex={-1} className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border px-4 py-3 last:border-b-0 *:max-w-full ${SETTING_ROW}`}>
      <span className="min-w-48 flex-1 break-words">
        <span className="block text-[13px]">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      {/* A control that wraps under its label stays on the right */}
      <div className="ml-auto flex min-w-0 justify-end">{children}</div>
    </div>
  )
}

export const Card = ({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element => (
  <SearchGroup title={title} className="mb-6">
    <h2 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{title}</h2>
    <div data-card={title} className="rounded-lg border border-border bg-card">
      {children}
    </div>
  </SearchGroup>
)
