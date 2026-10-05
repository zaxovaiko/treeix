export type Mood = 'idle' | 'working' | 'waiting' | 'done' | 'failed'
export type Character = 'claude' | 'codex' | 'shell'

// Rendered in ElevenLabs (Veo 3.1), blue background keyed out with ffmpeg into VP9 webm with alpha at 2.1x speed
const FILES = import.meta.glob<string>('./aliens/*', { eager: true, query: '?url', import: 'default' })
const CLIP: Partial<Record<Mood, string>> = { working: 'running', waiting: 'input', done: 'done' }

/** Claude and Codex have their own alien; the shell and every other agent fly the UFO */
export const characterOf = (agent: string | undefined): Character => (agent === 'claude' || agent === 'codex' ? agent : 'shell')

/** The hub's agent: a kawaii alien that works, waves for an answer and hops once when done */
export function Alien({ character, mood, size }: { character: Character; mood: Mood; size: number }): React.JSX.Element {
  const clip = CLIP[mood]
  // The renders leave room for the hop, so the figure is drawn a bit larger than its box
  const props = { width: size, height: size, 'aria-hidden': true, 'data-mood': mood, className: `shrink-0 scale-130 ${mood === 'failed' ? 'grayscale' : ''}` }
  return clip ? (
    <video key={`${character}-${clip}`} {...props} src={FILES[`./aliens/${character}-${clip}.webm`]} autoPlay muted playsInline loop={mood !== 'done'} />
  ) : (
    <img {...props} src={FILES[`./aliens/${character}.png`]} alt="" />
  )
}
