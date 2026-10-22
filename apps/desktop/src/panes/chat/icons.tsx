// The chat's prototype icons, drawn like lib/icons
const LINE = {
  check: '<path d="M5 12l5 5 9-10"/>',
  loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>',
  send: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
  attach: '<path d="M20 11.5l-8.1 8.1a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  comment: '<path d="M4 5h16v11H9l-5 4z"/>',
} as const

export type ChatIconName = keyof typeof LINE

export const ChatIcon = ({ name, className }: { name: ChatIconName; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden dangerouslySetInnerHTML={{ __html: LINE[name] }} />
)
