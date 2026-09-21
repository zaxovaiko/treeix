import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { ChatContent, ChatEvent, ChatOption, PermissionOption, PlanEntry, ToolCall, ToolOutput } from '@treeix/sdk/main'

// ACP messages come over JSON-RPC from the agent's process, so every field is read defensively
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const nullableNum = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function chatContent(value: unknown): ChatContent | null {
  const block = record(value)
  if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text }
  if (block.type === 'image' && typeof block.mimeType === 'string' && typeof block.data === 'string') return { type: 'image', mimeType: block.mimeType, data: block.data }
  return null
}

function toolOutput(value: unknown): ToolOutput | null {
  const item = record(value)
  if (item.type === 'content') {
    const content = chatContent(item.content)
    return content
  }
  if (item.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string') return { type: 'diff', path: item.path, oldText: nullableText(item.oldText), newText: item.newText }
  if (item.type === 'terminal' && typeof item.terminalId === 'string') return { type: 'terminal', terminalId: item.terminalId }
  return null
}

function toolOutputs(value: unknown): ToolOutput[] {
  return list(value).flatMap((entry) => {
    const output = toolOutput(entry)
    return output ? [output] : []
  })
}

const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const toolKind = (value: unknown): ToolCall['kind'] => (typeof value === 'string' && TOOL_KINDS.has(value) ? (value as ToolCall['kind']) : 'other')

const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed'])
const toolStatus = (value: unknown): ToolCall['status'] => (typeof value === 'string' && TOOL_STATUSES.has(value) ? (value as ToolCall['status']) : 'pending')

function toolLocations(value: unknown): ToolCall['locations'] {
  return list(value).flatMap((entry) => {
    const location = record(entry)
    return typeof location.path === 'string' ? [{ path: location.path, line: nullableNum(location.line) }] : []
  })
}

const PLAN_PRIORITIES = new Set(['high', 'medium', 'low'])
const planPriority = (value: unknown): PlanEntry['priority'] => (typeof value === 'string' && PLAN_PRIORITIES.has(value) ? (value as PlanEntry['priority']) : 'medium')

const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const planStatus = (value: unknown): PlanEntry['status'] => (typeof value === 'string' && PLAN_STATUSES.has(value) ? (value as PlanEntry['status']) : 'pending')

function planEntries(value: unknown): PlanEntry[] {
  return list(value).map((entry) => {
    const item = record(entry)
    return { content: text(item.content), priority: planPriority(item.priority), status: planStatus(item.status) }
  })
}

function toolCallEvent(update: Record<string, unknown>): ChatEvent[] {
  if (typeof update.toolCallId !== 'string') return []
  return [
    {
      type: 'tool_call',
      call: {
        id: update.toolCallId,
        title: text(update.title),
        kind: toolKind(update.kind),
        status: toolStatus(update.status),
        output: toolOutputs(update.content),
        locations: toolLocations(update.locations),
        rawInput: update.rawInput ?? null
      }
    }
  ]
}

function toolCallUpdateEvent(update: Record<string, unknown>): ChatEvent[] {
  if (typeof update.toolCallId !== 'string') return []
  const patch: Partial<Omit<ToolCall, 'id'>> = {}
  if (typeof update.title === 'string') patch.title = update.title
  if (update.kind !== undefined && update.kind !== null) patch.kind = toolKind(update.kind)
  if (update.status !== undefined && update.status !== null) patch.status = toolStatus(update.status)
  if (update.content !== undefined && update.content !== null) patch.output = toolOutputs(update.content)
  if (update.locations !== undefined && update.locations !== null) patch.locations = toolLocations(update.locations)
  if (update.rawInput !== undefined) patch.rawInput = update.rawInput
  return [{ type: 'tool_call_update', id: update.toolCallId, patch }]
}

/** Maps one ACP `session/update` notification payload (the `update` field) to zero or more chat events */
export function fromSessionUpdate(update: unknown): ChatEvent[] {
  const value = record(update)
  const kind = value.sessionUpdate

  if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
    const content = chatContent(value.content)
    return content ? [{ type: 'message_chunk', role: kind === 'agent_message_chunk' ? 'agent' : 'user', content }] : []
  }
  if (kind === 'agent_thought_chunk') {
    const content = chatContent(value.content)
    return content && content.type === 'text' ? [{ type: 'thought_chunk', text: content.text }] : []
  }
  if (kind === 'tool_call') return toolCallEvent(value)
  if (kind === 'tool_call_update') return toolCallUpdateEvent(value)
  if (kind === 'plan') return [{ type: 'plan', entries: planEntries(value.entries) }]
  if (kind === 'plan_update') return [{ type: 'plan', entries: planEntries(record(value.plan).entries) }]
  if (kind === 'usage_update') {
    const cost = record(value.cost)
    return [
      {
        type: 'usage',
        used: num(value.used),
        size: num(value.size),
        cost: typeof cost.amount === 'number' && typeof cost.currency === 'string' ? { amount: cost.amount, currency: cost.currency } : null
      }
    ]
  }
  if (kind === 'available_commands_update') {
    const commands = list(value.availableCommands).map((entry) => {
      const command = record(entry)
      return { name: text(command.name), description: text(command.description) }
    })
    return [{ type: 'commands', commands }]
  }
  if (kind === 'config_option_update') return [{ type: 'options', options: optionsFrom({ configOptions: value.configOptions }) }]

  return []
}

/** A select option's values, either flat or grouped (`SessionConfigSelectOption[] | SessionConfigSelectGroup[]`) */
function selectValues(value: unknown): ChatOption['values'] {
  return list(value).flatMap((entry) => {
    const item = record(entry)
    if (Array.isArray(item.options)) return selectValues(item.options)
    return typeof item.value === 'string' ? [{ value: item.value, name: text(item.name), description: nullableText(item.description) }] : []
  })
}

/** Config options (select only) or legacy session modes, both surfaced as `ChatOption`s */
export function optionsFrom(response: unknown): ChatOption[] {
  const value = record(response)
  const configOptions = list(value.configOptions)
  if (configOptions.length) {
    return configOptions.flatMap((entry) => {
      const option = record(entry)
      if (option.type !== 'select') return []
      const values = selectValues(option.options)
      return [{ id: text(option.id), name: text(option.name), category: option.category === 'model' ? 'model' : option.category === 'mode' ? 'mode' : 'other', currentValue: text(option.currentValue), values }]
    })
  }

  const modes = record(value.modes)
  if (Array.isArray(modes.availableModes)) {
    const values = list(modes.availableModes).map((v) => {
      const item = record(v)
      return { value: text(item.id), name: text(item.name), description: nullableText(item.description) }
    })
    return [{ id: 'mode', name: 'Mode', category: 'mode', currentValue: text(modes.currentModeId), values }]
  }

  return []
}

const PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
const permissionKind = (value: unknown): PermissionOption['kind'] | null => (typeof value === 'string' && PERMISSION_KINDS.has(value) ? (value as PermissionOption['kind']) : null)

/** Maps a `session/request_permission` request's params to a `permission` chat event */
export function fromPermissionRequest(requestId: string, params: unknown): ChatEvent | null {
  const value = record(params)
  const subjectToolCall = record(record(value.subject).toolCall)
  const toolCall = record(value.toolCall)
  const title = text(value.title) || text(toolCall.title) || text(subjectToolCall.title)
  const toolCallId = nullableText(toolCall.toolCallId) ?? nullableText(subjectToolCall.toolCallId)
  const options = list(value.options).flatMap((entry): PermissionOption[] => {
    const option = record(entry)
    const kind = permissionKind(option.kind)
    return typeof option.optionId === 'string' && kind ? [{ id: option.optionId, name: text(option.name), kind }] : []
  })
  if (!title && !toolCallId && !options.length) return null
  return { type: 'permission', requestId, title, toolCallId, options }
}

/** Maps chat prompt content to ACP `ContentBlock`s for `session/prompt` */
export function toPromptBlocks(content: ChatContent[]): ContentBlock[] {
  return content.map((item) => (item.type === 'text' ? { type: 'text', text: item.text } : { type: 'image', mimeType: item.mimeType, data: item.data }))
}
