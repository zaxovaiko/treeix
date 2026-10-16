import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { readJsonFile } from '@treeix/host/paths'
import { isJson, isString, list, text } from '@treeix/shared/json'
import type { Meeting, MeetingDetail, MeetingStatus } from '../shared/types'

/** One speaker's run of speech; `start` is seconds into the recording */
export type Utterance = { speaker: string; start: number; text: string }

const META = 'meeting.json'
const TRANSCRIPT = 'transcript.md'
const NOTES = 'notes.md'
/** The mix kept after transcribing, and the tracks it's made from while they last */
const AUDIO = ['meeting.m4a', 'me.caf', 'others.caf']
const STATUSES = new Set<unknown>(['recording', 'transcribing', 'done', 'failed'] satisfies MeetingStatus[])
const pad = (value: number): string => String(value).padStart(2, '0')

/** `2026-10-14 1100 Daily`: sorts by time and reads well in Finder */
export function folderName(title: string, at: Date): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${pad(at.getMinutes())}`
  return `${stamp} ${title.replace(/[/\\:]/g, '-').trim()}`.trim()
}

export const isUtterance = (value: unknown): value is Utterance => isJson(value) && isString(value.speaker) && typeof value.start === 'number' && isString(value.text)

/** `**[00:01:05] Speaker 1:** text` lines under the title and invitees */
export function renderTranscript(meeting: Pick<Meeting, 'title' | 'invitees'>, utterances: Utterance[]): string {
  const lines = utterances.map(({ speaker, start, text: said }) => {
    const seconds = Math.floor(start)
    return `**[${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}] ${speaker}:** ${said}`
  })
  const invitees = meeting.invitees.length ? `Invitees: ${meeting.invitees.join(', ')}\n\n` : ''
  return `# ${meeting.title}\n\n${invitees}${lines.join('\n\n')}\n`
}

function parseMeeting(id: string, value: unknown): Meeting | null {
  if (!isJson(value) || !isString(value.title) || !isString(value.start) || !STATUSES.has(value.status)) return null
  return {
    id,
    title: value.title,
    start: value.start,
    end: text(value.end) || null,
    app: text(value.app),
    url: text(value.url) || null,
    invitees: list(value.invitees, isString),
    status: value.status as MeetingStatus,
    ...(isString(value.error) ? { error: value.error } : {})
  }
}

/** Meeting folders under one root; ids are folder names, so anything with a path separator is refused */
export function createStore(root: () => string) {
  const folder = (id: string): string => {
    if (!id || basename(id) !== id || id.startsWith('.')) throw new Error(`No meeting ${id}`)
    return join(root(), id)
  }
  const read = async (id: string): Promise<Meeting | null> => parseMeeting(id, await readJsonFile(join(folder(id), META)))
  const readText = (id: string, file: string): Promise<string> => readFile(join(folder(id), file), 'utf8').catch(() => '')

  return {
    folder,
    read,
    async create(meeting: Omit<Meeting, 'id'>, at: Date): Promise<Meeting> {
      await mkdir(root(), { recursive: true })
      let id = folderName(meeting.title, at)
      // Two calls in the same minute with the same title get their own folders
      for (
        let copy = 2;
        await readFile(join(root(), id, META)).then(
          () => true,
          () => false
        );
        copy++
      )
        id = `${folderName(meeting.title, at)} ${copy}`
      await mkdir(folder(id), { recursive: true })
      const created = { ...meeting, id }
      await this.write(created)
      return created
    },
    async write({ id, ...meeting }: Meeting): Promise<void> {
      await writeFile(join(folder(id), META), JSON.stringify(meeting, null, 2))
    },
    async list(query = ''): Promise<Meeting[]> {
      const ids = await readdir(root()).catch(() => [])
      const meetings = (await Promise.all(ids.map((id) => read(id).catch(() => null)))).filter((meeting) => meeting !== null)
      const lower = query.toLowerCase()
      const matches = lower
        ? (
            await Promise.all(
              meetings.map(async (meeting) =>
                `${meeting.title}\n${meeting.invitees.join('\n')}\n${await readText(meeting.id, TRANSCRIPT)}`.toLowerCase().includes(lower) ? meeting : null
              )
            )
          ).filter((meeting) => meeting !== null)
        : meetings
      return matches.sort((a, b) => b.start.localeCompare(a.start))
    },
    async detail(id: string): Promise<MeetingDetail> {
      const meeting = await read(id)
      if (!meeting) throw new Error(`No meeting ${id}`)
      return { ...meeting, transcript: await readText(id, TRANSCRIPT), notes: await readText(id, NOTES) }
    },
    async saveTranscript(meeting: Meeting, utterances: Utterance[]): Promise<string> {
      const markdown = renderTranscript(meeting, utterances)
      await writeFile(join(folder(meeting.id), 'transcript.json'), JSON.stringify(utterances))
      await writeFile(join(folder(meeting.id), TRANSCRIPT), markdown)
      return markdown
    },
    async saveNotes(id: string, markdown: string): Promise<void> {
      if (!(await read(id))) throw new Error(`No meeting ${id}`)
      await writeFile(join(folder(id), NOTES), markdown)
    },
    /** Bytes of the meeting's audio files */
    async audioSize(id: string): Promise<number> {
      const sizes = await Promise.all(
        AUDIO.map((file) =>
          stat(join(folder(id), file)).then(
            ({ size }) => size,
            () => 0
          )
        )
      )
      return sizes.reduce((total, size) => total + size, 0)
    },
    removeAudio: (id: string): Promise<unknown> => Promise.all(AUDIO.map((file) => rm(join(folder(id), file), { force: true }))),
    remove: (id: string): Promise<void> => rm(folder(id), { recursive: true, force: true })
  }
}

export type Store = ReturnType<typeof createStore>
