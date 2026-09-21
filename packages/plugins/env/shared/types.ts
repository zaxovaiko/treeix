export type Annotation = 'secret' | 'public'

/** A name set in an env file, with the 1-based line that sets it; the last line wins when a name repeats */
export type EnvVar = { name: string; value: string; line: number }

export type EnvFile = {
  /** Relative to the worktree */
  path: string
  vars: EnvVar[]
  /** Dependencies of the nearest package.json at or above the file */
  frameworks: string[]
  /** Checked into git, so an edit shows up in the diff */
  tracked: boolean
}

/** `.env.example` and friends: what a folder expects, never edited from the page */
export type EnvTemplate = { path: string; names: string[]; frameworks: string[] }

export type WorktreeEnv = {
  path: string
  files: EnvFile[]
  templates: EnvTemplate[]
  /** `# @secret` / `# @public` from each folder's .env.example, by folder then name */
  annotations: Record<string, Record<string, Annotation>>
}

/** Sets `name` in `file`, adding the line or creating the file when needed */
export type EnvEdit = { worktreePath: string; file: string; name: string; value: string }

export type CopyMode = 'copy' | 'symlink' | 'example'

/** A place code reads a variable, from git grep */
export type Usage = { path: string; line: number }
