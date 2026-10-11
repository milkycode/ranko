import type { SessionMessage, SessionRateLimit, SessionUsage } from 'claude-code'

/**
 * The figures the band shows beside Ranko, each with a bar: how full the
 * context is and how far auto-compaction is off, how long the prompt cache
 * stays warm, how much of the plan's five-hour window is used, with the
 * limits' reset times and when they run full at the pace they are used, and
 * how far Claude's task list has come, or else the session: how long it has
 * run, its turns, and what runs in the background; and a compaction's summary
 * cut into lines the transcript draws whole.
 *
 * No engine here: register.tsx reads the session and draws what this says.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
// The plan's windows, by the kind their limit carries.
const WINDOWS: Record<string, number> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
// A forecast goes by the readings of the last half hour when they span ten
// minutes or more, else by the window so far, once that is ten minutes old.
const RECENT_MS = 30 * MINUTE
const MIN_SPAN_MS = 10 * MINUTE
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
// The terminal draws the first 2000 characters of a log line; a remote
// surface draws more, so this fits both.
export const LOG_LIMIT = 2000
// The Compact button shows from this much context on, and stands out from
// the second, or within the last tenth before auto-compaction runs.
export const COMPACT_FROM = 15
export const COMPACT_AT = 80
const NEARLY_AT = 0.1
// What stands before a limit's reset time.
const RESET_MARK = '↻'

/** A used-up share's color: green, yellow from half, red once nearly full. */
export const fillColor = (percent: number) => (percent >= COMPACT_AT ? 'error' : percent >= 50 ? 'warning' : 'success')

/** The cache's color by the share of its time left: green, yellow under half, red under a quarter. */
export const cacheColor = (percentLeft: number) => (percentLeft >= 50 ? 'success' : percentLeft >= 25 ? 'warning' : 'error')

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
 * plan, five minutes on an API key. The engine doesn't say which; the
 * session's credential does.
 */
export const cacheTtl = (isPlan: boolean) => (isPlan ? HOUR : 5 * MINUTE)

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

/** A turn's or a session's length: 42s, 2m 14s, 1h 23m, 2d 5h. */
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** A bar of `width` cells, filled to `percent`. */
export function bar(percent: number, width = 10) {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/**
 * The context's fill and how many tokens are left before auto-compaction
 * runs, when it is on; null before the first response has measured it.
 */
export function contextOf(usage: SessionUsage | null, autoCompactAt: number | null = null) {
  const { percent, tokens: used, window } = usage?.context ?? {}
  if (percent === undefined || window === undefined) {
    return null
  }
  const left = autoCompactAt === null || used === undefined ? null : autoCompactAt - used
  const auto = left === null ? '' : left > 0 ? ` · auto-compact in ${tokens(left)}` : ' · auto-compact due'
  return { percent, left, text: `${percent}% · ${used === undefined ? '?' : tokens(used)} / ${tokens(window)}${auto}` }
}

/**
 * The cache: the share of its time left, for the bar, and how much longer it
 * stays warm with how much of the last request it served, or how long ago it
 * lapsed; `short` is the time left alone, for the collapsed line.
 */
export function cacheOf(reading: CacheReading | null, ttlMs: number, nowMs: number) {
  if (!reading) {
    return { percent: 0, text: 'no request yet', short: '–' }
  }
  const left = reading.at + ttlMs - nowMs
  if (left <= 0) {
    return { percent: 0, text: `expired ${span(-left)} ago`, short: 'expired' }
  }
  const total = reading.input + reading.read + reading.written
  const hit = total > 0 ? ` · ${Math.round((reading.read / total) * 100)}% read` : ''
  return { percent: Math.min(100, (left / ttlMs) * 100), text: `${span(left)} left${hit}`, short: span(left) }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Whether the context is so full that compacting is due: near auto-compaction, or 80% without it. */
export function isNearlyFull(context: { percent: number; left: number | null }, autoCompactAt: number | null) {
  return context.left !== null && autoCompactAt !== null
    ? context.left <= autoCompactAt * NEARLY_AT
    : context.percent >= COMPACT_AT
}

/** A time as the person's clock has it: 17:40, or Mon 09:00 a day or more ahead. */
function clockAt(atMs: number, nowMs: number) {
  const at = new Date(atMs)
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  return atMs - nowMs >= 24 * HOUR ? `${WEEKDAYS[at.getDay()]} ${time}` : time
}

/** A reading of how much of a limit was used, and when. */
export type LimitSample = { at: number; percent: number }

/** Whether two readings of a reset time are the same window's: the endpoint stamps them to the microsecond. */
export const isSameReset = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && Math.abs(Date.parse(a) - Date.parse(b)) < MINUTE

/**
 * When a limit runs full at the pace it is being used: the last half hour's
 * pace (`samples`, the window's own readings) where they span long enough,
 * else the window's so far. `lasts` when it won't before it resets; null
 * when it can't be told yet.
 */
export function fullAt(limit: SessionRateLimit, nowMs: number, samples: readonly LimitSample[] = []) {
  const windowMs = WINDOWS[limit.kind]
  const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
  if (windowMs === undefined || Number.isNaN(reset) || limit.percentUsed >= 100) {
    return null
  }
  const recent = samples.filter(sample => nowMs - sample.at <= RECENT_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]
  let rate: number
  if (first && last && last.at - first.at >= MIN_SPAN_MS) {
    rate = (last.percent - first.percent) / (last.at - first.at)
  } else {
    const elapsed = nowMs - (reset - windowMs)
    if (elapsed < MIN_SPAN_MS) {
      return null
    }
    rate = limit.percentUsed / elapsed
  }
  if (rate <= 0) {
    return 'lasts'
  }
  const at = nowMs + (100 - limit.percentUsed) / rate
  return at < reset ? at : 'lasts'
}

/**
 * The plan's usage limits, `5h 68% ↻ 17:40 (full ≈ 16:10) · 7d 41% ↻ Mon
 * 09:00 (lasts)`, the session window's share for the bar (the five hours, or
 * the first limit there is), and whether that window runs full before it
 * resets; `short` is the shares alone, `5h 68% · 7d 41%`, for the collapsed
 * line; null with none. `samples` are the five-hour window's readings.
 */
export function limitsOf(limits: readonly SessionRateLimit[], nowMs: number, samples: readonly LimitSample[] = []) {
  const names: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
  const session = limits.find(limit => limit.kind === 'five_hour') ?? limits[0]
  if (!session) {
    return null
  }
  let isRunningOut = false
  const text = limits
    .map(limit => {
      const reset = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)
      const full = fullAt(limit, nowMs, limit.kind === 'five_hour' ? samples : [])
      if (limit === session && typeof full === 'number') {
        isRunningOut = true
      }
      const forecast = full === null ? '' : full === 'lasts' ? ' (lasts)' : ` (full ≈ ${clockAt(full, nowMs)})`
      const resets = Number.isNaN(reset) ? '' : ` ${RESET_MARK} ${clockAt(reset, nowMs)}`
      return `${names[limit.kind] ?? limit.kind} ${Math.round(limit.percentUsed)}%${resets}${forecast}`
    })
    .join(' · ')
  const short = limits.map(limit => `${names[limit.kind] ?? limit.kind} ${Math.round(limit.percentUsed)}%`).join(' · ')
  return { percent: session.percentUsed, isRunningOut, text, short }
}

/**
 * The plan's limits as Anthropic's usage endpoint (what /usage reads) has
 * them now, every session of the account counted; null for a body without
 * them.
 */
export function planLimits(body: string): SessionRateLimit[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const limits: SessionRateLimit[] = []
  for (const kind of ['five_hour', 'seven_day']) {
    const window = (parsed as Record<string, unknown>)[kind] as { utilization?: unknown; resets_at?: unknown } | null
    if (typeof window?.utilization === 'number') {
      limits.push({
        kind,
        percentUsed: window.utilization,
        ...(typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}),
      })
    }
  }
  return limits.length > 0 ? limits : null
}

/** A reading of the plan's limits from the usage endpoint, and when it was taken. */
export type PlanReading = { limits: SessionRateLimit[]; at: number }

/** A reading as the store keeps it, for any session to take; null for anything else. */
export function planReadingOf(value: unknown): PlanReading | null {
  const reading = value as { limits?: unknown; at?: unknown } | null | undefined
  if (typeof reading?.at !== 'number' || !Array.isArray(reading.limits)) {
    return null
  }
  const isLimit = (limit: unknown) => {
    const l = limit as Record<string, unknown> | null
    return (
      typeof l?.kind === 'string' &&
      typeof l.percentUsed === 'number' &&
      (l.resetsAt === undefined || typeof l.resetsAt === 'string')
    )
  }
  return reading.limits.every(isLimit) ? { limits: reading.limits as SessionRateLimit[], at: reading.at } : null
}

/** How long a 429's `retry-after` asks to wait, in seconds or until a date; null without one. */
export function retryAfterMs(header: string | undefined, nowMs: number) {
  if (header === undefined || header.trim() === '') {
    return null
  }
  const seconds = Number(header)
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000)
  }
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs)
}

/** One item of Claude's task list, from TodoWrite or the Task tools. */
export type Task = {
  id: string
  subject: string
  // What it says while under way: "Writing tests" for "Write tests".
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed'
}

const STATUSES: readonly Task['status'][] = ['pending', 'in_progress', 'completed']
const statusOf = (value: unknown) => STATUSES.find(status => status === value)
const textOf = (value: unknown) => (typeof value === 'string' ? value : undefined)

/**
 * The task list after a call of one of the tools that keep it: TodoWrite
 * writes it whole; TaskCreate adds one, TaskUpdate changes or deletes one,
 * TaskList reads it back. `input` is the call's arguments, `result` its
 * structured result.
 */
export function nextTasks(tasks: readonly Task[], tool: string, input: Record<string, unknown>, result: unknown): Task[] {
  const record = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.flatMap((todo: Record<string, unknown>, i) => {
      const status = statusOf(todo.status)
      const subject = textOf(todo.content)
      const activeForm = textOf(todo.activeForm)
      return status && subject ? [{ id: String(i), subject, status, ...(activeForm ? { activeForm } : {}) }] : []
    })
  }
  if (tool === 'TaskCreate') {
    const created = record.task as Record<string, unknown> | undefined
    const id = textOf(created?.id)
    const activeForm = textOf(input.activeForm)
    const subject = textOf(input.subject) ?? textOf(created?.subject) ?? ''
    return id ? [...tasks, { id, subject, status: 'pending', ...(activeForm ? { activeForm } : {}) }] : [...tasks]
  }
  if (tool === 'TaskUpdate') {
    const id = textOf(input.taskId)
    if (input.status === 'deleted') {
      return tasks.filter(task => task.id !== id)
    }
    return tasks.map(task => {
      if (task.id !== id) {
        return task
      }
      const subject = textOf(input.subject)
      const activeForm = textOf(input.activeForm)
      const status = statusOf(input.status)
      return {
        ...task,
        ...(subject ? { subject } : {}),
        ...(activeForm ? { activeForm } : {}),
        ...(status ? { status } : {}),
      }
    })
  }
  if (tool === 'TaskList' && Array.isArray(record.tasks)) {
    return record.tasks.flatMap((listed: Record<string, unknown>) => {
      const id = textOf(listed.id)
      const status = statusOf(listed.status)
      const subject = textOf(listed.subject)
      const activeForm = tasks.find(task => task.id === id)?.activeForm
      return id && status && subject ? [{ id, subject, status, ...(activeForm ? { activeForm } : {}) }] : []
    })
  }
  return [...tasks]
}

/**
 * How far the task list has come, `3/7 · Writing tests`, and its share done
 * for the bar; null with no list, or with one all done after the turn.
 */
export function tasksOf(tasks: readonly Task[], isWorking: boolean) {
  const done = tasks.filter(task => task.status === 'completed').length
  if (tasks.length === 0 || (done === tasks.length && !isWorking)) {
    return null
  }
  const current = tasks.find(task => task.status === 'in_progress')
  const doing = current ? ` · ${current.activeForm ?? current.subject}` : done === tasks.length ? ' · all done' : ''
  return { percent: (done / tasks.length) * 100, text: `${done}/${tasks.length}${doing}` }
}

/** What the session row reads. */
export type SessionFacts = {
  // When the session began ($.session.usage()'s startedAt).
  startedAt: number
  turns: number
  // The main conversation's turn under way, and the last one done.
  turn: { startedAt: number; tools: number } | null
  lastTurn: { durationMs: number; tools: number } | null
  // The agent types running, and the background work and wakeups the last
  // turn left (classic Stop's background_tasks and session_crons).
  agents: readonly string[]
  background: readonly { type: string }[]
  wakeups: readonly { schedule: string; recurring: boolean }[]
  // The five-hour window's reset, for the bar: how much of it has passed.
  fiveHourReset?: string
}

const FIVE_HOURS = 5 * HOUR

/**
 * When a one-shot wakeup fires: its cron names the minute, hour, day and
 * month, this year's or, for a month already gone, next year's; null for
 * one that recurs, doesn't parse, or has passed.
 */
export function wakeupAt(schedule: string, recurring: boolean, nowMs: number) {
  const [minute = Number.NaN, hour = Number.NaN, day = Number.NaN, month = Number.NaN] = schedule
    .trim()
    .split(/\s+/)
    .map(Number)
  if (recurring || ![minute, hour, day, month].every(Number.isInteger)) {
    return null
  }
  const now = new Date(nowMs)
  const year = now.getFullYear() + (month - 1 < now.getMonth() ? 1 : 0)
  const at = new Date(year, month - 1, day, hour, minute).getTime()
  return at >= nowMs ? at : null
}

/** `2 agents (Explore, Plan)`, `1 shell`: so many of a kind, with what they are. */
function counted(n: number, one: string, kinds: readonly string[] = []) {
  const names = [...new Set(kinds)]
  return `${n} ${one}${n === 1 ? '' : 's'}${names.length > 0 ? ` (${names.join(', ')})` : ''}`
}

/**
 * The session row: how long the session has run and its turns, what runs in
 * the background, and the turn under way or the last one, in that order, so
 * a narrow row loses the turn first; and how much of the five-hour window
 * has passed, for the bar beside the limits' use, or null without one.
 */
export function sessionOf(facts: SessionFacts, nowMs: number) {
  const parts = [duration(nowMs - facts.startedAt), counted(facts.turns, 'turn')]
  if (facts.agents.length > 0) {
    parts.push(counted(facts.agents.length, 'agent', facts.agents))
  }
  const byType = new Map<string, number>()
  for (const task of facts.background) {
    byType.set(task.type, (byType.get(task.type) ?? 0) + 1)
  }
  for (const [type, n] of byType) {
    parts.push(counted(n, type))
  }
  const loops = facts.wakeups.filter(wakeup => wakeup.recurring).length
  const next = facts.wakeups
    .map(wakeup => wakeupAt(wakeup.schedule, wakeup.recurring, nowMs))
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b)[0]
  if (next !== undefined) {
    parts.push(`wakeup ${clockAt(next, nowMs)}`)
  }
  if (loops > 0) {
    parts.push(counted(loops, 'loop'))
  }
  if (facts.turn) {
    parts.push(`this turn ${duration(nowMs - facts.turn.startedAt)}, ${counted(facts.turn.tools, 'tool')}`)
  } else if (facts.lastTurn) {
    parts.push(`last ${duration(facts.lastTurn.durationMs)}, ${counted(facts.lastTurn.tools, 'tool')}`)
  }
  const reset = facts.fiveHourReset === undefined ? Number.NaN : Date.parse(facts.fiveHourReset)
  const percent = Number.isNaN(reset) ? null : Math.max(0, Math.min(100, ((nowMs - (reset - FIVE_HOURS)) / FIVE_HOURS) * 100))
  return { percent, text: parts.join(' · ') }
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
