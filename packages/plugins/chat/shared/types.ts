import type { ChatCapabilities, ChatSpec } from '@treeix/sdk/main'

export type StartOptions = ChatSpec & { cwd: string; resume: string | null }

export type StartResult = { agentSessionId: string; capabilities: ChatCapabilities; terminalCommand: string | null }
