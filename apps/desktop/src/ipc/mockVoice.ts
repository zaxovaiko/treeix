import type { Api, DictationEntry, DictationStatus, RecordingInfo, RecordingStatus, VoiceEvent } from './api'

// Phase 7 dictation and recording demo (owner V7). Toggling dictation listens for 2 s, streams partial words,
// then inserts a sentence; a recording streams a transcript line every 3 s and saves a note on stop

type VoiceApi = Pick<
  Api,
  | 'dictationStatus' | 'dictationToggle' | 'voiceModelDownload' | 'voiceModelDelete' | 'voiceRequestAccess' | 'dictationHistory' | 'dictationForget'
  | 'recordingStatus' | 'recordingStart' | 'recordingPause' | 'recordingStop' | 'recordings' | 'recordingRead' | 'recordingDelete' | 'onVoice'
>

const AT = Date.UTC(2026, 9, 22, 11)
const MIN = 60_000
const FOLDER = '/Users/me/Library/Application Support/treeix/recordings'

const HISTORY: DictationEntry[] = [
  { at: AT - 5 * MIN, raw: 'open a worktree for tree x fifty two', text: 'Open a worktree for TRX-52.', app: 'Treeix' },
  { at: AT - 42 * MIN, raw: 'review the p t y leak fix and leave comments', text: 'Review the PTY leak fix and leave comments.', app: 'Treeix' },
  { at: AT - 3 * 60 * MIN, raw: 'sounds good lets ship it tomorrow', text: "Sounds good, let's ship it tomorrow.", app: 'Slack' },
]

const SAVED: RecordingInfo[] = [
  { id: '2026-10-21-1400-standup', title: 'Standup', startedAt: AT - 21 * 60 * MIN, durationMs: 14 * MIN, folder: `${FOLDER}/2026-10-21-1400-standup`, hasNote: true },
  { id: '2026-10-20-1030-routines-design', title: 'Routines design', startedAt: AT - 48 * 60 * MIN, durationMs: 52 * MIN, folder: `${FOLDER}/2026-10-20-1030-routines-design`, hasNote: false },
]

const LINES = ['Let us start with the routines engine.', 'The webhook listens on localhost only.', 'Budget kills the run when it goes over.', 'I will take the browser pane.']

const NOTE = `## Summary

Routines run in ptyd; the browser pane ships behind a feature flag.

## Action items

- [ ] Me: webhook token rotation
- [ ] Anna: cookie import from Arc
`

export function voiceMock(): VoiceApi {
  const listeners = new Set<(e: VoiceEvent) => void>()
  const fire = (e: VoiceEvent) => listeners.forEach((cb) => cb(e))
  let history = [...HISTORY]
  let saved = [...SAVED]
  let dictation: DictationStatus = {
    helper: 'running',
    models: [{ id: 'parakeet-v3', phase: 'ready', progress: null, error: null }, { id: 'parakeet-v2', phase: 'missing', progress: null, error: null }],
    microphone: 'granted',
    accessibility: 'notAsked',
    phase: 'idle',
    error: null,
  }
  let recording: RecordingStatus = { helper: 'running', phase: 'idle', title: null, startedAt: null, elapsedMs: 0, error: null }
  let ticker: ReturnType<typeof setInterval> | undefined
  const setDictation = (patch: Partial<DictationStatus>) => {
    dictation = { ...dictation, ...patch }
    fire({ type: 'dictation', status: dictation })
  }
  const setRecording = (patch: Partial<RecordingStatus>) => {
    recording = { ...recording, ...patch }
    fire({ type: 'recording', status: recording })
    return recording
  }
  const model = (id: string, patch: Partial<DictationStatus['models'][number]>) => {
    if (!dictation.models.some((m) => m.id === id)) throw new Error(`no model ${id}`)
    setDictation({ models: dictation.models.map((m) => (m.id === id ? { ...m, ...patch } : m)) })
  }
  const stream = () => {
    let i = 0
    ticker = setInterval(() => fire({ type: 'transcript', line: { at: Date.now() - (recording.startedAt ?? Date.now()), speaker: i % 2 ? 'Speaker 2' : 'Me', text: LINES[i++ % LINES.length] ?? '' } }), 3000)
  }

  return {
    dictationStatus: async () => dictation,
    async dictationToggle() {
      if (dictation.phase !== 'idle') return setDictation({ phase: 'idle' })
      setDictation({ phase: 'listening' })
      fire({ type: 'partial', text: 'Open the plan' })
      setTimeout(() => {
        if (dictation.phase !== 'listening') return
        setDictation({ phase: 'transcribing' })
        const entry = { at: Date.now(), raw: 'open the plan for the routines engine', text: 'Open the plan for the routines engine.', app: 'Treeix' }
        history = [entry, ...history]
        fire({ type: 'dictated', entry })
        setDictation({ phase: 'idle' })
      }, 2000)
    },
    async voiceModelDownload(id) {
      model(id, { phase: 'downloading', progress: 0.4 })
      setTimeout(() => model(id, { phase: 'ready', progress: null }), 1500)
    },
    voiceModelDelete: async (id) => model(id, { phase: 'missing', progress: null }),
    voiceRequestAccess: async (kind) => setDictation(kind === 'microphone' ? { microphone: 'granted' } : { accessibility: 'granted' }),
    dictationHistory: async () => history,
    async dictationForget(at) {
      history = at === null ? [] : history.filter((h) => h.at !== at)
    },
    recordingStatus: async () => recording,
    async recordingStart(title) {
      if (recording.phase !== 'idle') throw new Error('already recording')
      stream()
      return setRecording({ phase: 'recording', title: title ?? 'Meeting Oct 22', startedAt: Date.now(), elapsedMs: 0, error: null })
    },
    async recordingPause(paused) {
      if (recording.phase === 'idle' || recording.phase === 'saving') throw new Error('not recording')
      clearInterval(ticker)
      if (paused) return setRecording({ phase: 'paused', elapsedMs: recording.elapsedMs + Date.now() - (recording.startedAt ?? Date.now()), startedAt: null })
      stream()
      return setRecording({ phase: 'recording', startedAt: Date.now() })
    },
    async recordingStop() {
      if (recording.phase === 'idle') throw new Error('not recording')
      clearInterval(ticker)
      const durationMs = recording.elapsedMs + (recording.startedAt ? Date.now() - recording.startedAt : 0)
      const info: RecordingInfo = { id: `2026-10-22-${saved.length}`, title: recording.title ?? 'Meeting', startedAt: Date.now() - durationMs, durationMs, folder: `${FOLDER}/2026-10-22-${saved.length}`, hasNote: true }
      setTimeout(() => {
        saved = [info, ...saved]
        setRecording({ phase: 'idle', title: null, startedAt: null, elapsedMs: 0 })
        fire({ type: 'saved', recording: info })
      }, 1000)
      return setRecording({ phase: 'saving' })
    },
    recordings: async () => saved,
    async recordingDelete(id) {
      saved = saved.filter((r) => r.id !== id)
    },
    async recordingRead(id) {
      const info = saved.find((r) => r.id === id)
      if (!info) throw new Error(`no recording ${id}`)
      return { info, transcript: LINES.map((text, i) => ({ at: i * 4000, speaker: i % 2 ? 'Speaker 2' : 'Me', text })), note: info.hasNote ? NOTE : null }
    },
    onVoice(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}
