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
import { FEATURES, LEAVE_FRAMES, PROP_FOR_TOOL, Pet, isManifest, moodOf, sizeFor } from './pet'
import type { Feature, Manifest, Mini } from './pet'
import {
  COMPACT_AT,
  COMPACT_FROM,
  bar,
  cacheColor,
  cacheOf,
  cacheTtl,
  contextOf,
  fillColor,
  limitsOf,
  logChunks,
  planLimits,
  summaryOf,
  tokens,
} from './stats'
import type { CacheReading } from './stats'

/**
 * Ranko above the prompt: frames baked by blender/bake.py, played
 * by swapping one Image's source on a timer, the clip picked by what the
 * main conversation is doing (pet.ts).
 *
 * The terminal draws pixels through the Image. The desktop app has no
 * Image: there each frame is a PNG inside an SVG, and the band is drawn again
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
 * carries on with, in log lines the model doesn't read.
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
  // The frames the desktop drew lately, base64 by file, the oldest first.
  frames: Map<string, string>
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
  plan: { limits: SessionRateLimit[]; at: number } | null
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
}

type StatsElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const KEY = 'ranko'
// A turn shorter than this ends without a celebration: quick answers would
// otherwise make it jump after every message.
const HAPPY_AFTER_MS = 4000
const KIND_WORDS =
  /\b(thanks|thank you|thx|good job|great job|nice work|well done|love it|love you|awesome|you rock)\b/i

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
// How many frames the desktop keeps read: a few clips' worth.
const FRAME_CACHE = 256
// The most an Svg's source may hold.
const SVG_LIMIT = 131072
// The stats beside Ranko take at least this many columns and at most this
// many, kept this far from him.
const STATS_MIN_COLUMNS = 34
const STATS_MAX_COLUMNS = 60
const STATS_GAP = 2
const STATS_LABEL_COLUMNS = 8
// How often the stats read the session again, and ask the usage endpoint for
// the plan's limits, which other sessions use up too.
const STATS_EVERY_MS = 10_000
const PLAN_EVERY_MS = 60_000
const PLAN_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, Math.round(value)))

const fileOf = (s: Ranko, clip: string, frame: number) =>
  `${s.root}/assets/frames/${clip}/${String(frame).padStart(3, '0')}.png`

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
    const oldest = s.frames.keys().next().value
    if (s.frames.size > FRAME_CACHE && oldest !== undefined) {
      s.frames.delete(oldest)
    }
    return base64
  } catch {
    return null
  }
}

/**
 * A frame as the desktop draws it: the PNG inside an SVG that the Svg element
 * scales to the size it is given, faded by `opacity` (a mini walking off).
 * Null when the file can't be read or the SVG would be over the limit.
 */
async function desktopFrame($: EngineInterface, s: Ranko, file: string, opacity = 1) {
  const base64 = await frameBytes($, s, file)
  if (base64 === null || !s.manifest) {
    return null
  }
  const { width, height } = desktopSize(s.manifest)
  const fade = opacity < 1 ? ` opacity="${opacity.toFixed(2)}"` : ''
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<image width="${width}" height="${height}"${fade} href="data:image/png;base64,${base64}"/></svg>`
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
  s.usage = await $.session.usage().catch(() => s.usage)
}

/**
 * Asks Anthropic's usage endpoint, as /usage does, for the plan's limits
 * with the session's own login; an API key or another provider has none.
 */
async function readPlan($: EngineInterface, s: Ranko) {
  try {
    const auth = await $.session.authorize()
    s.isPlan = auth?.kind === 'bearer'
    if (!auth || !s.isPlan) {
      return
    }
    const response = await $.http.fetch(PLAN_USAGE_URL, {
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      auth: auth.handle,
    })
    const limits = response.ok ? planLimits(response.text) : null
    if (limits) {
      s.plan = { limits, at: await $.clock.now() }
    }
  } catch {
    // Offline, or the traffic is off: the session's own reading stands.
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
 * context, the cache and the limits, a dim label, a bar and the reading. The
 * context's row ends in the Compact button once there is something to
 * compact, and it stands out once the context is nearly full.
 */
function stats(el: StatsElements, s: Ranko, nowMs: number, width: number, rows: number, onCompact: () => void) {
  const { Box, Text, Button } = el
  const context = contextOf(s.usage)
  const cache = cacheOf(s.cache, cacheTtl(s.isPlan), nowMs)
  const limits = limitsOf(limitsNow(s), nowMs)
  const isCompactable = s.isCompacting || (context?.percent ?? 0) >= COMPACT_FROM
  // A dim label, a bar in the reading's color (or dim, empty, with none), the
  // reading, and what else the row holds.
  const row = (key: string, label: string, percent: number, barColor: string | null, text: string, end?: RenderElement) => (
    <Box key={key} flexDirection="row">
      <Box width={STATS_LABEL_COLUMNS}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {barColor ? <Text color={barColor}>{bar(percent)}</Text> : <Text dimColor>{bar(0)}</Text>}
        <Text wrap="truncate">{text}</Text>
        {end}
      </Box>
    </Box>
  )
  const compact = isCompactable ? (
    <Button
      key="compact"
      label={s.isCompacting ? 'Compacting…' : 'Compact'}
      variant={(context?.percent ?? 0) >= COMPACT_AT ? 'primary' : 'secondary'}
      onPress={onCompact}
    />
  ) : undefined
  return (
    <Box flexDirection="column" width={width} height={rows} overflow="hidden">
      {context
        ? row('context', 'Context', context.percent, fillColor(context.percent), context.text, compact)
        : row('context', 'Context', 0, null, 'no reading yet', compact)}
      {row('cache', 'Cache', cache.percent, cache.percent > 0 ? cacheColor(cache.percent) : null, cache.text)}
      {limits ? row('limits', 'Limits', limits.percent, fillColor(limits.percent), limits.text) : null}
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

    const saved = await $.store.get('left').catch(() => undefined)
    s.left = typeof saved === 'number' ? saved : null

    await $.command
      .register({
        name: 'ranko',
        description: 'Show or hide Ranko, play one of his reactions, or turn a switch on or off',
        argumentHint: '[happy | oops | pat | blush | sleepy | … | list | on <switch> | off <switch>]',
      })
      .catch(() => undefined)

    $.clock.every(Math.round(1000 / manifest.fps), () => {
      void tick(s).catch(() => undefined)
    })
    $.clock.every(STATS_EVERY_MS, () => {
      if (s.isOn('stats') && s.isShown) {
        void readUsage($, s).then(() => host.invalidate())
      }
    })
    $.clock.every(PLAN_EVERY_MS, () => {
      if (s.isOn('stats') && s.isShown) {
        void readPlan($, s).then(() => host.invalidate())
      }
    })
    if (s.isOn('stats')) {
      await readUsage($, s)
      void readPlan($, s).then(() => host.invalidate())
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
  pet.sync(await host.now())

  if (isOnTerminal) {
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
  if (pet.advance() || s.isOnDesktop) {
    host.invalidate()
  }
}

async function noteActivity($: EngineInterface, s: Ranko) {
  if (s.pet) {
    s.pet.lastActivityMs = await $.clock.now()
  }
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

  on('turn.start', async ($, e, next) => {
    // The start doesn't say whose turn it is; any turn means work is under way.
    s.pet?.runningTurns.add(e.turnId)
    await noteActivity($, s)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
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
    if (s.isOn('stuffing')) {
      try {
        const { context } = await $.session.usage()
        pet.size = sizeFor(context.percent ?? 0)
      } catch {
        // No reading this time; the size stays as it was.
      }
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const { pet } = s
    // A subagent's tool calls are its own business: no prop, no wobble.
    if (e.agentId || !pet) {
      return next(e)
    }
    const prop = PROP_FOR_TOOL[e.tool]
    if (prop) {
      pet.toolStarted(e.tool_use_id, prop, await $.clock.now())
    }
    try {
      const result = await next(e)
      if (result.deny !== undefined || result.isError) {
        pet.play('oops')
      }
      return result
    } finally {
      pet.toolEnded(e.tool_use_id)
    }
  })

  on('prompt.submit', async ($, e, next) => {
    await noteActivity($, s)
    if (s.pet && s.isOn('blush') && KIND_WORDS.test(e.text)) {
      s.pet.play('blush')
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (s.pet && s.isOn('miniRankos') && result.agentId) {
      s.pet.spawnMini(result.agentId)
      s.host?.sound('mini')
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // Every response, a subagent's too, brings fresh limits; one of the main
  // conversation also keeps the prompt cache warm for another stretch.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
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
      void readUsage($, s).then(() => $.ui.invalidate('ui.render'))
    }
    return result
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

    // The desktop app: laid out in its own cells as the terminal lays out
    // its Images, each frame an SVG; the grab region is a strip along the
    // whole band, so it can show where a dragged Ranko will land.
    if (e.surface === 'desktop') {
      await start($, s)
      const { manifest, pet } = s
      const size = manifest && desktopSize(manifest)
      s.isOnDesktop =
        s.isShown && !e.props.hasSurvey && pet !== null && size !== null && e.props.bodyColumns >= size.columns
      if (!s.isOnDesktop || !manifest || !pet || !size) {
        return below
      }
      pet.sync(await $.clock.now())

      s.bandColumns = e.props.bodyColumns
      s.petColumns = size.columns
      const petLeft = leftIn(s, s.bandColumns, size.columns)
      const mini = desktopSize(manifest, 0.5)
      const places = miniPlaces(s, pet, petLeft, size.columns, mini.columns)
      const working = pet.framesOf('working')
      const [main, ...minis] = await Promise.all([
        desktopFrame($, s, fileOf(s, pet.clip, pet.fileFrame())),
        ...places.map(({ mini: m }) =>
          desktopFrame($, s, fileOf(s, 'working', m.frame % working), 1 - (m.leaving ?? 0) / LEAVE_FRAMES),
        ),
      ])
      if (!main) {
        return below
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
          <Box width={s.bandColumns} height={size.rows}>
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
                {stats({ Box, Text, Button }, s, await $.clock.now(), place.width, size.rows, () => {
                  void compactNow($, s)
                })}
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
    const isDrawable =
      s.isShown &&
      !s.isUnsupported &&
      !e.props.hasSurvey &&
      manifest !== null &&
      e.props.maxRows >= MIN_ROWS &&
      e.props.bodyColumns >= manifest.columns + 20
    if (!isDrawable || !manifest || !pet) {
      return below
    }

    s.requestId = e.requestId
    s.bandColumns = e.props.bodyColumns
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
        <Box width={s.bandColumns} height={rows}>
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
              {stats({ Box, Text, Button }, s, await $.clock.now(), place.width, rows, () => {
                void compactNow($, s)
              })}
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
