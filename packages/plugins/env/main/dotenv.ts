import { parseEnv } from 'node:util'
import type { EnvVar } from '../shared/types'

export const ENV_FILE = /(^|\/)\.env(\.[\w.-]+)?$/
export const isTemplate = (path: string): boolean => /\.(example|sample|template|dist)$/.test(path)
export const isEnvPath = (path: string): boolean => ENV_FILE.test(path) && !path.includes('node_modules/')

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const isEnvName = (name: string): boolean => NAME.test(name)

const assignment = (name: string): RegExp => new RegExp(`^(\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*)(.*?)(\\r?)$`)
const lastLineOf = (lines: string[], name: string): number => lines.findLastIndex((line) => assignment(name).test(line))

/** What Node reads from the file, with the line that sets each name */
export function parseWithLines(text: string): EnvVar[] {
  const lines = text.split('\n')
  return Object.entries(parseEnv(text)).map(([name, value]) => ({ name, value: value ?? '', line: lastLineOf(lines, name) + 1 }))
}

const QUOTES = ['"', "'", '`']
const reads = (written: string, value: string): boolean => parseEnv(`X=${written}`).X === value

/** The value as it would be written: in the line's own quoting when that reads back the same, else the plainest that does */
function formatValue(value: string, quote: string | null): string {
  const candidates = [...(quote ? [`${quote}${value}${quote}`] : []), value, ...QUOTES.map((candidate) => `${candidate}${value}${candidate}`)]
  const written = candidates.find((candidate) => reads(candidate, value))
  if (written === undefined) throw new Error('This value mixes every kind of quote; edit the file by hand')
  return written
}

/**
 * Sets `name` to `value` by rewriting only the line that sets it (the last one when it repeats), keeping `export`,
 * spacing, quoting and a trailing comment; every other byte stays as it was. A name the file lacks is appended.
 */
export function setValue(text: string, name: string, value: string): string {
  if (!isEnvName(name)) throw new Error(`${name} is not a variable name`)
  const lines = text.split('\n')
  const index = lastLineOf(lines, name)
  if (index === -1) return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${name}=${formatValue(value, null)}\n`
  const [, prefix, rest, carriage] = lines[index].match(assignment(name)) ?? []
  const quote = QUOTES.find((candidate) => rest.startsWith(candidate)) ?? null
  const closing = quote ? rest.indexOf(quote, 1) : -1
  // A quoted value may run over several lines until its closing quote
  const end = quote && closing === -1 ? lines.findIndex((line, candidate) => candidate > index && line.includes(quote)) : index
  const quoted = quote !== null && (closing !== -1 || end !== -1)
  const last = end === -1 ? index : end
  const suffix = !quoted
    ? (rest.match(/\s*#.*$/)?.[0] ?? '')
    : last === index
      ? rest.slice(closing + 1)
      : lines[last].slice(lines[last].indexOf(quote) + 1).replace(/\r$/, '')
  lines.splice(index, last - index + 1, `${prefix}${formatValue(value, quoted ? quote : null)}${suffix}${carriage}`)
  return lines.join('\n')
}
