import { useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../lib/icons'
import { registerQuickShortcut } from '../lib/native'
import { accelerator, acceleratorLabel } from './shortcuts'
import type { UiState } from './state'
import type { ShellView } from './Shell'

type Patch = Partial<Pick<UiState, 'theme' | 'ui' | 'orientation' | 'renderer' | 'quickShortcut'>>

function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (value: T) => void }) {
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

function Row({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="srow">
      <div className="grow">
        <div className="sl">{label}</div>
        {desc && <div className="sd">{desc}</div>}
      </div>
      <div className="sc">{children}</div>
    </div>
  )
}

/** Click, then press a chord; Escape cancels, Backspace clears */
function ShortcutRecorder({ value, onChange }: { value: string | null; onChange: (accel: string | null) => Promise<void> }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = (accel: string | null) => {
    setRecording(false)
    onChange(accel).then(
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
  })
  // On the window: WebKit doesn't focus a clicked button, so its own keydown never fires
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [recording])
  return (
    <>
      {error && <span className="sd st-err">{error}</span>}
      <button className={`krec ${recording ? 'on' : ''}`} onClick={() => setRecording(!recording)} title="Click, then press the new keys. Backspace clears">
        {recording ? 'Press keys...' : value ? <kbd>{acceleratorLabel(value)}</kbd> : <span className="dim">Not set</span>}
      </button>
    </>
  )
}

const SECTIONS: [id: 'appearance' | 'terminal', label: string, icon: IconName][] = [
  ['appearance', 'Appearance', 'moon'],
  ['terminal', 'Terminal', 'terminal'],
]

/** Phase 2 settings: look, renderer and the quick terminal chord. Everything saves as it changes, in the UI blob */
export function Settings({ view, onClose }: { view: ShellView; onClose: () => void }) {
  const [section, setSection] = useState<(typeof SECTIONS)[number][0]>('appearance')
  const { ui, dispatch } = view
  const set = (patch: Patch) => dispatch({ type: 'set', patch })
  const current = SECTIONS.find(([id]) => id === section) ?? SECTIONS[0]

  return (
    <>
      <div className="gtop">
        <button className="btn sm" onClick={onClose}>
          <Icon name="left" />
          Terminal
        </button>
        <b>Settings</b>
        <span className="grow" />
        <span className="dim">Saved as you change them</span>
      </div>
      <div className="setp">
        <nav className="snav">
          <div className="snav-g">General</div>
          {SECTIONS.map(([id, label, icon]) => (
            <button key={id} className={`snav-i ${id === section ? 'on' : ''}`} onClick={() => setSection(id)}>
              <Icon name={icon} />
              <span className="trunc">{label}</span>
            </button>
          ))}
        </nav>
        <div className="scont">
          <div className="sinner">
            <h1 className="sh1">
              <Icon name={current[2]} />
              {current[1]}
            </h1>
            {section === 'appearance' ? (
              <>
                <div className="sgrp">
                  <h3>Theme</h3>
                  <Row label="Mode">
                    <Seg value={ui.theme} options={[['light', 'Light'], ['dark', 'Dark']]} onChange={(theme) => set({ theme })} />
                  </Row>
                </div>
                <div className="sgrp">
                  <h3>Layout</h3>
                  <Row label="Tabs" desc="Grouped in a sidebar, or a strip on top. With Compact, the strip sits in the title bar">
                    <Seg value={ui.orientation} options={[['vertical', 'Vertical'], ['horizontal', 'Horizontal']]} onChange={(orientation) => set({ orientation })} />
                  </Row>
                  <Row label="Density" desc="Compact runs edge to edge with 1px lines. Islands floats rounded panels">
                    <Seg value={ui.ui} options={[['compact', 'Compact'], ['islands', 'Islands']]} onChange={(density) => set({ ui: density })} />
                  </Row>
                </div>
              </>
            ) : (
              <>
                <div className="sgrp">
                  <h3>Sessions</h3>
                  <Row label="Renderer" desc="WebGL is fastest. DOM for old GPUs and screen sharing. Auto uses WebGL, except DOM on Linux">
                    <Seg value={ui.renderer} options={[['auto', 'Auto'], ['webgl', 'WebGL'], ['dom', 'DOM']]} onChange={(renderer) => set({ renderer })} />
                  </Row>
                </div>
                <div className="sgrp">
                  <h3>Quick terminal</h3>
                  <Row label="Shortcut" desc="Works from any app">
                    <ShortcutRecorder
                      value={ui.quickShortcut}
                      onChange={async (quickShortcut) => {
                        await registerQuickShortcut(quickShortcut)
                        set({ quickShortcut })
                      }}
                    />
                  </Row>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
