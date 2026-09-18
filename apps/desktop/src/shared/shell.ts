/** ANSI-C quoting survives newlines and quotes when typed into zsh or bash */
export const shellQuote = (text: string): string =>
  `$'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
