// `monaco-editor`'s own `declare global { var MonacoEnvironment }` isn't visible on `self` here
// because this file only reaches monaco's types through a dynamic `import()`.
interface Window {
  MonacoEnvironment?: { getWorker: () => Worker }
}
