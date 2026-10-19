import { defineActions, key } from '../../shared/keymap'
import { IS_MAC } from '../../shared/platform'

/**
 * The app's own actions and the keys they ship with. Plugins add theirs the same way, from their own modules.
 * Movement inside a zone (j k, arrows, ⏎, esc) is the focus model rather than an action, so it stays fixed.
 */
defineActions([
  { id: 'app.settings', label: 'Settings', section: 'Go to', keys: key('Comma', { meta: true }) },
  { id: 'app.search', label: 'Search across projects in scope', menuLabel: 'Search across projects', section: 'Go to', keys: key('KeyF', { meta: true, shift: true }) },
  { id: 'app.back', label: 'Back to the panel, file and line you were on', menuLabel: 'Back', section: 'Go to', keys: key('Minus', { ctrl: true, alt: !IS_MAC }) },
  { id: 'app.forward', label: 'Forward again', menuLabel: 'Forward', section: 'Go to', keys: key('Minus', { ctrl: true, shift: true }) },

  { id: 'chat.new', label: 'New chat', section: 'Chat', keys: key('KeyN', { meta: true }) },
  { id: 'side.changes', label: "Changes of the chat's folder, in the right panel", section: 'Chat', keys: key('KeyC', { meta: true, shift: true }) },
  { id: 'side.schema', label: 'Schema, in the right panel', section: 'Chat', keys: key('KeyS', { meta: true, shift: true }) },
  { id: 'side.dependencies', label: 'Dependencies, in the right panel', section: 'Chat', keys: key('KeyM', { meta: true, shift: true }) },
  { id: 'side.prs', label: "Pull requests of the chat's repository, in the right panel", section: 'Chat', keys: key('KeyP', { meta: true, alt: true }) },
  { id: 'changes.foldAll', label: 'Fold or unfold every file in Changes', section: 'Chat', keys: key('KeyF', { meta: true, alt: true }) },
  { id: 'changes.diffStyle', label: 'Split or unified diff in Changes', section: 'Chat', keys: key('KeyS', { meta: true, alt: true }) },

  { id: 'panel.list', label: 'Show or hide the sidebar', menuLabel: 'Sidebar', section: 'Panels', keys: key('KeyE', { meta: true, shift: true }) },
  { id: 'panel.listAlt', label: 'Show or hide the sidebar, second key', section: 'Panels', keys: key('KeyB', { meta: true }) },
  { id: 'panel.inspector', label: 'Toggle inspector', menuLabel: 'Inspector', section: 'Panels', keys: key('KeyB', { meta: true, alt: true }) },
  {
    id: 'panel.fill',
    label: 'Fill the window with the right panel, or bring the chat back',
    menuLabel: 'Fill Window with Panel',
    section: 'Panels',
    keys: key('Enter', { meta: true, alt: true })
  },
  { id: 'app.shortcuts', label: 'Keyboard sheet', section: 'Panels', keys: key('Slash', { meta: true }) },
  { id: 'app.shortcutsBare', label: 'Keyboard sheet, second key', section: 'Panels', keys: key('Slash', { shift: true }) },

  { id: 'composer.save', label: 'Save the comment or message being written', section: 'Comments', keys: key('Enter', { meta: true }) },
  { id: 'composer.saveAlternative', label: 'Save it the second way, where the box offers one', section: 'Comments', keys: key('Enter', { meta: true, shift: true }) },

  { id: 'app.zoomIn', label: 'Zoom the window in', menuLabel: 'Zoom In', section: 'General', keys: key('Equal', { meta: true }) },
  { id: 'app.zoomOut', label: 'Zoom the window out', menuLabel: 'Zoom Out', section: 'General', keys: key('Minus', { meta: true }) },
  { id: 'app.zoomReset', label: 'Zoom the window back to normal', menuLabel: 'Actual Size', section: 'General', keys: key('Digit0', { meta: true }) },
  { id: 'app.fontBigger', label: 'Bigger font in the focused terminal, else the editor', section: 'General', keys: key('Equal', { meta: true, alt: true }) },
  { id: 'app.fontSmaller', label: 'Smaller font', section: 'General', keys: key('Minus', { meta: true, alt: true }) },
  { id: 'app.fontDefault', label: 'Default font size', section: 'General', keys: key('Digit0', { meta: true, alt: true }) }
])
