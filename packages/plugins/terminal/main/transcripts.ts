import { access, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SessionUsage, TranscriptRef } from '../shared/types'
import { isJson } from '@treeix/shared/json'

const claudeProjects = (): string => join(homedir(), '.claude', 'projects')
const codexSessions = (): string => join(homedir(), '.codex', 'sessions')

/** Claude keeps `<id>.jsonl` in a folder named after the working directory, which can move; so every project folder is tried */
async function claudeTranscript(id: string): Promise<string | null> {
  for (const folder of await readdir(claudeProjects()).catch(() => [])) {
    const path = join(claudeProjects(), folder, `${id}.jsonl`)
    if (await access(path).then(() => true, () => false)) return path
  }
  return null
}

/** Codex names each rollout `rollout-<time>-<id>.jsonl` under YYYY/MM/DD */
async function codexTranscript(id: string): Promise<string | null> {
  const entries = await readdir(codexSessions(), { recursive: true }).catch(() => [])
  const name = entries.find((entry) => entry.endsWith(`-${id}.jsonl`))
  return name ? join(codexSessions(), name) : null
}

const transcriptPath = (ref: TranscriptRef): Promise<string | null> =>
  ref.kind === 'claude' ? claudeTranscript(ref.agentSessionId) : ref.kind === 'codex' ? codexTranscript(ref.agentSessionId) : Promise.resolve(null)

export const readTranscript = async (ref: TranscriptRef): Promise<string> => {
  const path = await transcriptPath(ref)
  return path ? readFile(path, 'utf8').catch(() => '') : ''
}

/** Which of the sessions' conversations mention `query`, by session id; JSON escapes mean text with quotes or newlines may be missed */
export async function searchTranscripts(query: string, refs: TranscriptRef[]): Promise<string[]> {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const hits = await Promise.all(refs.map(async (ref) => ((await readTranscript(ref)).toLowerCase().includes(needle) ? ref.sessionId : null)))
  return hits.filter((id) => id !== null)
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function parseLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line)
    return isJson(value) ? value : null
  } catch {
    return null
  }
}

/** Claude writes one line per content block, each repeating its message's usage, so messages count once by id */
export function claudeUsage(transcript: string): SessionUsage {
  const seen = new Set<string>()
  const usage: SessionUsage = { input: 0, output: 0, cached: 0 }
  for (const line of transcript.split('\n')) {
    if (!line.includes('"usage"')) continue
    const message = parseLine(line)?.message
    if (!isJson(message) || !isJson(message.usage) || typeof message.id !== 'string' || seen.has(message.id)) continue
    seen.add(message.id)
    usage.input += count(message.usage.input_tokens) + count(message.usage.cache_creation_input_tokens)
    usage.cached += count(message.usage.cache_read_input_tokens)
    usage.output += count(message.usage.output_tokens)
  }
  return usage
}

/** Codex reports running totals; the last one is the conversation's */
export function codexUsage(transcript: string): SessionUsage {
  const last = transcript
    .split('\n')
    .findLast((line) => line.includes('"total_token_usage"'))
  const payload = last ? parseLine(last)?.payload : null
  const info = isJson(payload) && isJson(payload.info) ? payload.info : null
  const total = info && isJson(info.total_token_usage) ? info.total_token_usage : null
  if (!total) return { input: 0, output: 0, cached: 0 }
  const cached = count(total.cached_input_tokens)
  return { input: count(total.input_tokens) - cached, cached, output: count(total.output_tokens) }
}

export async function transcriptUsage(ref: TranscriptRef): Promise<SessionUsage | null> {
  const transcript = await readTranscript(ref)
  if (!transcript) return null
  return ref.kind === 'claude' ? claudeUsage(transcript) : codexUsage(transcript)
}

const texts = (content: unknown, type: string): string[] =>
  Array.isArray(content) ? content.filter((block) => isJson(block) && block.type === type && typeof block.text === 'string').map((block) => (block as { text: string }).text) : []

/** The agent's last `count` written replies, oldest first; tool calls and results left out */
export function lastReplies(kind: string, transcript: string, count: number): string[] {
  const replies: string[] = []
  for (const line of transcript.split('\n')) {
    const entry = parseLine(line)
    if (kind === 'claude' && entry?.type === 'assistant' && isJson(entry.message)) replies.push(...texts(entry.message.content, 'text'))
    if (kind === 'codex' && isJson(entry?.payload) && entry.payload.type === 'message' && entry.payload.role === 'assistant') replies.push(...texts(entry.payload.content, 'output_text'))
  }
  return replies.slice(-count)
}
