/** Files the bundled TypeScript language service understands */
export const supportsLanguageService = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path)
