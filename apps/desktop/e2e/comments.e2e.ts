import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'notes.md': Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') }, 'notes.md')
})
test.afterAll(() => launched.close())

test('a line comment can be typed and saved from the editor', async () => {
  const { page } = launched
  // Monaco draws spaces as non-breaking ones, which \s matches
  const line = page.locator('.monaco-editor .view-line', { hasText: /^line\s3$/ })
  await line.hover()
  await page.locator('.code-editor-comment-glyph').click()

  // A real click, so a Monaco layer drawn over the card fails here
  const draft = page.getByRole('textbox', { name: 'Leave a note for the agent' })
  await draft.click()
  await page.keyboard.type('rename this')
  await expect(draft).toHaveValue('rename this')
  // By role, so a card hidden from screen readers fails here
  await page.getByRole('button', { name: 'Comment', exact: true }).click()

  await expect(page.locator('.monaco-editor .view-zones')).toContainText('rename this')
})
