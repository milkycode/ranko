/**
 * What Ranko is doing and which frame he shows: the mood picked from what is
 * under way, the one-off clips that play over it, the variant of a clip a
 * reaction asks for, and the mini Rankos standing in for subagents.
 *
 * No engine here: register.tsx feeds it events and the time, and draws and
 * blits what it says.
 */

export const FEATURES = [
  'drag',
  'pats',
  'toolProps',
  'miniRankos',
  'stuffing',
  'blush',
  'attention',
  'thumbsUp',
  'fidgets',
  'sounds',
  'stats',
  'compactSummary',
] as const
export type Feature = (typeof FEATURES)[number]

// The verbs /ranko takes besides a reaction, with what they do, for the
// typeahead; it shows this many rows at most.
const VERBS: Record<string, string> = {
  list: 'every reaction and switch',
  collapse: 'fold the band to one line',
  expand: 'open the band again',
  on: 'turn a switch on',
  off: 'turn a switch off',
}
const MAX_SUGGESTIONS = 12

/**
 * The typeahead's rows for the word being typed after /ranko: its verbs and
 * the reactions `clips` names, or after on or off the switches, each with
 * whether it is on. `start` is where the word `token` begins in `text`.
 */
export function commandSuggestions(
  text: string,
  start: number,
  token: string,
  clips: readonly string[],
  isOn: (feature: Feature) => boolean,
) {
  const command = /^\/ranko\s+/.exec(text)
  if (!command || start < command[0].length) {
    return []
  }
  const args = text.slice(command[0].length, start).split(/\s+/).filter(arg => arg !== '')
  const [verb] = args
  const rows: [string, string][] =
    args.length === 0
      ? [...Object.entries(VERBS), ...clips.map((clip): [string, string] => [clip, 'play this reaction'])]
      : args.length === 1 && (verb === 'on' || verb === 'off')
        ? FEATURES.map((feature): [string, string] => [feature, isOn(feature) ? 'on now' : 'off now'])
        : []
  const typed = token.toLowerCase()
  return rows
    .filter(([name]) => name.toLowerCase().startsWith(typed) && name !== token)
    .slice(0, MAX_SUGGESTIONS)
    .map(([name, description]) => ({ text: name, description }))
}

export type ClipInfo = {
  frames: number
  loop: boolean
  /** How the clip leaves him: `stand` (the default), `sit` or `cushion`. */
  posture?: string
  /** For a clip that takes him from one posture to another, the two. */
  transition?: [string, string]
}

export type Manifest = {
  fps: number
  columns: number
  rows: number
  clips: Record<string, ClipInfo>
}

/** Whether parsed JSON is a manifest this mod can play: a frames folder from
 * an older bake has another shape, and drawing from it would throw on every
 * render. */
export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const m = value as Record<string, unknown>
  if (typeof m.fps !== 'number' || typeof m.columns !== 'number' || typeof m.rows !== 'number') {
    return false
  }
  if (typeof m.clips !== 'object' || m.clips === null || !('idle' in m.clips)) {
    return false
  }
  return Object.values(m.clips as Record<string, unknown>).every(c => {
    const clip = c as Record<string, unknown> | null
    return typeof clip?.frames === 'number' && clip.frames > 0 && typeof clip.loop === 'boolean'
  })
}

export type Prop = 'magnifier' | 'notepad' | 'binoculars'
export type Size = 'normal' | 'plump' | 'stuffed'

// The shell, and anything else, is his laptop: plain working.
const PROP_FOR_TOOL: Record<string, Prop> = {
  Read: 'magnifier',
  Grep: 'magnifier',
  Glob: 'magnifier',
  LSP: 'magnifier',
  ToolSearch: 'magnifier',
  Edit: 'notepad',
  Write: 'notepad',
  NotebookEdit: 'notepad',
  TodoWrite: 'notepad',
  TaskCreate: 'notepad',
  TaskUpdate: 'notepad',
  WebFetch: 'binoculars',
  WebSearch: 'binoculars',
}
// An MCP server's tools that browse or fetch the web, by a word in their
// name: Chrome, the built-in browser, Playwright and the like.
const BROWSING = /^mcp__.*(browser|chrome|playwright|puppeteer|firecrawl|fetch)/i

/** The prop Ranko holds while a tool runs, if it has one. */
export const propFor = (tool: string): Prop | undefined =>
  PROP_FOR_TOOL[tool] ?? (BROWSING.test(tool) ? 'binoculars' : undefined)

export const sizeFor = (percent: number): Size =>
  percent >= 80 ? 'stuffed' : percent >= 50 ? 'plump' : 'normal'

const SLEEP_AFTER_MS = 2 * 60 * 1000
// Asleep this long, there is nothing to see but slow z's; this long, nobody
// is likely to be looking at all (sleepDepth).
const DROWSY_AFTER_MS = 60_000
const STILL_AFTER_MS = 10 * 60_000
// While Claude waits for the person, he waves at once, then says psst this
// often; left waiting this long, he gives up and dozes off.
const BECKON_EVERY_MS = 30_000
const WAIT_AWAKE_MS = 5 * 60 * 1000
const THUMBS = 'fidget-thumbs'
// Every call shows its prop at least this long: reads and edits finish in
// milliseconds and would otherwise never show one, and a burst of them shows
// one steady prop instead of a flicker.
const PROP_HOLD_MS = 1500
const MAX_MINIS = 3
// Frames a finished subagent's mini spends walking off before it goes.
export const LEAVE_FRAMES = 16
// How long Ranko idles between fidgets, picked fresh each time.
const FIDGET_MIN_MS = 15_000
const FIDGET_MAX_MS = 40_000

// Which one-off clip may cut another short: a higher number wins, an equal
// one restarts. A clip played by hand outranks them all.
const PRIORITY: Record<string, number> = {
  fidget: 0,
  pat: 1,
  blush: 1,
  happy: 2,
  hello: 2,
  drop: 2,
  deflate: 2,
  oops: 3,
}
const BY_HAND = 10

/** The mood a clip belongs to: `idle-stuffed` is idle, stuffed. */
export const moodOf = (clip: string) => clip.split('-')[0] ?? clip

// A fidget is cut short by anything under way, a beckon by the end of the
// wait it called for.
type OneOff = { clip: string; serial: number; length: number; priority: number; kind?: 'fidget' | 'beckon' }

export type Mini = { id: string; frame: number; leaving: number | null }

export class Pet {
  readonly runningTurns = new Set<string>()
  lastActivityMs = 0
  isHeld = false
  size: Size = 'normal'

  clip = 'idle'
  frame = 0
  readonly minis: Mini[] = []
  extraMinis = 0

  private readonly tools = new Map<string, { prop: Prop; startMs: number; isDone: boolean }>()
  private oneOff: OneOff | null = null
  private serial = 0
  private playing = ''
  private nextFidgetMs: number | null = null
  // Since when Claude has waited for the person, how often he has beckoned,
  // and when he beckons next.
  private waitingSince: number | null = null
  private beckons = 0
  private nextBeckonMs: number | null = null
  // How he is now, and the transition under way to how the next clip has
  // him: the clips are baked standing, sitting or on his cushion, and going
  // straight from one to another would be a jump.
  private posture = 'stand'
  private transition: { clip: string; to: string } | null = null

  constructor(
    private readonly manifest: Manifest,
    private readonly isOn: (feature: Feature) => boolean,
    // Told each time a different clip starts (not when a variant of the same
    // mood takes over mid-loop): where the sounds hang off.
    private readonly onStart: (clip: string) => void = () => {},
  ) {}

  has(clip: string) {
    return clip in this.manifest.clips
  }

  /** Every clip there are frames for, the names `/ranko <reaction>` takes. */
  clipNames() {
    return Object.keys(this.manifest.clips)
  }

  postureOf(clip: string) {
    return this.manifest.clips[clip]?.posture ?? 'stand'
  }

  /** The clip that takes him from one posture toward another, if one is baked:
   * straight there, or else up onto his feet first. */
  private transitionFor(from: string, to: string) {
    const find = (a: string, b: string) =>
      Object.entries(this.manifest.clips).find(([, c]) => c.transition?.[0] === a && c.transition?.[1] === b)?.[0]
    const direct = find(from, to)
    if (direct) {
      return { clip: direct, to }
    }
    const up = from !== 'stand' && to !== 'stand' ? find(from, 'stand') : undefined
    return up ? { clip: up, to: 'stand' } : null
  }

  framesOf(clip: string) {
    return this.manifest.clips[clip]?.frames ?? 1
  }

  /** The frame of the current clip's files to show. */
  fileFrame() {
    return this.frame % this.framesOf(this.clip)
  }

  /**
   * Plays a clip once over whatever is running, unless a stronger one is
   * playing. By hand, a looping clip runs for at least three seconds so it can
   * be seen.
   */
  play(clip: string, isByHand = false) {
    const priority = isByHand ? BY_HAND : (PRIORITY[moodOf(clip)] ?? 1)
    const frames = this.framesOf(clip)
    const length = isByHand && this.manifest.clips[clip]?.loop ? Math.max(frames, 3 * this.manifest.fps) : frames
    return this.begin({ clip, length, priority })
  }

  /**
   * A thumbs up for work that went well, as strong as a jump: a turn's work
   * doesn't cut it short, as it does an idle fidget.
   */
  thumbsUp() {
    return this.begin({ clip: THUMBS, length: this.framesOf(THUMBS), priority: PRIORITY.happy ?? 2 })
  }

  private begin(oneOff: Omit<OneOff, 'serial'>) {
    if (!this.has(oneOff.clip) || (this.oneOff && this.oneOff.priority > oneOff.priority)) {
      return false
    }
    this.serial += 1
    this.oneOff = { ...oneOff, serial: this.serial }
    return true
  }

  /**
   * Claude waits for the person (a permission, a question), or no longer
   * does: waiting, he stops typing and beckons; the wait over, a beckon still
   * playing stops.
   */
  setWaiting(isWaiting: boolean, nowMs: number) {
    if (!isWaiting) {
      if (this.oneOff?.kind === 'beckon') {
        this.oneOff = null
      }
      this.waitingSince = null
      this.nextBeckonMs = null
    } else if (this.waitingSince === null && this.isOn('attention')) {
      this.waitingSince = nowMs
      this.beckons = 0
      this.nextBeckonMs = nowMs
    }
  }

  /**
   * How deep he sleeps, nothing else under way: `drowsy` a minute in, with
   * nothing to see but slow z's, `still` ten minutes in, when nobody is likely
   * to be looking; else `awake`.
   */
  sleepDepth(nowMs: number): 'awake' | 'drowsy' | 'still' {
    const at = this.sleepsAt()
    if (this.playing !== 'sleepy' || at === null) {
      return 'awake'
    }
    const asleep = nowMs - at
    return asleep > STILL_AFTER_MS ? 'still' : asleep > DROWSY_AFTER_MS ? 'drowsy' : 'awake'
  }

  /** When he dozes off: left alone two minutes, or left waiting five; null while a turn has him working. */
  private sleepsAt() {
    if (this.waitingSince !== null) {
      return this.waitingSince + WAIT_AWAKE_MS
    }
    return this.runningTurns.size === 0 ? this.lastActivityMs + SLEEP_AFTER_MS : null
  }

  private isAsleep(nowMs: number) {
    const at = this.sleepsAt()
    return at !== null && nowMs > at
  }

  toolStarted(id: string, prop: Prop, nowMs: number) {
    this.tools.set(id, { prop, startMs: nowMs, isDone: false })
  }

  toolEnded(id: string) {
    const call = this.tools.get(id)
    if (call) {
      call.isDone = true
    }
  }

  spawnMini(id: string) {
    if (this.minis.filter(m => m.leaving === null).length >= MAX_MINIS) {
      this.extraMinis += 1
      return
    }
    this.minis.push({ id, frame: this.minis.length * 7, leaving: null })
  }

  finishMini(id: string) {
    const mini = this.minis.find(m => m.id === id)
    if (mini) {
      mini.leaving = 0
    } else if (this.extraMinis > 0) {
      this.extraMinis -= 1
    }
  }

  /** Settles which clip shows now; a change of mood starts it from its first frame. */
  sync(nowMs: number) {
    this.fidget(nowMs)
    this.beckon(nowMs)
    let key: string
    let clip: string
    if (this.isHeld && this.has('held')) {
      key = 'held'
      clip = 'held'
    } else if (this.oneOff) {
      key = `once:${this.oneOff.serial}`
      clip = this.oneOff.clip
    } else {
      // Waiting for the person, he stops typing.
      key =
        this.runningTurns.size > 0 && this.waitingSince === null
          ? 'working'
          : this.isAsleep(nowMs)
            ? 'sleepy'
            : 'idle'
      clip = this.variantOf(key, nowMs)
    }

    if (!this.has(clip)) {
      clip = this.has(moodOf(clip)) ? moodOf(clip) : 'idle'
    }

    // A clip in another posture waits for the transition there; being held
    // lifts him straight off whatever he sat on.
    if (key === 'held') {
      this.transition = null
    } else if (!this.transition && !this.manifest.clips[clip]?.transition) {
      const want = this.postureOf(clip)
      if (want !== this.posture) {
        this.transition = this.transitionFor(this.posture, want)
      }
    }
    if (this.transition) {
      key = `transition:${this.transition.clip}`
      clip = this.transition.clip
    } else {
      this.posture = this.postureOf(clip)
    }

    // Variants of one mood share a length, so switching between them (idle to
    // idle-stuffed) carries on from the same frame instead of jumping back.
    const isSameMood = key === this.playing && this.framesOf(clip) === this.framesOf(this.clip)
    if (!isSameMood) {
      this.frame = 0
    }
    if (key !== this.playing) {
      this.onStart(clip)
    }
    this.playing = key
    this.clip = clip
  }

  /** Steps one frame on; returns whether the band must be drawn again. */
  advance() {
    this.frame += 1
    if (this.oneOff && this.playing === `once:${this.oneOff.serial}` && this.frame >= this.oneOff.length) {
      this.oneOff = null
    }
    const { transition } = this
    if (transition && this.playing === `transition:${transition.clip}` && this.frame >= this.framesOf(transition.clip)) {
      this.posture = transition.to
      this.transition = null
    }

    let isRedrawn = false
    for (const mini of this.minis) {
      mini.frame += 1
      if (mini.leaving !== null) {
        mini.leaving += 1
        isRedrawn = true
      }
    }
    const before = this.minis.length
    this.minis.splice(0, this.minis.length, ...this.minis.filter(m => m.leaving === null || m.leaving < LEAVE_FRAMES))
    return isRedrawn || this.minis.length !== before
  }

  /**
   * Now and then an idle Ranko plays a random fidget. Anything else under way
   * (a turn, a hold, sleep) cuts a fidget short and puts the next one off.
   */
  private fidget(nowMs: number) {
    const isIdle =
      !this.isHeld && this.runningTurns.size === 0 && this.waitingSince === null && !this.isAsleep(nowMs)
    if (this.oneOff?.kind === 'fidget' && !isIdle) {
      this.oneOff = null
    }
    if (!this.isOn('fidgets') || !isIdle || this.oneOff) {
      this.nextFidgetMs = null
      return
    }
    if (this.nextFidgetMs === null) {
      this.nextFidgetMs = nowMs + FIDGET_MIN_MS + Math.random() * (FIDGET_MAX_MS - FIDGET_MIN_MS)
      return
    }
    if (nowMs >= this.nextFidgetMs) {
      const fidgets = Object.keys(this.manifest.clips).filter(clip => moodOf(clip) === 'fidget')
      const picked = fidgets[Math.floor(Math.random() * fidgets.length)]
      if (picked) {
        this.begin({ clip: picked, length: this.framesOf(picked), priority: PRIORITY.fidget ?? 0, kind: 'fidget' })
      }
      this.nextFidgetMs = null
    }
  }

  /**
   * While Claude waits for the person, he waves at once, then says psst now
   * and then, until he dozes off; a stronger clip playing puts it off.
   */
  private beckon(nowMs: number) {
    if (this.nextBeckonMs === null || nowMs < this.nextBeckonMs || this.isHeld || this.isAsleep(nowMs)) {
      return
    }
    const clip = this.beckons === 0 ? 'hello' : 'fidget-psst'
    if (this.begin({ clip, length: this.framesOf(clip), priority: PRIORITY.hello ?? 2, kind: 'beckon' })) {
      this.beckons += 1
      this.nextBeckonMs = nowMs + BECKON_EVERY_MS
    }
  }

  private variantOf(mood: string, nowMs: number) {
    if (mood === 'working') {
      if (this.isOn('toolProps')) {
        let latest: { prop: Prop; startMs: number } | null = null
        for (const [id, call] of this.tools) {
          if (call.isDone && nowMs - call.startMs >= PROP_HOLD_MS) {
            this.tools.delete(id)
          } else if (!latest || call.startMs > latest.startMs) {
            latest = call
          }
        }
        if (latest) {
          return `working-${latest.prop}`
        }
      }
      if (this.isOn('stuffing') && this.size !== 'normal') {
        return `working-${this.size}`
      }
    }
    if (mood === 'idle') {
      if (this.isOn('stuffing') && this.size !== 'normal') {
        return `idle-${this.size}`
      }
    }
    return mood
  }
}
