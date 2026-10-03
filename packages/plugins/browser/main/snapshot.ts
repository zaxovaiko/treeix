/** CDP Accessibility.getFullAXTree nodes, read defensively since they come from the page's process */
type AxValue = { value?: unknown }
export type AxNode = {
  nodeId: string
  ignored?: boolean
  role?: AxValue
  name?: AxValue
  value?: AxValue
  childIds?: string[]
  backendDOMNodeId?: number
  properties?: { name: string; value: AxValue }[]
}

const SNAPSHOT_LIMIT = 60_000
/** Wrappers that say nothing on their own; their children take their place */
const TRANSPARENT = new Set([
  'generic',
  'none',
  'presentation',
  'InlineTextBox',
  'LineBreak',
  'RootWebArea',
  'WebArea',
  'group',
  'Section',
  'paragraph',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell'
])
const STATES = new Set(['focused', 'checked', 'pressed', 'selected', 'expanded', 'disabled', 'required', 'invalid'])
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'listbox',
  'treeitem'
])

const str = (value: AxValue | undefined): string =>
  typeof value?.value === 'string' || typeof value?.value === 'number' || typeof value?.value === 'boolean' ? String(value.value) : ''
const quoted = (value: string): string => JSON.stringify(value.replace(/\s+/g, ' ').trim().slice(0, 200))

/**
 * The page as an indented outline, one line per meaningful node. Refs are DOM backend node ids, which
 * the click and type tools take; only nodes one can point at get one.
 */
export function formatSnapshot(nodes: AxNode[]): string {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const lines: string[] = []
  let size = 0
  const walk = (node: AxNode, depth: number, parentName: string): void => {
    if (size > SNAPSHOT_LIMIT) return
    const role = str(node.role)
    const name = str(node.name).trim()
    const text = role === 'StaticText'
    // A link or button already carries its text as its name
    const repeats = text && name === parentName
    const shown = !node.ignored && !repeats && (text ? name !== '' : !TRANSPARENT.has(role) || name !== '') && role !== ''
    if (shown) {
      const states = (node.properties ?? []).filter((property) => STATES.has(property.name) && property.value.value === true).map((property) => property.name)
      const level = (node.properties ?? []).find((property) => property.name === 'level')
      const value = str(node.value)
      const parts = [
        text ? 'text' : role,
        name && quoted(name),
        level && `level=${str(level.value)}`,
        value && value !== name && `value=${quoted(value)}`,
        ...states,
        node.backendDOMNodeId !== undefined && (INTERACTIVE.has(role) || !text) && `[ref=${node.backendDOMNodeId}]`
      ].filter(Boolean)
      const line = `${'  '.repeat(depth)}- ${parts.join(' ')}`
      lines.push(line)
      size += line.length + 1
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) walk(child, shown ? depth + 1 : depth, name || parentName)
    }
  }
  const root = nodes[0]
  if (root) walk(root, 0, '')
  return size > SNAPSHOT_LIMIT ? `${lines.join('\n')}\n(cut at ${SNAPSHOT_LIMIT / 1000}k characters)` : lines.join('\n')
}

/** Key names agents use, with what CDP needs to press them */
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 }
}
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }

export type KeyPress = { key: string; code: string; keyCode: number; text?: string; modifiers: number }

/** "Enter", "Meta+a", "Shift+Tab"; null for a name it doesn't know */
export function parseKey(combo: string): KeyPress | null {
  const parts = combo.split('+').filter(Boolean)
  const name = parts.pop() ?? ''
  if (parts.some((part) => !(part in MODIFIERS))) return null
  const modifiers = parts.reduce((mask, part) => mask | MODIFIERS[part], 0)
  const known = KEYS[name === ' ' ? 'Space' : name]
  if (known) return { key: name === 'Space' ? ' ' : name, ...known, text: modifiers & ~MODIFIERS.Shift ? undefined : known.text, modifiers }
  if (name.length !== 1) return null
  const upper = name.toUpperCase()
  const letter = /[A-Z]/.test(upper)
  const digit = /[0-9]/.test(name)
  return {
    key: name,
    code: letter ? `Key${upper}` : digit ? `Digit${name}` : '',
    keyCode: letter || digit ? upper.charCodeAt(0) : 0,
    // With Meta or Control it's a shortcut, not typing
    text: modifiers & (MODIFIERS.Meta | MODIFIERS.Control) ? undefined : name,
    modifiers
  }
}
