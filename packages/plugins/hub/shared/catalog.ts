/**
 * Ollama models worth running on a Mac, rated 1-5 by hand for turning calls and chats in several languages into English notes and JSON.
 * Sizes are the download; refresh the list by editing it.
 */
export const LOCAL_MODELS = [
  { id: 'gemma4:26b-mlx', name: 'Gemma 4 26B', sizeGB: 18.3, quality: 5, speed: 3, note: 'Best notes and tasks in our tests.' },
  { id: 'qwen3:30b-a3b', name: 'Qwen3 30B A3B', sizeGB: 18.6, quality: 4, speed: 5, note: 'Mixture of experts, so it answers fast for its size.' },
  { id: 'gpt-oss:20b', name: 'gpt-oss 20B', sizeGB: 13.8, quality: 4, speed: 4, note: 'Reliable JSON, weaker outside English.' },
  { id: 'mistral-small3.2:24b', name: 'Mistral Small 3.2 24B', sizeGB: 15.2, quality: 4, speed: 3, note: 'Good with European languages.' },
  { id: 'gemma4:e4b', name: 'Gemma 4 E4B', sizeGB: 6.6, quality: 2, speed: 5, note: 'Fits small Macs, but got dates wrong and invented owners.' }
] as const

export type Fit = 'fits' | 'tight' | 'too big'

/** What Ollama has and how much memory the Mac has; null when Ollama isn't running */
export type LocalModelsState = { installed: string[]; totalGB: number } | null

/** The tag of a model's variant with a 64k token context, which Ollama's OpenAI endpoint can't ask for per request */
export const longContextId = (id: string): string => `${id}-64k`

/** A model takes about its size plus a fifth for context; the GPU gets about three quarters of a Mac's memory, and past 60% little is left for apps */
export function fit(sizeGB: number, totalGB: number): Fit {
  const needGB = sizeGB * 1.2
  if (needGB > totalGB * 0.75) return 'too big'
  return needGB > totalGB * 0.6 ? 'tight' : 'fits'
}
