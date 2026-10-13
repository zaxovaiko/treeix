import { isJson } from '@treeix/shared/json'

/** A data source's properties by name, as Notion describes them */
export type Schema = Record<string, { type: string }>

const TEXT_LIMIT = 2000
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
