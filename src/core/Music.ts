/**
 * Procedural music.
 *
 * The `music` bus existed from the start and nothing was ever connected to it.
 * What a player actually heard was six events' worth of `loopNoise` beds —
 * broadband pink noise behind a Q≈0.6 lowpass, which is barely a filter at all.
 * The first human to listen to this project described it, accurately, as
 * "annoying white noise".
 *
 * So: one tune per event, synthesised, no assets to download.
 *
 * ## Scheduling
 *
 * Web Audio is sample-accurate but `setInterval` is not, so this uses the
 * standard lookahead pattern: a coarse timer wakes every `TICK_MS` and schedules
 * every step that falls inside the next `LOOKAHEAD` seconds, at absolute
 * `AudioContext` times. Timer jitter — including the ~3 samples/sec a throttled
 * background tab gives you — then has no effect on when a note actually sounds,
 * because the note was scheduled ahead of time against the audio clock.
 *
 * This deliberately does NOT run off the game loop. The game loop is
 * fixed-timestep and can run many updates in one frame to catch up; music that
 * followed it would stutter on exactly the frames the player notices.
 *
 * ## Why it stops rather than mutes
 *
 * Turning music off calls `stop()`, which kills the timer. Muting a bus would
 * leave the scheduler building oscillator nodes forever for silence. This
 * project has burned enough CPU in background tabs already.
 */

const TICK_MS = 25
const LOOKAHEAD = 0.14
/** Sixteenth-note steps per bar. */
const STEPS_PER_BAR = 16

/** MIDI note number to Hz. */
function hz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/**
 * One step of one voice.
 *
 * `null` is a rest. A number is a semitone offset from the track root, so a
 * pattern transposes by changing one field and a part can be read as shape
 * rather than as a pile of note names.
 */
type Step = number | null

interface Voice {
  wave: OscillatorType
  /** Peak gain per note, before the music bus. */
  gain: number
  /** Whole octaves added to the track root. */
  octave: number
  attack: number
  /** Note length as a fraction of one step; >1 overlaps into the next step. */
  hold: number
  /** Second oscillator, cents. Thickens pads and leads. */
  detune?: number
  /** Lowpass, Hz. Leads without one are what make chip music shrill. */
  cutoff?: number
  /** Send level into the shared delay, 0..1. */
  space?: number
  steps: Step[]
}

interface Drums {
  kick: number[]
  snare: number[]
  hat: number[]
  /** Peak gains; drums that sit too loud are the other half of "annoying". */
  gain?: number
}

export interface Track {
  name: string
  bpm: number
  /** MIDI root. Everything else is an offset from here. */
  root: number
  voices: Voice[]
  drums?: Drums
  /** 0 = straight, ~0.12 = a relaxed shuffle. Applied to odd 16ths. */
  swing?: number
  /**
   * Overall trim. Set from measurement, not by ear: the first pass was written
   * by feel and came out with a 10x spread in RMS between the loudest track
   * (BMX) and the quietest (Half Pipe), which would have been a jolt on every
   * scene change. These normalise all seven to ~0.011, measured with
   * `__cg.probe()` on the master with ambience off.
   *
   * These are APPROXIMATE and clamped to [0.7, 1.6]. Trust your ears over them.
   *
   * Measure over a FULL LOOP. The first correction probed 700ms of tracks whose
   * loops run 7-10 seconds, so every reading caught a different part of the
   * pattern; the "corrected" levels made Half Pipe four times quieter and Foot
   * Bag three times louder, swapping the two extremes. A short window on a long
   * loop is not a measurement. Re-measuring over one whole loop landed Foot Bag
   * exactly on target (0.01107 vs 0.0110) and left Half Pipe and BMX low —
   * their loops are 7.6s and 6.8s, so an 11s window covered 1.45 and 1.6 loops
   * and the reading then depends on where in the pattern it started. Repeated
   * runs of the same configuration varied by ~2x. The instrument is only
   * trustworthy over a whole number of loops: 16 beats x 60/bpm seconds.
   *
   * Rather than ship a 2.2x trim derived from a number that would not
   * reproduce, the two extremes are clamped. Re-measure over whole loops if a
   * track's parts change; do not nudge these by intuition.
   */
  level?: number
}

/* ------------------------------------------------------------------ tracks -- */
/*
 * Each track is four bars (64 steps) and loops. They are written to be heard
 * for 90 seconds at a time behind a game, so they stay diatonic, keep the lead
 * sparse, and leave the top octave mostly empty — the sound effects live up
 * there and a lead competing with them is what makes game music get switched
 * off.
 */

/** `x` marks a hit; anything else is a rest. Reads as a drum grid should. */
const grid = (s: string): number[] =>
  s.replace(/\s/g, '').split('').map((c) => (c === 'x' ? 1 : c === 'o' ? 0.55 : 0))

/** Four bars of one repeated bar, for parts that do not develop. */
const x4 = (bar: Step[]): Step[] => [...bar, ...bar, ...bar, ...bar]

const R = null

// Half Pipe — Hollywood, purple sky. Minor-key synthwave, the most driving of
// the six because it is the only event with a vert ramp under it.
const HALF_PIPE: Track = {
  name: 'Sunset Vert',
  bpm: 126,
  root: 45, // A2
  level: 1.6,
  voices: [
    {
      wave: 'sawtooth', gain: 0.16, octave: 0, attack: 0.004, hold: 0.9, cutoff: 700,
      steps: [
        0, R, 0, 0, R, 0, R, 0, 12, R, 0, R, 0, R, 7, R,
        8, R, 8, 8, R, 8, R, 8, 20, R, 8, R, 8, R, 3, R,
        3, R, 3, 3, R, 3, R, 3, 15, R, 3, R, 3, R, 10, R,
        10, R, 10, 10, R, 10, R, 10, 22, R, 10, R, 10, R, 7, R,
      ],
    },
    {
      wave: 'square', gain: 0.045, octave: 2, attack: 0.006, hold: 0.55, cutoff: 2000, space: 0.3, detune: 7,
      steps: [
        R, 12, 16, 19, R, 12, 16, 19, R, 12, 16, 19, R, 12, 16, 19,
        R, 20, 24, 27, R, 20, 24, 27, R, 20, 24, 27, R, 20, 24, 27,
        R, 15, 19, 22, R, 15, 19, 22, R, 15, 19, 22, R, 15, 19, 22,
        R, 22, 26, 29, R, 22, 26, 29, R, 22, 26, 29, R, 22, 26, 29,
      ],
    },
    {
      wave: 'triangle', gain: 0.1, octave: 3, attack: 0.01, hold: 1.8, cutoff: 2600, space: 0.55,
      steps: [
        R, R, R, R, 12, R, R, 15, 16, R, R, R, R, R, R, R,
        R, R, R, R, 20, R, R, 19, 15, R, R, R, R, R, R, R,
        R, R, R, R, 15, R, R, 19, 22, R, R, R, R, R, R, R,
        R, R, R, R, 22, R, R, 19, 15, R, R, 12, R, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.5,
    kick:  grid('x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x .xx.'),
    snare: grid('.... x... .... x... .... x... .... x... .... x... .... x... .... x... .... x.x.'),
    hat:   grid('..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x. ..x.'),
  },
}

// Foot Bag — the Golden Gate, a lawn, no clock pressure worth speaking of.
// Major sevenths, slow shuffle, the calmest track here.
const FOOT_BAG: Track = {
  name: 'Bay Breeze',
  bpm: 94,
  root: 41, // F2
  level: 1.09,
  swing: 0.12,
  voices: [
    {
      wave: 'triangle', gain: 0.17, octave: 0, attack: 0.008, hold: 1.1, cutoff: 520,
      steps: [
        0, R, R, 7, R, 0, R, R, 12, R, R, 7, R, R, R, R,
        5, R, R, 12, R, 5, R, R, 17, R, R, 12, R, R, R, R,
        9, R, R, 16, R, 9, R, R, 21, R, R, 16, R, R, R, R,
        7, R, R, 14, R, 7, R, R, 19, R, R, 14, R, R, 10, R,
      ],
    },
    {
      wave: 'sine', gain: 0.075, octave: 2, attack: 0.09, hold: 3.6, detune: 9, cutoff: 1500, space: 0.45,
      steps: [
        0, R, R, R, R, R, R, R, 4, R, R, R, R, R, R, R,
        5, R, R, R, R, R, R, R, 9, R, R, R, R, R, R, R,
        9, R, R, R, R, R, R, R, 12, R, R, R, R, R, R, R,
        7, R, R, R, R, R, R, R, 11, R, R, R, R, R, R, R,
      ],
    },
    {
      wave: 'sine', gain: 0.085, octave: 3, attack: 0.02, hold: 2.2, cutoff: 2400, space: 0.6,
      steps: [
        R, R, 16, R, 19, R, R, 16, R, R, R, R, 12, R, R, R,
        R, R, 17, R, 21, R, R, 17, R, R, R, R, 14, R, R, R,
        R, R, 21, R, 24, R, R, 21, R, R, 19, R, R, R, R, R,
        R, R, 19, R, 23, R, R, 19, R, R, 16, R, R, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.3,
    kick:  grid('x... .... ..x. .... x... .... ..x. .... x... .... ..x. .... x... .... ..x. ....'),
    snare: grid('.... o... .... o... .... o... .... o... .... o... .... o... .... o... .... o..o'),
    hat:   grid('..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o.'),
  },
}

// Surfing — the one event the original scores on style. Surf rock: twang lead,
// heavy space, a descending run that keeps falling like the wave face does.
const SURFING: Track = {
  name: 'Point Break',
  bpm: 134,
  root: 40, // E2
  level: 0.75,
  voices: [
    {
      wave: 'sawtooth', gain: 0.15, octave: 0, attack: 0.004, hold: 0.8, cutoff: 620,
      steps: x4([0, R, 0, R, 7, R, 0, R, 0, R, 0, R, 10, R, 7, R]),
    },
    {
      wave: 'sawtooth', gain: 0.07, octave: 2, attack: 0.006, hold: 0.9, cutoff: 1700, space: 0.7, detune: -8,
      steps: [
        12, 11, 10, 9, 7, R, R, R, R, R, R, R, R, R, R, R,
        10, 9, 7, 5, 3, R, R, R, R, R, R, R, R, R, R, R,
        15, 14, 12, 10, 9, R, R, R, R, R, R, R, R, R, R, R,
        7, R, 10, R, 12, R, 14, R, 15, R, R, R, R, R, R, R,
      ],
    },
    {
      wave: 'triangle', gain: 0.06, octave: 1, attack: 0.05, hold: 3.8, cutoff: 1100, space: 0.4, detune: 6,
      steps: [
        0, R, R, R, R, R, R, R, R, R, R, R, R, R, R, R,
        8, R, R, R, R, R, R, R, R, R, R, R, R, R, R, R,
        3, R, R, R, R, R, R, R, R, R, R, R, R, R, R, R,
        10, R, R, R, R, R, R, R, R, R, R, R, R, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.5,
    kick:  grid('x... ..x. .x.. ..x. x... ..x. .x.. ..x. x... ..x. .x.. ..x. x... ..x. .x.. .xx.'),
    snare: grid('.... x... .... x..x .... x... .... x... .... x... .... x..x .... x... .... x.x.'),
    hat:   grid('x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x. x.x.'),
  },
}

// Roller Skating — a boardwalk. The most straightforwardly cheerful of the six,
// because it is the only event whose hazards are bananas and beach balls.
const SKATING: Track = {
  name: 'Boardwalk',
  bpm: 118,
  root: 43, // G2
  level: 1.08,
  swing: 0.06,
  voices: [
    {
      wave: 'triangle', gain: 0.16, octave: 0, attack: 0.005, hold: 0.85, cutoff: 600,
      steps: [
        0, R, 0, R, 7, R, 12, R, 0, R, 0, R, 7, R, 4, R,
        5, R, 5, R, 12, R, 17, R, 5, R, 5, R, 12, R, 9, R,
        9, R, 9, R, 16, R, 21, R, 9, R, 9, R, 16, R, 12, R,
        7, R, 7, R, 14, R, 19, R, 7, R, 7, R, 14, R, 11, R,
      ],
    },
    {
      wave: 'square', gain: 0.04, octave: 2, attack: 0.005, hold: 0.5, cutoff: 2300, space: 0.35,
      steps: x4([12, R, 16, R, 19, R, 16, R, 12, R, 16, R, 19, R, 16, R]),
    },
    {
      wave: 'triangle', gain: 0.095, octave: 3, attack: 0.012, hold: 1.6, cutoff: 2800, space: 0.5,
      steps: [
        R, R, R, R, R, R, R, R, 19, R, 21, R, 23, R, R, R,
        24, R, R, 21, R, R, 19, R, R, R, R, R, R, R, R, R,
        R, R, R, R, 21, R, 23, R, 24, R, R, 26, R, R, R, R,
        23, R, R, 19, R, R, 16, R, R, R, R, R, 14, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.45,
    kick:  grid('x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... .xx.'),
    snare: grid('.... x... .... x... .... x... .... x... .... x... .... x... .... x... .... x...'),
    hat:   grid('..x. ..x. ..x. ..xx ..x. ..x. ..x. ..xx ..x. ..x. ..x. ..xx ..x. ..x. ..x. ..xx'),
  },
}

// BMX — the desert. Fastest and driest: power-chord bass, almost no pad, so the
// frame's washed-out palette has something equally arid under it.
const BMX: Track = {
  name: 'Dust Devil',
  bpm: 142,
  root: 38, // D2
  level: 0.7,
  voices: [
    {
      wave: 'sawtooth', gain: 0.17, octave: 0, attack: 0.003, hold: 0.7, cutoff: 560,
      steps: x4([0, 0, R, 0, R, 0, 0, R, 0, 0, R, 0, R, 10, R, 7]),
    },
    {
      wave: 'square', gain: 0.055, octave: 1, attack: 0.004, hold: 0.85, cutoff: 1300, detune: 5,
      steps: [
        0, R, R, R, 7, R, R, R, 0, R, R, R, 7, R, R, R,
        10, R, R, R, 5, R, R, R, 10, R, R, R, 5, R, R, R,
        8, R, R, R, 3, R, R, R, 8, R, R, R, 3, R, R, R,
        10, R, R, R, 12, R, R, R, 14, R, R, R, 15, R, 14, R,
      ],
    },
    {
      wave: 'sawtooth', gain: 0.055, octave: 2, attack: 0.008, hold: 1.2, cutoff: 2100, space: 0.4,
      steps: [
        R, R, R, R, R, R, R, R, R, R, R, R, R, R, R, R,
        24, R, 22, R, 19, R, R, R, R, R, R, R, R, R, R, R,
        R, R, R, R, 20, R, 19, R, 15, R, R, R, R, R, R, R,
        R, R, R, R, R, R, R, R, 19, R, 22, R, 24, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.55,
    kick:  grid('x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x..x ..x. x.xx .xx.'),
    snare: grid('.... x... .... x... .... x... .... x..x .... x... .... x... .... x... .... x.x.'),
    hat:   grid('x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx x.xx'),
  },
}

// Flying Disc — Yosemite. Two phases, a lot of watching a disc travel, so this
// one is wide and slow and stays out of the way of the throw.
const FLYING_DISC: Track = {
  name: 'High Sierra',
  bpm: 104,
  root: 43, // G2
  level: 1.27,
  voices: [
    {
      wave: 'sine', gain: 0.18, octave: 0, attack: 0.012, hold: 1.4, cutoff: 480,
      steps: [
        0, R, R, R, R, R, 7, R, R, R, R, R, 0, R, R, R,
        9, R, R, R, R, R, 16, R, R, R, R, R, 9, R, R, R,
        5, R, R, R, R, R, 12, R, R, R, R, R, 5, R, R, R,
        7, R, R, R, R, R, 14, R, R, R, R, R, 7, R, 11, R,
      ],
    },
    {
      wave: 'triangle', gain: 0.07, octave: 2, attack: 0.12, hold: 4.2, detune: 8, cutoff: 1400, space: 0.5,
      steps: [
        7, R, R, R, R, R, R, R, 11, R, R, R, R, R, R, R,
        16, R, R, R, R, R, R, R, 12, R, R, R, R, R, R, R,
        12, R, R, R, R, R, R, R, 16, R, R, R, R, R, R, R,
        14, R, R, R, R, R, R, R, 18, R, R, R, R, R, R, R,
      ],
    },
    {
      wave: 'sine', gain: 0.08, octave: 3, attack: 0.03, hold: 2.6, cutoff: 2600, space: 0.7,
      steps: [
        R, R, R, R, 19, R, R, R, R, R, 23, R, R, R, R, R,
        R, R, 21, R, R, R, R, R, 19, R, R, R, R, R, R, R,
        R, R, R, R, 24, R, R, R, R, R, 21, R, R, R, R, R,
        R, R, 19, R, R, R, 16, R, R, R, R, R, R, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.26,
    kick:  grid('x... .... .... .... x... .... .... .... x... .... .... .... x... .... .... ....'),
    snare: grid('.... .... o... .... .... .... o... .... .... .... o... .... .... .... o... ....'),
    hat:   grid('.... o... .... o... .... o... .... o... .... o... .... o... .... o... .... o...'),
  },
}

// The menu. Announces the game rather than accompanying it, so it is the
// brightest and the only one that leans on the major sixth.
const MENU: Track = {
  name: 'California Games',
  bpm: 112,
  root: 45, // A2
  level: 0.86,
  voices: [
    {
      wave: 'triangle', gain: 0.15, octave: 0, attack: 0.006, hold: 0.9, cutoff: 560,
      steps: [
        0, R, R, 0, R, 7, R, R, 0, R, R, 0, R, 12, R, R,
        5, R, R, 5, R, 12, R, R, 5, R, R, 5, R, 17, R, R,
        7, R, R, 7, R, 14, R, R, 7, R, R, 7, R, 19, R, R,
        9, R, R, 9, R, 16, R, R, 4, R, R, 4, R, 11, R, R,
      ],
    },
    {
      wave: 'square', gain: 0.04, octave: 2, attack: 0.006, hold: 0.45, cutoff: 2400, space: 0.4, detune: 6,
      steps: x4([R, 12, 16, 21, R, 12, 16, 21, R, 12, 16, 21, R, 16, 12, R]),
    },
    {
      wave: 'triangle', gain: 0.1, octave: 3, attack: 0.015, hold: 2.0, cutoff: 3000, space: 0.6,
      steps: [
        12, R, R, 16, R, R, 21, R, R, R, 19, R, R, R, R, R,
        17, R, R, R, 16, R, R, R, 12, R, R, R, R, R, R, R,
        14, R, R, 19, R, R, 23, R, R, R, 21, R, R, R, R, R,
        16, R, R, R, 12, R, R, R, 9, R, R, R, R, R, R, R,
      ],
    },
  ],
  drums: {
    gain: 0.38,
    kick:  grid('x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... ..x. x... .xx.'),
    snare: grid('.... x... .... x... .... x... .... x... .... x... .... x... .... x... .... x...'),
    hat:   grid('..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o. ..o.'),
  },
}

/** Scene id to track. `registry.ts` ids; anything unlisted plays nothing. */
export const TRACKS: Record<string, Track> = {
  menu: MENU,
  halfpipe: HALF_PIPE,
  footbag: FOOT_BAG,
  surfing: SURFING,
  skating: SKATING,
  bmx: BMX,
  flyingdisc: FLYING_DISC,
}

/* --------------------------------------------------------------- sequencer -- */

/**
 * Read lazily as functions, not captured as values: none of the audio graph
 * exists until the first user gesture unlocks it, and `MusicPlayer` is built
 * long before that.
 */
interface Host {
  context(): AudioContext | null
  musicBus(): GainNode | null
  noiseBuffer(): AudioBuffer | null
}

export class MusicPlayer {
  private host: Host
  private track: Track | null = null
  private timer: number | null = null
  /** Next step index to schedule, and the absolute time it falls on. */
  private step = 0
  private nextTime = 0
  private enabled: boolean
  /** Per-track output trim and the shared delay send, rebuilt per track. */
  private out: GainNode | null = null
  private delaySend: GainNode | null = null

  constructor(host: Host, enabled: boolean) {
    this.host = host
    this.enabled = enabled
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  /** Current track's display name, for a toast or a menu line. */
  get nowPlaying(): string | null {
    return this.track?.name ?? null
  }

  /**
   * Switch tunes. Safe before the context exists — the id is remembered and
   * `play` is re-entered from `App` once audio unlocks on the first gesture.
   */
  play(sceneId: string): void {
    const next = TRACKS[sceneId] ?? null
    if (next === this.track && this.timer !== null) return
    this.stopAudio()
    this.track = next
    if (!next || !this.enabled) return
    this.start()
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      if (this.track) this.start()
    } else {
      this.stopAudio()
    }
  }

  /** Full stop, e.g. on teardown. Keeps the selected track for a later resume. */
  stop(): void {
    this.stopAudio()
  }

  private start(): void {
    const ctx = this.host.context()
    const bus = this.host.musicBus()
    if (!ctx || !bus || !this.track || this.timer !== null) return

    // Per-track chain: trim -> bus, plus a feedback delay that every voice can
    // send to. One delay shared across voices is what makes three cheap
    // oscillators sound like a room rather than three cheap oscillators.
    const out = ctx.createGain()
    out.gain.value = this.track.level ?? 0.85
    out.connect(bus)

    const delay = ctx.createDelay(1.0)
    delay.delayTime.value = (60 / this.track.bpm) * 0.75
    const fb = ctx.createGain()
    fb.gain.value = 0.32
    const damp = ctx.createBiquadFilter()
    damp.type = 'lowpass'
    damp.frequency.value = 2200
    const send = ctx.createGain()
    send.gain.value = 1
    send.connect(delay)
    delay.connect(damp)
    damp.connect(fb)
    fb.connect(delay)
    damp.connect(out)

    this.out = out
    this.delaySend = send
    this.step = 0
    this.nextTime = ctx.currentTime + 0.08
    this.timer = window.setInterval(this.tick, TICK_MS)
  }

  private stopAudio(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    const ctx = this.host.context()
    if (this.out && ctx) {
      // Ramp rather than disconnect: notes already scheduled are still running
      // and yanking the node out from under them clicks.
      const g = this.out
      g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05)
      window.setTimeout(() => g.disconnect(), 500)
    }
    this.out = null
    this.delaySend = null
  }

  private tick = (): void => {
    const ctx = this.host.context()
    const track = this.track
    if (!ctx || !track || !this.out) return
    const stepDur = 60 / track.bpm / 4
    const horizon = ctx.currentTime + LOOKAHEAD
    // Bounded so a tab that was suspended for a minute does not try to schedule
    // a minute of music in one tick.
    let guard = 0
    while (this.nextTime < horizon && guard++ < 96) {
      this.scheduleStep(track, this.step, this.nextTime, stepDur)
      const swing = track.swing ?? 0
      // Swing delays the odd sixteenths and shortens the following even one, so
      // the bar length is unchanged.
      const isOdd = this.step % 2 === 1
      this.nextTime += stepDur * (isOdd ? 1 - swing : 1 + swing)
      this.step++
    }
    if (this.nextTime < ctx.currentTime) this.nextTime = ctx.currentTime + 0.02
  }

  private scheduleStep(track: Track, step: number, when: number, stepDur: number): void {
    for (const v of track.voices) {
      const n = v.steps[step % v.steps.length]
      if (n === null || n === undefined) continue
      this.note(hz(track.root + v.octave * 12 + n), when, stepDur * v.hold, v)
    }
    const d = track.drums
    if (!d) return
    const len = d.kick.length || STEPS_PER_BAR
    const i = step % len
    const dg = d.gain ?? 0.5
    if (d.kick[i]) this.kick(when, dg * d.kick[i])
    if (d.snare[i]) this.snare(when, dg * d.snare[i])
    if (d.hat[i]) this.hat(when, dg * d.hat[i])
  }

  private note(freq: number, when: number, dur: number, v: Voice): void {
    const ctx = this.host.context()
    if (!ctx || !this.out) return
    const env = ctx.createGain()
    const attack = Math.min(v.attack, dur * 0.4)
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(v.gain, when + attack)
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur)

    let tail: AudioNode = env
    if (v.cutoff) {
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = v.cutoff
      f.Q.value = 0.6
      env.connect(f)
      tail = f
    }
    tail.connect(this.out)
    if (v.space && this.delaySend) {
      const s = ctx.createGain()
      s.gain.value = v.space
      tail.connect(s)
      s.connect(this.delaySend)
    }

    const mk = (cents: number): void => {
      const o = ctx.createOscillator()
      o.type = v.wave
      o.detune.value = cents
      o.frequency.setValueAtTime(freq, when)
      o.connect(env)
      o.start(when)
      o.stop(when + dur + 0.03)
    }
    mk(0)
    if (v.detune) mk(v.detune)
  }

  private kick(when: number, gain: number): void {
    const ctx = this.host.context()
    if (!ctx || !this.out) return
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.setValueAtTime(128, when)
    o.frequency.exponentialRampToValueAtTime(42, when + 0.11)
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(gain * 0.5, when + 0.004)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.19)
    o.connect(env)
    env.connect(this.out)
    o.start(when)
    o.stop(when + 0.22)
  }

  private snare(when: number, gain: number): void {
    const ctx = this.host.context()
    const buf = this.host.noiseBuffer()
    if (!ctx || !buf || !this.out) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const f = ctx.createBiquadFilter()
    f.type = 'bandpass'
    f.frequency.value = 1750
    f.Q.value = 0.9
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(gain * 0.3, when + 0.003)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.14)
    src.connect(f)
    f.connect(env)
    env.connect(this.out)
    src.start(when, Math.random() * 1.2, 0.2)
    src.stop(when + 0.2)
  }

  private hat(when: number, gain: number): void {
    const ctx = this.host.context()
    const buf = this.host.noiseBuffer()
    if (!ctx || !buf || !this.out) return
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const f = ctx.createBiquadFilter()
    f.type = 'highpass'
    f.frequency.value = 7200
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, when)
    env.gain.exponentialRampToValueAtTime(gain * 0.14, when + 0.002)
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.05)
    src.connect(f)
    f.connect(env)
    env.connect(this.out)
    src.start(when, Math.random() * 1.2, 0.08)
    src.stop(when + 0.08)
  }
}
