import { useEffect } from 'react'
import { Keys, type ShortcutInfo } from '@treeix/sdk'
import { actionKeys, actionList } from '../../shared/keymap'
import { usePlugins } from './plugins'
import { useSettings } from './settings'
import { keysText } from '../../shared/shortcut'

/** Keys that aren't single actions: the focus model and what plugins list */
export function useKeyExtras(): ShortcutInfo[] {
  const { loaded } = usePlugins()
  return [{ keys: 'j k ⏎ esc', label: 'Move in a list, open, step back: the focus model, fixed', section: 'Focus' }, ...loaded.flatMap(({ plugin }) => plugin.shortcuts ?? [])]
}

/** Every key the app answers to: the actions in the keymap and the fixed ones beside them, grouped by section */
export function useShortcuts(): [section: string, shortcuts: ShortcutInfo[]][] {
  'use no memo' // action keys are read from the keymap during render
  useSettings()
  const extras = useKeyExtras()
  const all: ShortcutInfo[] = [...actionList().map(({ id, label, section, page }) => ({ keys: actionKeys(id) || 'unbound', label, section, page })), ...extras]
  const sections = [...new Set(all.map((shortcut) => shortcut.section))]
  return sections.map((section) => [section, all.filter((shortcut) => shortcut.section === section)])
}

/** ? or ⌘/: every shortcut at once; closing puts focus back where it was */
export function ShortcutSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const sections = useShortcuts()
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Keys stay with the sheet, not the list behind it
    const onKey = (event: KeyboardEvent): void => {
      event.stopPropagation()
      if (event.key !== 'Escape' && event.key !== '?') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus({ preventScroll: true })
    }
  }, [])
  return (
    <div onClick={(event) => event.target === event.currentTarget && onClose()} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-[2px]">
      <div className="flex max-h-[86vh] w-[1040px] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-input bg-popover">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
          <span className="text-[13px] font-medium">Keyboard</span>
          <span className="truncate text-xs text-muted-foreground">{keysText('Chords with ⌘ work everywhere, single letters work outside text fields and the terminal.')}</span>
          <span className="flex-1" />
          <Keys combo="?" />
          <Keys combo="esc" />
        </div>
        <div className="min-h-0 flex-1 columns-3 gap-6 overflow-y-auto px-4 pt-4 pb-8 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]">
          {sections.map(([section, shortcuts]) => (
            <div key={section} className="mb-4 break-inside-avoid">
              <div className="mb-1 text-[11px] font-semibold text-foreground">{section}</div>
              {shortcuts.map((shortcut) => (
                <div key={`${shortcut.keys}:${shortcut.label}`} className="flex min-h-6 items-center gap-2 py-0.5 text-xs text-foreground/85">
                  <span className="flex-1">{keysText(shortcut.label)}</span>
                  <Keys combo={shortcut.keys} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
