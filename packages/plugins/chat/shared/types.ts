import type { ChatCapabilities, ChatSpec } from '@treeix/sdk/main'

export type StartOptions = ChatSpec & { cwd: string; resume: string | null; workspaceId?: string }

export type StartResult = { agentSessionId: string; capabilities: ChatCapabilities; terminalCommand: string | null }
