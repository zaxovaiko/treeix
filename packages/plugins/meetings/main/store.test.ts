import { describe, expect, it } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, folderName, renderTranscript } from './store'

describe('meeting store', () => {
  it('names folders by local time and strips path separators', () => {
    expect(folderName('Design / review: v2', new Date(2026, 9, 14, 9, 5))).toBe('2026-10-14 0905 Design - review- v2')
  })

  it('renders speakers with hh:mm:ss stamps under the title and invitees', () => {
    const transcript = renderTranscript({ title: 'Daily', invitees: ['Ola'] }, [
      { speaker: 'Me', start: 3.7, text: 'Hi' },
      { speaker: 'Speaker 1', start: 3725, text: 'Hello' }
    ])
    expect(transcript).toBe('# Daily\n\nInvitees: Ola\n\n**[00:00:03] Me:** Hi\n\n**[01:02:05] Speaker 1:** Hello\n')
  })

  it('creates, searches, annotates and deletes meetings, refusing ids outside the folder', async () => {
    const root = await mkdtemp(join(tmpdir(), 'meetings-'))
    const store = createStore(() => root)
    const at = new Date(2026, 9, 14, 11, 0)
    const base = { title: 'Daily', start: at.toISOString(), end: null, app: 'Zoom', url: null, invitees: [], status: 'recording' as const }
    const first = await store.create(base, at)
    const second = await store.create(base, at)
    expect([first.id, second.id]).toEqual(['2026-10-14 1100 Daily', '2026-10-14 1100 Daily 2'])

    await store.saveTranscript(first, [{ speaker: 'Me', start: 0, text: 'ship the deposit fix' }])
    expect((await store.list('deposit')).map((meeting) => meeting.id)).toEqual([first.id])
    await store.saveNotes(first.id, '- fix deposits')
    expect((await store.detail(first.id)).notes).toBe('- fix deposits')

    await writeFile(join(store.folder(first.id), 'meeting.m4a'), 'abcd')
    await writeFile(join(store.folder(first.id), 'me.caf'), 'ef')
    expect(await store.audioSize(first.id)).toBe(6)
    await store.removeAudio(first.id)
    expect(await store.audioSize(first.id)).toBe(0)
    expect((await store.detail(first.id)).notes).toBe('- fix deposits')

    await store.remove(second.id)
    expect((await store.list()).map((meeting) => meeting.id)).toEqual([first.id])
    expect(() => store.folder('../elsewhere')).toThrow()
  })
})
