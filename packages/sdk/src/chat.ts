export type ChatText = { type: 'text'; text: string }
export type ChatImage = { type: 'image'; mimeType: string; data: string }
export type ChatContent = ChatText | ChatImage

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'
export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type ToolOutput =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }
  | { type: 'diff'; path: string; oldText: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }

export type ToolCall = {
  id: string
  title: string
  kind: ToolKind
  status: ToolStatus
  output: ToolOutput[]
  locations: { path: string; line: number | null }[]
  rawInput: unknown
}

export type PlanEntry = { content: string; priority: 'high' | 'medium' | 'low'; status: 'pending' | 'in_progress' | 'completed' }

export type ChatOption = { id: string; name: string; category: 'mode' | 'model' | 'other'; currentValue: string; values: { value: string; name: string; description: string | null }[] }

export type PermissionOption = { id: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled'

export type ChatEvent =
  | { type: 'message_chunk'; role: 'user' | 'agent'; content: ChatContent }
  | { type: 'thought_chunk'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_call_update'; id: string; patch: Partial<Omit<ToolCall, 'id'>> }
  | { type: 'plan'; entries: PlanEntry[] }
  | { type: 'usage'; used: number; size: number; cost: { amount: number; currency: string } | null }
  | { type: 'options'; options: ChatOption[] }
  | { type: 'commands'; commands: { name: string; description: string }[] }
  | { type: 'permission'; requestId: string; title: string; toolCallId: string | null; options: PermissionOption[] }
  | { type: 'permission_settled'; requestId: string }
  | { type: 'turn_start' }
  | { type: 'turn_end'; stopReason: StopReason }
  | { type: 'error'; message: string }
  /** The agent's process or connection ended; the session can be resumed with a new start */
  | { type: 'disconnected'; message: string }

export type ChatCapabilities = { images: boolean; load: boolean; list: boolean }

export type ChatSessionInfo = { sessionId: string; title: string; updatedAt: number }

export type ChatConnection = {
  sessionId: string
  capabilities: ChatCapabilities
  onEvent: (listener: (event: ChatEvent) => void) => () => void
  prompt: (content: ChatContent[]) => Promise<{ stopReason: StopReason }>
  cancel: () => void
  /** `optionId` null cancels the request */
  answer: (requestId: string, optionId: string | null) => void
  setOption: (id: string, value: string) => Promise<void>
  list?: (cwd: string) => Promise<ChatSessionInfo[]>
  /** Command that opens this session in a terminal, when the agent's ids match its CLI's */
  terminalCommand?: string
  close: () => void
}

export type ChatAdapter = {
  id: string
  label: string
  /** Starts, or resumes when `resume` is set; `command` is the agent's chat command from the registry */
  connect: (options: { cwd: string; command: string; env: Record<string, string>; resume: string | null }) => Promise<ChatConnection>
}
