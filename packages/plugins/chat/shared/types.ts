import type { ChatCapabilities } from '@treeix/sdk/main'

export type StartOptions = { adapter: string; command: string; cwd: string; resume: string | null }

export type StartResult = { agentSessionId: string; capabilities: ChatCapabilities; terminalCommand: string | null }
