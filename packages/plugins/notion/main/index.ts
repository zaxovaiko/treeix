import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { MainPlugin } from '@treeix/sdk/main'
import { isJson, list, text } from '@treeix/shared/json'
import { type Schema, toProperties } from './properties'

const exec = promisify(execFile)
const VERSION = '2026-03-11'
const TIMEOUT_MS = 30_000
const SIGN_IN = 'run ntn login in a terminal'

/** ntn's own message: its "error:" prefix dropped, a missing CLI or login turned into the fix */
export const failure = (reason: unknown): string => {
  if (isJson(reason) && reason.code === 'ENOENT') return `Notion CLI not found. Install it with: curl -fsSL https://ntn.dev | bash, then ${SIGN_IN}`
  const stderr = isJson(reason) ? text(reason.stderr).trim() : ''
  const message = stderr || (reason instanceof Error ? reason.message : String(reason))
  // Signed out, ntn says "No workspace selected" with a hint to run ntn login
  if (/ntn login|unauthorized/i.test(message)) return `Notion CLI is not signed in: ${SIGN_IN}`
  return message.split('\n')[0].replace(/^error:\s*/i, '')
}

/** A public API call through ntn, which holds the login; rejects with ntn's message */
async function notion(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const args = ['api', `/v1${path}`, '-X', method, '--notion-version', VERSION, ...(body === undefined ? [] : ['-d', JSON.stringify(body)])]
  try {
    const reply: unknown = JSON.parse((await exec('ntn', args, { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout)
    if (!isJson(reply)) throw new Error(`Notion ${method} ${path} answered no object`)
    return reply
  } catch (reason) {
    throw new Error(failure(reason), { cause: reason })
  }
}

/** Who ntn acts for; pages it makes come from the Notion CLI bot on their behalf */
const whoIs = async (): Promise<string> => {
  const me = await notion('GET', '/users/me')
  const owner = isJson(me.bot) && isJson(me.bot.owner) && isJson(me.bot.owner.user) ? text(me.bot.owner.user.name) : ''
  return owner || text(me.name) || 'the Notion CLI'
}

const plugin: MainPlugin = {
  activate: (context) => {
    const schemas = new Map<string, Schema>()
    // A retried workflow step skips the pages it already made, so a failure halfway through a batch duplicates nothing
    const created = new Map<string, string>()

    context.handle('connection', () =>
      whoIs().then(
        (name) => ({ connected: true, message: `Signed in as ${name}` }),
        (reason: unknown) => ({ connected: false, message: reason instanceof Error ? reason.message : String(reason) })
      )
    )

    context.mcpTool({
      name: 'notion_create_pages',
      description: [
        'Adds pages to a Notion data source (a database) the Notion CLI login can reach. Replies with their URLs.',
        "properties take plain values by property name: text for title and rich_text, an ISO date, a select or status option's name, a list or comma-separated names for multi_select, true for a checkbox, page URLs or ids for a relation (an earlier notion_create_pages reply works); an object is passed as Notion's own property value. Empty values are left out.",
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
        let schema = schemas.get(dataSource)
        if (!schema) {
          const properties = (await notion('GET', `/data_sources/${dataSource}`)).properties
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
          const url = created.get(key) ?? text((await notion('POST', '/pages', body)).url)
          created.set(key, url)
          urls.push(url)
        }
        return urls.join('\n')
      }
    })
  }
}

export default plugin
