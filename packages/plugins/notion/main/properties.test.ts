import { expect, test } from 'bun:test'
import { pageLabels, pageTitle, plainProperties, toProperties, whereFilter } from './properties'

const schema = {
  Name: { type: 'title' },
  Due: { type: 'date' },
  Type: { type: 'select' },
  Tags: { type: 'multi_select' },
  Done: { type: 'checkbox' },
  Owner: { type: 'people' },
  Tasks: { type: 'relation' }
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

test('a relation takes the page ids in URLs', () => {
  const urls = 'https://www.notion.so/Ship-it-28a2c5e0b1c24f6e9d3a7b8c9d0e1f2a\nhttps://www.notion.so/Test-38a2c5e0b1c24f6e9d3a7b8c9d0e1f2b'
  expect(toProperties(schema, { Tasks: urls })).toEqual({ Tasks: { relation: [{ id: '28a2c5e0b1c24f6e9d3a7b8c9d0e1f2a' }, { id: '38a2c5e0b1c24f6e9d3a7b8c9d0e1f2b' }] } })
})

test('a watch condition becomes a query filter by the property type', () => {
  expect(whereFilter({ ...schema, Agent: { type: 'status' } }, 'Agent = ready')).toEqual({ property: 'Agent', status: { equals: 'ready' } })
  expect(whereFilter(schema, 'Done = true AND Tags = "a"')).toEqual({
    and: [
      { property: 'Done', checkbox: { equals: true } },
      { property: 'Tags', multi_select: { contains: 'a' } }
    ]
  })
  expect(() => whereFilter(schema, 'Agnet = ready')).toThrow('No property Agnet')
  expect(() => whereFilter(schema, 'Due = today')).toThrow('Due is a date property')
  expect(() => whereFilter(schema, 'ready')).toThrow('Property = value')
})

test('page properties read back as plain values', () => {
  const properties = {
    Name: {
      type: 'title',
      title: [{ plain_text: 'Ship ' }, { plain_text: 'it' }]
    },
    Agent: { type: 'select', select: { name: 'ready' } },
    Tags: { type: 'multi_select', multi_select: [{ name: 'a' }] },
    Done: { type: 'checkbox', checkbox: false }
  }
  expect(plainProperties(properties)).toEqual({
    Name: 'Ship it',
    Agent: 'ready',
    Tags: ['a'],
    Done: false
  })
  expect(pageTitle(properties)).toBe('Ship it')
})

test('pageLabels takes select and multi-select values, which name what a page is about', () => {
  const properties = {
    Name: { type: 'title', title: [{ plain_text: 'Fix it' }] },
    Type: { type: 'select', select: { name: 'Ariex' } },
    Agent: { type: 'select', select: null },
    Tags: { type: 'multi_select', multi_select: [{ name: 'Betfeel' }, { name: 'Marketing' }] },
    Status: { type: 'status', status: { name: 'Done' } }
  }
  expect(pageLabels(properties)).toEqual(['Ariex', 'Betfeel', 'Marketing'])
})
