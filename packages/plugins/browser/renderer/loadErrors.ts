import type { IconName } from '@treeix/app/Icon'

export type Problem = { icon: IconName; title: string; hint: string }

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** Chromium's net error codes, grouped by what the user can do about them */
export function loadError(code: number, url: string): Problem {
  const host = hostOf(url)
  if ([-100, -101, -102, -104, -109].includes(code)) return { icon: 'power', title: `Nothing is answering on ${host}`, hint: 'Start the server, then reload.' }
  if (code === -105 || code === -137) return { icon: 'globe', title: `Can't find ${host}`, hint: 'Check the address for typos.' }
  if (code === -106) return { icon: 'cloudCheck', title: 'No internet connection', hint: 'Reconnect, then reload.' }
  if (code === -7 || code === -118) return { icon: 'history', title: `${host} took too long to answer`, hint: 'The server may be busy or stuck.' }
  if (code <= -200 && code > -300) return { icon: 'lock', title: `${host} has a certificate problem`, hint: "The connection isn't private." }
  return { icon: 'alert', title: `${host} couldn't be loaded`, hint: '' }
}

/** A page that loaded with an HTTP error, shown beside the address */
export function httpProblem(status: number | null): Problem | null {
  if (status === null || status < 400) return null
  if (status === 404) return { icon: 'search', title: '404', hint: 'Not found' }
  if (status === 401 || status === 403) return { icon: 'lock', title: String(status), hint: status === 401 ? 'Sign-in needed' : 'Forbidden' }
  return { icon: 'alert', title: String(status), hint: status >= 500 ? 'Server error' : 'Request error' }
}
