import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Notification, shell, systemPreferences } from 'electron'
import { type NativeHelper, nativeBinary, nativeHelpersSupported, speechModelsPath, superviseHelper } from '@treeix/host/nativeHelper'
import { isString, object, text } from '@treeix/shared/json'
import type { MainPlugin } from '@treeix/sdk/main'
import { type CalendarEvent, clock, type Meeting, type Permissions, parseSettings, type Status } from '../shared/types'
import { type Call, type DetectorState, detect, needsTabs, step, type Tab } from './detector'
import { type HelperCommand, type HelperMessage, parseHelperMessage } from './protocol'
import { createStore } from './store'

const TICK_MS = 2_000
const ASK_TIMEOUT_MS = 5_000
const DAY_MS = 86_400_000

const CHROME_TABS = `tell application "Google Chrome"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (URL of t) & tab & (title of t) & linefeed
    end repeat
  end repeat
  return out
end tell`

async function chromeTabs(): Promise<Tab[]> {
  const { stdout } = await promisify(execFile)('osascript', ['-e', CHROME_TABS], { timeout: ASK_TIMEOUT_MS })
  return stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [url, ...title] = line.split('\t')
      return { url, title: title.join('\t') }
    })
}

const PANES = { Microphone: 'Privacy_Microphone', 'System audio': 'Privacy_ScreenCapture', Calendars: 'Privacy_Calendars', Automation: 'Privacy_Automation' } as const
type Pane = keyof typeof PANES

const plugin: MainPlugin = {
  activate: (context) => {
    let settings = parseSettings({})
    const store = createStore(() => settings.folder || join(context.dataPath, 'meetings'))
    let status: Status = { helper: nativeHelpersSupported ? 'starting' : 'unsupported', recording: null, error: null }
    const setStatus = (patch: Partial<Status>): void => {
      status = { ...status, ...patch }
      context.broadcast('status', status)
    }
    const changed = (): void => context.broadcast('changed')
    let helper: NativeHelper | null = null
    const command = (message: HelperCommand): void => helper?.send(message)
    let micApps: string[] = []
    let detector: DetectorState = { state: 'idle' }
    let starting = false
    let ticking = false
    let calendarAccess = 'unknown'
    /** Folders sent to the helper to transcribe; a helper that dies on one fails it, so it isn't retried forever */
    const transcribing = new Set<string>()

    // The menu bar shows a recording's time and that transcripts are being made, like a call app's indicator
    let shown = ''
    const showMenuBar = (): void => {
      const { recording } = status
      const next = recording
        ? { title: `● ${clock(Date.now() - recording.since)}`, meters: [], lines: [`Recording ${recording.title}`] }
        : transcribing.size
          ? { title: 'Transcribing…', meters: [], lines: [`Transcribing ${transcribing.size === 1 ? 'a meeting' : `${transcribing.size} meetings`}`] }
          : null
      if (JSON.stringify(next) === shown) return
      shown = JSON.stringify(next)
      context.menuBar(next)
    }
    const menuBarClock = setInterval(showMenuBar, 1000)
    context.onDispose(() => clearInterval(menuBarClock))

    /** One reply of each type is awaited at a time; a newer question answers the older one with null */
    const waiting = new Map<HelperMessage['type'], (message: HelperMessage | null) => void>()
    const ask = (message: HelperCommand, reply: HelperMessage['type']): Promise<HelperMessage | null> =>
      new Promise((resolve) => {
        waiting.get(reply)?.(null)
        const timer = setTimeout(() => answer(reply, null), ASK_TIMEOUT_MS)
        waiting.set(reply, (answered) => {
          clearTimeout(timer)
          resolve(answered)
        })
        command(message)
      })
    const answer = (type: HelperMessage['type'], message: HelperMessage | null): void => {
      const resolve = waiting.get(type)
      waiting.delete(type)
      resolve?.(message)
    }

    const update = async (id: string, patch: Partial<Meeting>): Promise<Meeting | null> => {
      const meeting = await store.read(id)
      if (!meeting) return null
      const next = { ...meeting, ...patch }
      await store.write(next)
      changed()
      return next
    }

    const fail = (id: string, error: string): Promise<unknown> => update(id, { status: 'failed', error })

    const transcribe = async (id: string): Promise<void> => {
      await update(id, { status: 'transcribing', error: undefined })
      transcribing.add(id)
      command({ type: 'transcribe', folder: store.folder(id), keepAudio: settings.keepAudio })
    }

    async function startRecording(call: Call | null): Promise<void> {
      if (status.recording || starting || status.helper !== 'running') return
      starting = true
      try {
        const at = new Date()
        const found = settings.calendar ? await ask({ type: 'calendar', at: at.toISOString(), url: call?.url ?? null }, 'calendar') : null
        const event = found?.type === 'calendar' ? found.event : null
        const meeting = await store.create(
          {
            title: event?.title || call?.name || 'Meeting',
            start: at.toISOString(),
            end: null,
            app: call?.name ?? '',
            url: call?.url ?? null,
            invitees: event?.invitees ?? [],
            status: 'recording'
          },
          at
        )
        command({ type: 'record', folder: store.folder(meeting.id), app: call?.app ?? '' })
        setStatus({ recording: { id: meeting.id, title: meeting.title, since: at.getTime() }, error: null })
        changed()
        if (Notification.isSupported()) new Notification({ title: `Recording ${meeting.title}`, body: 'Let participants know the meeting is recorded.' }).show()
      } catch (reason) {
        setStatus({ error: `Couldn't start recording: ${String(reason)}` })
      } finally {
        starting = false
      }
    }

    const stopRecording = (): void => {
      if (!status.recording) return
      command({ type: 'stop' })
      setStatus({ recording: null })
    }

    async function finishTranscript(id: string, utterances: Parameters<typeof store.saveTranscript>[1]): Promise<void> {
      transcribing.delete(id)
      const meeting = await store.read(id)
      if (!meeting) return
      const transcript = await store.saveTranscript(meeting, utterances)
      const done = (await update(id, { status: 'done', error: undefined })) ?? meeting
      await emitTranscribed(done, transcript)
    }

    // `date` is the local day the folder name starts with, for date properties that take no time
    const emitTranscribed = ({ id, title, start, end, app: callApp, url, invitees }: Meeting, transcript: string): Promise<boolean> =>
      context.emit('transcribed', { id, title, date: id.slice(0, 10), start, end, app: callApp, url, invitees, folder: store.folder(id), transcript })

    const receive = (message: HelperMessage): void => {
      const id = 'folder' in message && message.folder ? (message.folder.split('/').pop() ?? '') : ''
      switch (message.type) {
        case 'ready':
          setStatus({ helper: 'running' })
          command({ type: 'configure', modelsPath: speechModelsPath() })
          return void recover()
        case 'mic':
          micApps = message.apps
          return
        case 'stopped':
          return void update(id, { end: new Date().toISOString() }).then((meeting) => meeting && transcribe(id))
        case 'transcript':
          return void finishTranscript(id, message.utterances).catch((reason: unknown) => setStatus({ error: `Couldn't save the transcript: ${String(reason)}` }))
        case 'error':
          if (id) {
            transcribing.delete(id)
            if (status.recording?.id === id) {
              setStatus({ recording: null })
              detector = { state: 'dismissed' }
            }
            void fail(id, message.message)
          }
          return setStatus({ error: message.message })
        case 'calendarAccess':
          calendarAccess = message.status
          return answer(message.type, message)
        case 'recording':
          return
        default:
          return answer(message.type, message)
      }
    }

    /** Meetings left recording or transcribing when Treeix or the helper stopped are transcribed from what reached the disk */
    async function recover(): Promise<void> {
      for (const meeting of await store.list()) {
        if (meeting.id === status.recording?.id || transcribing.has(meeting.id)) continue
        if (meeting.status === 'recording') await update(meeting.id, { end: meeting.end ?? meeting.start })
        if (meeting.status === 'recording' || meeting.status === 'transcribing') await transcribe(meeting.id)
      }
    }

    async function tick(): Promise<void> {
      if (!settings.auto || status.helper !== 'running' || ticking) return
      ticking = true
      try {
        let tabs: Tab[] = []
        if (needsTabs(settings.rules, micApps))
          tabs = await chromeTabs().catch((reason: unknown) => {
            const denied = String(reason).includes('-1743')
            setStatus({
              error: denied ? 'Allow Treeix to control Google Chrome in System Settings, Privacy & Security, Automation' : `Couldn't read Chrome tabs: ${String(reason)}`
            })
            return []
          })
        const { next, action } = step(detector, detect(settings.rules, micApps, tabs), Date.now(), { startMs: settings.startDelaySec * 1000, stopMs: settings.stopDelaySec * 1000 })
        if (action === 'start' && next.state === 'recording') await startRecording(next.call)
        if (action === 'stop') stopRecording()
        detector = next
      } finally {
        ticking = false
      }
    }

    const permissions = (): Permissions => ({ microphone: systemPreferences.getMediaAccessStatus('microphone'), calendar: calendarAccess })
    const openPane = (pane: Pane): Promise<void> => shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[pane]}`)

    const detail = (args: Record<string, unknown>): string => {
      if (!isString(args.id)) throw new Error('Give the id of a meeting from meetings_list')
      return args.id
    }

    context.mcpTool({
      name: 'meetings_list',
      description:
        'Lists recorded meetings, newest first, as JSON: id, title, start, end, app, url, invitees and status. A query keeps the meetings whose title, invitees or transcript contain it.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args) => JSON.stringify(await store.list(text(args.query)))
    })
    context.mcpTool({
      name: 'meetings_get',
      description: 'One meeting as JSON with its transcript (markdown, one line per speaker turn) and the notes saved for it.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (args) => JSON.stringify(await store.detail(detail(args)))
    })
    context.mcpTool({
      name: 'meetings_save_notes',
      description: "Saves markdown notes for a meeting, shown next to its transcript in Treeix's Meetings tab; replaces earlier notes.",
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, markdown: { type: 'string' } }, required: ['id', 'markdown'] },
      run: async (args) => {
        await store.saveNotes(detail(args), text(args.markdown))
        changed()
        return 'Saved'
      }
    })
    context.mcpTool({
      name: 'meetings_delete',
      description: 'Deletes a meeting by id, or every meeting older than olderThanDays, with its audio, transcript and notes. Meetings still recording or transcribing are kept.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, olderThanDays: { type: 'number', minimum: 1 } } },
      run: async (args) => {
        const cutoff = typeof args.olderThanDays === 'number' && args.olderThanDays >= 1 ? new Date(Date.now() - args.olderThanDays * DAY_MS).toISOString() : null
        if (!isString(args.id) && !cutoff) throw new Error('Give an id or olderThanDays')
        const doomed = (await store.list()).filter(
          (meeting) => (meeting.id === args.id || (cutoff !== null && meeting.start < cutoff)) && meeting.status !== 'recording' && meeting.status !== 'transcribing'
        )
        for (const meeting of doomed) await store.remove(meeting.id)
        changed()
        return doomed.length ? `Deleted ${doomed.map((meeting) => meeting.id).join(', ')}` : 'Nothing to delete'
      }
    })

    context.handle('configure', (_, stored: unknown) => {
      settings = parseSettings(object(stored))
    })
    context.handle('status', () => status)
    context.handle('meetings', (_, query: string) => store.list(query))
    context.handle('detail', (_, id: string) => store.detail(id))
    context.handle('remove', async (_, id: string) => {
      if (status.recording?.id === id) throw new Error('Stop the recording first')
      await store.remove(id)
      changed()
    })
    context.handle('rerun', async (_, id: string) => {
      const meeting = await store.detail(id)
      return emitTranscribed(meeting, meeting.transcript)
    })
    context.handle('transcribe', (_, id: string) => transcribe(id))
    context.handle('start', () => {
      if (status.helper !== 'running') throw new Error('The meetings helper is not running')
      return startRecording(null)
    })
    context.handle('stop', () => {
      stopRecording()
      detector = { state: 'dismissed' }
    })
    context.handle('events', async (_, from: string, to: string): Promise<CalendarEvent[]> => {
      const reply = await ask({ type: 'events', from, to }, 'events')
      return reply?.type === 'events' ? reply.events : []
    })
    context.handle('permissions', permissions)
    context.handle('requestMicrophone', async () => {
      if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') await systemPreferences.askForMediaAccess('microphone')
      else await openPane('Microphone')
      return permissions()
    })
    context.handle('requestCalendar', async () => {
      await ask({ type: 'calendarAccess' }, 'calendarAccess')
      if (calendarAccess !== 'granted') await openPane('Calendars')
      return permissions()
    })
    context.handle('openPane', (_, pane: Pane) => Object.hasOwn(PANES, pane) && openPane(pane))
    context.handle('join', (_, url: string) => url.startsWith('https://') && shell.openExternal(url))

    if (nativeHelpersSupported) {
      helper = superviseHelper(nativeBinary('treeix-meetings'), 'meetings', {
        line: (line) => {
          const message = parseHelperMessage(line)
          if (message) receive(message)
        },
        down: (reason) => {
          micApps = []
          if (status.recording) detector = { state: 'dismissed' }
          for (const id of transcribing) void fail(id, 'The helper stopped while transcribing this meeting')
          transcribing.clear()
          setStatus({ helper: 'crashed', recording: null, error: reason })
        }
      })
      if (!helper) setStatus({ helper: 'missing' })
    }
    const timer = setInterval(() => void tick(), TICK_MS)
    context.onDispose(() => {
      clearInterval(timer)
      helper?.stop()
    })
  }
}

export default plugin
