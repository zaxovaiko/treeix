export type SearchEngine = 'google' | 'duckduckgo' | 'bing'

const SEARCH: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
}

// Dev servers: localhost and its subdomains, IPv4 addresses (LAN devices, Docker) and IPv6 loopback, all plain http
const LOCAL_HOST = /^(([\w-]+\.)*localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\])(:\d+)?([/?#]|$)/i

export const searchUrl = (engine: SearchEngine): string => SEARCH[engine]

/** What the address bar loads: a URL as typed, a host completed with a scheme, anything else searched */
export function toUrl(input: string, engine: SearchEngine): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  // Like Chrome: a space means words to search, even after a scheme
  if ((/^[a-z][\w+.-]*:\/\//i.test(text) && !/\s/.test(text)) || /^(about|data|file):/i.test(text)) return text
  if (LOCAL_HOST.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/?#\s@]+\.\p{L}{2,}(:\d+)?([/?#]|$)/iu.test(text)) return `https://${text}`
  return SEARCH[engine] + encodeURIComponent(text)
}
