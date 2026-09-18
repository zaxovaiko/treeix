import type { MainPlugin } from '@treeix/sdk/main'
import { listPlans, readPlan } from './plans'

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('list', () => listPlans())
    context.handle('read', (_, name: string) => readPlan(name))
  }
}

export default plugin
