import type { ContextMenuItem } from '../../shared/types'

export type MenuAction = { label: string; run: () => void; enabled?: boolean; accelerator?: string }
/** `null` draws a separator; `false` and `undefined` let callers write `condition && action` */
export type MenuEntry = MenuAction | null | false | undefined

/** Drops hidden entries and separators that would sit at an edge or next to another separator */
export function normalizeEntries(entries: MenuEntry[]): (MenuAction | null)[] {
  const visible = entries.filter((entry): entry is MenuAction | null => entry !== false && entry !== undefined)
  return visible.filter((entry, index) => entry !== null || (index > 0 && visible[index - 1] !== null && visible.slice(index + 1).some(Boolean)))
}

export function openMenu(event: MouseEvent | React.MouseEvent, entries: MenuEntry[]): void {
  event.preventDefault()
  event.stopPropagation()
  // Custom menus replace the native text menu, so keep copying a selection available
  const selection = window.getSelection()?.toString() ?? ''
  const copySelection: MenuEntry[] = selection ? [{ label: 'Copy selection', accelerator: 'CmdOrCtrl+C', run: () => copyText(selection) }, null] : []
  const actions = normalizeEntries([...copySelection, ...entries])
  const items: ContextMenuItem[] = actions.map((action, index) =>
    action === null
      ? { type: 'separator' }
      : { id: `${index}`, label: action.label, enabled: action.enabled, accelerator: action.accelerator }
  )
  window.api.showContextMenu(items).then((id) => {
    const chosen = id === null ? null : actions[Number(id)]
    chosen?.run()
  })
}

export const copyText = (text: string): void => void navigator.clipboard.writeText(text)
