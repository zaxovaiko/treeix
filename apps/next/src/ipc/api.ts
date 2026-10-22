// The one surface the UI talks to. `tauri.ts` implements it over Tauri commands + channels,
// `mock.ts` in the browser (dev server, visual checks, tests). Mirrors crates/proto.

export type SessionKind = 'shell' | 'claude' | 'codex' | 'routine'
export type SessionStatus = 'running' | 'needs' | 'done' | 'idle' | 'exited' | 'error' | 'restored' | 'crashed'

export interface SessionInfo {
  id: string
  kind: SessionKind
  cwd: string
  title: string
  status: SessionStatus
  pid: number | null
  exitCode: number | null
  cols: number
  rows: number
  createdAt: number
  command: string[]
  seq: number
  agentSession: string | null
  routine: string | null
}

export interface CreateSession {
  kind: SessionKind
  cwd?: string
  command?: string[]
  env?: [string, string][]
  cols: number
  rows: number
  title?: string
  routine?: string
}

export type PlaceKind = 'root' | 'worktree' | 'git' | 'folder' | 'scratch' | 'detached'

/** Where a session runs. Sessions group by `key` in the sidebar */
export interface Place {
  /** Group key: the checkout's top-level dir, or the folder itself */
  key: string
  kind: PlaceKind
  /** Display name: branch for root/worktree, folder name otherwise, `~` for scratch */
  name: string
  path: string
  /** Main checkout of the repo this place belongs to (root and worktrees share it) */
  repoRoot: string | null
  repoName: string | null
  branch: string | null
  /** Short sha when detached */
  head: string | null
  /** Folder no longer exists */
  missing: boolean
}

export type SessionEvent =
  | { type: 'status'; session: string; status: SessionStatus }
  | { type: 'exit'; session: string; code: number | null }
  | { type: 'title'; session: string; title: string }
  | { type: 'cwd'; session: string; cwd: string }
  | { type: 'notify'; session: string; title: string; body: string }
  | { type: 'bell'; session: string }
  | { type: 'created'; info: SessionInfo }
  | { type: 'removed'; session: string }
  /** The daemon restarted (crash or upgrade); re-list and re-attach */
  | { type: 'daemon'; state: 'connected' | 'disconnected' }

export interface Attachment {
  /** Screen + scrollback as ANSI; write it before any data */
  snapshot: Uint8Array
  /** Seq the snapshot ends at */
  seq: number
  info: SessionInfo
  /** Stops the stream; the session keeps running in the daemon */
  detach(): Promise<void>
}

export interface Api {
  hello(): Promise<{ proto: number; build: string; daemonPid: number }>
  sessions(): Promise<SessionInfo[]>
  create(opts: CreateSession): Promise<SessionInfo>
  /** `onData` gets output from `seq` on. Call `ack` with bytes once xterm has rendered them (write callback) */
  attach(id: string, onData: (bytes: Uint8Array, seq: number) => void): Promise<Attachment>
  write(id: string, data: string | Uint8Array): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
  ack(id: string, bytes: number): Promise<void>
  kill(id: string): Promise<void>
  remove(id: string): Promise<void>
  /** Runs an exited, restored or crashed session's command again in place, keeping its scrollback */
  restart(id: string): Promise<void>
  /** Shift+Cmd+K: drops the scrollback and the lines above the cursor in the daemon too */
  clear(id: string): Promise<void>
  /** Opaque UI state persisted by the daemon next to the sessions */
  getUi(): Promise<string | null>
  putUi(json: string): Promise<void>
  /** Resolves each cwd to its place (git top-level, worktree, branch) */
  places(paths: string[]): Promise<Place[]>
  homeDir(): Promise<string>
  onEvent(cb: (e: SessionEvent) => void): () => void
}

let current: Api | null = null

/** Tauri when running inside the app, the in-browser mock otherwise */
export async function api(): Promise<Api> {
  if (current) return current
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  current = inTauri ? (await import('./tauri')).tauriApi() : (await import('./mock')).mockApi()
  return current
}
