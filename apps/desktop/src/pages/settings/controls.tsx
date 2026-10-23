import { createContext, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { IS_MAC, MODIFIER_KEYS, accelerator, acceleratorLabel } from '../../shell/shortcuts'

/** The search and where a row sits, so each row can tell whether it matches */
const Where = createContext({ query: '', section: '', group: '' })

export const Search = Where.Provider

const matches = (query: string, ...texts: (string | undefined)[]) => !query || texts.join(' ').toLowerCase().includes(query)

/** Whether a control that isn't a Row matches the search */
export function useHit(...texts: string[]) {
  const { query, section, group } = useContext(Where)
  return matches(query, ...texts, group, section)
}

/** A titled group of rows; CSS hides it when the search leaves no row in it */
export function Group({ title, children }: { title?: string; children: ReactNode }) {
  const where = useContext(Where)
  return (
    <section className="sgrp">
      {title && <h3>{title}</h3>}
      <Where.Provider value={{ ...where, group: title ?? '' }}>{children}</Where.Provider>
    </section>
  )
}

/** One setting: label and description on the left, its control on the right. `keywords` widen the search; `wide` stacks the control under */
export function Row({ label, icon, desc, keywords, wide, children }: { label: string; icon?: ReactNode; desc?: ReactNode; keywords?: string; wide?: boolean; children?: ReactNode }) {
  const { query, section, group } = useContext(Where)
  if (!matches(query, label, typeof desc === 'string' ? desc : '', keywords, group, section)) return null
  return (
    <div className={`srow ${wide ? 'col' : ''}`}>
      <div className="grow">
        {label && (
          <div className="sl">
            {icon}
            {label}
          </div>
        )}
        {desc && <div className="sd">{desc}</div>}
      </div>
      {children && <div className="sc">{children}</div>}
    </div>
  )
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return (
    <div className="seg">
      {options.map(([option, label]) => (
        <button key={option} className={option === value ? 'on' : ''} onClick={() => onChange(option)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button className={`sw ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <i />
    </button>
  )
}

/** A text or number field that saves on Enter and on blur, not on every key */
export function Field({ value, onSave, width = 200, type = 'text', min, max, placeholder, mono }: {
  value: string
  onSave: (value: string) => void
  width?: number
  type?: 'text' | 'number'
  min?: number
  max?: number
  placeholder?: string
  mono?: boolean
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => {
    if (draft !== value) onSave(draft)
  }
  return (
    <input
      className={`inp ${type === 'number' ? 'num' : ''} ${mono ? 'mono' : ''}`}
      style={{ width }}
      type={type}
      min={min}
      max={max}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') setDraft(value)
      }}
    />
  )
}

export function Select<T extends string | number>({ value, options, onChange }: { value: T; options: readonly (readonly [T, string])[]; onChange: (value: T) => void }) {
  return (
    <select className="sel" value={String(value)} onChange={(e) => onChange(options.find(([o]) => String(o) === e.target.value)?.[0] ?? value)}>
      {options.map(([option, label]) => (
        <option key={option} value={String(option)}>
          {label}
        </option>
      ))}
    </select>
  )
}

/** Click, then press a chord; Escape cancels, Backspace clears. `onChange` may reject, the message shows next to it */
export function Recorder({ value, onChange, label }: { value: string | null; onChange: (accel: string | null) => Promise<void> | void; label: string }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const self = useRef<HTMLButtonElement>(null)
  const save = (accel: string | null) => {
    setRecording(false)
    Promise.resolve(onChange(accel)).then(
      () => setError(null),
      (e: unknown) => setError(`Couldn't use ${accel ? acceleratorLabel(accel) : 'that'}: ${String(e)}`)
    )
  }
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') return setRecording(false)
    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) return save(null)
    const accel = accelerator(e)
    if (accel) save(accel)
    else if (!MODIFIER_KEYS.has(e.key)) setError(`Hold ${IS_MAC ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'} with the key, or press ${IS_MAC ? '§' : '<'} or an F-key alone`)
  })
  // On the window: WebKit doesn't focus a clicked button, so its own keydown never fires
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => onKey(e)
    // A click anywhere else, another recorder too, stops this one
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node && self.current?.contains(e.target))) setRecording(false)
    }
    window.addEventListener('keydown', handler, true)
    window.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      window.removeEventListener('pointerdown', away, true)
    }
  }, [recording])
  return (
    <>
      {error && <span className="sd st-err">{error}</span>}
      <button ref={self} className={`krec ${recording ? 'on' : ''}`} aria-label={`${label} shortcut`} onClick={() => setRecording(!recording)} title="Click, then press the new keys. Backspace clears">
        {recording ? 'Press keys...' : value ? <kbd>{acceleratorLabel(value)}</kbd> : <span className="dim">Not set</span>}
      </button>
    </>
  )
}

/** A status dot and its text */
export const Status = ({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'idle'; children: ReactNode }) => (
  <span className="sstat">
    <span className={`sdot ${tone}`} />
    {children}
  </span>
)
