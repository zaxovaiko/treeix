import { expect, test } from 'bun:test'
import { matchRoute, openAsks, refuse } from './remote'

const identity = { host: 'mac.tail1.ts.net', owner: 'me@example.com' }
const fromPhone = { host: 'mac.tail1.ts.net', 'tailscale-user-login': 'me@example.com', 'x-treeix': '1' }

test('lets in only the owner, through the tailnet name, with the API header', () => {
  expect(refuse(fromPhone, '/api/runs', identity)).toBeNull()
  expect(refuse({ ...fromPhone, origin: 'https://mac.tail1.ts.net' }, '/api/runs', identity)).toBeNull()
  expect(refuse(fromPhone, '/api/runs', null)).toBe(503)
  expect(refuse({ ...fromPhone, host: '127.0.0.1:4000' }, '/api/runs', identity)).toBe(421)
  expect(refuse({ ...fromPhone, host: 'evil.example' }, '/api/runs', identity)).toBe(421)
  expect(refuse({ ...fromPhone, 'tailscale-user-login': 'friend@example.com' }, '/api/runs', identity)).toBe(403)
  expect(refuse({ host: fromPhone.host, 'x-treeix': '1' }, '/api/runs', identity)).toBe(403)
  expect(refuse({ ...fromPhone, origin: 'https://evil.example' }, '/api/runs', identity)).toBe(403)
  expect(refuse({ ...fromPhone, 'x-treeix': undefined }, '/api/runs', identity)).toBe(403)
  // Pages and the service worker load without the API header
  expect(refuse({ ...fromPhone, 'x-treeix': undefined }, '/sw.js', identity)).toBeNull()
})

test('routes only what is listed', () => {
  const routes = { 'GET runs': () => 'list', 'POST runs/:id/decide': (params: Record<string, string>) => params.id }
  expect(matchRoute(routes, 'POST', 'runs/r%201/decide')?.params).toEqual({ id: 'r 1' })
  expect(matchRoute(routes, 'GET', 'runs')).not.toBeNull()
  expect(matchRoute(routes, 'POST', 'runs')).toBeNull()
  expect(matchRoute(routes, 'POST', 'runs//decide')).toBeNull()
  expect(matchRoute(routes, 'POST', 'setKey')).toBeNull()
})

test('finds permission questions still open', () => {
  const ask = (requestId: string) => ({ node: 'agent', at: 0, event: { type: 'permission' as const, requestId, title: 'Run ls', toolCallId: null, options: [] } })
  const asks = openAsks([ask('a'), ask('b'), { node: 'agent', at: 1, event: { type: 'permission_settled', requestId: 'a' } }])
  expect(asks.map((entry) => entry.requestId)).toEqual(['b'])
})
