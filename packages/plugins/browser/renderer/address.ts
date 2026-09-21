export type SearchEngine = 'google' | 'duckduckgo' | 'bing'

const SEARCH: Record<SearchEngine, string> = {
  google: 'https://www.google.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  bing: 'https://www.bing.com/search?q='
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i

/** What the address bar loads: a URL as typed, a host completed with a scheme, anything else searched */
export function toUrl(input: string, engine: SearchEngine): string {
  const text = input.trim()
  if (!text) return 'about:blank'
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || /^(about|data|file):/i.test(text)) return text
  if (LOCAL_HOST.test(text)) return `http://${text}`
  if (!/\s/.test(text) && /^[^/?#\s]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(text)) return `https://${text}`
  return SEARCH[engine] + encodeURIComponent(text)
}

export const isLocalUrl = (url: string): boolean => LOCAL_HOST.test(url.replace(/^https?:\/\//i, ''))
