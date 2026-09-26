import './main.css'
import { EditProvider, WorkerPoolContextProvider } from '@pierre/diffs/react'
import DiffsWorker from '@pierre/diffs/worker/worker.js?worker'
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './ErrorBoundary'
import { activeTheme, activeThemeId, codeThemes, fontStack, getSettings, hotkeyOptions, MONO_STACK, SANS_STACK, subscribeSettings } from './settings'
import { applyTheme } from './themes'

// Fetched while the settings below apply; ~330KB of editor code stays out of the entry chunk
const editModule = import('@pierre/diffs/edit')

function applyAppearance(): void {
  const { opacity, editorFontSize, uiFont, editorFont } = getSettings()
  const theme = activeTheme()
  applyTheme(activeThemeId(), theme, opacity / 100, getSettings().borderStrength / 100)
  document.documentElement.style.setProperty('--font-sans', fontStack(uiFont, SANS_STACK))
  document.documentElement.style.setProperty('--diffs-font-family', fontStack(editorFont, MONO_STACK))
  // Inherited into the diff components' shadow roots; rows keep the default 13px/20px proportion
  document.documentElement.style.setProperty('--diffs-font-size', `${editorFontSize}px`)
  document.documentElement.style.setProperty('--diffs-line-height', `${Math.round(editorFontSize * 1.54)}px`)
  // The System theme hands appearance back to macOS; otherwise prefers-color-scheme would stay on the last fixed theme's mode
  window.api.setTranslucent(opacity < 100, theme.background, getSettings().themeMode === 'system' ? 'system' : theme.mode)
  document.documentElement.toggleAttribute('data-translucent', opacity < 100)
  // Registering the same shortcut again is a no-op in the main process
  window.api.configureHotkey(hotkeyOptions())
}
applyAppearance()
subscribeSettings(applyAppearance)

// Highlight off the UI thread with grammars warmed at startup; without a pool
// the first file of each language renders blank until shiki finishes loading.
const poolOptions = { workerFactory: () => new DiffsWorker(), poolSize: getSettings().highlightWorkers }
const highlighterOptions = {
  // Both themes tokenize together; each component's themeType shows one, so switching appearance needs no re-highlight
  theme: codeThemes(),
  useTokenTransformer: true,
  // Other languages load on demand; each preloaded grammar costs memory in every worker
  langs: ['typescript', 'tsx', 'javascript', 'json', 'markdown']
}
// The provider reuses this singleton; picking another theme swaps the pool's code colors
const pool = getOrCreateWorkerPoolSingleton({ poolOptions, highlighterOptions })
subscribeSettings(() => void pool.setRenderOptions({ theme: codeThemes() }).catch(console.error))

// createEditor must return synchronously, so the first render waits for the editor chunk
const { Editor } = await editModule
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <EditProvider createEditor={(type, options, editStateKey) => new Editor(type, options, editStateKey)}>
        <ErrorBoundary label="Treeix" root>
          <App />
        </ErrorBoundary>
      </EditProvider>
    </WorkerPoolContextProvider>
  </StrictMode>
)
