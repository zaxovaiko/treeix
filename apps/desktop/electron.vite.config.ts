import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = resolve(__dirname, '../..')
// Plugins in packages/ import the app's modules through these, like a published SDK would be imported
const alias = {
  '@treeix/sdk/main': resolve(root, 'packages/sdk/src/main.ts'),
  '@treeix/sdk': resolve(root, 'packages/sdk/src/index.ts'),
  '@treeix/atlassian': resolve(root, 'packages/atlassian'),
  '@treeix/shared': resolve(__dirname, 'src/shared'),
  '@treeix/host': resolve(__dirname, 'src/main'),
  '@treeix/app': resolve(__dirname, 'src/renderer/src')
}

// Unpackaged Electron answers app.getVersion() with its own version, so the app's is baked in instead
const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string }
const define = { __APP_VERSION__: JSON.stringify(version) }

export default defineConfig({
  // The chat adapter SDK and zod are pure JS: bundled, only what's used ships instead of every zod build and locale
  main: { define, resolve: { alias }, build: { externalizeDeps: { exclude: ['@agentclientprotocol/sdk', 'zod'] } } },
  preload: {
    define,
    resolve: { alias },
    // The browser's pages get their own sandboxed preload, which the webview policy points at
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          browserInject: resolve(root, 'packages/plugins/browser/inject/preload.ts')
        }
      }
    }
  },
  // The diff highlighter worker lazy-loads grammars, which needs code-splitting ES workers
  renderer: {
    define,
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    // electron-vite leaves renderer output unminified; main and preload stay readable for stack traces
    build: { minify: true },
    server: { fs: { allow: [root] } }
  }
})
