import type { Annotation } from './types'

// Env variable kind: a pure function of name, value, the package's frameworks and an optional .env.example annotation.
// Same input, same answer, and every answer carries the rule that produced it.

export type Kind = 'exposed' | 'secret' | 'public' | 'config'

// Client prefixes only count when the package actually uses the framework that inlines them
export const CLIENT_PREFIXES: [prefix: string, framework: string][] = [
  ['NEXT_PUBLIC_', 'next'],
  ['VITE_', 'vite'],
  ['REACT_APP_', 'react-scripts'],
  ['EXPO_PUBLIC_', 'expo'],
  ['NUXT_PUBLIC_', 'nuxt'],
  ['GATSBY_', 'gatsby'],
  ['PUBLIC_', '@sveltejs/kit']
]

// Formats that are secret whatever the name says
const SECRET_VALUES: [pattern: RegExp, label: string][] = [
  [/^sk_(live|test)_/, 'Stripe secret key'],
  [/^rk_(live|test)_/, 'Stripe restricted key'],
  [/^sk-(proj-|ant-)?[A-Za-z0-9_-]{8,}/, 'OpenAI or Anthropic key'],
  [/^(ghp|gho|ghs|ghu)_|^github_pat_/, 'GitHub token'],
  [/^glpat-/, 'GitLab token'],
  [/^xox[abpr]-/, 'Slack token'],
  [/^AKIA[0-9A-Z]{16}$/, 'AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/, 'URL with a password']
]

const SECRET_NAME = /(SECRET|PASSWORD|PASSWD|_PASS$|PRIVATE_KEY|_TOKEN$|API_KEY$|ACCESS_KEY|ENCRYPTION_KEY|SIGNING_KEY|_SA_KEY$|SERVICE_ACCOUNT)/

export function classify(name: string, value = '', { frameworks = [], annotation }: { frameworks?: string[]; annotation?: Annotation } = {}): { kind: Kind; reason: string } {
  if (annotation) return { kind: annotation, reason: `marked @${annotation} in .env.example` }
  const secretValue = SECRET_VALUES.find(([pattern]) => pattern.test(value))
  const secretName = SECRET_NAME.test(name)
  const client = CLIENT_PREFIXES.find(([prefix, framework]) => name.startsWith(prefix) && frameworks.includes(framework))
  if (client && (secretValue || secretName)) {
    return { kind: 'exposed', reason: `${client[0]} is inlined into the browser bundle by ${client[1]}, and ${secretValue ? `the value is a ${secretValue[1]}` : 'the name says secret'}` }
  }
  if (client) return { kind: 'public', reason: `${client[0]} is inlined into the browser bundle by ${client[1]} (from package.json)` }
  if (secretValue) return { kind: 'secret', reason: `the value is a ${secretValue[1]}` }
  if (secretName) return { kind: 'secret', reason: 'the name says secret' }
  return { kind: 'config', reason: 'no secret name or value format' }
}

export const isSecretKind = (kind: Kind): boolean => kind === 'secret' || kind === 'exposed'

const MARK = /^#\s*@(secret|public)\b/
const ASSIGNMENT = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/

/** `# @secret` or `# @public` on the line above a key in .env.example */
export function annotations(exampleText: string): Record<string, Annotation> {
  const marks: Record<string, Annotation> = {}
  let pending: Annotation | undefined
  for (const line of exampleText.split('\n')) {
    const mark = line.match(MARK)
    if (mark) pending = mark[1] === 'secret' ? 'secret' : 'public'
    else if (ASSIGNMENT.test(line)) {
      if (pending) marks[line.split('=')[0].trim()] = pending
      pending = undefined
    }
  }
  return marks
}

/**
 * Writes `# @<annotation>` above `name` in .env.example text: replaces a mark already there, else inserts one,
 * else appends the name with the mark when the example doesn't list it
 */
export function setAnnotation(exampleText: string, name: string, annotation: Annotation): string {
  const lines = exampleText.split('\n')
  const index = lines.findIndex((line) => ASSIGNMENT.test(line) && line.split('=')[0].trim() === name)
  const mark = `# @${annotation}`
  if (index === -1) return `${exampleText}${exampleText && !exampleText.endsWith('\n') ? '\n' : ''}${mark}\n${name}=\n`
  if (index > 0 && MARK.test(lines[index - 1])) lines[index - 1] = mark
  else lines.splice(index, 0, mark)
  return lines.join('\n')
}
