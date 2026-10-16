import type { McpTool } from '@treeix/sdk/main'
import { isString, list, text } from '@treeix/shared/json'
import { checkedKey, commentOnWorkItem, editWorkItem, searchWorkItems, transitionWorkItem, workItemDetail } from './acli'

const key = (args: Record<string, unknown>): string => checkedKey(text(args.key).trim())
const keyArg = { key: { type: 'string', description: 'Work item key, such as ABC-123' } }

/** Jira through the user's acli login, for agents and workflow watches that can't reach Jira themselves */
export const jiraTools: McpTool[] = [
  {
    name: 'jira_search',
    description: 'Work items a JQL query matches, up to 200, as JSON: key, summary, status, type, assignee and url.',
    inputSchema: { type: 'object', properties: { jql: { type: 'string' } }, required: ['jql'] },
    run: async (args) => {
      const jql = text(args.jql).trim()
      if (!jql) throw new Error('jql is required')
      const { items } = await searchWorkItems(jql)
      return JSON.stringify(items.map(({ key, summary, status, type, assignee, url }) => ({ key, summary, status, type, assignee, url })))
    }
  },
  {
    name: 'jira_work_item',
    description: 'One work item as JSON: summary, status, labels, parent, the description and every comment as markdown, and the links in them.',
    inputSchema: { type: 'object', properties: keyArg, required: ['key'] },
    run: async (args) => JSON.stringify(await workItemDetail(key(args)))
  },
  {
    name: 'jira_comment',
    description: "Adds a comment to a work item under the user's own account. body is plain text; blank lines split paragraphs.",
    inputSchema: { type: 'object', properties: { ...keyArg, body: { type: 'string' } }, required: ['key', 'body'] },
    run: async (args) => {
      const body = text(args.body).trim()
      if (!body) throw new Error('body is required')
      await commentOnWorkItem(key(args), body, null)
      return 'Commented'
    }
  },
  {
    name: 'jira_transition',
    description: 'Moves a work item to another status by its name, such as "Code Review". Fails with the statuses Jira allows when the name is not one.',
    inputSchema: { type: 'object', properties: { ...keyArg, status: { type: 'string' } }, required: ['key', 'status'] },
    run: async (args) => {
      const status = text(args.status).trim()
      if (!status) throw new Error('status is required')
      await transitionWorkItem(key(args), status)
      return `Moved to ${status}`
    }
  },
  {
    name: 'jira_edit_labels',
    description: 'Adds and removes labels on a work item.',
    inputSchema: {
      type: 'object',
      properties: { ...keyArg, add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } },
      required: ['key']
    },
    run: async (args) => {
      const add = list(args.add, isString)
      const remove = list(args.remove, isString)
      await editWorkItem(key(args), { addLabels: add, removeLabels: remove })
      return 'Labels changed'
    }
  }
]
