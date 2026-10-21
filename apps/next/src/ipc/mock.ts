import type { Api } from './api'

// In-browser fake daemon for the dev server and visual checks
export function mockApi(): Api {
  throw new Error('mock api not implemented yet')
}
