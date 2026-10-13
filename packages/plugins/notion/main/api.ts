import { isJson, text } from '@treeix/shared/json'

const VERSION = '2026-03-11'
const TIMEOUT_MS = 30_000
const NO_TOKEN = 'No Notion token: add a personal access token in Settings > Notion'

/** Notion's error message, a rejected token turned into the fix */
export const failure = (status: number, reply: unknown): string => {
  if (status === 401) return 'Notion rejected the token: make a new personal access token in Settings > Notion'
  return (isJson(reply) && text(reply.message)) || `Notion answered ${status}`
}

/** A public API call as the token's owner; rejects with Notion's message */
export async function notion(token: string | null, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!token) throw new Error(NO_TOKEN)
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const reply: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(failure(response.status, reply))
  if (!isJson(reply)) throw new Error(`Notion ${method} ${path} answered no object`)
  return reply
}

/** Whom the token acts for */
export const whoIs = async (token: string | null): Promise<string> => {
  const me = await notion(token, 'GET', '/users/me')
  const owner = isJson(me.bot) && isJson(me.bot.owner) && isJson(me.bot.owner.user) ? text(me.bot.owner.user.name) : ''
  return owner || text(me.name) || 'your token'
}
