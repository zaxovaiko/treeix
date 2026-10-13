import type { MainPlugin } from '@treeix/sdk/main'
import { scanSchema } from './drizzle'

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('scan', (_, worktreePath: string) => scanSchema(worktreePath))
  }
}

export default plugin
