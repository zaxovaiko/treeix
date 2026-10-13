export const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]

/** One package.json in the worktree */
export type Package = {
  name: string
  version: string | null
  /** Worktree-relative path of the package.json */
  manifest: string
  dependencies: { name: string; range: string; kind: DependencyKind }[]
}

export type DependencyScan = {
  packages: Package[]
  /** Worktree-relative source files */
  files: string[]
  /** `[importer, imported]` as indexes into `files`, once per pair */
  imports: [number, number][]
}
