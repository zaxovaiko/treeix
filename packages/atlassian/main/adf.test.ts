import { expect, test } from 'bun:test'
import { adfToMarkdown, confluencePageOf } from './adf'

const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const t = (text: string, marks: unknown[] = []) => ({ type: 'text', text, marks })

test('adfToMarkdown keeps blocks apart and renders marks, lists, tasks, tables, code and images', () => {
  const links: string[] = []
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [t('Context')] },
      p(t('See '), t('spec', [{ type: 'link', attrs: { href: 'https://x.atlassian.net/wiki/spaces/B/pages/42/Wallet+Balance' } }]), t(' and '), t('code', [{ type: 'code' }])),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('one'))] }, { type: 'listItem', content: [p(t('two')), { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('nested'))] }] }] }] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { state: 'DONE' }, content: [t('done')] }, { type: 'taskItem', attrs: { state: 'TODO' }, content: [t('todo')] }] },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [p(t('A'))] }, { type: 'tableHeader', content: [p(t('B'))] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [p(t('1'))] }, { type: 'tableCell', content: [p(t('x|y'))] }] }] },
      { type: 'codeBlock', attrs: { language: 'mermaid' }, content: [t('graph TD\n  A-->B')] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'shot.png', id: 'f1' } }] },
      { type: 'inlineCard', attrs: { url: 'https://x.atlassian.net/browse/BF-1' } }
    ]
  }
  const markdown = adfToMarkdown(doc, { mediaSource: (attrs) => `img://${String(attrs.id)}`, onLink: (url) => links.push(url) })
  expect(markdown).toBe(
    [
      '## Context',
      '',
      'See [spec](https://x.atlassian.net/wiki/spaces/B/pages/42/Wallet+Balance) and `code`',
      '',
      '- one',
      '- two',
      '  - nested',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | x\\|y |',
      '',
      '```mermaid',
      'graph TD',
      '  A-->B',
      '```',
      '',
      '![shot.png](img://f1)',
      '',
      '[BF-1](https://x.atlassian.net/browse/BF-1)'
    ].join('\n')
  )
  expect(links).toEqual(['https://x.atlassian.net/wiki/spaces/B/pages/42/Wallet+Balance', 'https://x.atlassian.net/browse/BF-1'])
})

test('confluencePageOf reads the page id and title', () => {
  expect(confluencePageOf('https://x.atlassian.net/wiki/spaces/Betfeel/pages/76120081/Wallet+Balance+Management')).toEqual({ id: '76120081', title: 'Wallet Balance Management' })
  expect(confluencePageOf('https://x.atlassian.net/browse/BF-1')).toBeNull()
})
