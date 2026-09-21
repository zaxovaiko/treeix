import { expect, test } from 'bun:test'
import { annotations, classify, setAnnotation } from './classify'

const next = { frameworks: ['next'] }
const kind = (...args: Parameters<typeof classify>): string => classify(...args).kind

test('classify: names, value formats and client prefixes', () => {
  // A DSN has no password, Sentry treats it as public
  expect(kind('SENTRY_DSN', 'https://4f1c9e@o4507.ingest.sentry.io/12')).toBe('config')
  expect(kind('NEXT_PUBLIC_SENTRY_DSN', 'https://77ab01@o4507.ingest.sentry.io/31', next)).toBe('public')
  // A prefix without next in package.json is not inlined
  expect(kind('NEXT_PUBLIC_API_URL', 'http://localhost:3000')).toBe('config')
  expect(kind('NEXT_PUBLIC_STRIPE_SECRET_KEY', 'sk_test_51NxYz', next)).toBe('exposed')
  // The value format wins over an innocent name
  expect(kind('NEXT_PUBLIC_STRIPE_KEY', 'sk_live_abc', next)).toBe('exposed')
  // The name says token: flagged, @public in .env.example clears it
  expect(kind('NEXT_PUBLIC_MAPBOX_TOKEN', 'pk.eyJ1', next)).toBe('exposed')
  expect(kind('NEXT_PUBLIC_MAPBOX_TOKEN', 'pk.eyJ1', { ...next, annotation: 'public' })).toBe('public')
  expect(kind('DATABASE_URL', 'postgres://app:hunter2@localhost:5432/db')).toBe('secret')
  expect(kind('DATABASE_URL', 'postgres://localhost:5432/db')).toBe('config')
  expect(kind('REDIS_URL', 'redis://redis:6379')).toBe('config')
  expect(kind('JWT_SECRET', 'x')).toBe('secret')
  expect(kind('N8N_ENCRYPTION_KEY', 'q8Zr2x')).toBe('secret')
  expect(kind('OPENAI_API_KEY', '')).toBe('secret')
  expect(kind('PAYMENT_ID', 'sk_live_123')).toBe('secret')
  expect(kind('PORT', '3000')).toBe('config')
  expect(kind('STAGE_BASIC_AUTH_PASS', '')).toBe('secret')
  expect(kind('GOOGLE_DIRECTORY_SA_KEY', '')).toBe('secret')
  expect(kind('MEDUSA_PUBLIC_KEY', '')).toBe('config')
  expect(kind('VITE_APP_NAME', 'Admin', { frameworks: ['vite'] })).toBe('public')
})

test('classify is deterministic and gives its reason', () => {
  expect(classify('JWT_SECRET', 'x')).toEqual(classify('JWT_SECRET', 'x'))
  expect(classify('JWT_SECRET', 'x').reason).toBe('the name says secret')
  expect(classify('PORT', '1', { annotation: 'secret' })).toEqual({ kind: 'secret', reason: 'marked @secret in .env.example' })
})

test('annotations reads the mark on the line above a key', () => {
  expect(annotations('# @public\nNEXT_PUBLIC_MAPBOX_TOKEN=\nPORT=\n# @secret\n\nWEBHOOK_URL=')).toEqual({ NEXT_PUBLIC_MAPBOX_TOKEN: 'public', WEBHOOK_URL: 'secret' })
})

test('setAnnotation replaces, inserts or appends the mark', () => {
  expect(setAnnotation('# @public\nTOKEN=\nPORT=\n', 'TOKEN', 'secret')).toBe('# @secret\nTOKEN=\nPORT=\n')
  expect(setAnnotation('# about the port\nPORT=\n', 'PORT', 'public')).toBe('# about the port\n# @public\nPORT=\n')
  expect(setAnnotation('PORT=', 'TOKEN', 'secret')).toBe('PORT=\n# @secret\nTOKEN=\n')
  expect(setAnnotation('', 'TOKEN', 'public')).toBe('# @public\nTOKEN=\n')
  expect(annotations(setAnnotation('PORT=\nTOKEN=x\n', 'TOKEN', 'public'))).toEqual({ TOKEN: 'public' })
})
