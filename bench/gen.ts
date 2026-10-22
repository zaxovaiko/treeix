// Deterministic bench inputs in /tmp/treeix-bench (or $1): `bun bench/gen.ts [dir]`
//   mixed-100m.ans  100 MB of SGR (16, 256, truecolor), CJK, emoji, combining marks, long wrapping lines, cursor moves
//   plain-50m.txt   50 MB of printable ASCII lines
//   scroll-5k.ans   5000 colored lines, the reveal bench's scrollback
import { existsSync, mkdirSync, openSync, statSync, writeSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '/tmp/treeix-bench'
const MB = 1024 * 1024

/** mulberry32: same seed, same bytes on every machine */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ASCII = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:-_=+()[]{}<>/'
const CJK = '漢字仮名交じり文中文字符한국어텍스트日本語の文章'
const EMOJI = ['🚀', '✅', '🔥', '🌲', '👍🏽', '🇵🇱', '👨‍👩‍👧', '⚠️']
const COMBINING = ['é', 'ä', 'ñ', 'ǫ']

function mixedLine(next: () => number): string {
  const pick = <T>(items: ArrayLike<T>): T => items[Math.floor(next() * items.length)]
  const kind = next()
  const length = kind < 0.1 ? 300 + Math.floor(next() * 1700) : 20 + Math.floor(next() * 100)
  let out = ''
  while (out.length < length) {
    const roll = next()
    if (roll < 0.08) out += `\x1b[${30 + Math.floor(next() * 8)}m`
    else if (roll < 0.12) out += `\x1b[38;5;${Math.floor(next() * 256)}m`
    else if (roll < 0.16) out += `\x1b[38;2;${Math.floor(next() * 256)};${Math.floor(next() * 256)};${Math.floor(next() * 256)}m`
    else if (roll < 0.18) out += `\x1b[48;2;${Math.floor(next() * 256)};${Math.floor(next() * 256)};${Math.floor(next() * 256)}m`
    else if (roll < 0.2) out += '\x1b[0m'
    else if (roll < 0.23) out += pick(CJK).repeat(1 + Math.floor(next() * 6))
    else if (roll < 0.24) out += pick(EMOJI)
    else if (roll < 0.25) out += pick(COMBINING)
    else out += pick(ASCII).repeat(1 + Math.floor(next() * 4))
  }
  // Now and then a TUI-style redraw: up a line, clear it, rewrite
  if (kind > 0.97) out += '\r\n\x1b[1A\x1b[2K\x1b[1;32mredraw\x1b[0m'
  return `${out}\x1b[0m\n`
}

function plainLine(next: () => number): string {
  let out = ''
  const length = 40 + Math.floor(next() * 80)
  for (let i = 0; i < length; i++) out += ASCII[Math.floor(next() * ASCII.length)]
  return `${out}\n`
}

function write(name: string, bytes: number, line: (next: () => number) => string, seed: number): void {
  const path = join(dir, name)
  if (existsSync(path) && statSync(path).size === bytes) return console.log(`${path} up to date`)
  const next = rng(seed)
  const fd = openSync(path, 'w')
  const encoder = new TextEncoder()
  let written = 0
  let chunk = ''
  while (written < bytes) {
    chunk += line(next)
    if (chunk.length < 256 * 1024) continue
    const data = encoder.encode(chunk).subarray(0, bytes - written)
    writeSync(fd, data)
    written += data.length
    chunk = ''
  }
  closeSync(fd)
  console.log(`${path} ${(bytes / MB).toFixed(1)} MB`)
}

mkdirSync(dir, { recursive: true })
write('mixed-100m.ans', 100 * MB, mixedLine, 1)
write('plain-50m.txt', 50 * MB, plainLine, 2)
let lines = ''
for (let i = 1; i <= 5000; i++) lines += `\x1b[3${(i % 7) + 1}mline ${String(i).padStart(4, '0')}\x1b[0m ${'scrollback text '.repeat(1 + (i % 6))}\n`
write('scroll-5k.ans', new TextEncoder().encode(lines).length, () => lines, 3)
