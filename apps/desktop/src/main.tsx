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
const root = createRoot(document.getElementById('root')!)
void api().then((client) => root.render(quick ? <Quick api={client} /> : <Shell api={client} />))
