import type { SessionMessage, SessionRateLimit, SessionUsage } from 'claude-code'

/**
 * The figures the band shows beside Ranko: how full the context is, whether
 * the prompt cache is still warm and for how long, and the plan's usage
 * limits; and a compaction's summary cut into lines the transcript draws
 * whole.
 *
 * No engine here: register.tsx reads the session and draws what this says.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The terminal draws the first 2000 characters of a log line; a remote
// surface draws more, so this fits both.
export const LOG_LIMIT = 2000
// From here on the Compact button stands out.
export const COMPACT_AT = 80

/** What the last request of the main conversation did with the prompt cache. */
export type CacheReading = {
  // When the response came, in $.clock.now()'s milliseconds.
  at: number
  input: number
  read: number
  written: number
}

/**
 * How long the prompt cache lives after its last use: an hour on a Claude
 * plan, five minutes on an API key. The engine doesn't say which, so the
 * plan's rate-limit windows, which an API key has none of, tell.
 */
export const cacheTtl = (usage: SessionUsage | null) =>
  usage?.rateLimits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day') ? HOUR : 5 * MINUTE

/** 84000 as 84k, 1200000 as 1.2M. */
export function tokens(n: number) {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** A span in whole minutes, or hours and minutes; under a minute, "<1m". */
export function span(ms: number) {
  if (ms < MINUTE) {
    return '<1m'
  }
  const minutes = Math.floor(ms / MINUTE)
  return minutes <= 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A bar of `width` cells, filled to `percent`. */
export function bar(percent: number, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** The context's fill, or null before the first response has measured it. */
export function contextOf(usage: SessionUsage | null) {
  const { percent, tokens: used, window } = usage?.context ?? {}
  if (percent === undefined || window === undefined) {
    return null
  }
  return { percent, text: `${percent}% · ${used === undefined ? '?' : tokens(used)} / ${tokens(window)}` }
}

/** Whether the cache is warm and for how much longer, or how long ago it lapsed. */
export function cacheText(reading: CacheReading | null, ttlMs: number, nowMs: number) {
  if (!reading) {
    return 'no request yet'
  }
  const left = reading.at + ttlMs - nowMs
  if (left <= 0) {
    return `expired ${span(-left)} ago`
  }
  const total = reading.input + reading.read + reading.written
  const hit = total > 0 ? ` · ${Math.round((reading.read / total) * 100)}% read` : ''
  return `warm · ${span(left)} left${hit}`
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A reset time as the person's clock has it: 17:40, or Mon 09:00 a day or more ahead. */
function resetAt(iso: string, nowMs: number) {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) {
    return null
  }
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return at.getTime() - nowMs >= 24 * HOUR ? `${WEEKDAYS[at.getDay()]} ${time}` : time
}

/** The plan's usage limits, `5h 23% (17:40) · 7d 41% (Mon 09:00)`; null with none. */
export function limitsText(limits: readonly SessionRateLimit[], nowMs: number) {
  const names: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
  const parts = limits.map(limit => {
    const reset = limit.resetsAt ? resetAt(limit.resetsAt, nowMs) : null
    return `${names[limit.kind] ?? limit.kind} ${Math.round(limit.percentUsed)}%${reset ? ` (${reset})` : ''}`
  })
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The summary a compaction left: the user message that is not one of the
 * messages it kept, which carry the handles they had before.
 */
export function summaryOf(before: readonly SessionMessage[], after: readonly SessionMessage[]) {
  const kept = new Set(before.flatMap(m => (m.handle === undefined ? [] : [m.handle])))
  return after.find(m => m.role === 'user' && !(m.handle !== undefined && kept.has(m.handle)))?.text ?? null
}

// Where a text may be cut, most welcome first: between paragraphs, lines,
// sentences, words. Each keeps the break with the part before it.
const BREAKS = [/(?<=\n\n)/, /(?<=\n)/, /(?<=[.!?] )/, /(?<= )/]

function pieces(text: string, limit: number, level: number): string[] {
  if (text.length <= limit) {
    return [text]
  }
  const at = BREAKS[level]
  if (!at) {
    return Array.from({ length: Math.ceil(text.length / limit) }, (_, i) => text.slice(i * limit, (i + 1) * limit))
  }
  const chunks: string[] = []
  let current = ''
  for (const part of text.split(at)) {
    for (const piece of pieces(part, limit, level + 1)) {
      if (current.length + piece.length > limit && current !== '') {
        chunks.push(current)
        current = ''
      }
      current += piece
    }
  }
  if (current !== '') {
    chunks.push(current)
  }
  return chunks
}

/**
 * A text as log lines the terminal draws whole: cut between paragraphs where
 * it can, and only inside one that is longer than a line may be.
 */
export function logChunks(text: string, limit = LOG_LIMIT) {
  return pieces(text.trim(), limit, 0)
    .map(chunk => chunk.trim())
    .filter(chunk => chunk !== '')
}
