import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createSecrets } from '@treeix/host/secrets'
import type { MainPlugin } from '@treeix/sdk/main'
import { isJson, list, text } from '@treeix/shared/json'
import { notion, whoIs } from './api'
import { pageLabels, pageTitle, plainProperties, type Schema, toProperties, whereFilter } from './properties'

const PAGE_ID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i
const COMMENT_CHARS = 2000

const plugin: MainPlugin = {
  activate: (context) => {
    const secrets = createSecrets(join(context.dataPath, 'secrets.bin'))
    const call = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => notion(await secrets.get('token'), method, path, body)
    const schemas = new Map<string, Schema>()
    const schemaOf = async (dataSource: string): Promise<Schema> => {
      const known = schemas.get(dataSource)
      if (known) return known
      const properties = (await call('GET', `/data_sources/${dataSource}`)).properties
      const schema = Object.fromEntries(
        Object.entries(isJson(properties) ? properties : {}).map(([name, property]) => [name, { type: isJson(property) ? text(property.type) : '' }])
      )
      schemas.set(dataSource, schema)
      return schema
    }
    const pageId = (args: Record<string, unknown>): string => {
      const id = text(args.page).match(PAGE_ID)?.[0]
      if (!id) throw new Error('Give the page id or URL')
      return id
    }
    // A retried workflow step skips the pages it already made, so a failure halfway through a batch duplicates nothing
    const created = new Map<string, string>()

    context.handle('connection', async () => {
      const token = await secrets.get('token')
      return whoIs(token).then(
        (name) => ({ saved: true, connected: true, message: `Signed in as ${name}` }),
        (reason: unknown) => ({ saved: token !== null, connected: false, message: reason instanceof Error ? reason.message : String(reason) })
      )
    })
    context.handle('setToken', async (_, token: string | null) => {
      // Checked before it is kept, so a typo never replaces a working token
      if (token !== null) await whoIs(token)
      await secrets.set('token', token)
      schemas.clear()
    })

    context.mcpTool({
      name: 'notion_create_pages',
      description: [
        "Adds pages to a Notion data source (a database) the Notion token's owner can reach. Replies with their URLs.",
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
        const schema = await schemaOf(dataSource)
        const defaults = isJson(args.defaults) ? args.defaults : {}
        const urls: string[] = []
        for (const page of pages) {
          const body = {
            parent: { type: 'data_source_id', data_source_id: dataSource },
            properties: toProperties(schema, { ...defaults, ...(isJson(page.properties) ? page.properties : {}) }),
            ...(text(page.markdown).trim() ? { markdown: text(page.markdown) } : {})
          }
          const key = createHash('sha256').update(JSON.stringify(body)).digest('hex')
          const url = created.get(key) ?? text((await call('POST', '/pages', body)).url)
          created.set(key, url)
          urls.push(url)
        }
        return urls.join('\n')
      }
    })
    context.mcpTool({
      name: 'notion_query',
      description:
        'Pages of a Notion data source whose properties match `where`, as JSON: id, title, url and labels (its select and multi-select values). `where` is `Property = value`, several joined by AND; checkbox, select, status, multi-select (contains) and text properties.',
      inputSchema: {
        type: 'object',
        properties: {
          dataSource: { type: 'string' },
          where: { type: 'string' }
        },
        required: ['dataSource', 'where']
      },
      run: async (args) => {
        const dataSource = text(args.dataSource).trim()
        if (!dataSource) throw new Error('dataSource is required')
        const filter = whereFilter(await schemaOf(dataSource), text(args.where))
        const reply = await call('POST', `/data_sources/${dataSource}/query`, {
          filter,
          page_size: 100
        })
        return JSON.stringify(
          list(reply.results).map((page) => ({
            id: text(page.id),
            title: pageTitle(page.properties),
            url: text(page.url),
            labels: pageLabels(page.properties)
          }))
        )
      }
    })
    context.mcpTool({
      name: 'notion_page',
      description: 'One Notion page as JSON: url, title, its properties as plain values, and its body as Notion-flavored markdown.',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'string', description: 'Page id or URL' } },
        required: ['page']
      },
      run: async (args) => {
        const id = pageId(args)
        const [page, body] = await Promise.all([call('GET', `/pages/${id}`), call('GET', `/pages/${id}/markdown`)])
        return JSON.stringify({
          url: text(page.url),
          title: pageTitle(page.properties),
          properties: plainProperties(page.properties),
          markdown: text(body.markdown),
          truncated: body.truncated === true
        })
      }
    })
    context.mcpTool({
      name: 'notion_comment',
      description: "Adds a comment to a Notion page as the token's owner. body is plain text.",
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id or URL' },
          body: { type: 'string' }
        },
        required: ['page', 'body']
      },
      run: async (args) => {
        const body = text(args.body).trim()
        if (!body) throw new Error('body is required')
        // Notion takes at most 2000 characters per text part
        const parts = Array.from({ length: Math.ceil(body.length / COMMENT_CHARS) }, (_, index) => body.slice(index * COMMENT_CHARS, (index + 1) * COMMENT_CHARS))
        await call('POST', '/comments', {
          parent: { page_id: pageId(args) },
          rich_text: parts.map((content) => ({ text: { content } }))
        })
        return 'Commented'
      }
    })
    context.mcpTool({
      name: 'notion_comments',
      description: 'The open comments on a Notion page as JSON, oldest first: created (ISO time) and body as plain text.',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'string', description: 'Page id or URL' } },
        required: ['page']
      },
      run: async (args) => {
        const id = pageId(args)
        const comments: { created: string; body: string }[] = []
        for (let cursor = ''; ;) {
          const page = await call('GET', `/comments?block_id=${id}&page_size=100${cursor && `&start_cursor=${cursor}`}`)
          for (const comment of list(page.results))
            comments.push({
              created: text(comment.created_time),
              body: list(comment.rich_text)
                .map((part) => text(part.plain_text))
                .join('')
            })
          cursor = page.has_more === true ? text(page.next_cursor) : ''
          if (!cursor) return JSON.stringify(comments)
        }
      }
    })
    context.mcpTool({
      name: 'notion_update_page',
      description: 'Sets properties of a page in a data source, with plain values by property name as notion_create_pages takes them.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id or URL' },
          properties: { type: 'object' }
        },
        required: ['page', 'properties']
      },
      run: async (args) => {
        const id = pageId(args)
        const parent = (await call('GET', `/pages/${id}`)).parent
        const dataSource = isJson(parent) ? text(parent.data_source_id) : ''
        if (!dataSource) throw new Error('The page is not in a data source')
        await call('PATCH', `/pages/${id}`, {
          properties: toProperties(await schemaOf(dataSource), isJson(args.properties) ? args.properties : {})
        })
        return 'Updated'
      }
    })
    context.mcpTool({
      name: 'notion_edit_page',
      description: 'Renames a page and/or replaces its whole body with Notion-flavored markdown. Omit what stays as it is.',
      inputSchema: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page id or URL' },
          title: { type: 'string' },
          markdown: { type: 'string', description: 'The new body, replacing all of it' }
        },
        required: ['page']
      },
      run: async (args) => {
        const id = pageId(args)
        const title = text(args.title).trim()
        if (title) {
          const properties = (await call('GET', `/pages/${id}`)).properties
          const name = Object.entries(isJson(properties) ? properties : {}).find(([, property]) => isJson(property) && property.type === 'title')?.[0]
          if (!name) throw new Error('The page has no title property')
          await call('PATCH', `/pages/${id}`, { properties: { [name]: { title: [{ text: { content: title } }] } } })
        }
        if (typeof args.markdown === 'string') await call('PATCH', `/pages/${id}/markdown`, { type: 'replace_content', replace_content: { new_str: args.markdown } })
        return 'Updated'
      }
    })
  }
}

export default plugin
