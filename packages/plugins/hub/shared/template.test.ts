import { expect, test } from 'bun:test'
import { render } from './template'

test('fills the input, what flows in and earlier outputs, and leaves other braces alone', () => {
  const scope = { input: 'the ask', prev: 'a\n\nb', outputs: { 'review-1': 'looks fine' } }
  expect(render('{{input}} / {{ prev }} / {{nodes.review-1.output}} / {{nodes.gone.output}} / {{other}}', scope)).toBe('the ask / a\n\nb / looks fine /  / {{other}}')
})
