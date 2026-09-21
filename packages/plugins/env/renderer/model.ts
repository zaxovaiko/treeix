import { classify, type Kind } from '../shared/classify'
import type { EnvFile, WorktreeEnv } from '../shared/types'

/** A name in a worktree's env file, or one its folder's template expects that no file there sets */
export type Row = {
  file: string
  name: string
  /** Null when missing */
  value: string | null
  /** 0 when missing */
  line: number
  kind: Kind
  reason: string
}

export const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const valueIn = (env: WorktreeEnv | null, file: string, name: string): string | undefined =>
  env?.files.find((candidate) => candidate.path === file)?.vars.find((entry) => entry.name === name)?.value

export function kindOf(env: WorktreeEnv, file: EnvFile, name: string, value: string): Pick<Row, 'kind' | 'reason'> {
  return classify(name, value, { frameworks: file.frameworks, annotation: env.annotations[folderOf(file.path)]?.[name] })
}

/** Every name the worktree sets, then the names its folders' templates expect and no file in that folder sets */
export function rowsOf(env: WorktreeEnv, main: WorktreeEnv | null): Row[] {
  const rows: Row[] = env.files.flatMap((file) => file.vars.map((entry) => ({ file: file.path, name: entry.name, value: entry.value, line: entry.line, ...kindOf(env, file, entry.name, entry.value) })))
  const seen = new Set(rows.map((row) => `${folderOf(row.file)}|${row.name}`))
  for (const template of env.templates) {
    const folder = folderOf(template.path)
    // Missing names land in the folder's first env file; a folder with none isn't reported
    const target = env.files.find((file) => folderOf(file.path) === folder)
    if (!target) continue
    for (const name of template.names) {
      if (seen.has(`${folder}|${name}`)) continue
      seen.add(`${folder}|${name}`)
      rows.push({ file: target.path, name, value: null, line: 0, ...kindOf(env, target, name, valueIn(main, target.path, name) ?? '') })
    }
  }
  return rows
}

/** `none`: a worktree without env files whose main has some, the fresh worktree git left without them */
export type Issues = { none: boolean; missing: number; exposed: number; drift: number }

/** `main` is null for the main worktree itself, which has nothing to drift from */
export function issuesOf(env: WorktreeEnv, main: WorktreeEnv | null): Issues {
  const rows = rowsOf(env, main)
  return {
    none: env.files.length === 0 && (main?.files.length ?? 0) > 0,
    missing: rows.filter((row) => row.value === null).length,
    exposed: rows.filter((row) => row.value !== null && row.kind === 'exposed').length,
    drift: rows.filter((row) => {
      const mainValue = row.value === null ? undefined : valueIn(main, row.file, row.name)
      return mainValue !== undefined && mainValue !== row.value
    }).length
  }
}

/** For tooltips: "1 exposed to the browser, 2 differ from main"; empty when all is well */
export function issueSummary(issues: Issues): string {
  if (issues.none) return 'No env files, main has some'
  return [
    issues.exposed && `${issues.exposed} exposed to the browser`,
    issues.missing && `${issues.missing} missing from .env.example`,
    issues.drift && `${issues.drift} differ from main`
  ]
    .filter(Boolean)
    .join(', ')
}

/** Red for what breaks or leaks, amber for what only differs */
export const issueTone = (issues: Issues): 'red' | 'amber' | null => (issues.none || issues.exposed || issues.missing ? 'red' : issues.drift ? 'amber' : null)

export const KIND_ORDER: Kind[] = ['exposed', 'secret', 'public']
export const worstKind = (kinds: Kind[]): Kind => KIND_ORDER.find((kind) => kinds.includes(kind)) ?? 'config'

export type Place = Row & { worktreePath: string }

/** Name to every place it is set or missing, across worktrees */
export function placesByName(worktrees: { env: WorktreeEnv; main: WorktreeEnv | null }[]): Map<string, Place[]> {
  const index = new Map<string, Place[]>()
  for (const { env, main } of worktrees) {
    for (const row of rowsOf(env, main)) index.set(row.name, [...(index.get(row.name) ?? []), { ...row, worktreePath: env.path }])
  }
  return new Map([...index].sort(([a], [b]) => a.localeCompare(b)))
}
