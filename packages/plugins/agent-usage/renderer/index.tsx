import type { RendererPlugin } from '@treeix/sdk'
import { AgentUsage } from './AgentUsage'

const plugin: RendererPlugin = {
  Settings: AgentUsage
}

export default plugin
