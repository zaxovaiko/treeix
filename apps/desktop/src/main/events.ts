/** Answers true when it started work for the event, so the sender knows the event was taken */
export type PluginEventListener = (name: string, payload: Record<string, unknown>) => Promise<boolean>

const listeners = new Set<PluginEventListener>()

export function onPluginEvent(listener: PluginEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** True when any listener took the event; a listener that throws counts as not taking it */
export async function emitPluginEvent(name: string, payload: Record<string, unknown>): Promise<boolean> {
  const taken = await Promise.all([...listeners].map((listener) => listener(name, payload).catch(() => false)))
  return taken.some(Boolean)
}
