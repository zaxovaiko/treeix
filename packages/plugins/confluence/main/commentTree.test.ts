import { expect, test } from 'bun:test'
import { toCommentTree } from './commentTree'

const comment = (id: string, ancestors: string[]) => ({
  id,
  history: { createdBy: { accountId: `a${id}`, displayName: `User ${id}`, profilePicture: { path: '/wiki/aa-avatar/x.png' } }, createdDate: '2026-09-27T10:00:00.000Z' },
  ancestors: ancestors.map((ancestor) => ({ id: ancestor, type: 'comment' })),
  body: { atlas_doc_format: { value: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `body ${id}` }] }] }) } }
})

test('toCommentTree nests replies under the comment they answer', () => {
  const tree = toCommentTree({ results: [comment('1', []), comment('2', ['1']), comment('3', ['1', '2']), comment('4', [])] }, '42', 'x.atlassian.net')
  expect(tree.map((root) => root.id)).toEqual(['1', '4'])
  expect(tree[0].replies?.[0].id).toBe('2')
  expect(tree[0].replies?.[0].replies?.[0].id).toBe('3')
  expect(tree[0]).toMatchObject({ author: 'User 1', authorId: 'a1', authorAvatar: 'https://x.atlassian.net/wiki/aa-avatar/x.png', body: 'body 1' })
})

test('toCommentTree keeps the text an inline comment is pinned to', () => {
  const inline = { ...comment('5', []), extensions: { location: 'inline', inlineProperties: { originalSelection: 'Adres dev' } } }
  const [pinned, footer] = toCommentTree({ results: [inline, comment('6', [])] }, '42', null)
  expect(pinned.quote).toBe('Adres dev')
  expect(footer.quote).toBeUndefined()
})
