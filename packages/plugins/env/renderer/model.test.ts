import { expect, test } from 'bun:test'
import type { EnvFile, WorktreeEnv } from '../shared/types'
import { issuesOf, issueTone, placesByName, rowsOf } from './model'

const file = (path: string, vars: Record<string, string>, frameworks: string[] = []): EnvFile => ({
  path,
  vars: Object.entries(vars).map(([name, value], index) => ({ name, value, line: index + 1 })),
  frameworks,
  tracked: false
})

const main: WorktreeEnv = {
  path: '/repo',
  files: [file('.env', { REDIS_URL: 'redis://redis:6379', PORT: '3000' }), file('apps/web/.env.local', { NEXT_PUBLIC_API_URL: 'http://localhost:3000' }, ['next'])],
  templates: [{ path: '.env.example', names: ['REDIS_URL', 'PORT', 'JWT_SECRET'], frameworks: [] }],
  annotations: {}
}

const feature: WorktreeEnv = {
  path: '/repo/.claude/worktrees/feat',
  files: [
    file('.env', { REDIS_URL: 'redis://localhost:6379', PORT: '3000' }),
    file('apps/web/.env.local', { NEXT_PUBLIC_API_URL: 'http://localhost:3000', NEXT_PUBLIC_STRIPE_KEY: 'sk_test_1' }, ['next'])
  ],
  templates: [
    { path: '.env.example', names: ['REDIS_URL', 'PORT', 'JWT_SECRET'], frameworks: [] },
    { path: '.env.sample', names: ['JWT_SECRET'], frameworks: [] },
    // No env file in this folder, so nothing is reported missing there
    { path: 'apps/api/.env.example', names: ['STRIPE_SECRET_KEY'], frameworks: [] }
  ],
  annotations: {}
}

test('rowsOf lists set names, then missing ones once, in the folder file', () => {
  const rows = rowsOf(feature, main)
  expect(rows.map((row) => `${row.file}|${row.name}|${row.value ?? 'missing'}`)).toEqual([
    '.env|REDIS_URL|redis://localhost:6379',
    '.env|PORT|3000',
    'apps/web/.env.local|NEXT_PUBLIC_API_URL|http://localhost:3000',
    'apps/web/.env.local|NEXT_PUBLIC_STRIPE_KEY|sk_test_1',
    '.env|JWT_SECRET|missing'
  ])
  expect(rows.find((row) => row.name === 'NEXT_PUBLIC_STRIPE_KEY')?.kind).toBe('exposed')
  expect(rows.find((row) => row.name === 'JWT_SECRET')?.kind).toBe('secret')
})

test('annotations from .env.example override the classifier', () => {
  const marked = { ...feature, annotations: { 'apps/web': { NEXT_PUBLIC_STRIPE_KEY: 'public' as const } } }
  expect(rowsOf(marked, main).find((row) => row.name === 'NEXT_PUBLIC_STRIPE_KEY')?.kind).toBe('public')
})

test('issuesOf counts missing, exposed and drift from main', () => {
  expect(issuesOf(feature, main)).toEqual({ none: false, missing: 1, exposed: 1, drift: 1 })
  expect(issuesOf(main, null)).toEqual({ none: false, missing: 1, exposed: 0, drift: 0 })
  expect(issueTone(issuesOf({ ...feature, files: [] }, main))).toBe('red')
  // Nothing here and nothing in main is not a problem, nor is the main worktree without env files
  expect(issueTone(issuesOf({ ...feature, files: [] }, { ...main, files: [] }))).toBeNull()
  expect(issueTone(issuesOf({ ...main, files: [], templates: [] }, null))).toBeNull()
  expect(issueTone({ none: false, missing: 0, exposed: 0, drift: 2 })).toBe('amber')
  expect(issueTone({ none: false, missing: 0, exposed: 0, drift: 0 })).toBeNull()
})

test('placesByName groups every place a name is set or missing, sorted by name', () => {
  const index = placesByName([
    { env: main, main: null },
    { env: feature, main }
  ])
  expect([...index.keys()]).toEqual(['JWT_SECRET', 'NEXT_PUBLIC_API_URL', 'NEXT_PUBLIC_STRIPE_KEY', 'PORT', 'REDIS_URL'])
  expect(index.get('REDIS_URL')?.map((place) => place.value)).toEqual(['redis://redis:6379', 'redis://localhost:6379'])
  expect(index.get('JWT_SECRET')?.every((place) => place.value === null)).toBe(true)
})
