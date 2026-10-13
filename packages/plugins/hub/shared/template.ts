import { isJson, parseJson } from '@treeix/shared/json'

/** What a template can reference: the run's input, the outputs flowing in, and any earlier node's output */
export type TemplateScope = { input: string; prev: string; outputs: Record<string, string> }

const REFERENCE = /\{\{\s*(input|prev|nodes\.([\w-]+)\.output)((?:\.[\w-]+)*)\s*\}\}/g
const WHOLE_REFERENCE = new RegExp(`^${REFERENCE.source}$`)

const isStructure = (value: unknown): boolean => isJson(value) || Array.isArray(value)

/** The object or array in a model's reply, which often wraps it in prose or a code fence; null when there is none */
export function parseLenient(text: string): unknown {
  const whole = parseJson(text)
  if (isStructure(whole)) return whole
  const start = text.search(/[{[]/)
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
  return start < 0 || end < start ? null : parseJson(text.slice(start, end + 1))
}

const child = (value: unknown, key: string): unknown => (Array.isArray(value) ? value[Number(key)] : isJson(value) ? value[key] : undefined)

/** A reference's value: the text itself, or with a path like `.tasks.0.name`, that part of the JSON in it */
function resolve(match: RegExpMatchArray, scope: TemplateScope): unknown {
  const [, name, node, path] = match
  const text = node !== undefined ? (scope.outputs[node] ?? '') : name === 'input' ? scope.input : scope.prev
  return path ? path.slice(1).split('.').reduce(child, parseLenient(text)) : text
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value))

/** Fills `{{input}}`, `{{prev}}` and `{{nodes.<id>.output}}`, each optionally with a JSON path; anything missing reads as empty */
export const render = (template: string, scope: TemplateScope): string => template.replace(REFERENCE, (...match) => asText(resolve(match as RegExpMatchArray, scope)))

/** Fills a JSON template: a string that is only a reference takes its value as is, an array or object included; other strings are rendered as text */
export function renderArgs(template: string, scope: TemplateScope): Record<string, unknown> {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = value.match(WHOLE_REFERENCE)
      if (!whole) return render(value, scope)
      const resolved = resolve(whole, scope)
      // A whole output holding JSON is passed as that JSON, so a step's reply can be the argument
      const parsed = typeof resolved === 'string' && !whole[3] ? parseJson(resolved) : null
      return isStructure(parsed) ? parsed : resolved
    }
    if (Array.isArray(value)) return value.map(fill)
    return isJson(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fill(entry)])) : value
  }
  const args = fill(parseJson(template))
  if (!isJson(args)) throw new Error('The arguments must be a JSON object')
  return args
}

/** The node ids a template reads the output of */
export const references = (template: string): string[] => [...template.matchAll(REFERENCE)].flatMap((match) => (match[2] === undefined ? [] : [match[2]]))
