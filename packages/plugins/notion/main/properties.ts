import { isJson } from '@treeix/shared/json'

/** A data source's properties by name, as Notion describes them */
export type Schema = Record<string, { type: string }>

const TEXT_LIMIT = 2000
const PAGE_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi
const richText = (value: unknown): { text: { content: string } }[] => [{ text: { content: String(value).slice(0, TEXT_LIMIT) } }]
const names = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : String(value).split(',')).map((name) => name.trim()).filter(Boolean)

/** Plain values to Notion's property values by each property's type; an object is taken as Notion's own value, an empty value is left out */
export function toProperties(schema: Schema, values: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    const property = schema[name]
    if (!property) throw new Error(`No property ${name}; the data source has ${Object.keys(schema).join(', ')}`)
    if (value === null || value === undefined || value === '') continue
    if (isJson(value)) {
      properties[name] = value
      continue
    }
    switch (property.type) {
      case 'title':
      case 'rich_text':
        properties[name] = { [property.type]: richText(value) }
        break
      case 'number':
        properties[name] = { number: Number(value) }
        break
      case 'checkbox':
        properties[name] = { checkbox: value === true || value === 'true' }
        break
      case 'select':
      case 'status':
        properties[name] = { [property.type]: { name: String(value) } }
        break
      case 'multi_select':
        properties[name] = { multi_select: names(value).map((option) => ({ name: option })) }
        break
      case 'date':
        properties[name] = { date: { start: String(value) } }
        break
      // Page ids or URLs, such as the reply of an earlier notion_create_pages
      case 'relation':
        properties[name] = { relation: (String(value).match(PAGE_ID) ?? []).map((id) => ({ id })) }
        break
      case 'url':
      case 'email':
      case 'phone_number':
        properties[name] = { [property.type]: String(value) }
        break
      default:
        throw new Error(`${name} is a ${property.type} property; pass Notion's own value object for it`)
    }
  }
  return properties
}

/**
 * `Property = value` as a data source query filter by the property's type, so a watch is set up by name;
 * several joined by `AND` must all match
 */
export function whereFilter(schema: Schema, where: string): Record<string, unknown> {
  const filters = where
    .split(/\s+AND\s+/i)
    .filter((part) => part.trim())
    .map((part): Record<string, unknown> => {
      const match = /^(.+?)\s*=\s*(.*)$/.exec(part.trim())
      if (!match) throw new Error(`Write the condition as Property = value, not ${part.trim()}`)
      const [, name = '', value = ''] = match
      const property = schema[name.trim()]
      if (!property) throw new Error(`No property ${name.trim()}; the data source has ${Object.keys(schema).join(', ')}`)
      const wanted = value.trim().replace(/^"(.*)"$/, '$1')
      switch (property.type) {
        case 'checkbox':
          return {
            property: name.trim(),
            checkbox: { equals: wanted.toLowerCase() === 'true' }
          }
        case 'select':
        case 'status':
          return { property: name.trim(), [property.type]: { equals: wanted } }
        case 'multi_select':
          return { property: name.trim(), multi_select: { contains: wanted } }
        case 'title':
        case 'rich_text':
          return { property: name.trim(), [property.type]: { equals: wanted } }
        default:
          throw new Error(`${name.trim()} is a ${property.type} property; watch a checkbox, select, status, multi-select or text one`)
      }
    })
  if (!filters.length) throw new Error('Write a condition such as Agent = ready')
  return filters.length === 1 ? (filters[0] ?? {}) : { and: filters }
}

const plainText = (value: unknown): string =>
  Array.isArray(value) ? value.map((part) => (isJson(part) && typeof part.plain_text === 'string' ? part.plain_text : '')).join('') : ''
const nameOf = (value: unknown): string | null => (isJson(value) && typeof value.name === 'string' ? value.name : null)

/** A page's property values as plain JSON, for agents to read */
export function plainProperties(properties: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(isJson(properties) ? properties : {}).map(([name, property]): [string, unknown] => {
      if (!isJson(property) || typeof property.type !== 'string') return [name, null]
      const value = property[property.type]
      switch (property.type) {
        case 'title':
        case 'rich_text':
          return [name, plainText(value)]
        case 'select':
        case 'status':
          return [name, nameOf(value)]
        case 'multi_select':
        case 'people':
          return [name, Array.isArray(value) ? value.map(nameOf).filter(Boolean) : []]
        case 'date':
          return [name, isJson(value) ? (value.start ?? null) : null]
        case 'relation':
          return [name, Array.isArray(value) ? value.map((entry) => (isJson(entry) ? entry.id : null)).filter(Boolean) : []]
        default:
          return [name, value ?? null]
      }
    })
  )
}

/** The text of a page's title property */
export const pageTitle = (properties: unknown): string => {
  const title = Object.values(isJson(properties) ? properties : {}).find((property) => isJson(property) && property.type === 'title')
  return isJson(title) ? plainText(title.title) : ''
}
