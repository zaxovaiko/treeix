import type { ChatAdapter, MainPlugin } from '@treeix/sdk/main'

/** Adapters of the enabled plugins, first one wins per id */
export function adaptersOf(plugins: Map<string, Pick<MainPlugin, 'chatAdapters'>>, enabled: string[]): ChatAdapter[] {
  const adapters = enabled.flatMap((id) => plugins.get(id)?.chatAdapters ?? [])
  return adapters.filter((adapter, index) => adapters.findIndex((other) => other.id === adapter.id) === index)
}
