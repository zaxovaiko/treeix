// The one surface the UI talks to. `tauri.ts` implements it over Tauri commands + channels,
// `mock.ts` in the browser (dev server, visual checks, tests). Mirrors crates/proto.

import type {
  Access,
  AccessKind,
  AgentLimits,
  AgentUsage,
  AgentView,
  Bounds,
  Browser,
  BrowserEntry,
  BrowserEvent,
  BrowserNav,
  BrowserProfile,
  BrowserState,
  Budget,
  ChatAgent,
  ChatCapabilities,
  ChatCommand,
  ChatContent,
  ChatEntry,
  ChatEvent,
  ChatInfo,
  ChatOption,
  ChatPreset,
  ChatRole,
  ChatsEvent,
  ChatStatus,
  CliTool,
  ConsoleLevel,
  CookieImport,
  Cost,
  CursorStyle,
  Dictation,
  DictationEntry,
  DictationPhase,
  DictationStatus,
  Features,
  GraphFile,
  GraphImport,
  GraphPackage,
  HelperState,
  ImportKind,
  KeepAwakeMode,
  KeepAwakeState,
  LimitWindow,
  LimitWindowName,
  McpAgent,
  McpInstall,
  McpInstallResult,
  McpInstallState,
  McpStatus,
  McpToolInfo,
  ModelPhase,
  ModuleGraph,
  NewChat,
  NotionDatabase,
  OptionCategory,
  OptionValue,
  Phone,
  PhoneStatus,
  PermissionKind,
  PermissionOption,
  PlanEntry,
  PlanFile,
  Recording,
  RecordingInfo,
  RecordingNote,
  RecordingPhase,
  RecordingStatus,
  Routine,
  RoutineEvent,
  RoutinePermission,
  RoutinePlace,
  RoutineResult,
  RoutineRun,
  Routines,
  RoutinesEvent,
  RunCause,
  RunStatus,
  Secret,
  SessionPort,
  SessionUsage,
  Settings,
  StopReason,
  Ticket,
  TicketDetail,
  TicketError,
  TicketKind,
  TicketList,
  TicketSource,
  ToolCall,
  ToolCallPatch,
  ToolKind,
  ToolLocation,
  ToolOutput,
  ToolStatus,
  TranscriptLine,
  TrayLabel,
  Trigger,
  TurnUsage,
  UpdateInfo,
  UsageLimits,
  UsageRow,
  VocabularyTerm,
  VoiceEvent,
  VoiceModel,
  WhileAsleep,
} from './bindings'

export type SessionKind = 'shell' | 'claude' | 'codex' | 'routine'
/** `watching`: an agent's turn ended with background work still running (Phase 4) */
export type SessionStatus = 'running' | 'needs' | 'done' | 'idle' | 'exited' | 'error' | 'restored' | 'crashed' | 'watching'

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

export type ProgressState = 'off' | 'normal' | 'error' | 'indeterminate' | 'paused'

export type SessionEvent =
  | { type: 'status'; session: string; status: SessionStatus }
  | { type: 'exit'; session: string; code: number | null }
  | { type: 'title'; session: string; title: string }
  | { type: 'cwd'; session: string; cwd: string }
  | { type: 'notify'; session: string; title: string; body: string }
  | { type: 'bell'; session: string }
  | { type: 'created'; info: SessionInfo }
  | { type: 'removed'; session: string }
  /** The agent's conversation id became known (Claude hook or Codex rollout); `SessionInfo.agentSession` */
  | { type: 'agentSession'; session: string; agentSession: string }
  /** OSC 9;4 progress the session reported; `off` once it ends or the session exits */
  | { type: 'progress'; session: string; state: ProgressState; percent: number }
  /** A shell started Claude or Codex in the foreground, or got back to its prompt */
  | { type: 'kind'; session: string; kind: SessionKind }
  /** The daemon restarted (crash or upgrade); re-list and re-attach */
  | { type: 'daemon'; state: 'connected' | 'disconnected' }

export interface Attachment {
  /** Screen + scrollback as ANSI; write it before any data */
  snapshot: Uint8Array
  /** Seq the snapshot ends at */
  seq: number
  info: SessionInfo
  /** Bytes xterm has rendered (write callback); a view that falls behind gets a resync once it caught up */
  ack(bytes: number): Promise<void>
  /** Stops the stream; the session keeps running in the daemon */
  detach(): Promise<void>
}

export interface Api {
  hello(): Promise<{ proto: number; build: string; daemonPid: number }>
  sessions(): Promise<SessionInfo[]>
  create(opts: CreateSession): Promise<SessionInfo>
  /** `onData` gets output from `seq` on. `resync`: the view fell behind, `bytes` is the screen that replaces it */
  attach(id: string, onData: (bytes: Uint8Array, seq: number, resync?: boolean) => void): Promise<Attachment>
  write(id: string, data: string | Uint8Array): Promise<void>
  resize(id: string, cols: number, rows: number): Promise<void>
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

  // Git
  /** Main checkout first, then linked worktrees, missing ones included */
  listWorktrees(repoPath: string): Promise<Worktree[]>
  /** Null when `path` is not in a git checkout */
  gitStatus(path: string): Promise<GitStatus | null>
  diff(path: string, scope: DiffScope): Promise<FilePatch[]>
  /** The file at `rev` (`HEAD`, `origin/main`, a sha); null when missing there or binary. Replaces readHeadFile */
  readFileAt(root: string, file: string, rev: string): Promise<string | null>
  /** Commits that touched the file, newest first */
  fileLog(root: string, file: string): Promise<Commit[]>
  /** What one commit changed, only `file` when given */
  commitDiff(root: string, sha: string, file?: string): Promise<FilePatch[]>
  /** Local branches plus remote-only ones, newest commit first */
  listBranches(repoPath: string): Promise<Branch[]>
  checkBranchName(name: string): Promise<boolean>
  createBranch(repoPath: string, name: string, base: string): Promise<void>
  /** Safe delete unless `force` */
  deleteBranch(repoPath: string, name: string, force: boolean): Promise<void>
  /** Resolves with the new worktree's path; `onStep` gets each step's progress. Rejects when a step fails; call again to Retry */
  addWorktree(request: NewWorktree, onStep: (step: WorktreeStep) => void): Promise<string>
  /** Refuses the main checkout; `deleteBranch` also force-deletes its branch */
  removeWorktree(path: string, force: boolean, deleteBranch: boolean): Promise<void>
  pruneWorktrees(repoPath: string): Promise<void>
  /** Restores a tracked file to HEAD, deletes an untracked one */
  discardChanges(root: string, file: string): Promise<void>

  // Files
  /** Null when the root is gone */
  listFiles(root: string): Promise<PlaceFiles | null>
  /** Names in one folder, folders ending with `/` */
  listDirectory(root: string, folder: string): Promise<string[]>
  /** Null for binary files and files over 2 MB */
  readFile(root: string, file: string): Promise<string | null>
  /** Snapshots the old version into local history first. Rejects with SAVE_CONFLICT when the disk no longer matches `expected`; null overwrites */
  saveFile(root: string, file: string, contents: string, expected: string | null): Promise<void>
  /** A path ending in `/` creates a folder */
  createPath(root: string, file: string): Promise<void>
  renamePath(root: string, from: string, to: string): Promise<void>
  /** Moves to the Trash */
  trashPath(root: string, file: string): Promise<void>
  revealInFinder(path: string): Promise<void>
  /** Opens with the default app */
  openPath(path: string): Promise<void>
  /** http(s) only */
  openUrl(url: string): Promise<void>
  /** Rejects with the regex error when `regex` is on and the pattern is invalid */
  searchText(roots: string[], query: string, options: SearchOptions): Promise<SearchResult>
  /** Calls back on changes to one file, our own saves included; returns the unsubscribe */
  watchFile(root: string, file: string, cb: () => void): () => void
  /** Calls back on debounced changes anywhere under a place (Explorer, Changes, git status); returns the unsubscribe */
  watchPlace(root: string, cb: (change: FsChange) => void): () => void

  // Pull requests
  listPullRequests(repoPaths: string[]): Promise<PullRequestList>
  prChecks(pr: PrRef): Promise<Check[]>
  mergePullRequest(pr: PrRef, method: MergeMethod, deleteBranch: boolean): Promise<void>
  /** gh and glab: installed, signed in, as whom */
  prProviders(): Promise<ProviderStatus[]>

  // History
  /** Local snapshots of a file, newest first */
  listHistory(root: string, file: string): Promise<HistoryEntry[]>
  readHistory(root: string, file: string, id: string): Promise<string>
  /** Closed sessions, newest first; resume with `create` */
  sessionHistory(): Promise<SessionRecord[]>
  forgetSession(id: string): Promise<void>

  // Phase 4-5. Contract: docs/contracts/phase45-contract.md. Each call rejects with a message string.
  // Agents (A3)
  /** Token rows for the usage popover and Settings > Usage, from Claude transcripts and Codex rollouts */
  agentUsage(): Promise<AgentUsage>
  /** Plan limits now; changes arrive through `onUsageLimits` */
  usageLimits(): Promise<UsageLimits>
  onUsageLimits(cb: (limits: UsageLimits) => void): () => void
  /** Tokens and cost of one agent session's conversation; null when it has no agent session yet */
  sessionUsage(session: string): Promise<SessionUsage | null>
  /** TCP ports the sessions' process trees listen on, for the ports popover */
  sessionPorts(): Promise<SessionPort[]>
  /** Kills the listener; refuses a pid that no longer listens on `port` */
  killPort(port: number, pid: number): Promise<void>
  // Chat (A4): ACP agents run inside ptyd and outlive the app
  /** Starts the agent adapter; the chat is `starting` until it connects */
  chatCreate(chat: NewChat): Promise<ChatInfo>
  /** Sends a user turn; a disconnected chat starts its agent again first */
  chatPrompt(chat: string, content: ChatContent[]): Promise<void>
  /** Cancels the running turn; pending permission requests settle */
  chatCancel(chat: string): Promise<void>
  /** Answers a `permission` event; null option rejects it */
  chatAnswer(chat: string, request: string, option: string | null): Promise<void>
  /** Sets a `ChatOption` (model, effort, mode) */
  chatSetOption(chat: string, option: string, value: string): Promise<void>
  chatList(): Promise<ChatInfo[]>
  /** Replays the log from `fromSeq` (0: all of it), then streams new entries in seq order */
  chatAttach(chat: string, fromSeq: number, onEntry: (entry: ChatEntry) => void): Promise<ChatAttachment>
  /** Stops the agent and forgets the chat; the conversation stays resumable from History */
  chatClose(chat: string): Promise<void>
  /** A chat was created, changed or closed, in any window */
  onChats(cb: (e: ChatsEvent) => void): () => void
  // MCP (A5)
  /** The in-app MCP server and whether each agent has it registered */
  mcpStatus(): Promise<McpStatus>
  /** Registers the server with every installed agent that misses it or has an old entry */
  mcpInstall(): Promise<McpInstallResult>
  // Tickets (A5)
  /** Jira (acli) and Notion tickets assigned to me, for "Your tickets" in Open worktree */
  myTickets(): Promise<TicketList>
  ticketDetail(source: TicketSource, key: string): Promise<TicketDetail>
  /** Databases the Notion token can see, for Settings > Notion */
  notionDatabases(): Promise<NotionDatabase[]>
  // Settings (U6)
  getSettings(): Promise<Settings>
  /** Merges the patch, saves, returns the result and fires `onSettings` in every window */
  updateSettings(patch: SettingsPatch): Promise<Settings>
  onSettings(cb: (settings: Settings) => void): () => void
  /** Whether a secret is in the keyring; secrets never come back to the UI */
  hasSecret(secret: Secret): Promise<boolean>
  setSecret(secret: Secret, value: string): Promise<void>
  deleteSecret(secret: Secret): Promise<void>
  // System (U6)
  /** claude, codex, acli, gh, glab: installed, version, signed in */
  cliTools(): Promise<CliTool[]>
  /** A one-off command in the login shell at `cwd`, no terminal: its output; rejects with the output when it fails */
  runCommand(cwd: string, command: string): Promise<string>
  appVersion(): Promise<string>
  /** null when this is the newest version */
  checkUpdate(): Promise<UpdateInfo | null>
  /** Downloads and installs the update `checkUpdate` found, then restarts the app */
  installUpdate(): Promise<void>
  keepAwake(): Promise<KeepAwakeState>
  /** Turns the toggle on or off; `settings.awake.mode` decides when it holds */
  setKeepAwake(on: boolean): Promise<KeepAwakeState>
  onKeepAwake(cb: (state: KeepAwakeState) => void): () => void
  phoneStatus(): Promise<PhoneStatus>
  /** Serves the phone page over Tailscale or stops it; asks for the admin password */
  setPhone(on: boolean): Promise<PhoneStatus>
  // Phase 6-7. Contract: docs/contracts/phase67-contract.md
  // Routines (R6 engine in ptyd, U7 UI): they fire in ptyd, also while the app is closed
  /** Every routine, by name */
  routineList(): Promise<Routine[]>
  /** Creates (empty id) or replaces a routine; ptyd fills id, created_at and a webhook token */
  routinePut(routine: Routine): Promise<Routine>
  /** Removes the routine; its finished runs stay in History */
  routineRemove(id: string): Promise<void>
  /** Fires it now (cause `manual`); queued when every slot is busy */
  routineRunNow(id: string): Promise<RoutineRun>
  /** Runs newest first, of one routine or all (null), at most `limit` */
  routineRuns(routine: string | null, limit: number): Promise<RoutineRun[]>
  /** Kills a running run or drops a queued one; it ends `cancelled` */
  routineCancelRun(run: string): Promise<void>
  /** The next `count` (max 20) fire times of a cron in local time, unix ms; rejects an invalid cron */
  routineNextFires(cron: string, count: number): Promise<number[]>
  /** A routine changed or was removed, or a run was queued, changed or ended, in any window */
  onRoutines(cb: (e: RoutinesEvent) => void): () => void
  // Browser pane (B7): a child webview per `browser:<pane>` leaf, laid over the leaf's rect
  /** Creates the pane's webview (or returns the live one) and loads `url` */
  browserOpen(pane: string, url: string): Promise<BrowserState>
  /** Moves the webview over the leaf, in CSS px of the window; null hides it (popover, dialog, other tab) */
  browserPlace(pane: string, bounds: Bounds | null): Promise<void>
  /** Destroys the webview */
  browserClose(pane: string): Promise<void>
  /** A URL, `localhost:5173`, or words searched with `settings.browser.searchUrl` */
  browserNavigate(pane: string, input: string): Promise<void>
  browserGo(pane: string, nav: BrowserNav): Promise<void>
  /** Opens the webview's own DevTools window */
  browserDevtools(pane: string): Promise<void>
  /** Browser profiles on this machine cookies can be imported from */
  browserCookieProfiles(): Promise<BrowserProfile[]>
  /** Copies the profile's cookies into the browser panes' store */
  browserImportCookies(profile: string): Promise<CookieImport>
  /** Drops cookies, storage and cache of every browser pane */
  browserClearData(): Promise<void>
  /** The dev server command of a folder (package.json `dev`/`start`, with its package manager); null when none */
  browserDevCommand(folder: string): Promise<string | null>
  /** Navigation, console and network entries, closes; pushed to every window */
  onBrowser(cb: (e: BrowserEvent) => void): () => void
  // Plans and module graph (G7)
  /** Claude Code's plans in ~/.claude/plans, newest first; watch the folder with `watchPlace` */
  plansList(): Promise<PlanFile[]>
  /** A plan's markdown, by file name */
  planRead(name: string): Promise<string>
  /** Parses every JS/TS file under the root and resolves its imports */
  graphScan(root: string): Promise<ModuleGraph>
  // Dictation and recording (V7): the treeix-voice and treeix-meetings sidecars, macOS on Apple silicon only
  dictationStatus(): Promise<DictationStatus>
  /** Starts or stops listening, like a tap of the hotkey */
  dictationToggle(): Promise<void>
  /** Downloads a speech model; progress arrives as `dictation` events */
  voiceModelDownload(model: string): Promise<void>
  voiceModelDelete(model: string): Promise<void>
  /** Shows the OS prompt, or opens System Settings when it was denied */
  voiceRequestAccess(kind: AccessKind): Promise<void>
  /** Recent dictations, newest first */
  dictationHistory(): Promise<DictationEntry[]>
  /** Drops one dictation by its `at`, or the whole history when null */
  dictationForget(at: number | null): Promise<void>
  recordingStatus(): Promise<RecordingStatus>
  /** Records the microphone and system audio; null title names it by date */
  recordingStart(title: string | null): Promise<RecordingStatus>
  recordingPause(paused: boolean): Promise<RecordingStatus>
  /** Stops; the transcript and note are written while `saving`, then a `saved` event */
  recordingStop(): Promise<RecordingStatus>
  /** Saved recordings, newest first */
  recordings(): Promise<RecordingInfo[]>
  recordingRead(id: string): Promise<RecordingNote>
  /** Moves the recording's folder to the Trash */
  recordingDelete(id: string): Promise<void>
  /** Dictation and recording status, partial words, live transcript lines, saved recordings */
  onVoice(cb: (e: VoiceEvent) => void): () => void
}

// Phase 4-7 types are the generated ones (bindings.ts carries their docs)
export type {
  Access,
  AccessKind,
  AgentLimits,
  AgentUsage,
  AgentView,
  Bounds,
  Browser,
  BrowserEntry,
  BrowserEvent,
  BrowserNav,
  BrowserProfile,
  BrowserState,
  Budget,
  ChatAgent,
  ChatCapabilities,
  ChatCommand,
  ChatContent,
  ChatEntry,
  ChatEvent,
  ChatInfo,
  ChatOption,
  ChatPreset,
  ChatRole,
  ChatsEvent,
  ChatStatus,
  CliTool,
  ConsoleLevel,
  CookieImport,
  Cost,
  CursorStyle,
  Dictation,
  DictationEntry,
  DictationPhase,
  DictationStatus,
  Features,
  GraphFile,
  GraphImport,
  GraphPackage,
  HelperState,
  ImportKind,
  KeepAwakeMode,
  KeepAwakeState,
  LimitWindow,
  LimitWindowName,
  McpAgent,
  McpInstall,
  McpInstallResult,
  McpInstallState,
  McpStatus,
  McpToolInfo,
  ModelPhase,
  ModuleGraph,
  NewChat,
  NotionDatabase,
  OptionCategory,
  OptionValue,
  Phone,
  PhoneStatus,
  PermissionKind,
  PermissionOption,
  PlanEntry,
  PlanFile,
  Recording,
  RecordingInfo,
  RecordingNote,
  RecordingPhase,
  RecordingStatus,
  Routine,
  RoutineEvent,
  RoutinePermission,
  RoutinePlace,
  RoutineResult,
  RoutineRun,
  Routines,
  RoutinesEvent,
  RunCause,
  RunStatus,
  Secret,
  SessionPort,
  SessionUsage,
  Settings,
  StopReason,
  Ticket,
  TicketDetail,
  TicketError,
  TicketKind,
  TicketList,
  TicketSource,
  ToolCall,
  ToolCallPatch,
  ToolKind,
  ToolLocation,
  ToolOutput,
  ToolStatus,
  TranscriptLine,
  TrayLabel,
  Trigger,
  TurnUsage,
  UpdateInfo,
  UsageLimits,
  UsageRow,
  VocabularyTerm,
  VoiceEvent,
  VoiceModel,
  WhileAsleep,
}

/** Any subset of the settings, one section deep: `{ terminal: { fontSize: 13 } }` */
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> }

export interface ChatAttachment {
  /** The chat as of the attach; entries from `fromSeq` up to `info.seq` replay first */
  info: ChatInfo
  /** Stops this stream; the chat keeps running */
  detach(): Promise<void>
}

// Phase 3: git, files, search, pull requests, history. Contract: docs/contracts/phase3-contract.md.
// Paths named `file` are relative to `root` (a place's path); a path that resolves outside the root is refused.

/** One `git worktree list` entry */
export interface Worktree {
  path: string
  /** Short sha; empty before the first commit */
  head: string
  /** Null when detached */
  branch: string | null
  /** The repo's main checkout */
  main: boolean
  /** Folder is gone; `pruneWorktrees` drops it */
  missing: boolean
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted'

export interface Change {
  path: string
  status: ChangeStatus
  oldPath: string | null
}

/** Everything the Changes panel, sidebar badges and Cleanup dialog show about one checkout */
export interface GitStatus {
  branch: string | null
  /** Short sha; null before the first commit */
  head: string | null
  /** Like `origin/feat/x`; null when never pushed */
  upstream: string | null
  ahead: number
  behind: number
  /** Upstream deleted, typically after its PR merged */
  gone: boolean
  /** Default branch, like `main` */
  base: string | null
  /** Commits on this branch not in the base */
  baseAhead: number
  merged: boolean
  /** Interrupted rebase: `step` of `total` applied */
  rebase: { step: number; total: number } | null
  conflicts: string[]
  /** Uncommitted, untracked included */
  changes: Change[]
}

/** `local`: uncommitted vs HEAD. `base`: what the PR shows, merge base with the base branch vs the working tree */
export type DiffScope = 'local' | 'base'

export interface FilePatch {
  path: string
  oldPath: string | null
  status: ChangeStatus
  /** `diff --git` text with headers; empty for binary files */
  patch: string
  additions: number
  deletions: number
}

export interface Branch {
  /** Remote-only branches are named like `origin/feat/x` */
  name: string
  remote: boolean
  ahead: number
  behind: number
  gone: boolean
  merged: boolean
  /** Unix seconds of the last commit */
  committedAt: number
  author: string
  /** Worktree that has it checked out */
  worktree: string | null
}

export interface Commit {
  sha: string
  author: string
  /** Unix seconds */
  date: number
  subject: string
}

/** Open worktree dialog request. Exactly one of `branch` or `pr` */
export interface NewWorktree {
  repoPath: string
  /** Checked out if local, tracks origin if only there, otherwise created from `base` */
  branch: string | null
  /** Start point for a new branch; default `origin/<default branch>` */
  base: string | null
  /** PR/MR number: fetches its head into a detached `pr-N` / `mr-N` worktree */
  pr: number | null
  copyEnv: boolean
  /** Setup command run in the new worktree, like `bun install` */
  setup: string | null
  /** "Continue without fetching" after a failed fetch */
  skipFetch: boolean
}

export type StepId = 'fetch' | 'add' | 'env' | 'setup'
export type StepState = 'running' | 'done' | 'failed' | 'skipped'

export interface WorktreeStep {
  step: StepId
  state: StepState
  /** Command line shown next to the step */
  command: string
  error: string | null
}

export interface PlaceFiles {
  /** Relative paths, .gitignore respected */
  files: string[]
  /** Ignored paths; folders end with `/` and are not expanded */
  ignored: string[]
}

/** A debounced change under a watched place */
export interface FsChange {
  /** Relative paths, `.git` excluded */
  paths: string[]
  /** Something under `.git` changed: re-read git status */
  git: boolean
}

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchMatch {
  /** The searched root it is under */
  root: string
  path: string
  /** 1-based */
  line: number
  /** 0-based, UTF-16 units of `text` */
  column: number
  length: number
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  /** A limit was hit (2000 matches, 100 per file) */
  truncated: boolean
}

export type Provider = 'github' | 'gitlab'
export type CheckStatus = 'passed' | 'failed' | 'running' | 'skipped'
export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface PullRequest {
  provider: Provider
  repoPath: string
  number: number
  title: string
  author: string
  authorAvatarUrl: string | null
  sourceBranch: string
  targetBranch: string
  /** Short sha of the head commit */
  head: string
  state: 'open' | 'merged' | 'closed'
  draft: boolean
  /** RFC 3339 */
  updatedAt: string
  url: string
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  /** Your relation to an open PR */
  review: {
    state: 'yours' | 'requested' | 'approved' | 'changes' | 'commented' | 'unreviewed'
    newCommits: number
    changesRequested: boolean
  } | null
  conflicts: boolean
  /** CI on the head commit; `done` of `total` for "CI 3/5" */
  pipeline: { status: CheckStatus; done: number; total: number; url: string } | null
}

export interface PullRequestList {
  pullRequests: PullRequest[]
  /** Repos that could not be listed; the rest still are */
  errors: { repoPath: string; message: string }[]
}

export interface PrRef {
  provider: Provider
  repoPath: string
  number: number
}

export interface Check {
  name: string
  status: CheckStatus
  url: string | null
}

export interface ProviderStatus {
  provider: Provider
  installed: boolean
  signedIn: boolean
  /** Your login, which "Mine" filters on */
  user: string | null
}

export interface HistoryEntry {
  /** Ms timestamp as a string */
  id: string
  savedAt: number
  bytes: number
}

/** A closed session, for the History panel */
export interface SessionRecord {
  id: string
  kind: 'shell' | 'claude' | 'codex'
  title: string
  cwd: string
  branch: string | null
  repoRoot: string | null
  /** What `claude --resume` / `codex resume` takes */
  agentSession: string | null
  command: string[]
  createdAt: number
  closedAt: number
  /** Transcript stats; null until Phase 4 */
  messages: number | null
  cost: number | null
  firstPrompt: string | null
  /** The routine run this session was (`RoutineRun.id`) */
  run?: string | null
}

/** Webhook routines listen on `http://127.0.0.1:${WEBHOOK_PORT}/r/<token>` (crates/proto routines.rs) */
export const WEBHOOK_PORT = 47311

/** The message `saveFile` rejects with when the file changed on disk */
export const SAVE_CONFLICT = 'SAVE_CONFLICT'

let current: Api | null = null

/** Tauri when running inside the app, the in-browser mock otherwise */
export async function api(): Promise<Api> {
  if (current) return current
  const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  current = inTauri ? (await import('./tauri')).tauriApi() : (await import('./mock')).mockApi()
  return current
}
