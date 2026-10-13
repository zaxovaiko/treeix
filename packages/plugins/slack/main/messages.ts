import { type Json, text } from '@treeix/shared/json'

const MENTION = /<@(\w+)(?:\|[^>]*)?>/g

/** People's own messages and thread replies sent to the channel; not edits, joins, bots or empty ones */
export const isHumanMessage = (event: Json): boolean =>
  event.type === 'message' && (event.subtype === undefined || event.subtype === 'thread_broadcast') && !event.bot_id && text(event.text).trim() !== ''

/** A message's link, built from the workspace URL auth.test gives, so no call per message */
export const permalink = (workspaceUrl: string, channel: string, ts: string): string => `${workspaceUrl}archives/${channel}/p${ts.replace('.', '')}`

export type Message = { channel: string; user: string; text: string; ts: string; permalink: string; thread: boolean }

/** Numbered lines a prompt can point back at, each with its link for a task to quote: `[1] #general (thread reply) 14:05 Anna: text (link)` */
export function render(messages: Message[]): string {
  return messages
    .map((message, index) => {
      const time = new Date(Number(message.ts) * 1000).toTimeString().slice(0, 5)
      return `[${index + 1}] ${message.channel}${message.thread ? ' (thread reply)' : ''} ${time} ${message.user}: ${message.text}${message.permalink ? ` (${message.permalink})` : ''}`
    })
    .join('\n')
}

/** Mentions written as people's names, resolved by `name` */
export const withNames = async (raw: string, name: (id: string) => Promise<string>): Promise<string> => {
  let result = raw
  for (const [mention, id] of raw.matchAll(MENTION)) result = result.replace(mention, `@${await name(id)}`)
  return result
}
