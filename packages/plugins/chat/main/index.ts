import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ChatConnection, ChatContent, ChatEvent, MainPlugin } from '@treeix/sdk/main'
import type { StartOptions, StartResult } from '../shared/types'
import { acpAdapter } from './acpAdapter'
import { createBatcher } from './batcher'

type Entry = { connection: ChatConnection; owner: WebContents; dispose: () => void }

const plugin: MainPlugin = {
  chatAdapters: [acpAdapter],
  activate: (context) => {
    const connections = new Map<string, Entry>()

    const owned = (event: IpcMainInvokeEvent | IpcMainEvent, chatId: string): Entry | null => {
      if (typeof chatId !== 'string') return null
      const entry = connections.get(chatId)
      return entry && entry.owner === event.sender ? entry : null
    }

    const drop = (chatId: string, entry: Entry): void => {
      if (connections.get(chatId) !== entry) return
      connections.delete(chatId)
      entry.dispose()
    }

    context.handle('start', async (event, chatId: string, options: StartOptions): Promise<StartResult> => {
      if (typeof chatId !== 'string') throw new Error('Invalid chat id')
      connections.get(chatId)?.dispose()
      connections.delete(chatId)

      const adapter = context.chatAdapter(options.adapter)
      if (!adapter) throw new Error(`No ${options.adapter} adapter`)

      const owner = event.sender
      const connection = await adapter.connect({ cwd: options.cwd, command: options.command, env: await context.sessionEnv(), resume: options.resume })

      const batcher = createBatcher<ChatEvent>((batch) => context.send(owner, 'events', chatId, batch))
      const disposers: (() => void)[] = []
      const entry: Entry = {
        connection,
        owner,
        dispose: () => {
          disposers.splice(0).forEach((dispose) => dispose())
          connection.close()
        }
      }
      disposers.push(() => batcher.dispose())
      // The agent process died: the abort handler in the adapter is the only source of an unprompted 'error' outside a turn
      disposers.push(
        connection.onEvent((chatEvent) => {
          batcher.push(chatEvent)
          if (chatEvent.type === 'error') {
            context.send(owner, 'closed', chatId, chatEvent.message)
            drop(chatId, entry)
          }
        })
      )
      const onDestroyed = (): void => drop(chatId, entry)
      owner.once('destroyed', onDestroyed)
      disposers.push(() => owner.off('destroyed', onDestroyed))
      connections.set(chatId, entry)

      return { agentSessionId: connection.sessionId, capabilities: connection.capabilities, terminalCommand: connection.terminalCommand ?? null }
    })

    context.handle('prompt', async (event, chatId: string, content: ChatContent[]) => {
      const entry = owned(event, chatId)
      if (!entry) throw new Error('Unknown chat')
      return entry.connection.prompt(content)
    })

    context.on('cancel', (event, chatId: string) => owned(event, chatId)?.connection.cancel())
    context.on('answer', (event, chatId: string, requestId: string, optionId: string | null) => owned(event, chatId)?.connection.answer(requestId, optionId))
    context.on('stop', (event, chatId: string) => {
      const entry = owned(event, chatId)
      if (entry) drop(chatId, entry)
    })

    context.handle('setOption', async (event, chatId: string, id: string, value: string) => {
      const entry = owned(event, chatId)
      if (!entry) throw new Error('Unknown chat')
      await entry.connection.setOption(id, value)
    })

    context.handle('list', async (event, chatId: string, cwd: string) => {
      const entry = owned(event, chatId)
      if (!entry?.connection.list) return []
      return entry.connection.list(cwd)
    })

    context.onDispose(() => {
      for (const entry of connections.values()) entry.dispose()
      connections.clear()
    })
  }
}

export default plugin
