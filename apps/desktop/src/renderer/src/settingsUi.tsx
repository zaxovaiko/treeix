/** Building blocks for the settings page, also used by plugins' settings */

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-foreground/15'}`}
    >
      <span className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
    </button>
  )
}

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
    <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-1 ring-1 ring-border">
      {options.map(([option, label]) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          className={`h-6 rounded-md px-2.5 text-xs ${value === option ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function Row({ label, description, children }: { label: string; description: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-6 border-b border-border px-4 py-3.5 last:border-b-0">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px]">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      {children}
    </div>
  )
}

export const Card = ({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element => (
  <section className="mb-8">
    <h2 className="mb-2 text-[13px] font-medium">{title}</h2>
    <div className="rounded-xl border border-border bg-card">{children}</div>
  </section>
)

