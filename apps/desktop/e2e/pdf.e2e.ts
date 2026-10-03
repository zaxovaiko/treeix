import { expect, test } from '@playwright/test'
import { launch, type Launched } from './app'

/** A one-page PDF saying Hello, with the byte offsets its cross-reference table needs */
function tinyPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 39 >>\nstream\nBT /F1 24 Tf 20 40 Td (Hello) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

let launched: Launched

test.beforeAll(async () => {
  launched = await launch({ 'doc.pdf': tinyPdf() }, 'doc.pdf')
})
test.afterAll(() => launched.close())

test('a PDF opens in the built-in viewer', async () => {
  const { page } = launched
  await expect(page.locator('iframe[title="doc.pdf"]')).toBeVisible()
  // Chromium's viewer is an extension page nested in the frame; it only loads when the CSP allows blob frames
  await expect.poll(() => page.frames().some((frame) => frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true)
})
