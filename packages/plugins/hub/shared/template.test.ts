import { expect, test } from 'bun:test'
import { references, render, renderArgs } from './template'

test('fills the input, what flows in and earlier outputs, and leaves other braces alone', () => {
  const scope = { input: 'the ask', prev: 'a\n\nb', outputs: { 'review-1': 'looks fine' } }
  expect(render('{{input}} / {{ prev }} / {{nodes.review-1.output}} / {{nodes.gone.output}} / {{other}}', scope)).toBe('the ask / a\n\nb / looks fine /  / {{other}}')
})

test('a JSON path reads into an output, even one wrapped in prose or a code fence', () => {
  const scope = { input: '{"title":"Daily","invitees":["Ann","Bo"]}', prev: '', outputs: { llm: 'Here you go:\n```json\n{"tasks":[{"Name":"Ship it"}]}\n```' } }
  expect(render('{{input.title}} with {{input.invitees.1}}: {{nodes.llm.output.tasks.0.Name}} {{input.missing}}!', scope)).toBe('Daily with Bo: Ship it !')
  expect(render('{{input.invitees}}', scope)).toBe('["Ann","Bo"]')
})

test('renderArgs passes a whole reference as its value and renders text around references', () => {
  const scope = { input: '{"title":"Daily","id":"2026-10-15 1100 Daily"}', prev: '', outputs: { llm: '{"tasks":[{"Name":"Ship it"}],"summary":"Short"}', plain: 'just text' } }
  const args = renderArgs(
    '{"pages":"{{nodes.llm.output.tasks}}","whole":"{{nodes.llm.output}}","text":"{{nodes.plain.output}}","name":"Notes: {{input.title}}","keep":3,"list":["{{input.id}}"]}',
    scope
  )
  expect(args).toEqual({
    pages: [{ Name: 'Ship it' }],
    whole: { tasks: [{ Name: 'Ship it' }], summary: 'Short' },
    text: 'just text',
    name: 'Notes: Daily',
    keep: 3,
    list: ['2026-10-15 1100 Daily']
  })
  expect(() => renderArgs('[1]', scope)).toThrow('JSON object')
  expect(() => renderArgs('{oops', scope)).toThrow('JSON object')
})

test('references sees node outputs read through a path', () => {
  expect(references('{{nodes.a.output.tasks}} {{nodes.b-2.output}} {{input.x}}')).toEqual(['a', 'b-2'])
})
