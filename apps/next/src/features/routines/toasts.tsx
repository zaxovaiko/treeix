import { useSyncExternalStore } from 'react'
import { Icon, type IconName } from '../../lib/icons'

// Corner toasts for what routines do in the background. ponytail: routines' own stack; one shell-wide host when a second feature needs toasts

export interface Toast {
  icon: IconName
  title: string
  body?: string
  /** The first is the primary button; each closes the toast */
  actions?: [label: string, run: () => void][]
}

const SHOWN_MS = 7000
let toasts: (Toast & { id: number })[] = []
let seq = 0
const listeners = new Set<() => void>()
const set = (next: typeof toasts) => {
  toasts = next
  listeners.forEach((l) => l())
}
const close = (id: number) => set(toasts.filter((t) => t.id !== id))

export function toast(t: Toast) {
  const id = ++seq
  set([...toasts, { ...t, id }])
  setTimeout(() => close(id), SHOWN_MS)
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => toasts)
  if (!list.length) return null
  return (
    <div className="rtoasts" role="status">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <span className={`ki sm ${t.icon}`}>
            <Icon name={t.icon} />
          </span>
          <div className="b">
            <div className="t">{t.title}</div>
            {t.body && <div className="d">{t.body}</div>}
            {t.actions && (
              <div className="a">
                {t.actions.map(([label, run], i) => (
                  <button key={label} className={`btn sm ${i ? '' : 'pri'}`} onClick={() => (close(t.id), run())}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon sm" onClick={() => close(t.id)} title="Close">
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  )
}
