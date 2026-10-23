import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Api, DictationEntry, DictationStatus, RecordingInfo, RecordingStatus, TranscriptLine, VoiceEvent } from '../../ipc/api'
import { Icon } from '../../lib/icons'
import type { Command } from '../../lib/paletteSearch'
import { Field, Group, Row, Status, Switch } from '../../pages/settings/controls'
import type { SectionProps } from '../../pages/settings/sections'
import { keyHint, withHint } from '../../shell/shortcuts'
import type { ShellView } from '../../shell/Shell'
import { launch } from '../agents/launch'
import { useSettings } from '../agents/settings'
import { toast, Toasts } from '../routines/toasts'
import { clock, formatVocabulary, hotkeyLabel, isHotkeyModifier, parseVocabulary } from './text'
import '../../styles/voice.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fail = (title: string) => (e: unknown) => toast({ icon: 'alert', title, body: message(e) })

/** Starts a recording, or stops one that is running or paused (⇧⌘R) */
export async function toggleRecording(api: Api): Promise<void> {
  const status = await api.recordingStatus()
  if (status.phase === 'idle') await api.recordingStart(null)
  else if (status.phase !== 'saving') await api.recordingStop()
}

/** A status kept current by `onVoice`; null while off or not loaded */
function useVoiceStatus<T>(api: Api, on: boolean, load: (api: Api) => Promise<T>, pick: (e: VoiceEvent) => T | undefined): T | null {
  const [status, setStatus] = useState<T | null>(null)
  useEffect(() => {
    if (!on) return setStatus(null)
    let live = true
    load(api).then((s) => live && setStatus(s), () => {})
    const stop = api.onVoice((e) => {
      const next = pick(e)
      if (next) setStatus(next)
    })
    return () => {
      live = false
      stop()
    }
  }, [api, on])
  return status
}

const useDictation = (api: Api, on: boolean) => useVoiceStatus<DictationStatus>(api, on, (a) => a.dictationStatus(), (e) => (e.type === 'dictation' ? e.status : undefined))
const useRecording = (api: Api, on: boolean) => useVoiceStatus<RecordingStatus>(api, on, (a) => a.recordingStatus(), (e) => (e.type === 'recording' ? e.status : undefined))

const elapsed = (s: RecordingStatus, now: number) => s.elapsedMs + (s.startedAt ? now - s.startedAt : 0)

/** Re-renders every second while `on` */
function useTick(on: boolean) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [on])
  return now
}

function openNotes(view: ShellView, r: RecordingInfo) {
  view.openFile(r.folder, r.hasNote ? 'note.md' : 'transcript.md')
}

function askClaude(view: ShellView, r: RecordingInfo) {
  const prompt = `This folder holds the meeting "${r.title}": transcript.md${r.hasNote ? ' and my notes in note.md' : ''}. Read them, then help me follow up on it.`
  launch(view, [{ cwd: r.folder, agent: 'claude' }], { prompt, shell: false, draftPr: false }).catch(fail("Couldn't start Claude"))
}

function savedToast(view: ShellView, r: RecordingInfo) {
  toast({
    icon: 'rec',
    title: 'Meeting saved',
    body: `${r.title} · ${clock(r.durationMs)} · ${r.hasNote ? 'transcript and note' : 'transcript'}`,
    actions: [
      ['Open notes', () => openNotes(view, r)],
      ['Ask Claude', () => askClaude(view, r)],
    ],
  })
}

/** Title bar: the Record pill (REC mm:ss while recording), the dictation mic, and the meeting HUD */
export function VoiceTitleItems({ view }: { view: ShellView }) {
  const settings = useSettings(view.api)
  const features = settings?.features
  const hotkey = settings?.dictation.hotkey ?? []
  const dictation = useDictation(view.api, !!features?.dictation)
  const recording = useRecording(view.api, !!features?.recording)
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    if (!features?.recording) return
    return view.api.onVoice((e) => e.type === 'saved' && savedToast(viewRef.current, e.recording))
  }, [view.api, features?.recording])
  return (
    <>
      {recording && recording.helper !== 'unsupported' && <RecordItems view={view} status={recording} />}
      {dictation && dictation.helper !== 'unsupported' && (
        <button
          className={`icon ${dictation.phase === 'idle' ? '' : 'rec'}`}
          title={`Dictation: hold ${hotkeyLabel(hotkey)}${dictation.helper === 'running' ? '' : ` (${dictation.helper})`}`}
          onClick={() => view.api.dictationToggle().catch(fail("Couldn't dictate"))}
        >
          <Icon name="mic" />
        </button>
      )}
      {/* ponytail: routines owns the toast stack; a shell-wide host when a third feature needs toasts */}
      {(features?.dictation || features?.recording) && !features.routines && <Toasts />}
    </>
  )
}

function RecordItems({ view, status }: { view: ShellView; status: RecordingStatus }) {
  const [hidden, setHidden] = useState(false)
  const [lines, setLines] = useState<TranscriptLine[]>([])
  const active = status.phase !== 'idle'
  const now = useTick(status.phase === 'recording')
  useEffect(() => {
    if (!active) return setLines([])
    return view.api.onVoice((e) => e.type === 'transcript' && setLines((l) => [...l.slice(-5), e.line]))
  }, [view.api, active])
  useEffect(() => setHidden(false), [active])
  if (!active)
    return (
      <button className="pill" title={withHint('Record a meeting', 'record')} onClick={() => toggleRecording(view.api).catch(fail("Couldn't record"))}>
        <Icon name="rec" />
        Record
      </button>
    )
  const time = clock(elapsed(status, now))
  const paused = status.phase === 'paused'
  const saving = status.phase === 'saving'
  return (
    <>
      <button className="pill rec" title="Recording. Click to show or hide the panel" onClick={() => setHidden(!hidden)}>
        <i />
        {saving ? 'Saving' : `REC ${time}`}
      </button>
      {!hidden && (
        <div className="hud meet" role="dialog" aria-label="Meeting recording">
          <div className="hd">
            <span className="pill rec">
              <i />
              {time}
            </span>
            <b>{status.title ?? 'Recording'}</b>
            <span className="grow" />
          </div>
          <div className={`wave ${paused || saving ? 'still' : ''}`}>
            {Array.from({ length: 18 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <div className="tr">
            {saving ? <div className="dim">Writing the transcript and note...</div> : lines.length ? lines.map((l, i) => <div key={i}>{l.speaker ? <b>{l.speaker}: </b> : null}{l.text}</div>) : <div className="dim">The transcript is written when you stop.</div>}
          </div>
          {status.error && <div className="err">{status.error}</div>}
          <div className="ft">
            <button className="btn sm" disabled={saving} onClick={() => view.api.recordingPause(!paused).catch(fail("Couldn't pause"))}>
              <Icon name={paused ? 'play' : 'pause'} />
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn sm pri" disabled={saving} onClick={() => view.api.recordingStop().catch(fail("Couldn't stop"))}>
              Stop and summarize
            </button>
            <span className="grow" />
            <button className="icon sm" title="Hide, keep recording" onClick={() => setHidden(true)}>
              <Icon name="down" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const HELPER_TONE = { running: 'ok', starting: 'idle', missing: 'bad', crashed: 'bad', unsupported: 'bad' } as const
const HELPER_TEXT = {
  running: 'Running',
  starting: 'Starting',
  missing: 'Helper missing from this build',
  crashed: 'Helper stopped, restarting',
  unsupported: 'Needs an Apple silicon Mac on macOS 14 or later',
} as const

// Word error rates: NVIDIA's model cards, Open ASR Leaderboard English average. Both are 0.6B, so equally fast
const MODELS: Record<string, string> = { 'parakeet-v3': 'Parakeet v3, 25 languages', 'parakeet-v2': 'Parakeet v2, English only, more accurate' }
const SPEED_QUALITY: Record<string, string> = { 'parakeet-v3': 'Speed: fast · Quality: 6.3% word error rate in English', 'parakeet-v2': 'Speed: fast · Quality: 6.1% word error rate in English' }

/** Records the modifiers held together, saved when the first one is let go; Escape cancels */
function HoldRecorder({ value, onChange }: { value: string[]; onChange: (keys: string[]) => void }) {
  const [held, setHeld] = useState<string[] | null>(null)
  const self = useRef<HTMLButtonElement>(null)
  const save = useEffectEvent(onChange)
  const recording = held !== null
  useEffect(() => {
    if (!recording) return
    let keys: string[] = []
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setHeld(null)
      if (!isHotkeyModifier(e.code)) return
      e.preventDefault()
      if (!keys.includes(e.code)) setHeld((keys = [...keys, e.code]))
    }
    const up = () => {
      if (!keys.length) return
      save(keys)
      setHeld(null)
    }
    const away = (e: PointerEvent) => {
      if (!(e.target instanceof Node && self.current?.contains(e.target))) setHeld(null)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('pointerdown', away, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('pointerdown', away, true)
    }
  }, [recording])
  return (
    <button ref={self} className={`krec ${recording ? 'on' : ''}`} aria-label="Record hold to talk keys" title="Click, then hold the modifier keys and let go" onClick={() => setHeld(recording ? null : [])}>
      {!recording ? <kbd>{hotkeyLabel(value)}</kbd> : held.length ? hotkeyLabel(held) : 'Hold keys...'}
    </button>
  )
}

/** Settings > Dictation: hotkey, model, permissions, vocabulary, history */
export function VoiceSection({ view, settings, update }: SectionProps) {
  const { api } = view
  const status = useDictation(api, true)
  const d = settings.dictation
  const set = (patch: Partial<typeof d>) => update({ dictation: patch })
  const [history, setHistory] = useState<DictationEntry[]>([])
  useEffect(() => {
    api.dictationHistory().then(setHistory, () => {})
    return api.onVoice((e) => e.type === 'dictated' && setHistory((h) => [e.entry, ...h.filter((x) => x.at !== e.entry.at)].slice(0, 50)))
  }, [api])
  const access = (kind: 'microphone' | 'accessibility', label: string, desc: string) => {
    const state = status?.[kind] ?? 'notAsked'
    return (
      <Row label={label} desc={desc}>
        {state === 'granted' ? (
          <Status tone="ok">Allowed</Status>
        ) : (
          <button className="btn sm" onClick={() => api.voiceRequestAccess(kind).catch(fail("Couldn't ask"))}>
            {state === 'denied' ? 'Open System Settings' : 'Allow'}
          </button>
        )}
      </Row>
    )
  }
  return (
    <>
      <Group>
        <Row label="Helper" desc={status?.error ?? undefined}>
          {status && <Status tone={HELPER_TONE[status.helper]}>{HELPER_TEXT[status.helper]}</Status>}
        </Row>
        {access('microphone', 'Microphone', 'To hear you')}
        {access('accessibility', 'Accessibility', 'To see the hotkey in any app and paste the text where the cursor is')}
      </Group>
      <Group title="Hotkey">
        <Row label="Hold to talk" desc="Hold the keys and speak; release to insert" keywords="hotkey shortcut">
          <HoldRecorder value={d.hotkey} onChange={(hotkey) => set({ hotkey })} />
        </Row>
        <Row label="Tap to toggle" desc="A quick tap keeps listening until the next tap">
          <Switch label="Tap to toggle" on={d.tapToToggle} onChange={(tapToToggle) => set({ tapToToggle })} />
        </Row>
        <Row label="Sounds">
          <Switch label="Sounds" on={d.sounds} onChange={(sounds) => set({ sounds })} />
        </Row>
      </Group>
      <Group title="Model">
        {(status?.models ?? []).map((m) => (
          <Row key={m.id} label={MODELS[m.id] ?? m.id} desc={m.error ?? [m.phase === 'downloading' ? `Downloading ${Math.round((m.progress ?? 0) * 100)}%` : m.phase === 'missing' ? 'Not downloaded' : m.id === d.model ? 'In use' : 'Downloaded', SPEED_QUALITY[m.id]].filter(Boolean).join(' · ')} keywords="parakeet speech model">
            {m.id !== d.model && m.phase !== 'missing' && m.phase !== 'downloading' && (
              <button className="btn sm" onClick={() => set({ model: m.id })}>
                Use
              </button>
            )}
            {m.phase === 'missing' || m.phase === 'error' ? (
              <button className="btn sm pri" onClick={() => api.voiceModelDownload(m.id).catch(fail("Couldn't download"))}>
                Download
              </button>
            ) : (
              m.phase !== 'downloading' && (
                <button className="btn sm" onClick={() => api.voiceModelDelete(m.id).catch(fail("Couldn't delete"))}>
                  Delete
                </button>
              )
            )}
          </Row>
        ))}
      </Group>
      <Group title="Vocabulary">
        <Row label="Words to spell exactly" desc="One per line; what the model hears instead after a colon: GitHub: git hub, get hub" wide>
          <Vocabulary value={formatVocabulary(d.vocabulary)} onSave={(text) => set({ vocabulary: parseVocabulary(text) })} />
        </Row>
      </Group>
      <Group title="History">
        {history.length ? (
          history.slice(0, 20).map((h) => (
            <Row key={h.at} label={h.text} desc={`${new Date(h.at).toLocaleString()}${h.app ? ` · ${h.app}` : ''}${h.raw !== h.text ? ` · heard "${h.raw}"` : ''}`} />
          ))
        ) : (
          <Row label="Nothing dictated yet" />
        )}
      </Group>
    </>
  )
}

function Vocabulary({ value, onSave }: { value: string; onSave: (text: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <textarea className="inp vocab" rows={4} spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onSave(draft)} />
}

/** Settings > Meeting recording: folder, language, recordings */
export function RecordingSection({ view, settings, update }: SectionProps) {
  const { api } = view
  const status = useRecording(api, true)
  const r = settings.recording
  const [saved, setSaved] = useState<RecordingInfo[]>([])
  useEffect(() => {
    api.recordings().then(setSaved, () => {})
    return api.onVoice((e) => e.type === 'saved' && api.recordings().then(setSaved, () => {}))
  }, [api, r.folder])
  return (
    <>
      <Group>
        <Row label="Helper" desc={status?.error ?? undefined}>
          {status && <Status tone={HELPER_TONE[status.helper]}>{HELPER_TEXT[status.helper]}</Status>}
        </Row>
        <Row label="Start or stop" desc="Records your microphone and the call app's audio, then writes a transcript and a note with Claude">
          <kbd>{keyHint('record')}</kbd>
        </Row>
        <Row label="Folder" desc="Each recording gets a folder with transcript.md and note.md. Empty keeps them in Treeix's data folder">
          <Field value={r.folder ?? ''} placeholder="Default" mono width={260} onSave={(folder) => update({ recording: { folder: folder.trim() || null } })} />
        </Row>
        <Row label="Language" desc="Two-letter code the calls are spoken in, like en or uk. Empty detects it">
          <Field value={r.language} placeholder="Auto" width={64} onSave={(language) => update({ recording: { language: language.trim().toLowerCase() } })} />
        </Row>
      </Group>
      <Group title="Recordings">
        {saved.length ? (
          saved.map((m) => (
            <Row key={m.id} label={m.title} desc={`${new Date(m.startedAt).toLocaleString()} · ${clock(m.durationMs)}`} keywords="meeting notes transcript">
              <button className="btn sm" onClick={() => openNotes(view, m)}>
                {m.hasNote ? 'Open notes' : 'Open transcript'}
              </button>
            </Row>
          ))
        ) : (
          <Row label="No recordings yet" />
        )}
      </Group>
    </>
  )
}

/** "Record a meeting"; only asked while the feature is on */
export const voiceCommands = (view: ShellView): Command[] => [
  { id: 'record', group: 'Actions', label: 'Record a meeting, or stop the recording', shortcut: keyHint('record'), icon: 'rec', run: () => view.run('record') },
]
