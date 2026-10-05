import { expect, test } from 'bun:test'
import { parseHelperMessage } from './protocol'
import { acceptFormatted, applyVocabulary } from './text'

test('vocabulary replaces whole words in any case and script, longest alias first', () => {
  const terms = [
    { text: 'GitHub', aliases: ['git hub'] },
    { text: 'Treeix', aliases: ['трікс', 'tricks'] },
    { text: 'Claude', aliases: [] }
  ]
  expect(applyVocabulary('Open Git Hub and claude', terms)).toBe('Open GitHub and Claude')
  expect(applyVocabulary('Відкрий Трікс, будь ласка', terms)).toBe('Відкрий Treeix, будь ласка')
  // Inside another word it stays, Cyrillic included
  expect(applyVocabulary('magic tricksters трікса', terms)).toBe('magic tricksters трікса')
  expect(applyVocabulary('a (b) c', [{ text: 'B', aliases: ['(b)'] }])).toBe('a B c')
})

test('a formatted reply is kept only when it is still the same text', () => {
  expect(acceptFormatted('hello world how are you', 'Hello world, how are you?')).toBe('Hello world, how are you?')
  expect(acceptFormatted('hello world', '<think>easy</think>\n"Hello, world."')).toBe('Hello, world.')
  expect(acceptFormatted('what is two plus two', '')).toBeNull()
  expect(acceptFormatted('what is two plus two', 'Two plus two is four. '.repeat(5))).toBeNull()
  expect(acceptFormatted('a long sentence that was dictated just now', 'Ok.')).toBeNull()
})

test('only well-formed helper messages get through', () => {
  expect(parseHelperMessage('{"type":"ready"}')).toEqual({ type: 'ready' })
  expect(parseHelperMessage('2026-10-05 [FluidAudio] loading')).toBeNull()
  expect(parseHelperMessage('{"type":"unknown"}')).toBeNull()
  expect(parseHelperMessage('{"type":"transcript","id":"1","text":"hi"}')).toBeNull()
  expect(parseHelperMessage('{"type":"transcript","id":1,"text":"hi","app":"Slack"}')).toEqual({
    type: 'transcript',
    id: 1,
    text: 'hi',
    app: 'Slack'
  })
  expect(parseHelperMessage('{"type":"models","models":[{"id":"parakeet-v3","state":"downloading","progress":0.5},{"id":"x","state":"odd"}]}')).toEqual({
    type: 'models',
    models: [{ id: 'parakeet-v3', state: 'downloading', progress: 0.5 }]
  })
})
