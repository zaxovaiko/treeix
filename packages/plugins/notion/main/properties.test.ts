import { expect, test } from 'bun:test'
import { toProperties } from './properties'

const schema = {
  Name: { type: 'title' },
  Due: { type: 'date' },
  Type: { type: 'select' },
  Tags: { type: 'multi_select' },
  Done: { type: 'checkbox' },
  Owner: { type: 'people' }
}

test('plain values become property values by type, empty ones are left out', () => {
  expect(toProperties(schema, { Name: 'Ship it', Due: '2026-10-15', Type: 'Blurify', Tags: 'a, b', Done: true, Owner: '' })).toEqual({
    Name: { title: [{ text: { content: 'Ship it' } }] },
    Due: { date: { start: '2026-10-15' } },
    Type: { select: { name: 'Blurify' } },
    Tags: { multi_select: [{ name: 'a' }, { name: 'b' }] },
    Done: { checkbox: true }
  })
})

test("an object is Notion's own value, an unknown property or type is refused with what would do", () => {
  expect(toProperties(schema, { Owner: { people: [{ id: 'u1' }] } })).toEqual({ Owner: { people: [{ id: 'u1' }] } })
  expect(() => toProperties(schema, { Nmae: 'x' })).toThrow('No property Nmae; the data source has Name, Due')
  expect(() => toProperties(schema, { Owner: 'Me' })).toThrow("people property; pass Notion's own value object")
})
