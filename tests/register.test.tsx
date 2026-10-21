import type { On, RenderElement, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

import { commandSuggestions, propFor } from '../hooks/pet'

tier('user')

// The clips a full bake produces (blender/clips.py lists those baked so far),
// all but hello, which has a test of its own.
const CLIPS: Record<string, [number, boolean]> = {
  idle: [48, true],
  'idle-plump': [48, true],
  'idle-stuffed': [48, true],
  working: [24, true],
  'working-magnifier': [24, true],
  'working-notepad': [24, true],
  'working-binoculars': [24, true],
  'working-thinking': [48, true],
  'working-plump': [24, true],
  'working-stuffed': [24, true],
  happy: [32, false],
  sleepy: [64, true],
  oops: [36, false],
  held: [24, true],
  drop: [16, false],
  deflate: [24, false],
  blush: [32, false],
  pat: [28, false],
  'fidget-wonder': [40, false],
  'fidget-psst': [40, false],
  'fidget-thumbs': [32, false],
  'fidget-look': [36, false],
}

const MANIFEST = JSON.stringify({
  fps: 24,
  columns: 12,
  rows: 6,
  clips: Object.fromEntries(Object.entries(CLIPS).map(([name, [frames, loop]]) => [name, { frames, loop }])),
})

const BAND = {
  plugin: 'ranko',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const START = { surface: 'terminal', isInteractive: true, cwd: '/work' } as const
const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const

/**
 * What the session beneath the plugin answers: a clock, the manifest,
 * commands, blits, turns, the context's fill, and an empty band, which is
 * what the engine draws there.
 */
function answerTheWorld(
  on: On,
  contextPercent = 10,
  manifest = MANIFEST,
  rateLimits: SessionRateLimit[] = [],
  autoCompactThreshold?: number,
  // What the plugin's store holds, read and written by it.
  stored: Record<string, unknown> = {},
  // Told of every blit, by the key of the Image it swaps; what it returns is
  // the blit's deny.
  onBlit: (key: string) => string | void = () => {},
) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // A frame's bytes are its path, so a test can tell which frame the
  // desktop drew.
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? { base64: btoa(e.path) } : manifest }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', ($, e) => ({ value: stored[e.key] }))
  on('store.set', ($, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('ui.blit', ($, e) => {
    const deny = onBlit('key' in e ? e.key : '')
    return { value: deny === undefined ? {} : { deny } }
  })
  on('ui.render', () => h(Fragment, null) as RenderElement)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', ($, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200000,
        percent: contextPercent,
        tokens: contextPercent * 2000,
        // The breakdown, where it was asked for, carries where auto-compaction runs.
        ...(e.breakdown && autoCompactThreshold !== undefined
          ? { breakdown: { isAutoCompactEnabled: true, autoCompactThreshold } as never }
          : {}),
      },
      rateLimits,
    },
  }))
  return clock
}

type Band = Mounted<'terminal', 'AbovePrompt'>
type DesktopBand = Mounted<'desktop', 'AbovePrompt'>

/** The clip the pet shows: the folder of the frame its Image draws. */
async function shownClip(band: Band) {
  await band.redraw()
  const pet = await band.find({ key: 'ranko' })
  return (pet?.props.source as { file: string } | undefined)?.file.match(/frames\/([\w-]+)\//)?.[1]
}

type AnyBand = Band | DesktopBand

/**
 * Whether the band's button keyed `key` stands out: a Button's variant in the
 * terminal, the desktop's press Client's `isPrimary`; undefined with none.
 */
async function isPrimary(band: AnyBand, key: string) {
  const found = await band.find({ key })
  if (!found) {
    return undefined
  }
  return found.type === 'Client'
    ? (found.props.props as { isPrimary: boolean }).isPrimary
    : found.props.variant === 'primary'
}

/** Presses the band's button keyed `key`: a click on the desktop's Client, a press of the terminal's Button. */
async function pressButton(band: AnyBand, key: string) {
  if ((await band.find({ key }))?.type === 'Client') {
    await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: key })
    await band.pointer({ type: 'up', x: 1, y: 0, button: 'left', in: key })
  } else {
    await band.press({ key })
  }
}

/** The props of the Svg the desktop draws in the Box keyed `key`. */
async function svgIn(band: DesktopBand, key: string) {
  const box = await band.find({ key })
  const svg = box?.children.find(child => (child as { type?: string }).type === 'Svg')
  return (svg as { props: { source: string; width?: number; height?: number } } | undefined)?.props
}

/** The frame the desktop draws in an element: the file inside its SVG. */
async function desktopFile(band: DesktopBand, key = 'ranko') {
  await band.redraw()
  const base64 = (await svgIn(band, key))?.source.match(/base64,([^"]+)"/)?.[1]
  return base64 === undefined ? undefined : atob(base64)
}

const complete = (
  $: { turn: { complete: (e: never) => Promise<unknown> } },
  turnId: string,
  durationMs: number,
  reason: 'answer' | 'aborted' = 'answer',
  agentId?: string,
) =>
  $.turn.complete({ answer: '', durationMs, isAborted: reason === 'aborted', turnId, reason, agentId } as never)

describe('register', () => {
  test('the terminal band draws the pet as an Image, the desktop band as an SVG', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const pet = await terminal.find({ key: 'ranko' })
    expect(pet?.type).toBe('Image')
    expect(pet?.props.columns).toBe(12)
    expect(String((pet?.props.source as { file: string }).file)).toMatch(/frames\/idle\/000\.png$/)
    await terminal.unmount()

    // 12x6 cells of 8x16 px.
    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const svg = await svgIn(desktop, 'ranko')
    expect(svg?.width).toBe(96)
    expect(svg?.height).toBe(96)
    expect(svg?.source).toContain('href="data:image/png;base64,')
    expect(await desktopFile(desktop)).toMatch(/frames\/idle\/000\.png$/)
    await desktop.unmount()
  })

  test('frames baked with WebPs are drawn from those on the desktop; the terminal keeps the PNGs', async ($, on) => {
    answerTheWorld(on, 10, JSON.stringify({ ...JSON.parse(MANIFEST), webp: true }))
    await $.session.start(START)

    const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await svgIn(desktop, 'ranko'))?.source).toContain('href="data:image/webp;base64,')
    expect(await desktopFile(desktop)).toMatch(/frames\/idle\/000\.webp$/)
    await desktop.unmount()

    const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const pet = await terminal.find({ key: 'ranko' })
    expect(String((pet?.props.source as { file: string }).file)).toMatch(/frames\/idle\/000\.png$/)
    await terminal.unmount()
  })

  test('on the desktop the frames move with the clock and the clip follows the turn', async ($, on) => {
    const clock = answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect(await desktopFile(band)).toMatch(/idle\/000\.png$/)
    // Half a second at 24 frames a second.
    await clock.advance(500)
    expect(await desktopFile(band)).toMatch(/idle\/01[12]\.png$/)

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await desktopFile(band)).toMatch(/working\/000\.png$/)
    await band.unmount()
  })

  test('on the desktop a survey or /ranko keeps the pet out of the way', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)

    const survey = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
    expect(await survey.find({ type: 'Svg' })).toBeUndefined()
    await survey.unmount()

    await $.command.run({ ...COMMAND, command: 'ranko', args: '' })
    const hidden = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await hidden.find({ type: 'Svg' })).toBeUndefined()
    await hidden.unmount()
  })

  test('he waves hello when a session starts, then idles', async ($, on) => {
    const withHello = JSON.stringify({
      ...JSON.parse(MANIFEST),
      clips: { ...JSON.parse(MANIFEST).clips, hello: { frames: 56, loop: false } },
    })
    const clock = answerTheWorld(on, 10, withHello)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await shownClip(band)).toBe('hello')
    await clock.advance(3000)
    expect(await shownClip(band)).toBe('idle')
    await band.unmount()
  })

  // Walking the clock through two idle minutes can outrun the usual 5 s on
  // a busy machine.
  test('he sits down to work and stands up when the turn is done', { timeoutMs: 20000 }, async ($, on) => {
    const base = JSON.parse(MANIFEST)
    const seated = JSON.stringify({
      ...base,
      clips: {
        ...base.clips,
        working: { frames: 24, loop: true, posture: 'sit' },
        sleepy: { frames: 64, loop: true, posture: 'cushion' },
        'sit-down': { frames: 16, loop: false, posture: 'sit', transition: ['stand', 'sit'] },
        'stand-up': { frames: 16, loop: false, transition: ['sit', 'stand'] },
        'doze-off': { frames: 30, loop: false, posture: 'cushion', transition: ['stand', 'cushion'] },
        'wake-up': { frames: 24, loop: false, transition: ['cushion', 'stand'] },
      },
    })
    const clock = answerTheWorld(on, 10, seated)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await shownClip(band)).toBe('sit-down')
    await clock.advance(800)
    expect(await shownClip(band)).toBe('working')

    // A quick answer: no jump, just back onto his feet.
    await complete($, 't1', 1000)
    expect(await shownClip(band)).toBe('stand-up')
    await clock.advance(800)
    expect(await shownClip(band)).toBe('idle')

    // Left alone two minutes he dozes off on his cushion; a turn wakes him,
    // and he sits down to it.
    await clock.advance(2 * 60 * 1000 + 100)
    expect(await shownClip(band)).toBe('doze-off')
    await clock.advance(1500)
    expect(await shownClip(band)).toBe('sleepy')
    await $.turn.start({ text: 'wake up', turnId: 't2' })
    expect(await shownClip(band)).toBe('wake-up')
    await clock.advance(1100)
    expect(await shownClip(band)).toBe('sit-down')
    await clock.advance(800)
    expect(await shownClip(band)).toBe('working')
    await band.unmount()
  })

  test('a terminal that draws no pictures shows the stats without Ranko, folded or not', async ($, on) => {
    const clock = answerTheWorld(on, 42, MANIFEST, [], undefined, {}, () => 'the terminal draws the alt text')
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    // The first blit learns that the terminal draws the Image's alt.
    await clock.advance(100)
    await band.redraw()
    expect(await band.find({ key: 'ranko' })).toBeUndefined()
    expect(await band.find({ type: 'Text', text: '42% · 84k / 200k' })).toBeDefined()
    expect(await band.find({ key: 'compact' })).toBeDefined()

    await pressButton(band, 'collapse')
    expect(await band.find({ key: 'stats-line' })).toBeDefined()
    await pressButton(band, 'expand')
    expect(await band.find({ key: 'stats-band' })).toBeDefined()
    await band.unmount()
  })

  test('a band too short for Ranko still shows the stats', async ($, on) => {
    answerTheWorld(on, 42)
    await $.session.start(START)
    const short = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 3 } })
    expect(await short.find({ type: 'Image' })).toBeUndefined()
    expect(await short.find({ key: 'stats-band' })).toBeDefined()
    expect(await short.find({ type: 'Text', text: '42% · 84k / 200k' })).toBeDefined()
    await short.unmount()
  })

  test('a narrow band or a survey keeps the pet out of the way', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)

    const narrow = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 30 } })
    expect(await narrow.find({ key: 'ranko' })).toBeUndefined()
    await narrow.unmount()

    const survey = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await survey.find({ key: 'ranko' })).toBeUndefined()
    await survey.unmount()
  })

  test('/ranko hides the pet and brings it back', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const run = () => $.command.run({ ...COMMAND, command: 'ranko', args: '' })

    expect((await run()).text).toContain('out of sight')
    const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await hidden.find({ key: 'ranko' })).toBeUndefined()
    await hidden.unmount()

    expect((await run()).text).toContain('back')
    const shown = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shown.find({ key: 'ranko' })).toBeDefined()
    await shown.unmount()
  })

  test('turns and tool calls pick the clip', async ($, on) => {
    const clock = answerTheWorld(on)
    on('tool.call', () => ({ isError: true as const, result: 'boom', text: 'boom' }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    expect(await shownClip(band)).toBe('idle')

    await $.turn.start({ text: 'hi', turnId: 't1' })
    expect(await shownClip(band)).toBe('working')

    await $.tool.call({ tool: 'Bash', command: 'false' })
    expect(await shownClip(band)).toBe('oops')
    // The wobble plays out, then the turn's work shows again.
    await clock.advance(2000)
    expect(await shownClip(band)).toBe('working')

    await complete($, 't1', 9000)
    expect(await shownClip(band)).toBe('happy')
    await clock.advance(2000)
    expect(await shownClip(band)).toBe('idle')

    await $.turn.start({ text: 'stop', turnId: 't2' })
    await complete($, 't2', 2000, 'aborted')
    expect(await shownClip(band)).toBe('oops')

    await band.unmount()
  })

  test('/ranko <clip> plays it', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    const { text } = await $.command.run({ ...COMMAND, command: 'ranko', args: 'working-binoculars' })
    expect(text).toBe('Ranko plays working-binoculars')
    expect(await shownClip(band)).toBe('working-binoculars')

    expect((await $.command.run({ ...COMMAND, command: 'ranko', args: 'nope' })).text).toContain('no "nope" reaction')
    await band.unmount()
  })

  test('dragging moves the pet along the band and drops it there', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const petLeft = async () => (await band.find({ key: 'pet' }))?.props.left

    // 100 columns wide, less the 6 the fold button takes, a 12-column pet:
    // it starts at the right end.
    expect(await petLeft()).toBe(82)

    // Take hold 4 columns into the pet and carry it 30 columns left. The
    // grab region stays where the press was until the release, so the
    // pointer's columns are counted from there throughout.
    await band.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: -26, y: 2, button: 'left', in: 'grab' })
    expect(await shownClip(band)).toBe('held')
    expect(await petLeft()).toBe(52)
    expect(((await band.find({ key: 'grab' }))?.props.props as { left: number } | undefined)?.left).toBe(82)
    await band.pointer({ type: 'up', x: -26, y: 2, button: 'left', in: 'grab' })
    expect(await petLeft()).toBe(52)
    expect(await shownClip(band)).toBe('drop')

    // A drag past the edge stops at the band's left end.
    await band.pointer({ type: 'down', x: 1, y: 0, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: -500, y: 0, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: -500, y: 0, button: 'left', in: 'grab' })
    expect(await petLeft()).toBe(0)

    await band.unmount()
  })

  test('a press without a drag is a pat', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await band.pointer({ type: 'down', x: 8, y: 3, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: 8, y: 3, button: 'left', in: 'grab' })
    expect(await shownClip(band)).toBe('pat')
    expect((await band.find({ key: 'pet' }))?.props.left).toBe(82)
    await band.unmount()
  })

  test('pats off: a press does nothing', { options: { pats: false } }, async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await band.pointer({ type: 'down', x: 8, y: 3, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: 8, y: 3, button: 'left', in: 'grab' })
    expect(await shownClip(band)).toBe('idle')
    await band.unmount()
  })

  test('drag and pats both off: no grab region at all', { options: { drag: false, pats: false } }, async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ key: 'grab' })).toBeUndefined()
      await band.unmount()
    }
  })

  test('on the desktop a drag shows where he will land and puts him there on release', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const petLeft = async () => (await band.find({ key: 'ranko' }))?.props.left

    // The grab region is a strip along the band. 100 columns wide, less the 6
    // the fold button takes, a 10-column pet: he starts at the right end.
    expect(await petLeft()).toBe(84)

    // Take hold 3 columns into him and carry him 30 columns left. The
    // desktop shows nothing new in the band while the button is down, so the
    // strip draws a frame where he will land.
    await band.pointer({ type: 'down', x: 93, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: 63, y: 2, button: 'left', in: 'grab' })
    expect((await band.find({ key: 'landing', in: 'grab' }))?.props.left).toBe(54)
    await band.pointer({ type: 'up', x: 63, y: 2, button: 'left', in: 'grab' })
    expect(await band.find({ key: 'landing', in: 'grab' })).toBeUndefined()
    expect(await petLeft()).toBe(54)
    expect(await desktopFile(band)).toMatch(/drop\/\d{3}\.png$/)
    await band.unmount()
  })

  test('on the desktop a click on him is a pat, a click beside him nothing', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await band.pointer({ type: 'down', x: 20, y: 1, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: 40, y: 1, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: 40, y: 1, button: 'left', in: 'grab' })
    expect(await desktopFile(band)).toMatch(/idle\/\d{3}\.png$/)
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(84)

    await band.pointer({ type: 'down', x: 89, y: 1, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: 89, y: 1, button: 'left', in: 'grab' })
    expect(await desktopFile(band)).toMatch(/pat\/\d{3}\.png$/)
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(84)
    await band.unmount()
  })

  test('on the desktop with drag off, a held press shows no landing frame', { options: { drag: false } }, async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await band.pointer({ type: 'down', x: 93, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: 63, y: 2, button: 'left', in: 'grab' })
    expect(await band.find({ key: 'landing', in: 'grab' })).toBeUndefined()
    await band.pointer({ type: 'up', x: 63, y: 2, button: 'left', in: 'grab' })
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(84)
    await band.unmount()
  })

  for (const isOn of [true, false]) {
    test(`a tool call shows its prop, a quick one for a moment at least (toolProps ${isOn ? 'on' : 'off'})`, { options: { toolProps: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      let finish = () => {}
      on('tool.call', ($, e) =>
        e.tool === 'WebFetch'
          ? new Promise(resolve => {
              finish = () => resolve({ result: 'ok', text: 'ok' })
            })
          : { result: 'ok', text: 'ok' },
      )
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await $.turn.start({ text: 'look', turnId: 't1' })

      // A read is over at once, but the magnifier stays up a moment.
      await $.tool.call({ tool: 'Read', file_path: '/work/notes.md' })
      expect(await shownClip(band)).toBe(isOn ? 'working-magnifier' : 'working')
      await clock.advance(1600)
      expect(await shownClip(band)).toBe('working')

      // A slow fetch holds the binoculars for as long as it runs.
      const call = $.tool.call({ tool: 'WebFetch', url: 'https://example.com', prompt: 'read it' } as never)
      await clock.settle()
      await clock.advance(5000)
      expect(await shownClip(band)).toBe(isOn ? 'working-binoculars' : 'working')
      finish()
      await call
      await clock.advance(100)
      expect(await shownClip(band)).toBe('working')
      await band.unmount()
    })
  }

  for (const isOn of [true, false]) {
    test(`while Claude thinks he puts a finger to his chin (thinking ${isOn ? 'on' : 'off'})`, { options: { thinking: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      let write = () => {}
      on('turn.step', async function* ($, e) {
        yield { kind: 'thinking' as const, index: 0, text: 'Hmm, the parser first.' }
        await new Promise<void>(resolve => {
          write = resolve
        })
        yield { kind: 'text' as const, index: 1, text: 'Done.' }
        return {
          turnId: e.turnId,
          index: e.index,
          answer: 'Done.',
          toolUses: [],
          stopReason: 'end_turn' as const,
          usage: { model: 'claude', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }
      })
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await $.turn.start({ text: 'think it over', turnId: 't1' })

      const step = (async () => {
        for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude', messageCount: 1 })) {
          // The chunks pass through; what Ranko does with them counts.
        }
      })()
      await clock.settle()
      expect(await shownClip(band)).toBe(isOn ? 'working-thinking' : 'working')
      await clock.advance(5000)
      expect(await shownClip(band)).toBe(isOn ? 'working-thinking' : 'working')

      // It writes: back to typing.
      write()
      await step
      expect(await shownClip(band)).toBe('working')
      await band.unmount()
    })
  }

  for (const isOn of [true, false]) {
    test(`kind words make Ranko blush (blush ${isOn ? 'on' : 'off'})`, { options: { blush: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      on('prompt.submit', ($, e) => ({ text: e.text }))
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      const submit = (text: string) =>
        $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

      await submit('fix the parser please')
      expect(await shownClip(band)).toBe('idle')
      await submit('Thanks, that worked!')
      expect(await shownClip(band)).toBe(isOn ? 'blush' : 'idle')
      await clock.advance(2000)

      // German too, whole words only: a Dankestext is no thanks.
      await submit('Füge einen Dankestext ein')
      expect(await shownClip(band)).toBe('idle')
      await submit('Dankeschön, läuft!')
      expect(await shownClip(band)).toBe(isOn ? 'blush' : 'idle')
      await clock.advance(2000)
      await submit('Gut gemacht')
      expect(await shownClip(band)).toBe(isOn ? 'blush' : 'idle')
      await band.unmount()
    })
  }

  for (const isOn of [true, false]) {
    test(`subagents get mini Rankos that walk off (miniRankos ${isOn ? 'on' : 'off'})`, { options: { miniRankos: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

      await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look around', description: 'look', subagentType: 'Explore' } as never)
      await band.redraw()
      const mini = await band.find({ key: 'mini-a1' })
      expect(mini === undefined).toBe(!isOn)
      if (isOn) {
        expect(mini?.props.columns).toBe(6)
      }

      await complete($, 'agent-turn', 3000, 'answer', 'a1')
      await clock.advance(1500)
      await band.redraw()
      expect(await band.find({ key: 'mini-a1' })).toBeUndefined()
      await band.unmount()
    })
  }

  test('on the desktop a mini Ranko stands beside him and fades as it leaves', async ($, on) => {
    const clock = answerTheWorld(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look around', description: 'look', subagentType: 'Explore' } as never)
    expect(await desktopFile(band, 'mini-a1')).toMatch(/working\/\d{3}\.png$/)
    expect((await svgIn(band, 'mini-a1'))?.width).toBe(48)

    await complete($, 'agent-turn', 3000, 'answer', 'a1')
    await clock.advance(200)
    await band.redraw()
    expect((await svgIn(band, 'mini-a1'))?.source).toMatch(/opacity="0\.\d+"/)
    await clock.advance(1300)
    await band.redraw()
    expect(await band.find({ key: 'mini-a1' })).toBeUndefined()
    await band.unmount()
  })

  test('beside him the stats show the context, the cache and the limits, each with a bar', { timeoutMs: 20000 }, async ($, on) => {
    // What this session's last response reported, and what the usage
    // endpoint has, other sessions counted.
    const own = [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2030-01-07T17:40:00Z' },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2030-01-13T09:00:00Z' },
    ]
    const clock = answerTheWorld(on, 42, MANIFEST, own)
    on('session.authorize', () => ({ value: { handle: 'login', kind: 'bearer' as const } }))
    on('http.fetch', ($, e) => ({
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: e.url.endsWith('/api/oauth/usage')
          ? JSON.stringify({
              five_hour: { utilization: 68, resets_at: '2030-01-07T17:40:00Z' },
              seven_day: { utilization: 62, resets_at: '2030-01-13T09:00:00Z' },
            })
          : '',
      },
    }))
    on('turn.step', async function* ($, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: {
          model: 'claude',
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 9000,
          cache_creation_input_tokens: 900,
        },
      }
    })
    await $.session.start(START)
    const limitsRow = /^(5h \d+%) ↻ .+ · (7d \d+%) ↻ .+$/
    const shownLimits = async (band: { find: (q: { type: string; text: RegExp }) => Promise<{ text: string } | undefined> }) =>
      (await band.find({ type: 'Text', text: limitsRow }))?.text.match(limitsRow)?.slice(1, 3).join(' ')

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      await band.redraw()
      expect(await band.find({ type: 'Text', text: '42% · 84k / 200k' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '████░░░░░░' })).toBeDefined()
      expect(await shownLimits(band)).toBe('5h 68% 7d 62%')
      expect(await band.find({ type: 'Text', text: '███████░░░' })).toBeDefined()
      expect(await isPrimary(band, 'compact')).toBe(false)
      await band.unmount()
    }

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ type: 'Text', text: 'no request yet' })).toBeDefined()
    // A response: the cache is warm for the hour a Claude plan keeps it, and
    // the limits it reported are the freshest until the endpoint is asked again.
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude', messageCount: 1 })) {
      // Nothing streams: the step's result is what counts.
    }
    await band.redraw()
    expect(await band.find({ type: 'Text', text: '60m left · 90% read' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '██████████' })).toBeDefined()
    expect(await shownLimits(band)).toBe('5h 23% 7d 41%')
    await band.unmount()

    // A minute on, the endpoint is asked again. (No band is drawn meanwhile:
    // a minute of the desktop's redraws is long for the kit.)
    await clock.advance(60_000)
    const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await later.redraw()
    expect(await shownLimits(later)).toBe('5h 68% 7d 62%')
    expect(await later.find({ type: 'Text', text: '59m left · 90% read' })).toBeDefined()
    await later.unmount()
  })

  test('the limits bar is colored by their use; one running full before its reset turns the reading yellow', async ($, on) => {
    // Half an hour into the five hours, 19% used: at that pace the window runs
    // full in a little over two hours, well before it resets.
    answerTheWorld(on, 10, MANIFEST, [{ kind: 'five_hour', percentUsed: 19, resetsAt: '1970-01-01T04:30:00Z' }])
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      await band.redraw()
      expect((await band.find({ type: 'Text', text: '██░░░░░░░░' }))?.props.color).toBe('success')
      const reading = await band.find({ type: 'Text', text: /^5h 19% ↻ \d\d:\d\d \(full ≈ \d\d:\d\d\)$/ })
      expect(reading?.props.color).toBe('warning')
      await band.unmount()
    }
  })

  test('a five-hour window used up turns the reading red with the bar', async ($, on) => {
    answerTheWorld(on, 10, MANIFEST, [{ kind: 'five_hour', percentUsed: 100, resetsAt: '1970-01-01T04:30:00Z' }])
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      await band.redraw()
      expect((await band.find({ type: 'Text', text: '██████████' }))?.props.color).toBe('error')
      const reading = await band.find({ type: 'Text', text: /^5h 100% ↻ \d\d:\d\d$/ })
      expect(reading?.props.color).toBe('error')
      await band.unmount()
    }
  })

  test('a lapsed cache says so in red, with the hint to compact, folded or not', async ($, on) => {
    const clock = answerTheWorld(on, 42)
    on('turn.step', async function* ($, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: { model: 'claude', input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    await $.session.start(START)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude', messageCount: 1 })) {
      // Nothing streams: the step's result is what counts.
    }
    // On an API key the cache lives five minutes.
    await clock.advance(6 * 60_000)

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      await band.redraw()
      const expired = await band.find({ type: 'Text', text: /^expired (<1m|\d+m) ago \(compact for fewer tokens\)$/ })
      expect(expired?.props.color).toBe('error')
      await pressButton(band, 'collapse')
      const folded = await band.find({ type: 'Text', text: 'Cache expired' })
      expect(folded?.props.color).toBe('error')
      await pressButton(band, 'expand')
      await band.unmount()
    }
  })

  test('the context row says how far auto-compaction is; Compact stands out in its last tenth', async ($, on) => {
    answerTheWorld(on, 76, MANIFEST, [], 167000)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.redraw()
    expect(await band.find({ type: 'Text', text: '76% · 152k / 200k · auto-compact in 15k' })).toBeDefined()
    expect(await isPrimary(band, 'compact')).toBe(true)
    await band.unmount()
  })

  test("Claude's task list gets a row of its own while there is one", async ($, on) => {
    answerTheWorld(on)
    on('tool.call', () => ({ result: {}, text: 'ok' }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ key: 'tasks' })).toBeUndefined()

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
        { content: 'Fix the bug', status: 'in_progress', activeForm: 'Fixing the bug' },
      ],
    } as never)
    await band.redraw()
    expect(await band.find({ type: 'Text', text: '1/2 · Fixing the bug' })).toBeDefined()
    await band.unmount()
  })

  test('without a task list the last row is the session: its turns, what runs, the last turn', async ($, on) => {
    answerTheWorld(on)
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('agent.list', () => ({ value: [{ id: 'a1', type: 'Explore', status: 'running', description: 'look' }] }))
    on('classic.Stop', () => ({}))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    await $.turn.start({ text: 'hi', turnId: 't1' })
    await $.tool.call({ tool: 'Read', file_path: '/work/notes.md' } as never)
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /· 0 turns · 1 agent \(Explore\) · this turn \d+s, 1 tool$/ })).toBeDefined()

    await complete($, 't1', 9000)
    await $.classic.Stop({
      stop_hook_active: false,
      background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test' }],
      session_crons: [{ id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: 'check' }],
    } as never)
    await band.redraw()
    expect(await band.find({ key: 'session' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /· 1 turn · 1 agent \(Explore\) · 1 shell · 1 loop · last 9s, 1 tool$/ })).toBeDefined()
    await band.unmount()
  })

  test('the band folds to one line of figures without Ranko, and opens again, on both surfaces', async ($, on) => {
    const stored: Record<string, unknown> = {}
    answerTheWorld(on, 42, MANIFEST, [], undefined, stored)
    await $.session.start(START)

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ key: 'ranko' })).toBeDefined()
      // The fold button stands at the band's top right, clear of Ranko.
      expect((await band.find({ key: 'fold' }))?.props.left).toBe(95)
      await pressButton(band, 'collapse')
      expect(stored.collapsed).toBe(true)
      expect(await band.find({ key: 'ranko' })).toBeUndefined()
      expect(await band.find({ key: 'stats' })).toBeUndefined()
      expect(await band.find({ key: 'stats-line' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '████░░░░░░' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '42%' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '–' })).toBeDefined()
      expect(await band.find({ key: 'compact' })).toBeDefined()

      await pressButton(band, 'expand')
      expect(stored.collapsed).toBe(false)
      expect(await band.find({ key: 'ranko' })).toBeDefined()
      expect(await band.find({ key: 'stats-line' })).toBeUndefined()
      await band.unmount()
    }

    // /ranko collapse and expand do the same.
    expect((await $.command.run({ ...COMMAND, command: 'ranko', args: 'collapse' })).text).toContain('one line')
    const folded = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await folded.find({ key: 'stats-line' })).toBeDefined()
    await folded.unmount()
    await $.command.run({ ...COMMAND, command: 'ranko', args: 'expand' })
    const open = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await open.find({ key: 'ranko' })).toBeDefined()
    await open.unmount()
  })

  test('folded in an earlier session, the band starts folded', async ($, on) => {
    answerTheWorld(on, 10, MANIFEST, [], undefined, { collapsed: true })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'stats-line' })).toBeDefined()
    expect(await band.find({ key: 'ranko' })).toBeUndefined()
    await band.unmount()
  })

  test('under 15% of context there is nothing to compact: no Compact button', async ($, on) => {
    answerTheWorld(on, 10)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: '10% · 20k / 200k' })).toBeDefined()
      expect(await band.find({ key: 'compact' })).toBeUndefined()
      await band.unmount()
    }
  })

  test("the session's bar shows the five-hour window passed from the start, by this session's own limits too", async ($, on) => {
    // No login for the usage endpoint: the limits are what the session's
    // last response reported. Two hours into the five-hour window: 40%.
    const own: SessionRateLimit[] = []
    const clock = answerTheWorld(on, 10, MANIFEST, own)
    own.push({ kind: 'five_hour', percentUsed: 23, resetsAt: new Date(clock.now() + 3 * 3_600_000).toISOString() })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.redraw()
    expect(await band.find({ key: 'session' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '████░░░░░░' })).toBeDefined()
    await band.unmount()
  })

  test('until the usage endpoint answers, it is asked again within seconds, not a minute', async ($, on) => {
    const clock = answerTheWorld(on, 10)
    let asked = 0
    on('session.authorize', () => ({ value: { handle: 'login', kind: 'bearer' as const } }))
    on('http.fetch', () => {
      asked += 1
      const body = JSON.stringify({ five_hour: { utilization: 68, resets_at: '2030-01-07T17:40:00Z' } })
      return { value: asked === 1 ? { status: 503, ok: false, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: body } }
    })
    await $.session.start(START)
    await clock.settle()
    expect(asked).toBe(1)

    await clock.advance(10_000)
    expect(asked).toBe(2)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /^5h 68% ↻/ })).toBeDefined()
    await band.unmount()

    // Answered: a minute until the next time.
    await clock.advance(30_000)
    expect(asked).toBe(2)
  })

  test('stats off: the band holds Ranko alone', { options: { stats: false } }, async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ key: 'stats' })).toBeUndefined()
      await band.unmount()
    }
  })

  test('the Compact button stands out from 80%, compacts, and logs the summary in whole lines', async ($, on) => {
    answerTheWorld(on, 85)
    const logs: string[] = []
    on('ui.log', ($, e) => {
      logs.push(e.text)
      return { value: undefined }
    })
    // Six paragraphs of some 450 characters: more than one log line holds.
    const summary = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}: ${'word '.repeat(88).trim()}.`).join('\n\n')
    on('session.compact', () => ({
      messages: [{ role: 'user' as const, text: summary, toolUses: [] }],
      tokensBefore: 170000,
      tokensAfter: 12000,
    }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })

    expect(await isPrimary(band, 'compact')).toBe(true)
    await pressButton(band, 'compact')
    expect(logs[0]).toBe('Compacted from 170k to 12k tokens. The summary Claude carries on with:')
    const lines = logs.slice(1)
    expect(lines.length).toBe(2)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(2000)
      expect(line.startsWith('Paragraph ')).toBe(true)
    }
    expect(lines.join('\n\n')).toBe(summary)
    await band.unmount()
  })

  test('/compact logs its summary too; a precomputed one neither logs nor deflates', async ($, on) => {
    answerTheWorld(on, 85)
    const logs: string[] = []
    on('ui.log', ($, e) => {
      logs.push(e.text)
      return { value: undefined }
    })
    on('session.compact', () => ({
      messages: [{ role: 'user' as const, text: 'What happened so far.', toolUses: [] }],
      tokensBefore: 170000,
      tokensAfter: 9000,
    }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, 't1', 1000)
    expect(await shownClip(band)).toBe('idle-stuffed')

    const messages = [{ role: 'user', text: 'go', toolUses: [] }]
    await $.session.compact({ trigger: 'precompute', messages } as never)
    expect(logs).toEqual([])
    expect(await shownClip(band)).toBe('idle-stuffed')

    await $.session.compact({ trigger: 'manual', messages } as never)
    expect(logs).toEqual(['Compacted from 170k to 9k tokens. The summary Claude carries on with:', 'What happened so far.'])
    expect(await shownClip(band)).toBe('deflate')
    await band.unmount()
  })

  test('compaction summaries off: nothing is logged', { options: { compactSummary: false } }, async ($, on) => {
    answerTheWorld(on)
    const logs: string[] = []
    on('ui.log', ($, e) => {
      logs.push(e.text)
      return { value: undefined }
    })
    on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'Summary.', toolUses: [] }] }))
    await $.session.start(START)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'go', toolUses: [] }] } as never)
    expect(logs).toEqual([])
  })

  test('a full context stuffs Ranko from the start, and compaction lets it out', async ($, on) => {
    // A resumed session's context is full before its first turn.
    answerTheWorld(on, 85)
    on('session.compact', ($, e) => ({ messages: e.messages }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await shownClip(band)).toBe('idle-stuffed')

    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await shownClip(band)).toBe('working-stuffed')
    await complete($, 't1', 1000)
    expect(await shownClip(band)).toBe('idle-stuffed')
    await $.turn.start({ text: 'more', turnId: 't2' })
    expect(await shownClip(band)).toBe('working-stuffed')
    await complete($, 't2', 1000)

    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'go', toolUses: [] }] } as never)
    expect(await shownClip(band)).toBe('deflate')
    await band.unmount()
  })

  test('stuffing off: Ranko keeps its size', { options: { stuffing: false } }, async ($, on) => {
    answerTheWorld(on, 85)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await complete($, 't1', 1000)
    expect(await shownClip(band)).toBe('idle')
    await band.unmount()
  })

  test('/ranko on|off flips a switch, /ranko list shows reactions and switches', async ($, on) => {
    answerTheWorld(on)
    const sets: unknown[] = []
    on('config.list', () => ({ value: [{ key: 'ranko@inline.blush', label: 'Blush', kind: 'boolean', value: true }] }) as never)
    on('config.set', ($, e) => {
      sets.push(e)
      return { value: e.value }
    })
    await $.session.start(START)
    const run = (args: string) => $.command.run({ ...COMMAND, command: 'ranko', args })

    expect((await run('off blush')).text).toBe("Ranko's blush is off")
    expect(sets).toEqual([expect.objectContaining({ key: 'ranko@inline.blush', value: false })])
    expect((await run('on sparkles')).text).toContain('No switch called "sparkles"')
    const listed = (await run('list')).text
    expect(listed).toContain('happy, ')
    expect(listed).toContain('on   toolProps')
  })

  for (const isOn of [true, false]) {
    test(`left alone, Ranko fidgets now and then (fidgets ${isOn ? 'on' : 'off'})`, { options: { fidgets: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

      // The wait is random but never past 40 s, and a fidget lasts under 2 s.
      const seen = new Set<string>()
      for (let ms = 0; ms < 42_000; ms += 500) {
        await clock.advance(500)
        seen.add((await shownClip(band)) ?? '')
      }
      const fidgeted = [...seen].some(clip => clip.startsWith('fidget-'))
      expect(fidgeted).toBe(isOn)

      // A turn starting cuts any fidget short.
      await $.turn.start({ text: 'go', turnId: 't1' })
      expect(await shownClip(band)).toBe('working')
      await band.unmount()
    })
  }

  for (const isOn of [true, false]) {
    test(`a pat and a jump make their sounds (sounds ${isOn ? 'on' : 'off'})`, { options: { sounds: isOn } }, async ($, on) => {
      answerTheWorld(on)
      const played: string[] = []
      on('audio.play', ($, e) => {
        played.push((e.clip as { asset: string }).asset)
        return { value: undefined }
      })
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

      await band.pointer({ type: 'down', x: 8, y: 3, button: 'left', in: 'grab' })
      await band.pointer({ type: 'up', x: 8, y: 3, button: 'left', in: 'grab' })
      await $.turn.start({ text: 'go', turnId: 't1' })
      await complete($, 't1', 9000)
      await shownClip(band)

      // Idle and working are quiet; the pat and the jump are not.
      expect(played).toEqual(isOn ? ['assets/sounds/pat.wav', 'assets/sounds/happy.wav'] : [])
      await band.unmount()
    })
  }

  test('a frames folder from an older bake shows the stats without Ranko', async ($, on) => {
    const older = JSON.stringify({ fps: 24, columns: 16, rows: 6, moods: { idle: { frames: 48, loop: true } } })
    answerTheWorld(on, 10, older)
    on('ui.log', () => ({ value: undefined }))
    await $.session.start(START)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ key: 'ranko' })).toBeUndefined()
      expect(await band.find({ key: 'stats-band' })).toBeDefined()
      await band.unmount()
    }
  })

  test('a short band gets a smaller Ranko, a very short one none', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)

    const short = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 5 } })
    // A new size is a new Image, so the terminal places it afresh.
    expect(await short.find({ key: 'ranko' })).toBeUndefined()
    const pet = await short.find({ key: 'ranko-5' })
    expect([pet?.props.columns, pet?.props.rows]).toEqual([10, 5])
    await short.unmount()

    const tiny = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, maxRows: 3 } })
    expect(await tiny.find({ key: 'ranko' })).toBeUndefined()
    await tiny.unmount()
  })

  test('a drag whose press the terminal folded into its first move still drags', async ($, on) => {
    answerTheWorld(on)
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await band.pointer({ type: 'move', x: 4, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: -26, y: 2, button: 'left', in: 'grab' })
    expect(await shownClip(band)).toBe('held')
    await band.pointer({ type: 'up', x: -26, y: 2, button: 'left', in: 'grab' })
    expect((await band.find({ key: 'pet' }))?.props.left).toBe(52)
    await band.unmount()
  })

  test('minis spawned in a full band get new Images when it shrinks', async ($, on) => {
    answerTheWorld(on)
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await $.agent.spawn({ tool_use_id: 'u1', prompt: 'look around', description: 'look', subagentType: 'Explore' } as never)
    await band.redraw()
    expect((await band.find({ key: 'mini-a1' }))?.props.columns).toBe(6)

    // The agent list under the prompt takes a row from the band.
    await band.redraw({ ...BAND.props, maxRows: 5 })
    expect(await band.find({ key: 'mini-a1' })).toBeUndefined()
    const shrunk = await band.find({ key: 'mini-a1-5' })
    expect([shrunk?.props.columns, shrunk?.props.rows]).toEqual([4, 2])
    await band.unmount()
  })

  test("a subagent's turn that starts first isn't taken for the main conversation's", async ($, on) => {
    answerTheWorld(on)
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
    on('turn.step', async function* ($, e) {
      return {
        turnId: e.turnId,
        index: e.index,
        answer: '',
        toolUses: [],
        stopReason: 'end_turn' as const,
        usage: { model: 'claude', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }
    })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const step = async (turnId: string, agentId?: string) => {
      for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
        // Nothing streams: the step's result is what counts.
      }
    }

    // A background agent's turn starts first, then the main conversation's;
    // their requests say whose is whose.
    await $.turn.start({ text: '', turnId: 'a-turn' })
    await $.turn.start({ text: 'hi', turnId: 't1' })
    await step('a-turn', 'a1')
    await step('t1')
    await $.tool.call({ tool: 'Read', file_path: '/work/notes.md' } as never)
    await complete($, 'a-turn', 3000, 'answer', 'a1')
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /this turn \d+s, 1 tool$/ })).toBeDefined()

    await complete($, 't1', 9000)
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /· 1 turn · last 9s, 1 tool$/ })).toBeDefined()
    await band.unmount()
  })

  test("another session's fresh reading of the limits stands in for asking the endpoint", async ($, on) => {
    const stored: Record<string, unknown> = {}
    const clock = answerTheWorld(on, 10, MANIFEST, [], undefined, stored)
    stored.plan = {
      at: clock.now() - 5000,
      limits: [{ kind: 'five_hour', percentUsed: 68, resetsAt: '2030-01-07T17:40:00Z' }],
    }
    let asked = 0
    on('session.authorize', () => ({ value: { handle: 'login', kind: 'bearer' as const } }))
    on('http.fetch', () => {
      asked += 1
      const body = JSON.stringify({ five_hour: { utilization: 70, resets_at: '2030-01-07T17:40:00Z' } })
      return { value: { status: 200, ok: true, headers: {}, text: body } }
    })
    await $.session.start(START)
    await clock.settle()
    expect(asked).toBe(0)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /^5h 68% ↻/ })).toBeDefined()
    await band.unmount()

    // A minute on, that reading is stale: this session asks, and leaves its own.
    await clock.advance(60_000)
    expect(asked).toBe(1)
    expect((stored.plan as { limits: { percentUsed: number }[] }).limits[0]?.percentUsed).toBe(70)
  })

  test('told to wait by a 429, no session asks the endpoint until the time is up', { timeoutMs: 20000 }, async ($, on) => {
    const stored: Record<string, unknown> = {}
    const clock = answerTheWorld(on, 10, MANIFEST, [], undefined, stored)
    let asked = 0
    on('session.authorize', () => ({ value: { handle: 'login', kind: 'bearer' as const } }))
    on('http.fetch', () => {
      asked += 1
      const body = JSON.stringify({ five_hour: { utilization: 68, resets_at: '2030-01-07T17:40:00Z' } })
      const busy: Record<string, string> = { 'retry-after': '150' }
      return {
        value:
          asked === 1
            ? { status: 429, ok: false, headers: busy, text: '' }
            : { status: 200, ok: true, headers: {}, text: body },
      }
    })
    const startedAt = clock.now()
    await $.session.start(START)
    await clock.settle()
    expect(asked).toBe(1)
    expect(stored.planWait).toBe(startedAt + 150_000)

    await clock.advance(140_000)
    expect(asked).toBe(1)
    await clock.advance(80_000)
    expect(asked).toBe(2)
  })

  const WITH_HELLO = JSON.stringify({
    ...JSON.parse(MANIFEST),
    clips: { ...JSON.parse(MANIFEST).clips, hello: { frames: 56, loop: false } },
  })

  test('waiting on a permission, Ranko stops typing, waves, then says psst, until the call goes on', { timeoutMs: 20000 }, async ($, on) => {
    const clock = answerTheWorld(on, 10, WITH_HELLO)
    let finish = () => {}
    on('tool.call', () => new Promise(resolve => {
      finish = () => resolve({ result: { stdout: '', stderr: '', interrupted: false }, text: 'ok' })
    }))
    on('classic.PermissionRequest', () => ({}))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await clock.advance(3000)

    await $.turn.start({ text: 'clean up', turnId: 't1' })
    expect(await shownClip(band)).toBe('working')
    const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build' } as never)
    await clock.settle()
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as never)
    expect(await shownClip(band)).toBe('hello')
    await clock.advance(3000)
    expect(await shownClip(band)).toBe('idle')
    await clock.advance(27_500)
    expect(await shownClip(band)).toBe('fidget-psst')

    // Allowed: the call goes on, and so does he, at once.
    finish()
    await call
    expect(await shownClip(band)).toBe('working')
    await band.unmount()
  })

  for (const isOn of [true, false]) {
    test(`a question for the person has him wave until it is answered (attention ${isOn ? 'on' : 'off'})`, { options: { attention: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on, 10, WITH_HELLO)
      let answer = () => {}
      on('tool.call', () => new Promise(resolve => {
        answer = () => resolve({ result: {}, text: 'ok' })
      }))
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await clock.advance(3000)

      await $.turn.start({ text: 'plan it', turnId: 't1' })
      const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
      await clock.settle()
      expect(await shownClip(band)).toBe(isOn ? 'hello' : 'working')
      answer()
      await call
      expect(await shownClip(band)).toBe('working')
      await band.unmount()
    })
  }

  for (const isOn of [true, false]) {
    test(`a commit or a passing test run gets a thumbs up (thumbsUp ${isOn ? 'on' : 'off'})`, { options: { thumbsUp: isOn } }, async ($, on) => {
      const clock = answerTheWorld(on)
      on('tool.call', ($, e) => {
        const command = (e as { command?: string }).command ?? ''
        const run = { stderr: '', interrupted: false }
        if (command.startsWith('git commit')) {
          return { result: { ...run, stdout: '', gitOperation: { commit: { sha: 'abc', kind: 'committed' } } }, text: 'ok' }
        }
        return { result: { ...run, stdout: command.includes('broken') ? 'Tests: 1 failed, 4 passed' : 'Tests: 5 passed' }, text: 'ok' }
      })
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      await $.turn.start({ text: 'ship it', turnId: 't1' })

      // Piped through tail a failed run ends well; its output says otherwise.
      await $.tool.call({ tool: 'Bash', command: 'npm test -- broken 2>&1 | tail -5' } as never)
      expect(await shownClip(band)).toBe('working')
      await $.tool.call({ tool: 'Bash', command: 'npm test 2>&1 | tail -5' } as never)
      expect(await shownClip(band)).toBe(isOn ? 'fidget-thumbs' : 'working')
      await clock.advance(2000)

      // A commit; the turn's work doesn't cut the thumbs up short.
      await $.tool.call({ tool: 'Bash', command: 'git commit -m "Ship it"' } as never)
      expect(await shownClip(band)).toBe(isOn ? 'fidget-thumbs' : 'working')
      await clock.advance(500)
      expect(await shownClip(band)).toBe(isOn ? 'fidget-thumbs' : 'working')
      await band.unmount()
    })
  }

  test('browsing tools get the binoculars, the task list the notepad', () => {
    expect(propFor('mcp__claude-in-chrome__navigate')).toBe('binoculars')
    expect(propFor('mcp__playwright__browser_click')).toBe('binoculars')
    expect(propFor('mcp__Claude_Browser__screenshot')).toBe('binoculars')
    expect(propFor('TodoWrite')).toBe('notepad')
    expect(propFor('TaskUpdate')).toBe('notepad')
    expect(propFor('ToolSearch')).toBe('magnifier')
    expect(propFor('mcp__github__create_issue')).toBeUndefined()
    expect(propFor('Bash')).toBeUndefined()
  })

  test('asleep a good while, he is drawn a few times a second, then not at all', { timeoutMs: 90000 }, async ($, on) => {
    const drawn: number[] = []
    const clock = answerTheWorld(on, 10, MANIFEST, [], undefined, {}, key => {
      if (key === 'ranko') {
        drawn.push(clock.now())
      }
    })
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    const drawsIn = async (ms: number) => {
      const from = clock.now()
      await clock.advance(ms)
      return drawn.filter(at => at > from).length
    }

    expect(await drawsIn(1000)).toBeGreaterThanOrEqual(20)
    // Two minutes alone he dozes off; a minute after, he is drawn less often.
    await clock.advance(3 * 60_000 + 1000)
    expect(await drawsIn(1000)).toBeLessThanOrEqual(5)
    // Ten minutes asleep, nobody is looking: he holds still. (A minute at a
    // time: the mock clock runs so many timers per advance.)
    for (let minute = 0; minute < 10; minute += 1) {
      await clock.advance(60_000)
    }
    expect(await drawsIn(1000)).toBe(0)
    // A turn wakes him, and every frame is drawn again.
    await $.turn.start({ text: 'wake up', turnId: 't1' })
    expect(await drawsIn(1000)).toBeGreaterThanOrEqual(20)
    await band.unmount()
  })

  test('/ranko completes its verbs, reactions and switches as they are typed', () => {
    const typeahead = (text: string) => {
      const token = text.split(/\s+/).pop() ?? ''
      const rows = commandSuggestions(text, text.length - token.length, token, Object.keys(CLIPS), feature => feature !== 'sounds')
      return rows.map(row => `${row.text}${row.description.endsWith('now') ? ` (${row.description})` : ''}`)
    }

    expect(typeahead('/ranko ha')).toEqual(['happy'])
    expect(typeahead('/ranko co')).toEqual(['collapse'])
    expect(typeahead('/ranko off s')).toEqual(['stuffing (on now)', 'sounds (off now)', 'stats (on now)'])
    expect(typeahead('/ranko happy x')).toEqual([])
    expect(typeahead('/rankoo ha')).toEqual([])
  })
})
