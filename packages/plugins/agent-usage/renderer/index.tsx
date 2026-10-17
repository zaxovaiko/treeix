import type { RendererPlugin } from '@treeix/sdk'
import { UsagePage } from './AgentUsage'

const plugin: RendererPlugin = {
  tabs: [{ id: 'agent-usage', label: 'Usage', icon: 'chart', order: 70, render: UsagePage }]
}

export default plugin
