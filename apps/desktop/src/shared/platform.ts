/** The main process asks Node; the renderer has no `process`, so it reads Chromium's user agent */
export const IS_MAC = globalThis.process?.platform ? globalThis.process.platform === 'darwin' : globalThis.navigator.userAgent.includes('Macintosh')
