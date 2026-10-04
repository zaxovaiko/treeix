import { useEffect } from 'react'
import { type ChatService, createBridge, type RendererPlugin, useHost } from '@treeix/sdk'
import { agentOr } from '@treeix/app/agents'
import { notify } from '@treeix/app/notifications'
import { Chat } from './Chat'
import { Transcript } from './Transcript'
import { appendDraft, chatIds, forget, getChat, listen, send, start, statusOf, stop, subscribe, titleOf } from './store'

listen(createBridge('chat'))

const service: ChatService = {
  View: Chat,
  Transcript,
  start,
  send: (chatId, text) => send(chatId, [{ type: 'text', text }]),
  stop,
  status: (chatId) => statusOf(getChat(chatId)),
  draft: appendDraft,
  forget,
  terminalCommand: (chatId) => getChat(chatId).terminalCommand,
  agentSessionId: (chatId) => getChat(chatId).agentSessionId,
  agent: (chatId) => getChat(chatId).options?.agent ?? null,
  title: (chatId) => titleOf(getChat(chatId)),
  subscribe
}

/** Into the notification center when a chat starts waiting for an answer; opening it shows the chat's session */
function Root(): null {
  const host = useHost()
  useEffect(() => {
    const previous = new Map<string, string>()
    return subscribe(() => {
      for (const chatId of chatIds()) {
        const chat = getChat(chatId)
        const status = statusOf(chat)
        if (status === 'input' && previous.get(chatId) !== 'input' && chat.options) {
          // Chats in the Terminal page are sessions under the same id; a hub run's chat is not
          const session = host
            .service('sessions')
            ?.getSessions()
            .find((candidate) => candidate.id === chatId)
          notify({
            title: `${agentOr(chat.options.agent).label} needs you`,
            body: session?.title ?? '',
            workspaceId: session?.workspaceId ?? null,
            open: session
              ? () => {
                  host.service('sessions')?.reveal(chatId)
                  host.setActiveTab('terminal')
                }
              : null
          })
        }
        previous.set(chatId, status)
      }
    })
  }, [host])
  return null
}

const plugin: RendererPlugin = { Root, services: { chat: service } }

export default plugin
