import { list, object, text } from '@treeix/shared/json'
import type { Formatting, Term } from '../shared/types'

const FORMAT_TIMEOUT_MS = 8000

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Replaces each term's aliases, and the term in any case, with the term as written; whole words only, in any script */
export function applyVocabulary(input: string, terms: Term[]): string {
  const replacements = new Map<string, string>()
  for (const term of terms) {
    for (const alias of [...term.aliases, term.text]) if (alias.trim()) replacements.set(alias.trim().toLowerCase(), term.text)
  }
  if (replacements.size === 0) return input
  // Longest first, so "git hub" wins over "git"
  const alternatives = [...replacements.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp)
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`, 'giu')
  return input.replace(pattern, (match) => replacements.get(match.toLowerCase()) ?? match)
}

/** The model's reply without reasoning or wrapping quotes, or null when it looks like an answer rather than the same text cleaned up */
export function acceptFormatted(raw: string, reply: string): string | null {
  let cleaned = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const quoted = /^["“«]([\s\S]*)["”»]$/.exec(cleaned)
  if (quoted && !/^["“«]/.test(raw)) cleaned = quoted[1].trim()
  if (!cleaned || cleaned.length < raw.length * 0.5 || cleaned.length > raw.length * 2 + 20) return null
  return cleaned
}

const endpoint = (baseUrl: string, path: string): string => `${baseUrl.trim().replace(/\/+$/, '')}${path}`

/** Cleans up a dictation with an OpenAI-compatible server such as Ollama or LM Studio; any failure returns the raw text and why */
export async function format(raw: string, settings: Formatting, terms: Term[]): Promise<{ text: string; error: string | null }> {
  const spelling = terms.length > 0 ? `\n\nSpell these exactly as written: ${terms.map((term) => term.text).join(', ')}` : ''
  try {
    const response = await fetch(endpoint(settings.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0,
        stream: false,
        messages: [
          { role: 'system', content: settings.prompt + spelling },
          { role: 'user', content: raw }
        ]
      }),
      signal: AbortSignal.timeout(FORMAT_TIMEOUT_MS)
    })
    if (!response.ok) return { text: raw, error: `the server answered ${response.status}` }
    const body: unknown = await response.json()
    const reply = text(object(object(list(object(body).choices)[0]).message).content)
    const accepted = acceptFormatted(raw, reply)
    return accepted === null ? { text: raw, error: 'the reply changed the text too much, so the raw text was used' } : { text: accepted, error: null }
  } catch (error) {
    return { text: raw, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Models the server offers, empty when it can't be reached */
export async function formatterModels(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(endpoint(baseUrl, '/models'), { signal: AbortSignal.timeout(FORMAT_TIMEOUT_MS) })
    const body: unknown = await response.json()
    return list(object(body).data)
      .map((model) => text(model.id))
      .filter(Boolean)
  } catch {
    return []
  }
}
