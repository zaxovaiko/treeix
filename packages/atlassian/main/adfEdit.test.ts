import { expect, test } from 'bun:test'
import { adfToMarkdown } from './adf'
import { editedAdf } from './adfEdit'

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const toc = { type: 'extension', attrs: { extensionKey: 'toc' } }
const status = { type: 'paragraph', content: [{ type: 'status', attrs: { text: 'DONE', color: 'green' } }] }
const image = { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'f1', alt: 'shot.png' } }] }
const doc = { type: 'doc', version: 1, content: [toc, p('Intro'), status, image, p('Old text')] }
const mediaSource = (attrs: Record<string, unknown>) => `img://${String(attrs.id)}`
const original = adfToMarkdown(doc, { mediaSource })

test('editedAdf keeps untouched blocks as they were and parses the edited text', () => {
  const edited = original.replace('Old text', 'New **bold** text\n\n- [ ] todo\n\n![shot.png](img://f1)\n\n<details><summary>More</summary>\n\nhidden\n\n</details>')
  const result = editedAdf(doc, original, edited, mediaSource)
  const content = result.content as unknown[]
  expect(content.slice(0, 4)).toEqual([toc, p('Intro'), status, image])
  expect(content[4]).toEqual({
    type: 'paragraph',
    content: [
      { type: 'text', text: 'New ' },
      { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
      { type: 'text', text: ' text' }
    ]
  })
  expect(content[5]).toMatchObject({ type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'TODO' }, content: [{ type: 'text', text: 'todo' }] }] })
  expect(content[6]).toEqual({ type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { id: 'f1', alt: 'shot.png' } }] })
  expect(content[7]).toEqual({ type: 'expand', attrs: { title: 'More' }, content: [p('hidden')] })
})

test('editedAdf drops deleted blocks and refuses an edit of a document changed meanwhile', () => {
  expect(editedAdf(doc, original, original.replace('Intro\n\n', ''), mediaSource).content).toEqual([toc, status, image, p('Old text')])
  expect(() => editedAdf(doc, 'stale', 'anything', mediaSource)).toThrow(/changed since/)
})
