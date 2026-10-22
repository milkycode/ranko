/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type {
  Elements,
  EngineInterface,
  On,
  PluginOptions,
  RenderElement,
  SessionCompacted,
  SessionMessage,
  SessionRateLimit,
  SessionUsage,
} from 'claude-code'

import type { GrabMessage, GrabProps } from './grab'
import type { PressMessage, PressProps } from './press'
import { FEATURES, LEAVE_FRAMES, Pet, commandSuggestions, isManifest, moodOf, propFor, propForAgent, sizeFor } from './pet'
import type { Feature, Manifest, Mini } from './pet'
import {
  COMPACT_FROM,
  bar,
  cacheColor,
  cacheOf,
  cacheTtl,
  contextOf,
  fillColor,
  isNearlyFull,
  isSameReset,
  limitsOf,
  logChunks,
  nextTasks,
  planLimits,
  planReadingOf,
  retryAfterMs,
  sessionOf,
  summaryOf,
  tasksOf,
  tokens,
} from './stats'
import type { CacheReading, LimitSample, PlanReading, SessionFacts, Task } from './stats'

/**
 * Ranko above the prompt: frames baked by blender/bake.py, played
 * by swapping one Image's source on a timer, the clip picked by what the
 * main conversation is doing (pet.ts).
 *
 * The terminal draws pixels through the Image. The desktop app has no
 * Image: there each frame is a WebP inside an SVG, and the band is drawn again
 * for every frame, which it does up to ten times a second. Elsewhere, or in a
 * terminal without an image protocol, the band is left as it was. Every
 * reaction beyond the base moods is a `userConfig` switch, on unless turned
 * off.
 *
 * The desktop shows nothing new in the band while a button is held, so a
 * dragged Ranko moves there only when he is let go; until then the grab
 * region, which it does draw, shows where he will land (grab.tsx).
 *
 * Beside him the band shows how full the context is, how long the prompt
 * cache stays warm and the plan's usage limits, with a Compact button
 * (stats.ts); after a compaction the transcript shows the summary Claude
 * carries on with, in log lines the model doesn't read. The band collapses to
 * one line of the figures alone, without him.
 */

type Host = {
  blit: (requestId: string, key: string, file: string) => Promise<{ deny?: string }>
  invalidate: () => void
  now: () => Promise<number>
  sound: (name: string) => void
}

/** Everything one load of the plugin keeps between events. */
type Ranko = {
  isOn: (feature: Feature) => boolean
  host: Host | null
  manifest: Manifest | null
  pet: Pet | null
  root: string
  starting: Promise<void> | null
  requestId: string | null
  isShown: boolean
  // Set when the terminal draws the Image's alt instead of pixels: the pet
  // stops drawing for the rest of the session.
  isUnsupported: boolean
  // Set while the desktop app shows the pet: each tick redraws its band.
  isOnDesktop: boolean
  // The frames the desktop drew lately, base64 by file, the oldest first,
  // and how many characters they come to.
  frames: Map<string, string>
  frameChars: number
  // The band column of the pet's left edge; null keeps it at the right end.
  left: number | null
  bandColumns: number
  // The size the pet is drawn at: the manifest's, or less when the band is short.
  petColumns: number
  // Added to every Image key when the band is short: an Image drawn again at
  // another size keeps its old placement in the terminal and is clipped, so a
  // new size gets new Images (the pet's and the minis', whose size follows it).
  sizeSuffix: string
  // A press on the pet: where in it the pointer took hold, whether it has
  // moved yet (a press that never moves is a pat), and the column the grab
  // region stays at until the release. Moved along with the pet, the region
  // would shift under the pointer while it reports columns against it, and
  // the pet would jitter.
  grab: { offset: number; downColumn: number; isMoved: boolean; regionLeft: number } | null
  // The last reading of the context and the plan's limits, for the stats.
  usage: SessionUsage | null
  // The plan's limits as the usage endpoint last had them, every session of
  // the account counted, and when; null without a Claude plan login.
  plan: PlanReading | null
  isPlan: boolean
  // When the last response of this session came, a subagent's too: the
  // limits it reported are as fresh. Null before the first.
  lastResponseAt: number | null
  // What the main conversation's last request did with the prompt cache.
  cache: CacheReading | null
  isCompacting: boolean
  // Compactions logged so far: the Compact button logs its own when the
  // session.compact hook didn't.
  compactLogs: number
  // The token count auto-compaction runs at; null when it is off or unread.
  autoCompactAt: number | null
  // The five-hour window's readings from the usage endpoint, for its pace;
  // a new window starts them over.
  fiveHour: { resetsAt?: string; samples: LimitSample[] }
  // When the usage endpoint and the context's breakdown were last asked,
  // and how often in a row the endpoint has had nothing.
  planAskedAt: number | null
  planMisses: number
  autoCompactReadAt: number | null
  // Claude's task list in the main conversation.
  tasks: Task[]
  // When each turn under way started, the main conversation's and the
  // subagents' alike: a start doesn't say whose it is.
  turnStarts: Map<string, number>
  // For the session row: the main conversation's turns, the one under way
  // and the last, the agents running, and the background work and wakeups
  // the last turn left.
  turns: number
  turn: { id: string; startedAt: number; tools: number } | null
  lastTurn: { durationMs: number; tools: number } | null
  agents: string[]
  background: { type: string }[]
  wakeups: { schedule: string; recurring: boolean }[]
  // The band folded to one line of the figures, Ranko not drawn; kept.
  isCollapsed: boolean
  // The tool calls under way, a subagent's too, and those of them that wait
  // on the person: a permission dialog, a question. WAITING stands for a
  // dialog whose call wasn't found.
  calls: Map<string, { tool: string; agentId: string | undefined }>
  waits: Set<string>
  // When the pet was last drawn: asleep a good while, he is drawn less often.
  drawnAt: number
}

// The elements the stats draw with, and whether the surface is the desktop,
// where the band's buttons are Clients (press.tsx).
type StatsElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Client'> & { isDesktop: boolean }

const KEY = 'ranko'
// A turn shorter than this ends without a celebration: quick answers would
// otherwise make it jump after every message.
const HAPPY_AFTER_MS = 4000
// In English and German, between letters of neither: \b doesn't know ö.
const KIND_WORDS =
  /(?<!\p{L})(thanks|thank you|thx|good job|great job|nice work|well done|love it|love you|awesome|you rock|danke|dankeschön|vielen dank|besten dank|merci|gut gemacht|super gemacht|gute arbeit|super arbeit|perfekt|toll|prima|genial|wunderbar|großartig|hervorragend)(?!\p{L})/iu

// The moods with a sound, by the name of their file in assets/sounds; the
// rest (idle, working, the fidgets) stay quiet, or Ranko would never stop.
const SOUNDS = new Set(['hello', 'pat', 'happy', 'oops', 'blush', 'held', 'drop', 'deflate', 'sleepy'])
const SOUND_GAIN = 0.6
// Below this many rows Ranko is too small to read and isn't drawn at all.
const MIN_ROWS = 4
// A terminal cell in CSS px: on the desktop Ranko is as big as the manifest's
// cells would make him in a terminal, 96 px square.
const TERMINAL_CELL_PX = { width: 8, height: 16 }
// The desktop lays the band out in cells of its own, measured there at about
// 10 px wide and 24 tall: 96 px of Ranko take 10 of them by 4.
const DESKTOP_CELL_PX = { width: 10, height: 24 }
// How much of the frames the desktop keeps read, in base64 characters, some
// 10 MB: every frame as WebP, a few clips' worth as PNG.
const FRAME_CACHE_CHARS = 10_000_000
// The most an Svg's source may hold.
const SVG_LIMIT = 131072
// The stats beside Ranko take at least this many columns and at most this
// many, kept this far from him.
const STATS_MIN_COLUMNS = 34
const STATS_MAX_COLUMNS = 84
const STATS_GAP = 2
const STATS_LABEL_COLUMNS = 8
// The buttons that fold the band to one line and open it again, at its
// top right; Ranko keeps clear of the columns the fold takes there.
const COLLAPSE_MARK = '▴'
const EXPAND_MARK = '▾'
const FOLD_COLUMNS = 6
// How often the stats read the session again, and ask the usage endpoint for
// the plan's limits, which other sessions use up too.
const STATS_EVERY_MS = 10_000
const PLAN_EVERY_MS = 60_000
// Until the endpoint has answered, it is asked again sooner, a few times: a
// session's login can come a moment after the session starts.
const PLAN_RETRY_MS = 10_000
const PLAN_RETRIES = 6
const PLAN_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
// The endpoint's last reading and, after a 429, when it may be asked again,
// in the store, which every session of this configuration shares, and so its
// login: a reading under a minute old stands in for asking. Told to wait
// without a time, it is left alone this long.
const PLAN_KEY = 'plan'
const PLAN_WAIT_KEY = 'planWait'
const PLAN_BACKOFF_MS = 5 * 60_000
// The five-hour window's readings are kept this long, for its recent pace.
const SAMPLES_KEPT_MS = 60 * 60_000
// The tools that keep Claude's task list.
const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList'])
// The agents that count as running.
const ACTIVE_AGENTS = new Set(['pending', 'running', 'waiting'])
// The tools that wait for the person's answer while they run.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// What stands in the waits for a permission dialog whose call wasn't found.
const WAITING = 'permission'
// Asleep a good while, Ranko is drawn this often rather than every frame:
// on the desktop every frame is a redraw carrying its picture whole. Asleep
// longer still, he holds still, drawn not at all until something wakes him.
// No surface says whether its window is in view; this is the stand-in.
const DROWSY_DRAW_MS = 250
// A test run, by its command: what earns a thumbs up when it passes.
// Its output can still say it failed: piped through tail, a failed run ends
// well.
const TEST_RUN =
  /(?<![\w-])((npm|pnpm|yarn|bun)( run)? test|jest|vitest|pytest|phpunit|go test|cargo test|claude plugin test|make test)(?![\w-])/
const FAILED = /\b[1-9]\d* (failed|failing|failures?)\b|\bfailures?: [1-9]|\bFAIL(ED|URES)?\b/i

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(value)))

const fileOf = (s: Ranko, clip: string, frame: number, format: 'png' | 'webp' = 'png') =>
  `${s.root}/assets/frames/${clip}/${String(frame).padStart(3, '0')}.${format}`

/** A frame as the desktop reads it: its WebP, a quarter of the PNG's bytes, where the bake made them all. */
const desktopFileOf = (s: Ranko, clip: string, frame: number) =>
  fileOf(s, clip, frame, s.manifest?.webp === true ? 'webp' : 'png')

/** A frame's bytes, base64, from the desktop's cache or the file. */
async function frameBytes($: EngineInterface, s: Ranko, file: string) {
  const cached = s.frames.get(file)
  if (cached !== undefined) {
    s.frames.delete(file)
    s.frames.set(file, cached)
    return cached
  }
  try {
    const { base64 } = await $.fs.read(file, { as: 'bytes' })
    s.frames.set(file, base64)
    s.frameChars += base64.length
    for (const [old, bytes] of s.frames) {
      if (s.frameChars <= FRAME_CACHE_CHARS) {
        break
      }
      s.frames.delete(old)
      s.frameChars -= bytes.length
    }
    return base64
  } catch {
    return null
  }
}

/**
 * A frame as the desktop draws it: its WebP or PNG inside an SVG that the
 * Svg element scales to the size it is given, faded by `opacity` (a mini
 * walking off). Null when the file can't be read or the SVG would be over
 * the limit.
 */
async function desktopFrame($: EngineInterface, s: Ranko, file: string, opacity = 1) {
  const base64 = await frameBytes($, s, file)
  if (base64 === null || !s.manifest) {
    return null
  }
  const { width, height } = desktopSize(s.manifest)
  const fade = opacity < 1 ? ` opacity="${opacity.toFixed(2)}"` : ''
  const type = file.endsWith('.webp') ? 'image/webp' : 'image/png'
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}"${fade} href="data:${type};base64,${base64}"/></svg>`
  return source.length <= SVG_LIMIT ? source : null
}

/** Ranko's size on the desktop: in CSS px, and the desktop's cells he covers. */
function desktopSize(manifest: Manifest, scale = 1) {
  const width = manifest.columns * TERMINAL_CELL_PX.width * scale
  const height = manifest.rows * TERMINAL_CELL_PX.height * scale
  return {
    width,
    height,
    columns: Math.ceil(width / DESKTOP_CELL_PX.width),
    rows: Math.ceil(height / DESKTOP_CELL_PX.height),
  }
}

/**
 * Where the mini Rankos stand: to the pet's left, or to its right when
 * there's no room; a leaving one walks off a column every other frame. Those
 * off the band are left out.
 */
function miniPlaces(s: Ranko, pet: Pet, petLeft: number, columns: number, miniColumns: number) {
  const places: { mini: Mini; x: number }[] = []
  pet.minis.forEach((mini, i) => {
    const slot = (i + 1) * (miniColumns + 1)
    const home = petLeft - slot >= 0 ? petLeft - slot : petLeft + columns + 1 + i * (miniColumns + 1)
    const x = home - (mini.leaving === null ? 0 : Math.floor(mini.leaving / 2))
    if (x >= 0 && x + miniColumns <= s.bandColumns && (mini.leaving ?? 0) < LEAVE_FRAMES) {
      places.push({ mini, x })
    }
  })
  return places
}

/** The columns Ranko, his minis and their count take in the strip. */
function takenColumns(pet: Pet, petLeft: number, columns: number, places: { x: number }[], miniColumns: number) {
  const lefts = [petLeft, ...places.map(p => p.x), ...(pet.extraMinis > 0 ? [Math.max(0, petLeft - 4)] : [])]
  const rights = [petLeft + columns, ...places.map(p => p.x + miniColumns)]
  return { from: Math.min(...lefts), to: Math.max(...rights) }
}

/**
 * Where the stats fit in the strip: left of Ranko and his minis, or right of
 * them when he was dragged too far left; null when neither side has room.
 */
function statsPlace(bandColumns: number, from: number, to: number) {
  const leftRoom = from - STATS_GAP
  if (leftRoom >= STATS_MIN_COLUMNS) {
    return { left: 0, width: Math.min(leftRoom, STATS_MAX_COLUMNS) }
  }
  const rightRoom = bandColumns - to - STATS_GAP
  if (rightRoom >= STATS_MIN_COLUMNS) {
    return { left: to + STATS_GAP, width: Math.min(rightRoom, STATS_MAX_COLUMNS) }
  }
  return null
}

async function readUsage($: EngineInterface, s: Ranko) {
  const [usage, agents] = await Promise.all([$.session.usage().catch(() => s.usage), $.agent.list().catch(() => null)])
  s.usage = usage
  if (agents) {
    s.agents = agents.filter(agent => ACTIVE_AGENTS.has(agent.status)).map(agent => agent.type)
  }
}

/** Fits Ranko's size to the context's fill, rounder as it fills: at the start too, so a resumed session shows him as full as it is. */
async function fitSize($: EngineInterface, s: Ranko) {
  if (!s.pet || !s.isOn('stuffing')) {
    return
  }
  try {
    const { context } = await $.session.usage()
    s.pet.size = sizeFor(context.percent ?? 0)
  } catch {
    // No reading this time; the size stays as it was.
  }
}

/** How many turns the conversation held before this load: the prompts in it. */
async function countTurns($: EngineInterface, s: Ranko) {
  const messages = await $.session.messages().catch(() => [])
  s.turns = messages.filter(m => m.role === 'user' && m.text.trim() !== '' && !m.toolResults?.length).length
}

/**
 * Asks Anthropic's usage endpoint, as /usage does, for the plan's limits
 * with the session's own login; an API key or another provider has none.
 */
async function readPlan($: EngineInterface, s: Ranko) {
  const now = await $.clock.now()
  s.planAskedAt = now
  s.planMisses += 1
  try {
    const auth = await $.session.authorize()
    s.isPlan = auth?.kind === 'bearer'
    if (!auth || !s.isPlan) {
      return
    }
    const shared = planReadingOf(await $.store.get(PLAN_KEY).catch(() => undefined))
    if (shared && now - shared.at < PLAN_EVERY_MS) {
      takePlan(s, shared)
      return
    }
    const waitUntil = await $.store.get(PLAN_WAIT_KEY).catch(() => undefined)
    if (typeof waitUntil === 'number' && now < waitUntil) {
      return
    }
    const response = await $.http.fetch(PLAN_USAGE_URL, {
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      auth: auth.handle,
    })
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers['retry-after'], now) ?? PLAN_BACKOFF_MS
      await $.store.set(PLAN_WAIT_KEY, now + wait).catch(() => undefined)
      return
    }
    const limits = response.ok ? planLimits(response.text) : null
    if (limits) {
      const reading: PlanReading = { limits, at: await $.clock.now() }
      takePlan(s, reading)
      await $.store.set(PLAN_KEY, reading).catch(() => undefined)
    }
  } catch {
    // Offline, or the traffic is off: the session's own reading stands.
  }
}

/** Takes a reading of the plan's limits, this session's or another's, and the five hours' pace from it. */
function takePlan(s: Ranko, reading: PlanReading) {
  s.planMisses = 0
  if (s.plan?.at === reading.at) {
    return
  }
  const { limits, at } = reading
  s.plan = reading
  const fiveHour = limits.find(limit => limit.kind === 'five_hour')
  if (fiveHour) {
    const isSameWindow = isSameReset(s.fiveHour.resetsAt, fiveHour.resetsAt)
    const kept = isSameWindow ? s.fiveHour.samples.filter(sample => at - sample.at <= SAMPLES_KEPT_MS) : []
    s.fiveHour = { resetsAt: fiveHour.resetsAt, samples: [...kept, { at, percent: fiveHour.percentUsed }] }
  }
}

/** Whether the endpoint is due again: a minute on, or sooner while it has never answered. */
function isPlanDue(s: Ranko, nowMs: number) {
  if (s.planAskedAt === null) {
    return true
  }
  const wait = s.plan === null && s.planMisses < PLAN_RETRIES ? PLAN_RETRY_MS : PLAN_EVERY_MS
  return nowMs - s.planAskedAt >= wait
}

/**
 * Reads what the stats show: the session every time, the usage endpoint and
 * where auto-compaction runs when they are due.
 */
async function readStats($: EngineInterface, s: Ranko) {
  const now = await $.clock.now()
  await Promise.all([
    readUsage($, s),
    isPlanDue(s, now) ? readPlan($, s) : null,
    s.autoCompactReadAt === null || now - s.autoCompactReadAt >= PLAN_EVERY_MS ? readAutoCompact($, s) : null,
  ])
}

/** Reads where auto-compaction runs, from the context's breakdown, estimated locally. */
async function readAutoCompact($: EngineInterface, s: Ranko) {
  s.autoCompactReadAt = await $.clock.now()
  try {
    const { breakdown } = (await $.session.usage({ breakdown: 'summary' })).context
    if (breakdown) {
      s.autoCompactAt = breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null
    }
  } catch {
    // No reading this time; the last one stands.
  }
}

/** The limits to show: the endpoint's, unless a response of this session came since. */
const limitsNow = (s: Ranko) =>
  s.plan && (s.lastResponseAt === null || s.plan.at > s.lastResponseAt) ? s.plan.limits : (s.usage?.rateLimits ?? [])

/** Logs a compaction: the tokens before and after, then the summary in lines drawn whole. */
function logCompaction(
  $: EngineInterface,
  s: Ranko,
  before: readonly SessionMessage[],
  result: SessionCompacted,
  tokensBefore?: number,
) {
  s.compactLogs += 1
  if (!s.isOn('compactSummary')) {
    return
  }
  const from = result.tokensBefore ?? tokensBefore
  const to = result.tokensAfter
  $.ui.log(
    `Compacted from ${from === undefined ? '?' : tokens(from)} to ${to === undefined ? '?' : tokens(to)} tokens. ` +
      'The summary Claude carries on with:',
  )
  const summary = summaryOf(before, result.messages) ?? 'No summary was found in the compacted conversation.'
  for (const line of logChunks(summary)) {
    $.ui.log(line)
  }
}

/** The Compact button's press: /compact's own call, between turns. */
async function compactNow($: EngineInterface, s: Ranko) {
  if (s.isCompacting) {
    return
  }
  s.isCompacting = true
  $.ui.invalidate('ui.render')
  const logged = s.compactLogs
  try {
    const result = await $.session.compact()
    if (result.skip !== undefined) {
      $.ui.toast(`Not compacted: ${result.skip}`)
    } else if (s.compactLogs === logged) {
      logCompaction($, s, [], result)
    }
  } catch (error) {
    $.ui.toast(`Couldn't compact: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    s.isCompacting = false
    await readUsage($, s)
    $.ui.invalidate('ui.render')
  }
}

/**
 * The stats beside Ranko, the same on every surface: a row each for the
 * context, the cache, the limits and Claude's task list while there is one,
 * else the session, a dim label, a bar and the reading. The context's row
 * ends in the Compact button. The limits' bar fills and colors with the
 * five-hour window's use, as the context's does; their reading turns yellow
 * when that window would run full before it resets, and red once it has.
 */
function stats(
  el: StatsElements,
  s: Ranko,
  nowMs: number,
  width: number,
  rows: number | undefined,
  onCompact: () => void,
) {
  const { Box, Text } = el
  const context = contextOf(s.usage, s.autoCompactAt)
  const cache = cacheOf(s.cache, cacheTtl(s.isPlan), nowMs)
  const limits = limitsOf(limitsNow(s), nowMs, s.fiveHour.samples)
  const tasks = tasksOf(s.tasks, (s.pet?.runningTurns.size ?? 0) > 0)
  // The five-hour window's reset, for the session's bar: from the limits on
  // show, the endpoint's or this session's own last response's.
  const fiveHourReset = limitsNow(s).find(limit => limit.kind === 'five_hour')?.resetsAt ?? s.fiveHour.resetsAt
  const facts: SessionFacts = {
    startedAt: s.usage?.startedAt ?? nowMs,
    turns: s.turns,
    turn: s.turn,
    lastTurn: s.lastTurn,
    agents: s.agents,
    background: s.background,
    wakeups: s.wakeups,
    ...(fiveHourReset === undefined ? {} : { fiveHourReset }),
  }
  const session = tasks ? null : sessionOf(facts, nowMs)
  const compact = compactButton(el, s, onCompact)
  // A dim label, a bar in the reading's color (or dim, empty, with none), the
  // reading, in a color of its own when it warns, and what else the row holds.
  // Too narrow a row cuts the reading short: the label, the bar and the end
  // keep their width, or the bar would wrap onto the next row.
  const row = (
    key: string,
    label: string,
    percent: number,
    barColor: string | null,
    text: string,
    end?: RenderElement,
    textColor?: string,
  ) => (
    <Box key={key} flexDirection="row">
      <Box width={STATS_LABEL_COLUMNS} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <Box flexShrink={0}>
          {barColor ? <Text color={barColor}>{bar(percent)}</Text> : <Text dimColor>{bar(0)}</Text>}
        </Box>
        <Text {...(textColor === undefined ? {} : { color: textColor })} wrap="truncate">
          {text}
        </Text>
        {end ? <Box flexShrink={0}>{end}</Box> : null}
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" width={width} {...(rows === undefined ? {} : { height: rows })} overflow="hidden">
      {context
        ? row('context', 'Context', context.percent, fillColor(context.percent), context.text, compact ?? undefined)
        : row('context', 'Context', 0, null, 'no reading yet', compact ?? undefined)}
      {row(
        'cache',
        'Cache',
        cache.percent,
        cache.percent > 0 ? cacheColor(cache.percent) : null,
        cache.text,
        undefined,
        cache.isExpired ? 'error' : undefined,
      )}
      {limits
        ? row(
            'limits',
            'Limits',
            limits.percent,
            fillColor(limits.percent),
            limits.text,
            undefined,
            limits.isFull ? 'error' : limits.isRunningOut ? 'warning' : undefined,
          )
        : null}
      {tasks ? row('tasks', 'Tasks', tasks.percent, 'suggestion', tasks.text) : null}
      {session ? row('session', 'Session', session.percent ?? 0, session.percent === null ? null : 'suggestion', session.text) : null}
    </Box>
  )
}

/**
 * Folds the band to one line of the figures, or opens it again, and keeps
 * that for later sessions. Folded, Ranko isn't drawn, so his ticks stop
 * blitting and redrawing until a full band draws him again.
 */
async function collapse($: EngineInterface, s: Ranko, isCollapsed: boolean) {
  s.isCollapsed = isCollapsed
  if (isCollapsed) {
    s.isOnDesktop = false
    s.requestId = null
  }
  $.ui.invalidate('ui.render')
  await $.store.set('collapsed', isCollapsed).catch(() => undefined)
}

/**
 * A button of the band: a Button in the terminal. On the desktop, which draws
 * the band again for every frame of Ranko, a Button drawn anew between press
 * and release loses the click, so there it is a Client (press.tsx), kept
 * across the redraws; its press reaches the `ui.message` hook on its key.
 */
function pressable(el: StatsElements, key: string, label: string, isPrimary: boolean, onPress: () => void) {
  const { Button, Client } = el
  if (el.isDesktop) {
    const props: PressProps = { label, isPrimary }
    return <Client key={key} module="./press.tsx" props={props} />
  }
  return <Button key={key} label={label} variant={isPrimary ? 'primary' : 'secondary'} onPress={onPress} />
}

/**
 * The Compact button, once there is something to compact: it stands out once
 * the context is nearly full. Null before.
 */
function compactButton(el: StatsElements, s: Ranko, onCompact: () => void) {
  const context = contextOf(s.usage, s.autoCompactAt)
  if (!s.isCompacting && (context?.percent ?? 0) < COMPACT_FROM) {
    return null
  }
  const isPrimary = context !== null && isNearlyFull(context, s.autoCompactAt)
  return pressable(el, 'compact', s.isCompacting ? 'Compacting…' : 'Compact', isPrimary, onCompact)
}

/** The button at the band's top right that folds it, or opens it again. */
function foldButton(el: StatsElements, isCollapsed: boolean, onPress: () => void) {
  return pressable(el, isCollapsed ? 'expand' : 'collapse', isCollapsed ? EXPAND_MARK : COLLAPSE_MARK, false, onPress)
}

const isPress = (data: unknown) => (data as PressMessage | null)?.isPressed === true

/**
 * The folded band, one line across it: the context as a bar, the cache's time
 * left and the limits' shares as figures, colored as the full rows color
 * them, the Compact button, and at the right end the button that opens the
 * band again.
 */
function statsLine(el: StatsElements, s: Ranko, nowMs: number, width: number, onCompact: () => void, onExpand: () => void) {
  const { Box, Text } = el
  const context = contextOf(s.usage, s.autoCompactAt)
  const cache = cacheOf(s.cache, cacheTtl(s.isPlan), nowMs)
  const limits = limitsOf(limitsNow(s), nowMs, s.fiveHour.samples)
  return (
    <Box key="stats-line" flexDirection="row" justifyContent="space-between" width={width}>
      <Box flexDirection="row" gap={1}>
        <Text dimColor>Context</Text>
        <Box flexShrink={0}>
          {context ? <Text color={fillColor(context.percent)}>{bar(context.percent)}</Text> : <Text dimColor>{bar(0)}</Text>}
        </Box>
        <Text>{context ? `${context.percent}%` : '–'}</Text>
        <Text dimColor>{cache.isExpired ? '·' : '· Cache'}</Text>
        {cache.isExpired ? (
          <Text color="error">{`Cache ${cache.short}`}</Text>
        ) : cache.percent > 0 ? (
          <Text color={cacheColor(cache.percent)}>{cache.short}</Text>
        ) : (
          <Text dimColor>{cache.short}</Text>
        )}
        {limits ? <Text dimColor>· Limits</Text> : null}
        {limits ? (
          <Text color={fillColor(limits.percent)} wrap="truncate">
            {limits.short}
          </Text>
        ) : null}
        {compactButton(el, s, onCompact)}
      </Box>
      {foldButton(el, true, onExpand)}
    </Box>
  )
}

/**
 * The full band without Ranko, where he can't be drawn (a terminal without
 * pictures, a band too short or narrow for him, frames that can't be read):
 * the stats' rows and the button that folds them. Null with the stats off,
 * or too narrow a band for them too.
 */
function statsBand(el: StatsElements, s: Ranko, nowMs: number, bodyColumns: number, onCompact: () => void, onCollapse: () => void) {
  const width = Math.min(bodyColumns - FOLD_COLUMNS, STATS_MAX_COLUMNS)
  if (!s.isOn('stats') || width < STATS_MIN_COLUMNS) {
    return null
  }
  const { Box } = el
  return (
    <Box key="stats-band" flexDirection="row" justifyContent="space-between" width={bodyColumns}>
      {stats(el, s, nowMs, width, undefined, onCompact)}
      {foldButton(el, false, onCollapse)}
    </Box>
  )
}

/** The pet's left column in a band this wide: where it was left, or the right end. */
const leftIn = (s: Ranko, columns: number, petColumns: number) =>
  clamp(s.left ?? columns - petColumns, 0, Math.max(0, columns - petColumns))

/**
 * Binds to the engine once per load. A session start does it; so does the
 * first drawing, since a plugin reloaded by a settings change sees no
 * session start.
 */
function start($: EngineInterface, s: Ranko) {
  s.starting ??= (async () => {
    s.root = $.plugin.root
    const host: Host = {
      blit: (id, key, file) => $.ui.blit({ requestId: id, key, source: { file, format: 'png' } }),
      invalidate: () => $.ui.invalidate('ui.render'),
      now: () => $.clock.now(),
      sound: name => {
        if (s.isOn('sounds')) {
          void $.audio.play({ asset: `assets/sounds/${name}.wav` }, { gain: SOUND_GAIN }).catch(() => undefined)
        }
      },
    }
    s.host = host

    let parsed: unknown
    try {
      parsed = JSON.parse(await $.fs.read(`${s.root}/assets/frames/manifest.json`))
    } catch {
      return
    }
    if (!isManifest(parsed)) {
      $.ui.log('ranko: assets/frames/manifest.json is not a manifest this version can play; rebake the frames')
      return
    }
    const manifest: Manifest = parsed
    s.manifest = manifest
    s.pet = new Pet(manifest, s.isOn, clip => {
      const mood = moodOf(clip)
      if (SOUNDS.has(mood)) {
        host.sound(mood)
      }
    })
    s.pet.lastActivityMs = await host.now()

    await fitSize($, s)

    const saved = await $.store.get('left').catch(() => undefined)
    s.left = typeof saved === 'number' ? saved : null
    s.isCollapsed = (await $.store.get('collapsed').catch(() => undefined)) === true

    await $.command
      .register({
        name: 'ranko',
        description: 'Show or hide Ranko, play one of his reactions, or turn a switch on or off',
        argumentHint: '[happy | oops | pat | blush | sleepy | … | list | collapse | expand | on <switch> | off <switch>]',
      })
      .catch(() => undefined)

    $.clock.every(Math.round(1000 / manifest.fps), () => {
      void tick(s).catch(() => undefined)
    })
    $.clock.every(STATS_EVERY_MS, () => {
      if (s.isOn('stats') && s.isShown) {
        void readStats($, s).then(() => host.invalidate())
      }
    })
    if (s.isOn('stats')) {
      await readUsage($, s)
      void Promise.all([readStats($, s), countTurns($, s)]).then(() => host.invalidate())
    }
  })()
  return s.starting
}

async function tick(s: Ranko) {
  const { host, pet, requestId } = s
  const isOnTerminal = requestId !== null && !s.isUnsupported
  if (!host || !pet || !s.isShown || !(isOnTerminal || s.isOnDesktop)) {
    return
  }
  const now = await host.now()
  pet.sync(now)
  const depth = pet.sleepDepth(now)
  if (depth === 'still') {
    return
  }
  const isDrawn = depth === 'awake' || now - s.drawnAt >= DROWSY_DRAW_MS
  if (isDrawn) {
    s.drawnAt = now
  }

  if (isOnTerminal && isDrawn) {
    const blits = [host.blit(requestId, KEY + s.sizeSuffix, fileOf(s, pet.clip, pet.fileFrame()))]
    const working = pet.framesOf('working')
    for (const mini of pet.minis) {
      blits.push(host.blit(requestId, `mini-${mini.id}${s.sizeSuffix}`, fileOf(s, 'working', mini.frame % working)))
    }
    const [main] = await Promise.all(blits)

    if (main?.deny && /alt/i.test(main.deny)) {
      s.isUnsupported = true
      host.invalidate()
      return
    }
  }
  // The desktop has no blit: each new frame is a redraw, and redraws asked
  // for faster than it takes them fold into one.
  if (pet.advance() || (s.isOnDesktop && isDrawn)) {
    host.invalidate()
  }
}

async function noteActivity($: EngineInterface, s: Ranko) {
  if (s.pet) {
    s.pet.lastActivityMs = await $.clock.now()
  }
}

/** Marks a call as waiting on the person, or done waiting, and tells Ranko whether any still waits. */
async function setWait($: EngineInterface, s: Ranko, id: string, isWaiting: boolean) {
  if (isWaiting) {
    s.waits.add(id)
  } else {
    s.waits.delete(id)
  }
  s.pet?.setWaiting(s.waits.size > 0, await $.clock.now())
}

/** Whether a shell call did something worth a thumbs up: a commit, a push, a pull request opened or merged, a test run that passed. */
function isWellDone(command: string, record: unknown) {
  const run = (record ?? {}) as {
    stdout?: string
    stderr?: string
    interrupted?: boolean
    backgroundTaskId?: string
    gitOperation?: { commit?: unknown; push?: unknown; pr?: { action: string } }
  }
  if (run.interrupted || run.backgroundTaskId !== undefined) {
    return false
  }
  const git = run.gitOperation
  if (git?.commit || git?.push || git?.pr?.action === 'created' || git?.pr?.action === 'merged') {
    return true
  }
  return TEST_RUN.test(command) && !FAILED.test(`${run.stdout ?? ''}\n${run.stderr ?? ''}`)
}

export function register(on: On, options: PluginOptions) {
  const s: Ranko = {
    isOn: feature => options[feature] !== false,
    host: null,
    manifest: null,
    pet: null,
    root: '',
    starting: null,
    requestId: null,
    isShown: true,
    isUnsupported: false,
    isOnDesktop: false,
    frames: new Map(),
    frameChars: 0,
    left: null,
    bandColumns: 0,
    petColumns: 0,
    sizeSuffix: '',
    grab: null,
    usage: null,
    plan: null,
    isPlan: false,
    lastResponseAt: null,
    cache: null,
    isCompacting: false,
    compactLogs: 0,
    autoCompactAt: null,
    fiveHour: { samples: [] },
    planAskedAt: null,
    planMisses: 0,
    autoCompactReadAt: null,
    tasks: [],
    turnStarts: new Map(),
    turns: 0,
    turn: null,
    lastTurn: null,
    agents: [],
    background: [],
    wakeups: [],
    isCollapsed: false,
    calls: new Map(),
    waits: new Set(),
    drawnAt: 0,
  }

  on('session.start', async ($, e, next) => {
    await start($, s)
    // He waves when a session starts.
    s.pet?.play('hello')
    return next(e)
  })

  on('command.run', { command: 'ranko' }, async ($, e) => {
    const [verb = '', name = ''] = e.args.trim().split(/\s+/)

    if (verb === '') {
      s.isShown = !s.isShown
      s.host?.invalidate()
      return { text: s.isShown ? 'Ranko is back' : 'Ranko is napping out of sight' }
    }

    if (verb === 'collapse' || verb === 'expand') {
      await collapse($, s, verb === 'collapse')
      return { text: verb === 'collapse' ? 'The band is folded to one line' : 'Ranko and the stats are back in full' }
    }

    if (verb === 'list') {
      const reactions = s.pet?.clipNames().join(', ') ?? 'none yet: the frames are missing'
      const switches = FEATURES.map(f => `${s.isOn(f) ? 'on ' : 'off'}  ${f}`).join('\n')
      return {
        text: `Reactions to play with /ranko <reaction>:\n${reactions}\n\nSwitches (/ranko on|off <switch>):\n${switches}`,
      }
    }

    if (verb === 'on' || verb === 'off') {
      const feature = FEATURES.find(f => f.toLowerCase() === name.toLowerCase())
      if (!feature) {
        return { text: `No switch called "${name}". There are: ${FEATURES.join(', ')}` }
      }
      // The switch is the plugin's userConfig field; its key carries however
      // the engine names this plugin (a --plugin-dir load adds @inline).
      const rows = await $.config.list()
      const row = rows.find(r => r.key.endsWith(`.${feature}`) && r.key.startsWith($.plugin.name))
      if (!row) {
        return { text: `Couldn't find the ${feature} setting` }
      }
      const { deny } = await $.config.set({ key: row.key, value: verb === 'on' })
      return { text: deny ?? `Ranko's ${feature} is ${verb}` }
    }

    if (!s.pet?.play(verb, true)) {
      return { text: `Ranko has no "${verb}" reaction; /ranko list shows them all` }
    }
    s.isShown = true
    s.host?.invalidate()
    return { text: `Ranko plays ${verb}` }
  })

  // The typeahead for /ranko: its verbs and reactions, and after on or off
  // the switches.
  on('prompt.autocomplete', async ($, e, next) => {
    const result = await next(e)
    const mine = commandSuggestions(e.text, e.start, e.token, s.pet?.clipNames() ?? [], s.isOn)
    return mine.length > 0 ? { suggestions: [...result.suggestions, ...mine] } : result
  })

  on('turn.start', async ($, e, next) => {
    // The start doesn't say whose turn it is; any turn means work is under way.
    s.pet?.runningTurns.add(e.turnId)
    const now = await $.clock.now()
    s.turnStarts.set(e.turnId, now)
    // The first to start while none is under way is taken for the main
    // conversation's until its first request says whose it is (turn.step).
    s.turn ??= { id: e.turnId, startedAt: now, tools: 0 }
    await noteActivity($, s)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    s.turnStarts.delete(e.turnId)
    if (!e.agentId) {
      s.turns += 1
      s.lastTurn = { durationMs: e.durationMs, tools: s.turn?.id === e.turnId ? s.turn.tools : 0 }
      s.turn = null
      // The turn is over: nothing waits on the person any more.
      s.waits.clear()
      await setWait($, s, WAITING, false)
    } else if (s.turn?.id === e.turnId) {
      s.turn = null
    }
    const { pet } = s
    if (!pet) {
      return result
    }
    pet.runningTurns.delete(e.turnId)
    if (e.agentId) {
      pet.finishMini(e.agentId)
      return result
    }

    await noteActivity($, s)
    if (e.isAborted || e.reason === 'error') {
      pet.play('oops')
    } else if (e.durationMs >= HAPPY_AFTER_MS) {
      pet.play('happy')
    }
    await fitSize($, s)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const { pet } = s
    // Every call, a subagent's too, may wait on the person's permission
    // (classic.PermissionRequest); a question waits on the answer.
    s.calls.set(e.tool_use_id, { tool: e.tool, agentId: e.agentId })
    try {
      // Otherwise a subagent's tool calls are its own business: no prop, no
      // wobble, no task of the list.
      if (e.agentId) {
        return await next(e)
      }
      if (s.turn) {
        s.turn.tools += 1
      }
      const prop = e.tool === 'Agent' ? propForAgent(e.subagent_type) : propFor(e.tool)
      if (pet && prop) {
        pet.toolStarted(e.tool_use_id, prop, await $.clock.now())
      }
      if (ASKING_TOOLS.has(e.tool)) {
        await setWait($, s, e.tool_use_id, true)
      }
      const result = await next(e)
      if (result.deny !== undefined || result.isError) {
        pet?.play('oops')
      } else if (TASK_TOOLS.has(e.tool)) {
        // Claude's task list, as TodoWrite and the Task tools keep it.
        s.tasks = nextTasks(s.tasks, e.tool, e as unknown as Record<string, unknown>, result.result)
        if (s.isOn('stats')) {
          $.ui.invalidate('ui.render')
        }
      } else if (e.tool === 'Bash' && s.isOn('thumbsUp') && isWellDone(e.command, result.result)) {
        pet?.thumbsUp()
      }
      return result
    } finally {
      s.calls.delete(e.tool_use_id)
      pet?.toolEnded(e.tool_use_id)
      // A call that ends was answered; so, by now, was a dialog whose call
      // wasn't found.
      if (s.waits.has(e.tool_use_id) || s.waits.has(WAITING)) {
        s.waits.delete(WAITING)
        await setWait($, s, e.tool_use_id, false)
      }
    }
  })

  // A permission dialog: the person is wanted until the call it asks for
  // ends. A decision from a hook beneath shows no dialog.
  on('classic.PermissionRequest', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === undefined) {
      const call = [...s.calls].find(([id, c]) => c.tool === e.tool_name && c.agentId === e.agent_id && !s.waits.has(id))
      await setWait($, s, call?.[0] ?? WAITING, true)
    }
    return result
  })

  // Typing in the prompt box is the person at hand: it keeps Ranko awake,
  // and wakes him from his nap, without holding up a key.
  on('prompt.edit', ($, e, next) => {
    void noteActivity($, s)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await noteActivity($, s)
    // A prompt is the person back: whatever waited on them has its answer.
    if (s.waits.size > 0) {
      s.waits.clear()
      await setWait($, s, WAITING, false)
    }
    if (s.pet && s.isOn('blush') && KIND_WORDS.test(e.text)) {
      s.pet.play('blush')
    }
    return next(e)
  })

  // An agent that stands in for a tool (web-fetch) holds up the tool's prop
  // at its Agent call instead of getting a mini.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (s.pet && s.isOn('miniRankos') && result.agentId && !propForAgent(e.subagentType)) {
      s.pet.spawnMini(result.agentId)
      s.host?.sound('mini')
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // Every response, a subagent's too, brings fresh limits; one of the main
  // conversation also keeps the prompt cache warm for another stretch.
  on('turn.step', async function* ($, e, next) {
    // A request says whose turn it is, which the start couldn't: the main
    // conversation's has no agent.
    if (!e.agentId && s.turn?.id !== e.turnId) {
      s.turn = { id: e.turnId, startedAt: s.turnStarts.get(e.turnId) ?? (await $.clock.now()), tools: 0 }
    } else if (e.agentId && s.turn?.id === e.turnId) {
      s.turn = null
    }
    // The main conversation's thinking, until it writes, calls a tool or the
    // response ends: Ranko thinks along.
    const stream = next(e)
    try {
      for await (const chunk of stream) {
        const { pet } = s
        if (!e.agentId && pet) {
          if (chunk.kind === 'thinking' && !pet.isThinking) {
            pet.thinkStarted(await $.clock.now())
          } else if (chunk.kind !== 'thinking' && chunk.kind !== 'engine' && pet.isThinking) {
            pet.thinkEnded(await $.clock.now())
          }
        }
        yield chunk
      }
    } finally {
      if (!e.agentId && s.pet?.isThinking) {
        s.pet.thinkEnded(await $.clock.now())
      }
    }
    const result = await stream.result
    if (result.usage) {
      const now = await $.clock.now()
      s.lastResponseAt = now
      if (!e.agentId) {
        const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens } = result.usage
        s.cache = { at: now, input: input_tokens, read: cache_read_input_tokens, written: cache_creation_input_tokens }
      }
      if (s.isOn('stats')) {
        void readUsage($, s).then(() => $.ui.invalidate('ui.render'))
      }
    }
    return result
  })

  // What the main conversation's turn left running in the background, and
  // the wakeups it scheduled; subagents the agent list gives live.
  on('classic.Stop', async ($, e, next) => {
    s.background = (e.background_tasks ?? []).filter(task => task.type !== 'subagent').map(task => ({ type: task.type }))
    s.wakeups = (e.session_crons ?? []).map(cron => ({ schedule: cron.schedule, recurring: cron.recurring }))
    if (s.isOn('stats')) {
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // A resumed conversation's cache dates from its last response.
  on('classic.SessionStart', async ($, e, next) => {
    if (e.seconds_since_last_response !== undefined) {
      const at = (await $.clock.now()) - e.seconds_since_last_response * 1000
      s.cache = { at, input: 0, read: 0, written: 0 }
    }
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const tokensBefore = s.usage?.context.tokens
    const result = await next(e)
    // A subagent's, a precomputed or a vetoed compaction leaves the
    // conversation as it was.
    if (e.agentId || e.trigger === 'precompute' || result.skip !== undefined) {
      return result
    }
    // Only a stuffed or plump Ranko has anything to let out.
    if (s.pet && s.isOn('stuffing') && s.pet.size !== 'normal') {
      s.pet.play('deflate')
      s.pet.size = 'normal'
    }
    if (e.trigger === 'manual' || e.trigger === 'plugin') {
      logCompaction($, s, e.messages, result, tokensBefore)
    }
    if (s.isOn('stats')) {
      void Promise.all([readUsage($, s), readAutoCompact($, s)]).then(() => $.ui.invalidate('ui.render'))
    }
    return result
  })

  // The desktop band's buttons (press.tsx) post their presses.
  on('ui.message', { element: 'compact' }, async ($, e, next) => {
    if (isPress(e.data)) {
      void compactNow($, s)
    }
    return next(e)
  })

  on('ui.message', { element: 'collapse' }, async ($, e, next) => {
    if (isPress(e.data)) {
      await collapse($, s, true)
    }
    return next(e)
  })

  on('ui.message', { element: 'expand' }, async ($, e, next) => {
    if (isPress(e.data)) {
      await collapse($, s, false)
    }
    return next(e)
  })

  on('ui.message', { element: 'grab' }, async ($, e, next) => {
    const message = e.data as GrabMessage
    const { pet, manifest } = s
    if (!pet || !manifest || typeof message?.column !== 'number') {
      return next(e)
    }
    const shownLeft = leftIn(s, s.bandColumns, s.petColumns)

    // A held move with no press before it starts the grab too: a terminal can
    // fold the press into the first move of a quick drag.
    if (message.phase === 'down' || (message.phase === 'move' && !s.grab)) {
      s.grab = { offset: message.column - shownLeft, downColumn: message.column, isMoved: false, regionLeft: shownLeft }
      await noteActivity($, s)
    }
    if (message.phase !== 'down' && s.grab) {
      const { grab } = s
      // Within a cell the pointer moves too; only a new column is worth a
      // redraw.
      let isChanged = false
      // It takes a column of travel to turn a press into a drag.
      if (!grab.isMoved && s.isOn('drag') && Math.abs(message.column - grab.downColumn) >= 1) {
        grab.isMoved = true
        pet.isHeld = true
        isChanged = true
      }
      if (grab.isMoved) {
        const left = clamp(Math.round(message.column - grab.offset), 0, s.bandColumns - s.petColumns)
        isChanged ||= left !== s.left
        s.left = left
      }
      if (message.phase === 'up') {
        isChanged = true
        if (grab.isMoved) {
          pet.isHeld = false
          pet.play('drop')
          await $.store.set('left', s.left).catch(() => undefined)
        } else if (s.isOn('pats')) {
          pet.play('pat')
        }
        s.grab = null
      }
      if (isChanged) {
        $.ui.invalidate('ui.render')
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    // Collapsed: one line of the figures, Ranko not drawn, on either surface.
    if ((e.surface === 'desktop' || e.surface === 'terminal') && s.isCollapsed && s.isOn('stats')) {
      await start($, s)
      if (!s.isShown || e.props.hasSurvey) {
        return below
      }
      s.isOnDesktop = false
      s.requestId = null
      const { Box, Button, Client, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {below}
          {statsLine(
            { Box, Text, Button, Client, isDesktop: e.surface === 'desktop' },
            s,
            await $.clock.now(),
            e.props.bodyColumns,
            () => void compactNow($, s),
            () => void collapse($, s, false),
          )}
        </Box>
      )
    }

    // The desktop app: laid out in its own cells as the terminal lays out
    // its Images, each frame an SVG; the grab region is a strip along the
    // whole band, so it can show where a dragged Ranko will land.
    if (e.surface === 'desktop') {
      await start($, s)
      const { manifest, pet } = s
      const size = manifest && desktopSize(manifest)
      if (!s.isShown || e.props.hasSurvey) {
        s.isOnDesktop = false
        return below
      }
      // Where he can't be drawn, the stats still are, without him.
      const withoutRanko = async () => {
        s.isOnDesktop = false
        const { Box, Button, Client, Text } = $.ui.resolve(e)
        const band = statsBand(
          { Box, Text, Button, Client, isDesktop: true },
          s,
          await $.clock.now(),
          e.props.bodyColumns,
          () => void compactNow($, s),
          () => void collapse($, s, true),
        )
        return band ? (
          <Box flexDirection="column">
            {below}
            {band}
          </Box>
        ) : (
          below
        )
      }
      s.isOnDesktop = pet !== null && size !== null && e.props.bodyColumns >= size.columns
      if (!s.isOnDesktop || !manifest || !pet || !size) {
        return withoutRanko()
      }
      pet.sync(await $.clock.now())

      const hasFold = s.isOn('stats')
      s.bandColumns = e.props.bodyColumns - (hasFold ? FOLD_COLUMNS : 0)
      s.petColumns = size.columns
      const petLeft = leftIn(s, s.bandColumns, size.columns)
      const mini = desktopSize(manifest, 0.5)
      const places = miniPlaces(s, pet, petLeft, size.columns, mini.columns)
      const working = pet.framesOf('working')
      const [main, ...minis] = await Promise.all([
        desktopFrame($, s, desktopFileOf(s, pet.clip, pet.fileFrame())),
        ...places.map(({ mini: m }) =>
          desktopFrame($, s, desktopFileOf(s, 'working', m.frame % working), 1 - (m.leaving ?? 0) / LEAVE_FRAMES),
        ),
      ])
      if (!main) {
        return withoutRanko()
      }

      const { Box, Button, Client, Svg, Text } = $.ui.resolve(e)
      const isGrabbable = s.isOn('drag') || s.isOn('pats')
      const grabProps: GrabProps = {
        left: 0,
        columns: s.bandColumns,
        rows: size.rows,
        pet: { left: petLeft, columns: size.columns, isDraggable: s.isOn('drag') },
      }
      const taken = takenColumns(pet, petLeft, size.columns, places, mini.columns)
      const place = s.isOn('stats') ? statsPlace(s.bandColumns, taken.from, taken.to) : null
      return (
        <Box flexDirection="column">
          {below}
          <Box width={e.props.bodyColumns} height={size.rows}>
            {places.map(({ mini: m, x }, i) => {
              const source = minis[i]
              return source ? (
                <Box key={`mini-${m.id}`} position="absolute" left={x} top={size.rows - mini.rows}>
                  <Svg source={source} alt="A mini Ranko at work" width={mini.width} height={mini.height} />
                </Box>
              ) : null
            })}
            {pet.extraMinis > 0 ? (
              <Box key="extra-minis" position="absolute" left={Math.max(0, petLeft - 4)} top={0}>
                <Text dimColor>+{pet.extraMinis}</Text>
              </Box>
            ) : null}
            <Box key={KEY} position="absolute" left={petLeft} top={0}>
              <Svg source={main} alt="Ranko" width={size.width} height={size.height} />
            </Box>
            {isGrabbable ? (
              <Box position="absolute" left={0} top={0}>
                <Client key="grab" module="./grab.tsx" props={grabProps} />
              </Box>
            ) : null}
            {/* Over the grab strip, so the Compact button gets its presses. */}
            {place ? (
              <Box key="stats" position="absolute" left={place.left} top={0}>
                {stats(
                  { Box, Text, Button, Client, isDesktop: true },
                  s,
                  await $.clock.now(),
                  place.width,
                  size.rows,
                  () => void compactNow($, s),
                )}
              </Box>
            ) : null}
            {hasFold ? (
              <Box key="fold" position="absolute" left={s.bandColumns + 1} top={0}>
                {foldButton({ Box, Text, Button, Client, isDesktop: true }, false, () => void collapse($, s, true))}
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    if (e.surface !== 'terminal') {
      return below
    }
    await start($, s)

    const { manifest, pet } = s
    if (!s.isShown || e.props.hasSurvey) {
      return below
    }
    const isDrawable =
      !s.isUnsupported && manifest !== null && e.props.maxRows >= MIN_ROWS && e.props.bodyColumns >= manifest.columns + 20
    if (!isDrawable || !manifest || !pet) {
      // Where he can't be drawn, the stats still are, without him; nothing
      // is blitted meanwhile.
      s.requestId = null
      const { Box, Button, Client, Text } = await $.ui.resolve(e)
      const band = statsBand(
        { Box, Text, Button, Client, isDesktop: false },
        s,
        await $.clock.now(),
        e.props.bodyColumns,
        () => void compactNow($, s),
        () => void collapse($, s, true),
      )
      return band ? (
        <Box flexDirection="column">
          {below}
          {band}
        </Box>
      ) : (
        below
      )
    }

    s.requestId = e.requestId
    const hasFold = s.isOn('stats')
    s.bandColumns = e.props.bodyColumns - (hasFold ? FOLD_COLUMNS : 0)
    pet.sync(await $.clock.now())

    const { Box, Button, Image, Client, Text } = await $.ui.resolve(e)
    // A short band (agents listed under the prompt take its rows) gets a
    // smaller Ranko, same shape, rather than none.
    const rows = Math.min(manifest.rows, e.props.maxRows)
    const columns = Math.round((manifest.columns * rows) / manifest.rows)
    s.petColumns = columns
    s.sizeSuffix = rows === manifest.rows ? '' : `-${rows}`
    const petLeft = leftIn(s, s.bandColumns, columns)

    // Mini Rankos are half the pet's height, never under two rows, in the
    // frames' proportions.
    const miniRows = Math.max(2, Math.floor(rows / 2))
    const miniColumns = Math.round((manifest.columns * miniRows) / manifest.rows)
    const working = pet.framesOf('working')
    const places = miniPlaces(s, pet, petLeft, columns, miniColumns)
    const minis: RenderElement[] = places.map(({ mini, x }) => (
      <Box key={`mini-slot-${mini.id}`} position="absolute" left={x} top={rows - miniRows}>
        <Image
          key={`mini-${mini.id}${s.sizeSuffix}`}
          source={{ file: fileOf(s, 'working', mini.frame % working), format: 'png' }}
          columns={miniColumns}
          rows={miniRows}
          alt=" "
        />
      </Box>
    ))

    const isGrabbable = s.isOn('drag') || s.isOn('pats')
    const grabLeft = s.grab?.regionLeft ?? petLeft
    const grabProps: GrabProps = { left: grabLeft, columns, rows }
    const taken = takenColumns(pet, petLeft, columns, places, miniColumns)
    const place = s.isOn('stats') ? statsPlace(s.bandColumns, taken.from, taken.to) : null

    // The pet has its own strip; inside it the picture and, on top, the
    // invisible grab region sit at the same column.
    return (
      <Box flexDirection="column">
        {below}
        <Box width={e.props.bodyColumns} height={rows}>
          {minis}
          {pet.extraMinis > 0 ? (
            <Box key="extra-minis" position="absolute" left={Math.max(0, petLeft - 4)} top={0}>
              <Text dimColor>+{pet.extraMinis}</Text>
            </Box>
          ) : null}
          <Box key="pet" position="absolute" left={petLeft} top={0}>
            <Image
              key={KEY + s.sizeSuffix}
              source={{ file: fileOf(s, pet.clip, pet.fileFrame()), format: 'png' }}
              columns={columns}
              rows={rows}
              alt=" "
            />
          </Box>
          {isGrabbable ? (
            <Box position="absolute" left={grabLeft} top={0}>
              <Client key="grab" module="./grab.tsx" props={grabProps} />
            </Box>
          ) : null}
          {place ? (
            <Box key="stats" position="absolute" left={place.left} top={0}>
              {stats(
                { Box, Text, Button, Client, isDesktop: false },
                s,
                await $.clock.now(),
                place.width,
                rows,
                () => void compactNow($, s),
              )}
            </Box>
          ) : null}
          {hasFold ? (
            <Box key="fold" position="absolute" left={s.bandColumns + 1} top={0}>
              {foldButton({ Box, Text, Button, Client, isDesktop: false }, false, () => void collapse($, s, true))}
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
