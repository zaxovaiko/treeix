// The file view's prototype icons, drawn like lib/icons
const LINE = {
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
  diff: '<path d="M12 3v14M5 10h14M5 21h14"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
} as const

export type FileIconName = keyof typeof LINE

export const FileIcon = ({ name, className }: { name: FileIconName; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden dangerouslySetInnerHTML={{ __html: LINE[name] }} />
)
