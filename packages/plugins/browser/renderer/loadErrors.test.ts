import { expect, test } from 'bun:test'
import { httpProblem, loadError } from './loadErrors'

test('loadError groups net errors by what to do about them', () => {
  expect(loadError(-102, 'http://localhost:3000/en')).toMatchObject({ icon: 'power', title: 'Nothing is answering on localhost:3000' })
  expect(loadError(-105, 'https://typo.test')).toMatchObject({ icon: 'globe' })
  expect(loadError(-202, 'https://self-signed.test')).toMatchObject({ icon: 'lock' })
  expect(loadError(-999, 'not a url')).toMatchObject({ icon: 'alert', title: "not a url couldn't be loaded" })
})

test('httpProblem marks only error statuses', () => {
  expect(httpProblem(200)).toBeNull()
  expect(httpProblem(null)).toBeNull()
  expect(httpProblem(404)).toMatchObject({ icon: 'search', hint: 'Not found' })
  expect(httpProblem(503)).toMatchObject({ icon: 'alert', hint: 'Server error' })
})
