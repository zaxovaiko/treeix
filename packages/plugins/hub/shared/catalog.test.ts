import { expect, test } from 'bun:test'
import { fit } from './catalog'

test('rates a model against the Mac memory', () => {
  expect(fit(6.6, 36)).toBe('fits')
  expect(fit(18.3, 36)).toBe('tight')
  expect(fit(18.3, 24)).toBe('too big')
})
