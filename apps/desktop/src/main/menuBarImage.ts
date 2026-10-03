/** One agent's rings: the 5-hour window outside, the week inside, as fractions used; null leaves only the track */
export type Meter = [fiveHour: number | null, weekly: number | null]

/** Menu bar height at 2x; macOS fits an 18pt image */
export const HEIGHT = 36
const GAP = 8
const METER = 30
const RINGS = [
  { radius: 13, width: 3.5 },
  { radius: 7.5, width: 3.5 }
] as const
const TRACK = 0.3

/** Clockwise from the top, 0 to 1 */
const turn = (dx: number, dy: number): number => (Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1

/** Alpha of the glyph followed by a ring meter per agent, like Activity rings; the caller paints it as a template image */
export function menuBarAlpha(glyph: { width: number; alpha: Uint8Array }, meters: Meter[]): { width: number; alpha: Uint8Array } {
  const width = glyph.width + meters.length * (GAP + METER)
  const alpha = new Uint8Array(width * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) alpha.set(glyph.alpha.subarray(y * glyph.width, (y + 1) * glyph.width), y * width)
  meters.forEach((meter, index) => {
    const left = glyph.width + GAP + index * (GAP + METER)
    const center = { x: left + METER / 2, y: HEIGHT / 2 }
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = left; x < left + METER; x++) {
        const dx = x + 0.5 - center.x
        const dy = y + 0.5 - center.y
        const distance = Math.hypot(dx, dy)
        let value = 0
        RINGS.forEach(({ radius, width: band }, ring) => {
          // Antialiased edges: full inside the band, fading over the pixel that crosses it
          const coverage = Math.min(1, Math.max(0, band / 2 + 0.5 - Math.abs(distance - radius)))
          const used = meter[ring]
          value = Math.max(value, coverage * (used !== null && turn(dx, dy) <= used ? 1 : TRACK))
        })
        alpha[y * width + x] = Math.round(value * 255)
      }
    }
  })
  return { width, alpha }
}
