import type { SessionMessage, SessionRateLimit, SessionUsage } from 'claude-code'

/**
 * The figures the band shows beside Ranko, each with a bar: how full the
 * context is and how far auto-compaction is off, how long the prompt cache
 * stays warm, how much of the plan's five-hour window is used, with the
 * limits' reset times and when they run full at the pace they are used, and
 * how far Claude's task list has come; and a compaction's summary cut into
 * lines the transcript draws whole.
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
 * lapsed.
 */
export function cacheOf(reading: CacheReading | null, ttlMs: number, nowMs: number) {
  if (!reading) {
    return { percent: 0, text: 'no request yet' }
  }
  const left = reading.at + ttlMs - nowMs
  if (left <= 0) {
    return { percent: 0, text: `expired ${span(-left)} ago` }
  }
  const total = reading.input + reading.read + reading.written
  const hit = total > 0 ? ` · ${Math.round((reading.read / total) * 100)}% read` : ''
  return { percent: Math.min(100, (left / ttlMs) * 100), text: `${span(left)} left${hit}` }
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
 * resets; null with none. `samples` are the five-hour window's readings.
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
  return { percent: session.percentUsed, isRunningOut, text }
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
