/** What a template can reference: the run's input, the outputs flowing in, and any earlier node's output */
export type TemplateScope = { input: string; prev: string; outputs: Record<string, string> }

const REFERENCE = /\{\{\s*(input|prev|nodes\.([\w-]+)\.output)\s*\}\}/g

/** Fills `{{input}}`, `{{prev}}` and `{{nodes.<id>.output}}`; a node without output yet reads as empty */
export const render = (template: string, scope: TemplateScope): string =>
  template.replace(REFERENCE, (_, name: string, node: string | undefined) => (node !== undefined ? (scope.outputs[node] ?? '') : name === 'input' ? scope.input : scope.prev))
