import { createRoot } from 'react-dom/client'
import { api } from './ipc/api'
import { Shell } from './shell/Shell'
import './styles/app.css'

if ('__TAURI_INTERNALS__' in window) {
  document.documentElement.classList.add('tauri')
  void import('./autorun').then((m) => m.autorun())
}
// WebKit's own menu (Reload, Inspect Element) never shows; text fields and selected text keep theirs for copy and paste
window.addEventListener('contextmenu', (e) => {
  const editable = e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
  if (!editable && !getSelection()?.toString()) e.preventDefault()
})
const root = createRoot(document.getElementById('root')!)
void api().then((client) => root.render(<Shell api={client} />))
