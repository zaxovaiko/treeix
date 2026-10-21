import { useSyncExternalStore } from 'react'
import { projectOf } from '@treeix/app/sessionUi'
import { readStored } from '@treeix/app/storage'
import { isString, list } from '@treeix/shared/json'

/** Repositories from other folders whose pull requests a project lists beside its own, kept per project folder */
const storageKey = (scope: string[]): string => `prs.addedRepos:${projectOf(scope[0] ?? '')}`

const listeners = new Set<() => void>()
let version = 0

/** Whether the scope already lists this folder's pull requests: it is one of the scope's repositories or their worktrees */
export const inScope = (scope: string[], folder: string): boolean => scope.some((path) => projectOf(path) === projectOf(folder))

export const addedRepos = (scope: string[]): string[] => (scope.length ? list(readStored(storageKey(scope)), isString).filter((path) => !inScope(scope, path)) : [])

export function setAddedRepos(scope: string[], paths: string[]): void {
  localStorage.setItem(storageKey(scope), JSON.stringify(paths))
  version++
  listeners.forEach((listener) => listener())
}

/** The scope's repositories and the ones added to its project; null until the scope is known */
export const prRepoPaths = (scope: string[] | null): string[] | null => scope && [...scope, ...addedRepos(scope)]

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePrRepoPaths(scope: string[] | null): string[] | null {
  'use no memo' // the added repositories are read from storage during render
  useSyncExternalStore(subscribe, () => version)
  return prRepoPaths(scope)
}
