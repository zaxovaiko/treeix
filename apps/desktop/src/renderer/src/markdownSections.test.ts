import { expect, test } from 'bun:test'
import { sectionize } from './markdownSections'

const heading = (depth: number) => ({ type: 'heading', depth })
const paragraph = { type: 'paragraph' }

test('sectionize nests sections by heading rank', () => {
  const tree = sectionize([paragraph, heading(2), paragraph, heading(3), paragraph, heading(2), paragraph])
  expect(tree.map((node) => node.type)).toEqual(['paragraph', 'section', 'section'])
  const first = tree[1]
  expect(first.children?.map((node) => node.type)).toEqual(['heading', 'paragraph', 'section'])
  expect(first.children?.[2].children?.map((node) => node.type)).toEqual(['heading', 'paragraph'])
})

test('sectionize leaves text without headings alone', () => {
  expect(sectionize([paragraph, paragraph]).map((node) => node.type)).toEqual(['paragraph', 'paragraph'])
})
