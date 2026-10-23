import { Channel } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { listen } from '@tauri-apps/api/event'
import type { Api, Attachment, ChatAttachment, ChatEntry, FsChange, SessionEvent, WorktreeStep } from './api'
import { commands, events, type Frame } from './bindings'
import { FRAME, parseFrame } from '../panes/terminal/stream'

const done = (call: Promise<unknown>): Promise<void> => call.then(() => undefined)

async function attach(id: string, onData: (bytes: Uint8Array, seq: number, resync?: boolean) => void): Promise<Attachment> {
  let resolveSnapshot: (bytes: Uint8Array) => void = () => {}
  const snapshot = new Promise<Uint8Array>((resolve) => (resolveSnapshot = resolve))
  const channel = new Channel<Frame>()
  channel.onmessage = (message) => {
    // Raw channel bodies arrive as an ArrayBuffer, not the number[] specta derives for Frame
    const { kind, seq, bytes } = parseFrame(message as unknown as ArrayBuffer)
    if (kind === FRAME.snapshot) resolveSnapshot(bytes)
    else onData(bytes, seq, kind === FRAME.resync)
  }
  // The snapshot is sent before the reply, and channel messages keep their order, so data never precedes it
  const { seq, info } = await commands.attach(id, channel)
  return { snapshot: await snapshot, seq, info, ack: (bytes) => done(commands.ack(id, channel.id, bytes)), detach: () => done(commands.detach(id, channel.id)) }
}

/** One `watch` per subscriber, told apart by id (unique across windows); the event carries every watch's changes */
function watch(root: string, file: string | null, cb: (change: FsChange) => void): () => void {
  const id = crypto.randomUUID()
  const unlisten = events.fsEvent.listen(({ payload }) => {
    if (payload.id === id) cb({ paths: payload.paths, git: payload.git })
  })
  commands.watch(id, root, file).catch((e: unknown) => console.warn('watch failed', root, file, e))
  return () => {
    void unlisten.then((stop) => stop())
    commands.unwatch(id).catch(() => {})
  }
}

/** Entries replayed and live arrive on one channel in seq order; the app drops duplicates */
async function chatAttach(chat: string, fromSeq: number, onEntry: (entry: ChatEntry) => void): Promise<ChatAttachment> {
  const channel = new Channel<ChatEntry>()
  channel.onmessage = onEntry
  const info = await commands.chatAttach(chat, fromSeq, channel)
  return { info, detach: () => done(commands.chatDetach(chat, channel.id)) }
}

function on<T, P>(event: { listen(cb: (e: { payload: P }) => void): Promise<() => void> }, pick: (payload: P) => T, cb: (value: T) => void): () => void {
  const unlisten = event.listen(({ payload }) => cb(pick(payload)))
  return () => void unlisten.then((stop) => stop())
}

export function tauriApi(): Api {
  return {
    hello: commands.hello,
    sessions: commands.sessions,
    create: (opts) =>
      commands.create({
        kind: opts.kind,
        cwd: opts.cwd ?? null,
        command: opts.command,
        env: opts.env,
        cols: opts.cols,
        rows: opts.rows,
        title: opts.title ?? null,
        routine: opts.routine ?? null,
      }),
    attach,
    write: (id, data) => done(typeof data === 'string' ? commands.write(id, data) : commands.writeBytes(id, Array.from(data))),
    resize: (id, cols, rows) => done(commands.resize(id, cols, rows)),
    kill: (id) => done(commands.kill(id)),
    remove: (id) => done(commands.remove(id)),
    restart: (id) => done(commands.restart(id)),
    clear: (id) => done(commands.clear(id)),
    getUi: commands.getUi,
    putUi: (json) => done(commands.putUi(json)),
    places: commands.places,
    homeDir: commands.homeDir,
    onEvent(cb) {
      const unlisten = listen<SessionEvent>('session-event', (event) => cb(event.payload))
      return () => void unlisten.then((stop) => stop())
    },

    listWorktrees: commands.listWorktrees,
    gitStatus: commands.gitStatus,
    diff: commands.diff,
    readFileAt: commands.readFileAt,
    fileLog: commands.fileLog,
    commitDiff: (root, sha, file) => commands.commitDiff(root, sha, file ?? null),
    listBranches: commands.listBranches,
    checkBranchName: commands.checkBranchName,
    createBranch: (repoPath, name, base) => done(commands.createBranch(repoPath, name, base)),
    deleteBranch: (repoPath, name, force) => done(commands.deleteBranch(repoPath, name, force)),
    addWorktree(request, onStep) {
      const channel = new Channel<WorktreeStep>()
      channel.onmessage = onStep
      return commands.addWorktree(request, channel)
    },
    removeWorktree: (path, force, deleteBranch) => done(commands.removeWorktree(path, force, deleteBranch)),
    pruneWorktrees: (repoPath) => done(commands.pruneWorktrees(repoPath)),
    discardChanges: (root, file) => done(commands.discardChanges(root, file)),

    listFiles: commands.listFiles,
    listDirectory: commands.listDirectory,
    readFile: commands.readFile,
    saveFile: (root, file, contents, expected) => done(commands.saveFile(root, file, contents, expected)),
    createPath: (root, file) => done(commands.createPath(root, file)),
    renamePath: (root, from, to) => done(commands.renamePath(root, from, to)),
    trashPath: (root, file) => done(commands.trashPath(root, file)),
    revealInFinder: (path) => done(commands.revealInFinder(path)),
    openPath: (path) => done(commands.openPath(path)),
    openUrl: (url) => done(commands.openUrl(url)),
    searchText: commands.searchText,
    watchFile: (root, file, cb) => watch(root, file, () => cb()),
    watchPlace: (root, cb) => watch(root, null, cb),

    listPullRequests: commands.listPullRequests,
    prChecks: commands.prChecks,
    mergePullRequest: (pr, method, deleteBranch) => done(commands.mergePullRequest(pr, method, deleteBranch)),
    prProviders: commands.prProviders,

    listHistory: commands.listHistory,
    readHistory: commands.readHistory,
    sessionHistory: commands.sessionHistory,
    forgetSession: (id) => done(commands.forgetSession(id)),

    agentUsage: commands.agentUsage,
    usageLimits: commands.usageLimits,
    onUsageLimits: (cb) => on(events.usageLimitsChanged, (p) => p.limits, cb),
    sessionUsage: commands.sessionUsage,
    sessionPorts: commands.sessionPorts,
    killPort: (port, pid) => done(commands.killPort(port, pid)),

    chatCreate: commands.chatCreate,
    chatPrompt: (chat, content) => done(commands.chatPrompt(chat, content)),
    chatCancel: (chat) => done(commands.chatCancel(chat)),
    chatAnswer: (chat, request, option) => done(commands.chatAnswer(chat, request, option)),
    chatSetOption: (chat, option, value) => done(commands.chatSetOption(chat, option, value)),
    chatList: commands.chatList,
    chatAttach,
    chatClose: (chat) => done(commands.chatClose(chat)),
    onChats: (cb) => on(events.chatsEvent, (p) => p, cb),

    mcpStatus: commands.mcpStatus,
    mcpInstall: commands.mcpInstall,
    myTickets: commands.myTickets,
    ticketDetail: commands.ticketDetail,
    notionDatabases: commands.notionDatabases,

    getSettings: commands.getSettings,
    updateSettings: (patch) => commands.updateSettings(patch),
    onSettings: (cb) => on(events.settingsChanged, (p) => p.settings, cb),
    hasSecret: commands.hasSecret,
    setSecret: (secret, value) => done(commands.setSecret(secret, value)),
    deleteSecret: (secret) => done(commands.deleteSecret(secret)),

    cliTools: commands.cliTools,
    runCommand: commands.runCommand,
    appVersion: getVersion,
    checkUpdate: commands.checkUpdate,
    installUpdate: () => done(commands.installUpdate()),
    keepAwake: commands.keepAwake,
    setKeepAwake: commands.setKeepAwake,
    onKeepAwake: (cb) => on(events.keepAwakeState, (p) => p, cb),
    phoneStatus: commands.phoneStatus,
    setPhone: commands.setPhone,

    routineList: commands.routineList,
    routinePut: commands.routinePut,
    routineRemove: (id) => done(commands.routineRemove(id)),
    routineRunNow: commands.routineRunNow,
    routineRuns: commands.routineRuns,
    routineCancelRun: (run) => done(commands.routineCancelRun(run)),
    routineNextFires: commands.routineNextFires,
    onRoutines: (cb) => on(events.routinesEvent, (p) => p, cb),

    browserOpen: commands.browserOpen,
    browserPlace: (pane, bounds) => done(commands.browserPlace(pane, bounds)),
    browserClose: (pane) => done(commands.browserClose(pane)),
    browserNavigate: (pane, input) => done(commands.browserNavigate(pane, input)),
    browserGo: (pane, nav) => done(commands.browserGo(pane, nav)),
    browserDevtools: (pane) => done(commands.browserDevtools(pane)),
    browserCookieProfiles: commands.browserCookieProfiles,
    browserImportCookies: commands.browserImportCookies,
    browserClearData: () => done(commands.browserClearData()),
    browserDevCommand: commands.browserDevCommand,
    onBrowser: (cb) => on(events.browserEvent, (p) => p, cb),

    plansList: commands.plansList,
    planRead: commands.planRead,
    graphScan: commands.graphScan,

    dictationStatus: commands.dictationStatus,
    dictationToggle: () => done(commands.dictationToggle()),
    voiceModelDownload: (model) => done(commands.voiceModelDownload(model)),
    voiceModelDelete: (model) => done(commands.voiceModelDelete(model)),
    voiceRequestAccess: (kind) => done(commands.voiceRequestAccess(kind)),
    dictationHistory: commands.dictationHistory,
    dictationForget: (at) => done(commands.dictationForget(at)),
    recordingStatus: commands.recordingStatus,
    recordingStart: commands.recordingStart,
    recordingPause: commands.recordingPause,
    recordingStop: commands.recordingStop,
    recordings: commands.recordings,
    recordingRead: commands.recordingRead,
    recordingDelete: (id) => done(commands.recordingDelete(id)),
    onVoice: (cb) => on(events.voiceEvent, (p) => p, cb),
  }
}
