/** IPC rejections arrive wrapped as "Error invoking remote method 'x': Error: message" */
export const errorMessage = (reason: unknown): string =>
  String(reason).replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
