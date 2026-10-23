import { createRoot } from 'react-dom/client'
import { api } from './ipc/api'
import { Shell } from './shell/Shell'
import { Quick } from './shell/Quick'
import './styles/app.css'

const quick = new URLSearchParams(location.search).get('window') === 'quick'
if ('__TAURI_INTERNALS__' in window) {
  document.documentElement.classList.add('tauri')
  if (!quick) void import('./autorun').then((m) => m.autorun())
}
// WebKit's own menu (Reload, Inspect Element) never shows; text fields and selected text keep theirs for copy and paste
window.addEventListener('contextmenu', (e) => {
  const editable = e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')
  if (!editable && !getSelection()?.toString()) e.preventDefault()
})
const root = createRoot(document.getElementById('root')!)
void api().then((client) => root.render(quick ? <Quick api={client} /> : <Shell api={client} />))
