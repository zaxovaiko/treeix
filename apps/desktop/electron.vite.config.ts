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

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  // The diff highlighter worker lazy-loads grammars, which needs code-splitting ES workers
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    server: { fs: { allow: [root] } }
  }
})
