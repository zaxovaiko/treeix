import { useEffect } from 'react'
import { type ChatService, createBridge, type RendererPlugin } from '@treeix/sdk'
import { agentOr } from '@treeix/app/agents'
import { Chat } from './Chat'
import { appendDraft, chatIds, forget, getChat, listen, start, statusOf, stop, subscribe, titleOf } from './store'

listen(createBridge('chat'))

const service: ChatService = {
  View: Chat,
  start,
  stop,
  status: (chatId) => statusOf(getChat(chatId)),
  draft: appendDraft,
  forget,
  terminalCommand: (chatId) => getChat(chatId).terminalCommand,
  agentSessionId: (chatId) => getChat(chatId).agentSessionId,
  title: (chatId) => titleOf(getChat(chatId)),
  subscribe
}

/** A system notification when a chat starts waiting for an answer while the window is hidden */
function Root(): null {
  useEffect(() => {
    const previous = new Map<string, string>()
    return subscribe(() => {
      for (const chatId of chatIds()) {
        const chat = getChat(chatId)
        const status = statusOf(chat)
        if (status === 'input' && previous.get(chatId) !== 'input' && document.hidden && chat.options) {
          new Notification(`${agentOr(chat.options.agent).label} needs you`)
        }
        previous.set(chatId, status)
      }
    })
  }, [])
  return null
}

const plugin: RendererPlugin = { Root, services: { chat: service } }

export default plugin
