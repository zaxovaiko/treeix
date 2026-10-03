import type { ChatAdapter, ChatContent, ChatEvent, ChatOption, StopReason } from '@treeix/sdk/main'
import { isString, list, object, parseJson, text } from '@treeix/shared/json'
import { sseReader } from './sse'

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
type Message = { role: 'system' | 'user' | 'assistant'; content: string | Part[] }
type Model = { id: string; name: string; contextLength: number }

const MODELS_TIMEOUT_MS = 15_000

const headers = (key: string | null): Record<string, string> => ({ 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) })

const toParts = (content: ChatContent[]): Part[] =>
  content.map((item) => (item.type === 'text' ? { type: 'text', text: item.text } : { type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${item.data}` } }))

/** The provider's own message when it sends one, e.g. "401 No auth credentials found" */
async function failure(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null)
  return `${response.status} ${text(object(object(body).error).message) || response.statusText}`
}

async function listModels(baseUrl: string, key: string | null): Promise<Model[]> {
  const response = await fetch(`${baseUrl}/models`, { headers: headers(key), signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) })
  if (!response.ok) throw new Error(await failure(response))
  return list(object(await response.json()).data).flatMap((model) =>
    isString(model.id) ? [{ id: model.id, name: text(model.name) || model.id, contextLength: typeof model.context_length === 'number' ? model.context_length : 0 }] : []
  )
}

/**
 * Chat with any OpenAI-compatible API (OpenRouter, Ollama, LM Studio); `command` is its base URL. Plain chat without
 * tools, and the history lives in memory, so a conversation can't be resumed after the app restarts.
 */
export function createOpenAiAdapter(keyFor: (baseUrl: string) => Promise<string | null>): ChatAdapter {
  return {
    id: 'openai',
    label: 'OpenAI-compatible API',
    connect: async ({ command, instructions, preset }) => {
      const baseUrl = command.replace(/\/+$/, '')
      const key = await keyFor(baseUrl)
      const listeners = new Set<(event: ChatEvent) => void>()
      const emit = (event: ChatEvent): void => listeners.forEach((listener) => listener(event))
      // A provider without a model list still chats with a model typed in
      const models = await listModels(baseUrl, key).catch((): Model[] => [])
      let model = preset?.model ?? models[0]?.id ?? ''
      const options = (): ChatOption[] =>
        model || models.length
          ? [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                currentValue: model,
                values: [...(models.some((entry) => entry.id === model) ? [] : [{ id: model, name: model }]), ...models].map((entry) => ({ value: entry.id, name: entry.name, description: null }))
              }
            ]
          : []
      const history: Message[] = instructions ? [{ role: 'system', content: instructions }] : []
      let turn: AbortController | null = null

      const read = (data: string, reply: { text: string; stopReason: StopReason }): void => {
        if (data === '[DONE]') return
        const chunk = object(parseJson(data))
        const error = text(object(chunk.error).message)
        if (error) emit({ type: 'error', message: error })
        const choice = object(list(chunk.choices)[0])
        const delta = object(choice.delta)
        // OpenRouter names it reasoning, DeepSeek and LM Studio reasoning_content
        const thought = text(delta.reasoning) || text(delta.reasoning_content)
        if (thought) emit({ type: 'thought_chunk', text: thought })
        const piece = text(delta.content)
        if (piece) {
          reply.text += piece
          emit({ type: 'message_chunk', role: 'agent', content: { type: 'text', text: piece } })
        }
        if (choice.finish_reason === 'length') reply.stopReason = 'max_tokens'
        const usage = object(chunk.usage)
        const size = models.find((entry) => entry.id === model)?.contextLength ?? 0
        if (typeof usage.total_tokens === 'number' && size > 0) {
          emit({ type: 'usage', used: usage.total_tokens, size, cost: typeof usage.cost === 'number' ? { amount: usage.cost, currency: 'USD' } : null })
        }
      }

      return {
        sessionId: crypto.randomUUID(),
        capabilities: { images: true, load: false, list: false },
        onEvent: (listener) => {
          listeners.add(listener)
          listener({ type: 'options', options: options() })
          return () => listeners.delete(listener)
        },
        prompt: async (content) => {
          emit({ type: 'turn_start' })
          history.push({ role: 'user', content: toParts(content) })
          const controller = (turn = new AbortController())
          const reply = { text: '', stopReason: 'end_turn' as StopReason }
          try {
            const response = await fetch(`${baseUrl}/chat/completions`, {
              method: 'POST',
              headers: headers(key),
              body: JSON.stringify({ model, messages: history, stream: true, stream_options: { include_usage: true } }),
              signal: controller.signal
            })
            if (!response.ok || !response.body) throw new Error(await failure(response))
            const events = sseReader((data) => read(data, reply))
            const decoder = new TextDecoder()
            const stream = response.body.getReader()
            for (let next = await stream.read(); !next.done; next = await stream.read()) events.push(decoder.decode(next.value, { stream: true }))
          } catch (error) {
            if (!controller.signal.aborted) emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
            reply.stopReason = 'cancelled'
          }
          turn = null
          // A turn that got nothing back leaves no trace, so sending again doesn't repeat the message
          if (reply.text) history.push({ role: 'assistant', content: reply.text })
          else history.pop()
          emit({ type: 'turn_end', stopReason: reply.stopReason })
          return { stopReason: reply.stopReason }
        },
        cancel: () => turn?.abort(),
        answer: () => undefined,
        setOption: async (id, value) => {
          if (id !== 'model') return
          model = value
          emit({ type: 'options', options: options() })
        },
        close: () => {
          turn?.abort()
          listeners.clear()
        }
      }
    }
  }
}
