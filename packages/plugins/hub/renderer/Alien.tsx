import { useState } from 'react'
import type { Character } from '../shared/types'

export type Mood = 'idle' | 'working' | 'waiting' | 'done' | 'failed'
type Clip = 'idle' | 'running' | 'input' | 'done' | 'curious' | 'giggle'

// Rendered in ElevenLabs (Kling 3.0 Pro) with the still as start and end frame, keyed out with ffmpeg into VP9 webm with alpha
const FILES = import.meta.glob<string>('./aliens/*', { eager: true, query: '?url', import: 'default' })
const CLIP: Record<Mood, Clip> = { idle: 'idle', working: 'running', waiting: 'input', done: 'done', failed: 'idle' }

/** Claude and Codex have their own alien; the shell and every other agent fly the UFO */
export const characterOf = (agent: string | undefined): Character => (agent === 'claude' || agent === 'codex' ? agent : 'shell')

// The pointer and a click each get one of a few reactions, so it never answers the same way twice in a row for long
const HOVER: Clip[] = ['input', 'curious']
const CLICK: Clip[] = ['done', 'giggle']
const clipUrl = (character: Character, clip: Clip): string | undefined => FILES[`./aliens/${character}-${clip}.webm`]
const react = (character: Character, clips: Clip[]): Clip | null => {
  const ready = clips.filter((clip) => clipUrl(character, clip))
  return ready[Math.floor(Math.random() * ready.length)] ?? null
}

const pick = (poke: Clip | null, mood: Mood, hopped: boolean): Clip => poke ?? (mood === 'done' && hopped ? 'idle' : CLIP[mood])

/**
 * The hub's agent: a kawaii alien that idles, works, waves for an answer and hops once when done. The pointer gets a wave or a
 * curious look, a click a hop or a giggle. Every clip starts and ends on the still pose, so the next one waits for the current to finish and
 * states change without a jump.
 */
export function Alien({ character, mood, size }: { character: Character; mood: Mood; size: number }): React.JSX.Element {
  const [poke, setPoke] = useState<Clip | null>(null)
  const [hopped, setHopped] = useState(false)
  const [shownMood, setShownMood] = useState(mood)
  if (mood !== shownMood) {
    setShownMood(mood)
    setHopped(false)
  }
  const [clip, setClip] = useState(() => pick(poke, mood, hopped))
  const [showing, setShowing] = useState(false)
  const [shownCharacter, setShownCharacter] = useState(character)
  if (character !== shownCharacter) {
    setShownCharacter(character)
    setShowing(false)
  }
  // A clip with no render never ends, so the still stands in for it only until there is something else to play
  const wanted = pick(poke, mood, hopped)
  if (!clipUrl(character, clip) && wanted !== clip) setClip(wanted)
  const ended = (event: React.SyntheticEvent<HTMLVideoElement>): void => {
    const pokeOver = poke !== null && clip === poke
    const nowHopped = hopped || (clip === 'done' && mood === 'done')
    if (pokeOver) setPoke(null)
    setHopped(nowHopped)
    const following = pick(pokeOver ? null : poke, mood, nowHopped)
    if (following === clip) void event.currentTarget.play()
    else {
      setClip(following)
      setShowing(false)
    }
  }
  const still = FILES[`./aliens/${character}.png`]
  return (
    <span
      aria-hidden
      data-mood={mood}
      style={{ width: size, height: size }}
      // The renders leave room for the hop, so the figure is drawn a bit larger than its box
      className={`relative shrink-0 scale-130 ${mood === 'failed' ? 'grayscale' : ''}`}
      onPointerEnter={() => {
        const reaction = react(character, HOVER)
        setPoke((current) => current ?? reaction)
      }}
      onClick={() => setPoke(react(character, CLICK))}
    >
      {/* The still pose under the video covers the frame a new clip takes to load */}
      <img src={still} alt="" className={`absolute inset-0 size-full ${showing ? 'invisible' : ''}`} />
      {!matchMedia('(prefers-reduced-motion: reduce)').matches && (
        <video
          key={character}
          src={clipUrl(character, clip)}
          className="absolute inset-0 size-full"
          autoPlay
          muted
          playsInline
          onPlaying={() => setShowing(true)}
          onEnded={ended}
        />
      )}
    </span>
  )
}
