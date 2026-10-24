import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Every grammar Shiki ships is its own chunk, and tauri embeds every chunk in the app whether it loads or not.
// Diffs and the editor color these; other files show as plain text. Grammars a kept one embeds still come along
const LANGUAGES = new Set(
  'astro bat c clojure cmake cpp csharp css csv dart diff docker dotenv elixir erb erlang fish git-commit git-rebase go graphql groovy haskell hcl html http ini java javascript jinja json json5 jsonc jsonl jsx just kotlin latex less log lua make markdown mdx nginx nix objective-c ocaml perl php powershell prisma proto python r ruby rust sass scala scss shellscript shellsession sql svelte swift terraform toml tsx typescript vue xml yaml zig'.split(' ')
)

/** Shiki down to LANGUAGES, Mermaid without ELK (1.4 MB; diagrams asking for it fall back to dagre) */
function trimBundle(): Plugin {
  const trimmed = new Set<string>()
  return {
    name: 'trim-bundle',
    enforce: 'pre',
    transform(code, id) {
      if (/shiki\/dist\/langs-bundle-full-[^/]+\.mjs$/.test(id)) {
        let kept = 0
        const out = code.replace(/\t\{\n\t\t"id": "([^"]+)"[\s\S]*?\n\t\},?\n/g, (entry, name: string) => (LANGUAGES.has(name) ? (kept++, entry) : ''))
        if (kept !== LANGUAGES.size) this.error(`trim-bundle kept ${kept} of ${LANGUAGES.size} Shiki grammars`)
        trimmed.add('shiki')
        return out
      }
      if (id.includes('mermaid/dist/chunks/mermaid.core/') && code.includes('...elkLayoutLoaders()')) {
        trimmed.add('mermaid')
        return code.replace('...elkLayoutLoaders()', '').replace(/import\("\.\/elk-[A-Z0-9]+\.mjs"\)/, 'Promise.reject(new Error("ELK is not bundled"))')
      }
    },
    // A Shiki or Mermaid update that moves what this matches must fail the build, not quietly ship it all again
    buildEnd(error) {
      if (!error && this.environment.mode === 'build' && trimmed.size < 2) this.error(`trim-bundle only trimmed ${[...trimmed].join(', ') || 'nothing'}`)
    }
  }
}

// Tauri serves the dev server on a fixed port and expects no clearing of its own output
export default defineConfig({
  plugins: [react({ babel: { plugins: ['babel-plugin-react-compiler'] } }), tailwindcss(), trimBundle()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: '127.0.0.1' },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'safari16.4', minify: true, sourcemap: false },
})
