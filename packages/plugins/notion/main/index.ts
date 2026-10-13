import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MainPlugin } from '@treeix/sdk/main'
import { createSecrets } from '@treeix/host/secrets'
import { isJson, list, text } from '@treeix/shared/json'
import { type Schema, toProperties } from './properties'

const API = 'https://api.notion.com/v1'
const VERSION = '2026-03-11'
const TOKEN = 'token'
const TIMEOUT_MS = 30_000

async function notion(token: string, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'notion-version': VERSION, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const reply: unknown = await response.json().catch(() => null)
  if (!response.ok || !isJson(reply)) throw new Error(`Notion ${method} ${path}: ${isJson(reply) ? text(reply.message) : response.status}`)
  return reply
}

/** The name of the integration a token belongs to; asking proves the token works */
const whoIs = async (token: string): Promise<string> => text((await notion(token, 'GET', '/users/me')).name) || 'the integration'

const plugin: MainPlugin = {
  activate: (context) => {
    const secrets = createSecrets(join(context.dataPath, 'secrets.bin'))
    const token = async (): Promise<string> => {
      const saved = await secrets.get(TOKEN)
      if (!saved) throw new Error('Notion is not connected; add the integration token in Settings > Notion')
      return saved
    }
    const schemas = new Map<string, Schema>()
    // A retried workflow step skips the pages it already made, so a failure halfway through a batch duplicates nothing
    const created = new Map<string, string>()

    context.handle('connection', async () => {
      const saved = await secrets.get(TOKEN)
      return saved
        ? whoIs(saved).then(
            (name) => `Connected as ${name}`,
            (reason: unknown) => `Saved, but Notion refused it: ${String(reason)}`
          )
        : null
    })
    context.handle('connect', async (_, secret: string) => {
      const name = await whoIs(secret)
      await secrets.set(TOKEN, secret)
      return `Connected as ${name}`
    })
    context.handle('disconnect', () => secrets.set(TOKEN, null))

    context.mcpTool({
      name: 'notion_create_pages',
      description: [
        'Adds pages to a Notion data source (a database) the integration was shared with. Replies with their URLs.',
        "properties take plain values by property name: text for title and rich_text, an ISO date, a select or status option's name, a list or comma-separated names for multi_select, true for a checkbox; an object is passed as Notion's own property value. Empty values are left out.",
        "markdown is the page body, Notion-flavored Markdown. defaults fill properties a page doesn't set."
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          dataSource: { type: 'string', description: 'The data source id (Notion > database > ••• > Copy data source ID)' },
          pages: {
            type: 'array',
            items: {
              type: 'object',
              properties: { properties: { type: 'object' }, markdown: { type: 'string' } },
              required: ['properties']
            }
          },
          defaults: { type: 'object', description: 'Property values every page gets unless it sets its own' }
        },
        required: ['dataSource', 'pages'],
        additionalProperties: false
      },
      run: async (args) => {
        const dataSource = text(args.dataSource).trim()
        if (!dataSource) throw new Error('dataSource is required')
        const pages = list(args.pages)
        if (!pages.length) return 'No pages to add'
        const auth = await token()
        let schema = schemas.get(dataSource)
        if (!schema) {
          const properties = (await notion(auth, 'GET', `/data_sources/${dataSource}`)).properties
          schema = Object.fromEntries(Object.entries(isJson(properties) ? properties : {}).map(([name, property]) => [name, { type: isJson(property) ? text(property.type) : '' }]))
          schemas.set(dataSource, schema)
        }
        const defaults = isJson(args.defaults) ? args.defaults : {}
        const urls: string[] = []
        for (const page of pages) {
          const body = {
            parent: { type: 'data_source_id', data_source_id: dataSource },
            properties: toProperties(schema, { ...defaults, ...(isJson(page.properties) ? page.properties : {}) }),
            ...(text(page.markdown).trim() ? { markdown: text(page.markdown) } : {})
          }
          const key = createHash('sha256').update(JSON.stringify(body)).digest('hex')
          const url = created.get(key) ?? text((await notion(auth, 'POST', '/pages', body)).url)
          created.set(key, url)
          urls.push(url)
        }
        return urls.join('\n')
      }
    })
  }
}

export default plugin
