/** Server-sent events from text arriving in arbitrary pieces; calls `onData` with each event's data, lines joined */
export function sseReader(onData: (data: string) => void): { push: (text: string) => void } {
  let partial = ''
  let data: string[] = []
  return {
    push: (text) => {
      const lines = (partial + text).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') {
          if (data.length) onData(data.join('\n'))
          data = []
        } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5))
      }
    }
  }
}
