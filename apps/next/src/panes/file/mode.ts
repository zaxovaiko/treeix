import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  window.addEventListener('treeix-theme', listener)
  return () => window.removeEventListener('treeix-theme', listener)
}
const read = (): 'dark' | 'light' => (document.documentElement.dataset.mode === 'light' ? 'light' : 'dark')

/** The app theme's mode, live; pierre's diff picks its code theme by it */
export const useMode = () => useSyncExternalStore(subscribe, read)
