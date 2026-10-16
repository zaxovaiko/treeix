import { writeFile } from 'node:fs/promises'
import { isJson, object } from '@treeix/shared/json'
import { readJsonFile } from '@treeix/host/paths'
import type { Price } from '../shared/types'

// The price list ccusage and most token counters read; fetched at most daily
const PRICES_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isPrice = (value: unknown): value is Price => Array.isArray(value) && value.length === 4 && value.every(isNumber)

/** Per-token prices of models listed under their bare name; a missing cache price falls back to the input price */
export function reducePrices(raw: unknown): Record<string, Price> {
  const prices: Record<string, Price> = {}
  for (const [model, entry] of Object.entries(object(raw))) {
    if (model.includes('/') || !isJson(entry)) continue
    const { input_cost_per_token: input, output_cost_per_token: output, cache_read_input_token_cost: read, cache_creation_input_token_cost: write } = entry
    if (!isNumber(input) || !isNumber(output)) continue
    prices[model] = [input, output, isNumber(read) ? read : input, isNumber(write) ? write : input]
  }
  return prices
}

/** Exact name first, then without a trailing date such as -20251001 */
export const priceOf = (prices: Record<string, Price>, model: string): Price | null => prices[model] ?? prices[model.replace(/-\d{8}$/, '')] ?? null

export async function modelPrices(file: string): Promise<Record<string, Price>> {
  const saved = object(await readJsonFile(file))
  const savedPrices = Object.fromEntries(Object.entries(object(saved.prices)).filter((entry): entry is [string, Price] => isPrice(entry[1])))
  if (isNumber(saved.fetchedAt) && Date.now() - saved.fetchedAt < MAX_AGE_MS) return savedPrices
  try {
    const response = await fetch(PRICES_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!response.ok) return savedPrices
    const prices = reducePrices(await response.json())
    await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), prices }))
    return prices
  } catch {
    // Offline: last known prices, or none
    return savedPrices
  }
}
