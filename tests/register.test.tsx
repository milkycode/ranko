import type { On, RenderElement, SessionRateLimit } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { Mounted } from 'claude-code/testing'

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
function answerTheWorld(on: On, contextPercent = 10, manifest = MANIFEST, rateLimits: SessionRateLimit[] = []) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  // A frame's bytes are its path, so a test can tell which frame the
  // desktop drew.
  on('fs.read', ($, e) => ({ value: e.as === 'bytes' ? { base64: btoa(e.path) } : manifest }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('ui.render', () => h(Fragment, null) as RenderElement)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, percent: contextPercent, tokens: contextPercent * 2000 },
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

    // 100 columns wide, a 12-column pet: it starts at the right end.
    expect(await petLeft()).toBe(88)

    // Take hold 4 columns into the pet and carry it 30 columns left. The
    // grab region stays where the press was until the release, so the
    // pointer's columns are counted from there throughout.
    await band.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: -26, y: 2, button: 'left', in: 'grab' })
    expect(await shownClip(band)).toBe('held')
    expect(await petLeft()).toBe(58)
    expect(((await band.find({ key: 'grab' }))?.props.props as { left: number } | undefined)?.left).toBe(88)
    await band.pointer({ type: 'up', x: -26, y: 2, button: 'left', in: 'grab' })
    expect(await petLeft()).toBe(58)
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
    expect((await band.find({ key: 'pet' }))?.props.left).toBe(88)
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

    // The grab region is a strip along the whole band. 100 columns wide, a
    // 10-column pet: he starts at the right end.
    expect(await petLeft()).toBe(90)

    // Take hold 3 columns into him and carry him 30 columns left. The
    // desktop shows nothing new in the band while the button is down, so the
    // strip draws a frame where he will land.
    await band.pointer({ type: 'down', x: 93, y: 2, button: 'left', in: 'grab' })
    await band.pointer({ type: 'move', x: 63, y: 2, button: 'left', in: 'grab' })
    expect((await band.find({ key: 'landing', in: 'grab' }))?.props.left).toBe(60)
    await band.pointer({ type: 'up', x: 63, y: 2, button: 'left', in: 'grab' })
    expect(await band.find({ key: 'landing', in: 'grab' })).toBeUndefined()
    expect(await petLeft()).toBe(60)
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
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(90)

    await band.pointer({ type: 'down', x: 95, y: 1, button: 'left', in: 'grab' })
    await band.pointer({ type: 'up', x: 95, y: 1, button: 'left', in: 'grab' })
    expect(await desktopFile(band)).toMatch(/pat\/\d{3}\.png$/)
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(90)
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
    expect((await band.find({ key: 'ranko' }))?.props.left).toBe(90)
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
    test(`kind words make Ranko blush (blush ${isOn ? 'on' : 'off'})`, { options: { blush: isOn } }, async ($, on) => {
      answerTheWorld(on)
      on('prompt.submit', ($, e) => ({ text: e.text }))
      await $.session.start(START)
      const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
      const submit = (text: string) =>
        $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

      await submit('fix the parser please')
      expect(await shownClip(band)).toBe('idle')
      await submit('Thanks, that worked!')
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

  test('beside him the stats show the context, the cache and the limits', async ($, on) => {
    const limits = [
      { kind: 'five_hour', percentUsed: 23, resetsAt: '2030-01-07T17:40:00Z' },
      { kind: 'seven_day', percentUsed: 41, resetsAt: '2030-01-13T09:00:00Z' },
    ]
    answerTheWorld(on, 42, MANIFEST, limits)
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

    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ ...BAND, surface })
      expect(await band.find({ type: 'Text', text: '42% · 84k / 200k' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: /^5h 23% \(.+\) · 7d 41% \(.+\)$/ })).toBeDefined()
      expect((await band.find({ key: 'compact' }))?.props.variant).toBe('secondary')
      await band.unmount()
    }

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect(await band.find({ type: 'Text', text: 'no request yet' })).toBeDefined()
    // A Claude plan keeps the cache an hour after its last use.
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude', messageCount: 1 })) {
      // Nothing streams: the step's result is what counts.
    }
    await band.redraw()
    expect(await band.find({ type: 'Text', text: 'warm · 60m left · 90% read' })).toBeDefined()
    await band.unmount()
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

    expect((await band.find({ key: 'compact' }))?.props.variant).toBe('primary')
    await band.press({ key: 'compact' })
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

  test('a full context stuffs Ranko and compaction lets it out', async ($, on) => {
    answerTheWorld(on, 85)
    on('session.compact', ($, e) => ({ messages: e.messages }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })

    await $.turn.start({ text: 'go', turnId: 't1' })
    expect(await shownClip(band)).toBe('working')
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

  test('a frames folder from an older bake leaves the band alone', async ($, on) => {
    const older = JSON.stringify({ fps: 24, columns: 16, rows: 6, moods: { idle: { frames: 48, loop: true } } })
    answerTheWorld(on, 10, older)
    on('ui.log', () => ({ value: undefined }))
    await $.session.start(START)
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'ranko' })).toBeUndefined()
    await band.unmount()
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
    expect((await band.find({ key: 'pet' }))?.props.left).toBe(58)
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
})
