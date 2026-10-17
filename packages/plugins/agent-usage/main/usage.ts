import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isJson, object, parseJson, text, type Json } from '@treeix/shared/json'
import { readJsonFile } from '@treeix/host/paths'
import type { UsageRow } from '../shared/types'

const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects')
const CODEX_FOLDERS = [join(homedir(), '.codex', 'sessions'), join(homedir(), '.codex', 'archived_sessions')]
const CODEX_INDEX = join(homedir(), '.codex', 'session_index.jsonl')
// Bumped when parsing changes, so every log is read again
const CACHE_VERSION = 2

type Tokens = Pick<UsageRow, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
type Lines = AsyncIterable<string> | Iterable<string>
/** A log's usage rows and the session titles it names, by session id */
export type Parsed = { rows: UsageRow[]; titles: Record<string, string> }

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

export function localDay(timestamp: string): string | null {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** A worktree counts toward its repository, shown from ~ */
export function projectOf(cwd: string, home = homedir()): string {
  const repo = cwd.replace(/\/\.claude\/worktrees\/.*$/, '')
  if (!repo) return 'unknown'
  return repo === home || repo.startsWith(`${home}/`) ? `~${repo.slice(home.length)}` : repo
}

function tally(): {
  add: (key: Omit<UsageRow, keyof Tokens>, tokens: Tokens) => void
  rows: () => UsageRow[]
} {
  const rows = new Map<string, UsageRow>()
  return {
    add: (key, tokens) => {
      const id = [key.day, key.agent, key.model, key.project, key.session].join('\n')
      const row = rows.get(id) ?? {
        ...key,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      }
      row.input += tokens.input
      row.output += tokens.output
      row.cacheRead += tokens.cacheRead
      row.cacheWrite += tokens.cacheWrite
      rows.set(id, row)
    },
    rows: () => [...rows.values()]
  }
}

/** Claude Code transcripts: one `usage` per API reply, repeated on each content block line of that reply; a title the user set beats the generated one */
export async function claudeRows(lines: Lines): Promise<Parsed> {
  const rows = tally()
  const seen = new Set<string>()
  const titles: Record<string, string> = {}
  const named = new Set<string>()
  for await (const line of lines) {
    if (line.includes('-title"')) {
      const entry = object(parseJson(line))
      const session = text(entry.sessionId)
      const custom = entry.type === 'custom-title' ? text(entry.customTitle) : ''
      const generated = entry.type === 'ai-title' ? text(entry.aiTitle) : ''
      if (session && custom) named.add(session)
      if (session && (custom || (generated && !named.has(session)))) titles[session] = custom || generated
      continue
    }
    if (!line.includes('"usage"')) continue
    const entry = parseJson(line)
    if (!isJson(entry) || entry.type !== 'assistant') continue
    const message = object(entry.message)
    const model = text(message.model)
    const day = localDay(text(entry.timestamp))
    if (!isJson(message.usage) || model === '<synthetic>' || !day) continue
    const id = text(message.id)
    if (id) {
      const reply = `${id}:${text(entry.requestId)}`
      if (seen.has(reply)) continue
      seen.add(reply)
    }
    const usage = message.usage
    rows.add(
      {
        day,
        agent: 'claude',
        model: model || 'unknown',
        project: projectOf(text(entry.cwd)),
        session: text(entry.sessionId) || 'unknown'
      },
      {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite: num(usage.cache_creation_input_tokens)
      }
    )
  }
  return { rows: rows.rows(), titles }
}

/** Codex rollouts: cumulative `token_count` totals, so each event adds what grew since the last; Ollama-backed sessions count as Ollama */
export async function codexRows(lines: Lines): Promise<Parsed> {
  const rows = tally()
  let session = 'unknown'
  let cwd = ''
  let agent = 'codex'
  let model = 'unknown'
  let previous: Json | null = null
  for await (const line of lines) {
    if (!line.includes('"session_meta"') && !line.includes('"turn_context"') && !line.includes('"token_count"')) continue
    const event = parseJson(line)
    if (!isJson(event)) continue
    const payload = object(event.payload)
    if (event.type === 'session_meta') {
      cwd = text(payload.cwd) || cwd
      session = text(payload.id) || session
      agent = text(payload.model_provider).includes('ollama') ? 'ollama' : 'codex'
      continue
    }
    if (event.type === 'turn_context') {
      model = text(payload.model) || model
      cwd = text(payload.cwd) || cwd
      continue
    }
    const info = payload.type === 'token_count' && isJson(payload.info) ? payload.info : null
    const day = localDay(text(event.timestamp))
    if (!info || !day) continue
    const total = isJson(info.total_token_usage) ? info.total_token_usage : null
    const last = object(info.last_token_usage)
    // A total that shrank started over; the turn's own usage is the best left
    const fromTotal = total !== null && num(total.total_tokens) >= num(previous?.total_tokens)
    const spent = (key: string): number => (fromTotal && total ? num(total[key]) - num(previous?.[key]) : num(last[key]))
    // input_tokens includes the cached ones
    const cacheRead = spent('cached_input_tokens')
    const cacheWrite = spent('cache_write_input_tokens')
    const tokens = {
      input: Math.max(0, spent('input_tokens') - cacheRead - cacheWrite),
      output: spent('output_tokens'),
      cacheRead,
      cacheWrite
    }
    if (total) previous = total
    if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite > 0) rows.add({ day, agent, model, project: projectOf(cwd), session }, tokens)
  }
  return { rows: rows.rows(), titles: {} }
}

/** Codex keeps thread names apart from the rollouts; a later line renames */
export async function codexTitles(lines: Lines): Promise<Record<string, string>> {
  const titles: Record<string, string> = {}
  for await (const line of lines) {
    const entry = object(parseJson(line))
    if (text(entry.id) && text(entry.thread_name)) titles[text(entry.id)] = text(entry.thread_name)
  }
  return titles
}

type FileRows = Parsed & { mtimeMs: number; size: number }

const isFileRows = (value: unknown): value is FileRows =>
  isJson(value) && typeof value.mtimeMs === 'number' && typeof value.size === 'number' && Array.isArray(value.rows) && isJson(value.titles)

const jsonlUnder = async (folder: string): Promise<string[]> =>
  (await readdir(folder, { recursive: true }).catch(() => [])).filter((name) => name.endsWith('.jsonl')).map((name) => join(folder, name))

const linesOf = (path: string): AsyncIterable<string> => createInterface({ input: createReadStream(path), crlfDelay: Infinity })

/**
 * Logs are read again only when their size or time changed; the rest come from `cacheFile`.
 * ponytail: a growing log is re-read whole, read from the last offset if live sessions make this slow.
 */
async function scan(cacheFile: string): Promise<Parsed> {
  const saved = object(await readJsonFile(cacheFile))
  const cached = saved.version === CACHE_VERSION ? object(saved.files) : {}
  const [claude, codex] = await Promise.all([jsonlUnder(CLAUDE_PROJECTS), Promise.all(CODEX_FOLDERS.map(jsonlUnder)).then((folders) => folders.flat())])
  const sources = [...claude.map((path) => [path, claudeRows] as const), ...codex.map((path) => [path, codexRows] as const)]
  const files: Record<string, FileRows> = {}
  let read = 0
  for (const [path, parse] of sources) {
    const info = await stat(path).catch(() => null)
    if (!info) continue
    const hit = cached[path]
    if (isFileRows(hit) && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
      files[path] = hit
      continue
    }
    files[path] = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      ...(await parse(linesOf(path)).catch((): Parsed => ({ rows: [], titles: {} })))
    }
    read++
  }
  if (read > 0 || Object.keys(cached).length !== Object.keys(files).length) await writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, files }))
  const codexNames = await stat(CODEX_INDEX).then(
    () => codexTitles(linesOf(CODEX_INDEX)),
    () => ({})
  )
  return {
    rows: Object.values(files).flatMap((file) => file.rows),
    titles: Object.assign({}, ...Object.values(files).map((file) => file.titles), codexNames)
  }
}

let scanning: Promise<Parsed> | null = null

/** Every agent's tokens by day, model, project and session, with session titles; overlapping calls share one scan */
export function usageRows(cacheFile: string): Promise<Parsed> {
  scanning ??= scan(cacheFile).finally(() => (scanning = null))
  return scanning
}
