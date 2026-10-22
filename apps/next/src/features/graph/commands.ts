import type { Command } from '../../lib/paletteSearch'
import { keyHint } from '../../shell/shortcuts'
import type { ShellView } from '../../shell/Shell'

/** "Module graph"; only asked while the feature is on */
export const graphCommands = (view: ShellView): Command[] => [
  { id: 'module-graph', group: 'Actions', label: 'Module graph', shortcut: keyHint('module-graph'), icon: 'network', run: () => view.run('module-graph') },
]
