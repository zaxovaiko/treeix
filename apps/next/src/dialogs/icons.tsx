// Prototype shapes the dialogs need that lib/icons doesn't have yet
const GLYPHS = {
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3l-2 3 2 3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
} as const

export type GlyphName = keyof typeof GLYPHS

export const Glyph = ({ name }: { name: GlyphName }) => <svg viewBox="0 0 24 24" aria-hidden dangerouslySetInnerHTML={{ __html: GLYPHS[name] }} />
