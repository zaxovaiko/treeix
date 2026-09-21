import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import type { ChatConnection, ChatContent, ChatEvent, MainPlugin } from '@treeix/sdk/main'
import type { StartOptions, StartResult } from '../shared/types'
import { acpAdapter } from './acpAdapter'
import { createBatcher } from './batcher'
import { createGenerationGuard } from './generations'

type Entry = { connection: ChatConnection; owner: WebContents; dispose: () => void }

const plugin: MainPlugin = {
  chatAdapters: [acpAdapter],
  activate: (context) => {
    const connections = new Map<string, Entry>()
    const generations = createGenerationGuard<string>()
    let disposed = false

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

      const token = generations.begin(chatId)
      const owner = event.sender
      const connection = await adapter.connect({ cwd: options.cwd, command: options.command, env: await context.sessionEnv(), resume: options.resume })

      // A newer start for this chat id arrived while connecting: let it own the map, this connection has nowhere to go
      if (!generations.isCurrent(chatId, token)) {
        connection.close()
        throw new Error('Superseded by a newer start')
      }
      // The plugin or the window went away while connecting: nobody could reach this agent
      if (disposed || owner.isDestroyed()) {
        connection.close()
        throw new Error('The chat was closed while connecting')
      }

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
      const onDestroyed = (): void => drop(chatId, entry)
      owner.once('destroyed', onDestroyed)
      disposers.push(() => owner.off('destroyed', onDestroyed))
      // In the map before subscribing: a replayed backlog can hold the disconnect, which has to drop this entry
      connections.set(chatId, entry)

      disposers.push(
        connection.onEvent((chatEvent) => {
          // A 'disconnected' event means the agent's process or connection ended; 'error' events are ordinary turn failures and just flow through
          if (chatEvent.type === 'disconnected') {
            batcher.flush()
            context.send(owner, 'closed', chatId, chatEvent.message)
            drop(chatId, entry)
            return
          }
          batcher.push(chatEvent)
        })
      )
      if (connections.get(chatId) !== entry) throw new Error('The agent stopped while connecting')

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

    // A reloaded window starts with no chats: its old agents are unreachable, and a resume would replay into a doubled feed
    context.on('stopAll', (event) => {
      for (const [chatId, entry] of connections) if (entry.owner === event.sender) drop(chatId, entry)
    })

    context.onDispose(() => {
      disposed = true
      for (const entry of connections.values()) entry.dispose()
      connections.clear()
    })
  }
}

export default plugin
