import type { Api } from './api'

// Implemented over Tauri commands + channels by the app shell
export function tauriApi(): Api {
  throw new Error('tauri api not implemented yet')
}
