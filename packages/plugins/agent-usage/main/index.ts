import { join } from 'node:path'
import type { MainPlugin } from '@treeix/sdk/main'
import { modelPrices, priceOf } from './prices'
import { usageRows } from './usage'
import type { AgentUsage, Price } from '../shared/types'

const plugin: MainPlugin = {
  activate: (context) => {
    context.handle('usage', async (): Promise<AgentUsage> => {
      const [rows, prices] = await Promise.all([usageRows(join(context.dataPath, 'usage-cache.json')), modelPrices(join(context.dataPath, 'prices.json'))])
      const priced = [...new Set(rows.map((row) => row.model))].flatMap((model): [string, Price][] => {
        const price = priceOf(prices, model)
        return price ? [[model, price]] : []
      })
      return { rows, prices: Object.fromEntries(priced) }
    })
  }
}

export default plugin
