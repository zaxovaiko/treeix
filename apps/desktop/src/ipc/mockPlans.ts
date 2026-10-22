import type { Api, GraphImport, ImportKind, ModuleGraph, PlanFile } from './api'

// Phase 7 plan pane and module graph demo (owner G7): two plans, one with mermaid, and a graph shaped like
// this repo's app with one cycle, an unresolved import and external packages

type PlansApi = Pick<Api, 'plansList' | 'planRead' | 'graphScan'>

const AT = Date.UTC(2026, 9, 22, 11)
const PLANS_DIR = '/Users/me/.claude/plans'

const PLANS: Record<string, string> = {
  'snug-wiggling-cat.md': `# Routines engine in ptyd

Routines fire inside ptyd, so they run while Treeix is closed.

## Flow

\`\`\`mermaid
flowchart LR
  cron[Schedule] --> queue[Queue]
  poll[gh / acli poll] --> queue
  hook[Webhook] --> queue
  queue -->|slot free| run[Agent session]
  run -->|turns or cost over budget| kill[Kill]
  run --> history[History]
\`\`\`

## Steps

1. Parse cron with croner, local time
2. Poll \`gh api\` with ETags every 60 s
3. Spawn the agent with \`--max-turns\` and \`--permission-mode\`
4. Read the transcript's usage, kill at the cost cap

| Trigger | Place |
| --- | --- |
| Schedule | repo root or a new worktree |
| CI failed | the PR's worktree |
`,
  'brave-orange-fox.md': `# Fix the quick terminal cwd

- [x] Find where the quick terminal is created
- [ ] Pass the saved cwd
- [ ] Add a test
`,
}

const PLAN_FILES: PlanFile[] = Object.entries(PLANS).map(([name, text], i) => ({
  name,
  path: `${PLANS_DIR}/${name}`,
  title: /^# (.+)$/m.exec(text)?.[1] ?? name.replace(/\.md$/, ''),
  modifiedAt: AT - i * 26 * 3_600_000,
}))

const PACKAGES = [
  { name: 'treeix', dir: '' },
  { name: '@treeix/next', dir: 'apps/next' },
  { name: '@treeix/ui', dir: 'packages/ui' },
]

/** from, to (a file, `pkg:<name>` for an external package, `?` unresolved), kind, line */
const EDGES: [string, string, ImportKind, number][] = [
  ['apps/next/src/main.tsx', 'apps/next/src/shell/Shell.tsx', 'static', 3],
  ['apps/next/src/main.tsx', 'pkg:react-dom', 'static', 1],
  ['apps/next/src/shell/Shell.tsx', 'apps/next/src/shell/Panes.tsx', 'static', 4],
  ['apps/next/src/shell/Shell.tsx', 'apps/next/src/shell/Palette.tsx', 'static', 5],
  ['apps/next/src/shell/Shell.tsx', 'apps/next/src/ipc/api.ts', 'static', 2],
  ['apps/next/src/shell/Shell.tsx', 'apps/next/src/pages/settings/index.tsx', 'dynamic', 61],
  ['apps/next/src/shell/Panes.tsx', 'apps/next/src/panes/terminal/Terminal.tsx', 'static', 6],
  ['apps/next/src/shell/Panes.tsx', 'apps/next/src/panes/chat/Chat.tsx', 'static', 7],
  ['apps/next/src/shell/Panes.tsx', 'apps/next/src/shell/state.ts', 'type', 2],
  ['apps/next/src/shell/state.ts', 'apps/next/src/shell/Panes.tsx', 'static', 9],
  ['apps/next/src/panes/terminal/Terminal.tsx', 'pkg:@xterm/xterm', 'static', 1],
  ['apps/next/src/panes/terminal/Terminal.tsx', 'apps/next/src/ipc/api.ts', 'type', 3],
  ['apps/next/src/panes/chat/Chat.tsx', 'apps/next/src/ipc/api.ts', 'type', 2],
  ['apps/next/src/panes/chat/Chat.tsx', 'packages/ui/src/index.ts', 'static', 4],
  ['apps/next/src/ipc/api.ts', 'apps/next/src/ipc/bindings.ts', 'type', 4],
  ['apps/next/src/ipc/api.ts', 'apps/next/src/ipc/mock.ts', 'dynamic', 640],
  ['apps/next/src/ipc/api.ts', 'apps/next/src/ipc/tauri.ts', 'dynamic', 640],
  ['apps/next/src/ipc/tauri.ts', 'pkg:@tauri-apps/api', 'static', 1],
  ['apps/next/src/ipc/mock.ts', 'apps/next/src/ipc/api.ts', 'static', 1],
  ['apps/next/src/pages/settings/index.tsx', 'apps/next/src/features.ts', 'static', 3],
  ['apps/next/src/pages/settings/index.tsx', '?', 'static', 8],
  ['packages/ui/src/index.ts', 'packages/ui/src/Button.tsx', 'static', 1],
  ['packages/ui/src/Button.tsx', 'pkg:react', 'static', 1],
  ['scripts/bench.js', 'pkg:node:fs', 'require', 2],
]

function graph(root: string): ModuleGraph {
  const files = new Set<string>()
  const imports: GraphImport[] = EDGES.map(([from, to, kind, line]) => {
    files.add(from)
    const external = to.startsWith('pkg:') ? to.slice(4) : null
    const unresolved = to === '?'
    if (!external && !unresolved) files.add(to)
    return { from, to: external || unresolved ? null : to, specifier: external ?? (unresolved ? './sections-old' : `./${(to.split('/').at(-1) ?? to).replace(/\.\w+$/, '')}`), kind, external, unresolved, line }
  })
  const pkgOf = (path: string) => [...PACKAGES].reverse().find((p) => p.dir === '' || path.startsWith(`${p.dir}/`))?.name ?? null
  return {
    root,
    packages: PACKAGES,
    files: [...files].sort().map((path) => ({ path, package: pkgOf(path) })),
    imports,
    cycles: [['apps/next/src/shell/Panes.tsx', 'apps/next/src/shell/state.ts']],
    errors: [['scripts/legacy.js', 'Unexpected token (3:14)']],
  }
}

export function plansMock(): PlansApi {
  return {
    plansList: async () => PLAN_FILES,
    async planRead(name) {
      const text = PLANS[name]
      if (text === undefined) throw new Error(`no plan ${name}`)
      return text
    },
    graphScan: async (root) => graph(root),
  }
}
