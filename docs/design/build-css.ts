// Compiles the app's real main.css for the classes the mockups use: bun docs/design/build-css.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

// Tailwind is installed in the desktop app only
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const { compile } = await import(require.resolve('@tailwindcss/node'))
const { Scanner } = await import(require.resolve('@tailwindcss/oxide'))

const here = dirname(new URL(import.meta.url).pathname)
const mainCss = join(here, '../../apps/desktop/src/renderer/src/main.css')
const compiler = await compile(readFileSync(mainCss, 'utf8'), { base: dirname(mainCss), onDependency: () => {} })
const candidates = new Scanner({ sources: [{ base: here, pattern: '*.html', negated: false }] }).scan()
writeFileSync(join(here, 'treeix.css'), compiler.build(candidates))
