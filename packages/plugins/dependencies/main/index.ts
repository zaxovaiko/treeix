import type { MainPlugin } from '@treeix/sdk/main'
import { scanDependencies } from './scan'

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('scan', (_, worktreePath: string) => scanDependencies(worktreePath))
  }
}

export default plugin
