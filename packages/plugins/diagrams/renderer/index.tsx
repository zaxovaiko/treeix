import type { RendererPlugin } from '@treeix/sdk'
import { Mermaid } from './Mermaid'

const plugin: RendererPlugin = {
  codeBlocks: { mermaid: Mermaid }
}

export default plugin
