import type { Rng } from '../../../core/Rng'

/**
 * The BMX course.
 *
 * Same idea as the half pipe's `Ramp`: the rider is a bead on a wire and the
 * ground is one continuous curve, so the on-ground physics is one dimensional —
 * gravity is a scalar along the tangent and there is no special case anywhere.
 * The difference is that this wire never ends, so instead of baking a fixed
 * profile it is *generated ahead of the camera and recycled behind it*.
 *
 * Storage is a ring of height samples at a uniform 8px spacing in world x. Dirt
 * jumps never overhang, so height is a genuine function of x, which buys an O(1)
 * lookup (no binary search) and makes the landing test a simple `y >= ground`.
 * Arc length is still what the rider moves by — `dx = v * cos(angle) * dt` is
 * exactly arc-length motion projected onto x.
 *
 * The course is not noise. It is a sequence of named features — rollers, whoops,
 * tabletops, doubles, step-ups, step-downs, dips — laid down by a small grammar
 * that always gives the player a run-in before a jump and a run-out after it.
 * That run-in is most of what separates a course that feels *designed* from a
 * height field that happens to be bumpy.
 */

/** World-x spacing between samples. Fine enough that the polyline never facets. */
export const STEP = 8
/** Ring capacity in samples. Power of two so the wrap is a mask. 2048*8 = 16.4k px. */
const RING = 2048
const MASK = RING - 1
const TAU = Math.PI * 2

/** Feature kinds, also used to label what the rider launched off. */
export const Feature = {
  Flat: 0,
  Roller: 1,
  Whoops: 2,
  Tabletop: 3,
  Double: 4,
  StepUp: 5,
  StepDown: 6,
  Dip: 7,
} as const
export type FeatureId = (typeof Feature)[keyof typeof Feature]

export const FEATURE_NAMES: readonly string[] = [
  'FLAT', 'ROLLER', 'WHOOPS', 'TABLETOP', 'DOUBLE', 'STEP-UP', 'STEP-DOWN', 'DIP',
]

/** Sample is on a takeoff face: this is where a pop pays off. */
export const FLAG_LIP = 1
/** Sample is a deck, gap or landing: keep scenery off it. */
export const FLAG_DECK = 2
/** Sample is too steep to stand a prop on. */
export const FLAG_STEEP = 4

/** Ground level is kept inside this band so the backdrop framing stays sane. */
const MIN_LEVEL = 690
const MAX_LEVEL = 980

/** Features that carry real consequence. */
const BIG_BAG: FeatureId[] = [
  Feature.Tabletop, Feature.Double, Feature.StepUp, Feature.StepDown,
  Feature.Double, Feature.Tabletop,
]
/** Features that give the player speed back. */
const SMALL_BAG: FeatureId[] = [Feature.Roller, Feature.Whoops, Feature.Dip, Feature.Roller]

export class Course {
  /** World x of the first sample the ring still holds. */
  private tailK = 0
  /** World x index one past the last generated sample. */
  private headK = 0

  private readonly ys = new Float32Array(RING)
  private readonly angles = new Float32Array(RING)
  private readonly flags = new Uint8Array(RING)
  private readonly kinds = new Uint8Array(RING)

  private level = 860
  private originX = 0
  private lastKind: number = Feature.Flat
  /** Features emitted since the last consequential one. Forces variety. */
  private sinceBig = 0

  constructor(private readonly rng: Rng) {
    this.reset()
  }

  /** Rebuild from scratch, e.g. on a fresh run. Reuses the arrays. */
  reset(startX = 0, startLevel = 860): void {
    this.tailK = this.headK = Math.floor(startX / STEP)
    this.originX = this.headK * STEP
    this.level = startLevel
    this.lastKind = Feature.Flat
    this.sinceBig = 0
    // Seed one sample so `push` always has a predecessor to smooth against.
    this.ys[this.headK & MASK] = startLevel
    this.angles[this.headK & MASK] = 0
    this.flags[this.headK & MASK] = 0
    this.kinds[this.headK & MASK] = Feature.Flat
    this.headK++
    // A long clean straight to roll out of: the player needs to feel the bike
    // before the course starts asking questions.
    this.flat(760)
  }

  // ------------------------------------------------------------- generation

  /** Make sure terrain exists out to `x`. Cheap when it already does. */
  ensureTo(x: number): void {
    let guard = 0
    while (this.headK * STEP < x && guard++ < 64) this.nextFeature()
  }

  get startX(): number { return this.tailK * STEP }
  get endX(): number { return (this.headK - 1) * STEP }

  /**
   * One beat of the course grammar: a run-in, then a feature.
   *
   * The run-in is not filler. It is the only place the player can choose a
   * speed, and choosing a speed is the whole game — so every feature gets one.
   */
  private nextFeature(): void {
    const rng = this.rng
    // Difficulty ramps over the first ~9k px, then holds. The course should
    // still be rideable at minute one and still interesting at minute two.
    const prog = Math.min(1, (this.headK * STEP - this.originX) / 9000)
    const scale = 0.64 + 0.36 * prog

    this.flat(rng.range(200, 340))

    const forceBig = this.sinceBig >= 3
    const bag = forceBig || rng.chance(0.52) ? BIG_BAG : SMALL_BAG
    let kind = rng.pick(bag)
    // A single reroll is enough to stop the course droning on one idea without
    // making the distribution feel artificially shuffled.
    if (kind === this.lastKind) kind = rng.pick(bag)
    this.lastKind = kind

    switch (kind) {
      case Feature.Roller:
        this.roller(rng.range(70, 106) * scale, rng.range(330, 440))
        this.sinceBig++
        break
      case Feature.Whoops:
        this.whoops(rng.int(3, 5), rng.range(40, 60) * scale)
        this.sinceBig++
        break
      case Feature.Dip:
        this.dip(rng.range(56, 94) * scale, rng.range(320, 440))
        this.sinceBig++
        break
      case Feature.Tabletop:
        this.tabletop(rng.range(80, 122) * scale, rng.range(140, 240))
        this.sinceBig = 0
        break
      case Feature.Double:
        this.double(rng.range(86, 126) * scale, rng.range(190, 340) * scale)
        this.sinceBig = 0
        break
      case Feature.StepUp:
        this.stepUp(rng.range(82, 118) * scale, rng.range(64, 100) * scale)
        this.sinceBig = 0
        break
      default:
        this.stepDown(rng.range(90, 150) * scale)
        this.sinceBig = 0
        break
    }
    // Run-out. Land, breathe, set up for the next one.
    this.flat(rng.range(200, 300))
  }

  /** Append `n` samples; `f(t, k)` returns the absolute height at each. */
  private run(lenPx: number, flags: number, kind: FeatureId, f: (t: number, k: number) => number): void {
    const n = Math.max(2, Math.round(lenPx / STEP))
    const k0 = this.headK
    for (let i = 1; i <= n; i++) this.push(f(i / n, k0 + i - 1), flags, kind)
    this.refreshAngles(k0)
  }

  private push(y: number, flags: number, kind: FeatureId): void {
    const k = this.headK
    this.ys[k & MASK] = y
    this.flags[k & MASK] = flags
    this.kinds[k & MASK] = kind
    this.headK = k + 1
    // Overwriting the oldest sample is the whole recycling story: the scene
    // graph and the height field are both bounded no matter how far you ride.
    if (this.headK - this.tailK > RING) this.tailK = this.headK - RING
  }

  /** Recompute tangents over the freshly written span plus its seam. */
  private refreshAngles(fromK: number): void {
    const lo = Math.max(this.tailK + 1, fromK - 1)
    const hi = this.headK - 1
    for (let k = lo; k < hi; k++) {
      const dy = this.ys[(k + 1) & MASK] - this.ys[(k - 1) & MASK]
      this.angles[k & MASK] = Math.atan2(dy, STEP * 2)
    }
    if (hi >= lo) this.angles[hi & MASK] = this.angles[(hi - 1) & MASK]
  }

  // ------------------------------------------------------------- the features

  /** Rideable straight with a breath of undulation, so it never reads as a ruler. */
  private flat(lenPx: number): void {
    const base = this.level
    this.run(lenPx, 0, Feature.Flat, (_t, k) =>
      base + Math.sin(k * 0.085) * 4.5 + Math.sin(k * 0.0271 + 1.3) * 3)
  }

  /** A single smooth hump. Fast enough over the crest and it launches you. */
  private roller(h: number, lenPx: number): void {
    const base = this.level
    this.run(lenPx, 0, Feature.Roller, (t) => base - h * (0.5 - 0.5 * Math.cos(TAU * t)))
  }

  /** A rhythm section. Pump these and you arrive at the next jump carrying speed. */
  private whoops(count: number, h: number): void {
    const base = this.level
    this.run(count * 190, 0, Feature.Whoops, (t) => base - h * (0.5 - 0.5 * Math.cos(TAU * count * t)))
  }

  /** A compression. Free speed, and the one place a preload feels wrong. */
  private dip(d: number, lenPx: number): void {
    const base = this.level
    this.run(lenPx, 0, Feature.Dip, (t) => base + d * (0.5 - 0.5 * Math.cos(TAU * t)))
  }

  /**
   * Takeoff lip. `pow(t, 1.7)` means the face starts tangent to the ground and
   * ends at its steepest — which is what a real dirt lip does, and why leaving
   * one throws you up rather than just forward.
   *
   * Length is derived from height so the steepest point lands around 40 degrees
   * whatever the jump size. Every face in this file is sized the same way: no
   * feature is ever allowed to become a wall the rider cannot ride back out of,
   * because a course that can trap you is not a course.
   */
  private lipFace(h: number): void {
    const base = this.level
    this.run(1.55 * h + 46, FLAG_LIP | FLAG_STEEP, this.lastKind as FeatureId,
      (t) => base - h * Math.pow(t, 1.7))
  }

  /** A slope-limited face between two levels, rounded at both ends. */
  private face(from: number, to: number, flags: number, kind: FeatureId, slack: number): void {
    const d = Math.abs(to - from)
    this.run(slack * d + 56, flags, kind, (t) => from + (to - from) * ease(t))
  }

  /** Steep lip, flat deck, ramp back down. Under-jump it and you case the deck. */
  private tabletop(h: number, deckLen: number): void {
    const base = this.level
    this.lipFace(h)
    this.run(deckLen, FLAG_DECK, Feature.Tabletop, () => base - h)
    this.run(1.5 * h + 70, FLAG_DECK, Feature.Tabletop, (t) => base - h * Math.pow(1 - t, 1.55))
  }

  /**
   * Lip, gap, landing mound. The landing's near face is the hazard — come up
   * short and you meet it nose-first, which the landing judge reads as a crash.
   */
  private double(h: number, gapLen: number): void {
    const base = this.level
    const pit = base + 10
    const top = base - h * 0.8
    this.lipFace(h)
    // Back side of the takeoff mound: falls away hard enough that the launch is
    // a commitment, shallow enough to roll back out of if you stall on it.
    this.face(base - h, pit, FLAG_DECK | FLAG_STEEP, Feature.Double, 1.35)
    this.run(gapLen, FLAG_DECK, Feature.Double, () => pit)
    this.face(pit, top, FLAG_DECK | FLAG_STEEP, Feature.Double, 1.4)
    this.face(top, base, FLAG_DECK, Feature.Double, 1.9)
  }

  /** Jump up onto a higher shelf. The ground level actually changes. */
  private stepUp(h: number, rise: number): void {
    const base = this.level
    const newLevel = this.clampLevel(base - rise)
    const pit = base + 10
    this.lipFace(h)
    this.face(base - h, pit, FLAG_DECK | FLAG_STEEP, Feature.StepUp, 1.35)
    this.run(180, FLAG_DECK, Feature.StepUp, () => pit)
    // The shelf edge is rounded over rather than square, so the landing has an
    // angle to match instead of a kerb to hit.
    this.face(pit, newLevel - 22, FLAG_DECK | FLAG_STEEP, Feature.StepUp, 1.4)
    this.face(newLevel - 22, newLevel, FLAG_DECK, Feature.StepUp, 2.4)
    this.level = newLevel
  }

  /** A kicker at the edge of a drop. Huck it or roll it. */
  private stepDown(drop: number): void {
    const base = this.level
    const newLevel = this.clampLevel(base + drop)
    this.run(96, FLAG_LIP, Feature.StepDown, (t) => base - 24 * Math.pow(t, 1.6))
    const lipY = base - 24
    this.run(250, FLAG_DECK, Feature.StepDown, (t) => lipY + (newLevel - lipY) * (1 - Math.pow(1 - t, 1.45)))
    this.level = newLevel
  }

  private clampLevel(v: number): number {
    return v < MIN_LEVEL ? MIN_LEVEL : v > MAX_LEVEL ? MAX_LEVEL : v
  }

  /**
   * Steepest slope anywhere in the live window, radians.
   *
   * The invariant every feature above is sized to hold: nothing exceeds about
   * 45 degrees, so there is no face the rider cannot ride back out of. Exposed
   * so it can be asserted from outside rather than only trusted.
   */
  maxSlope(): number {
    let worst = 0
    for (let k = this.tailK; k < this.headK; k++) {
      const a = Math.abs(this.angles[k & MASK])
      if (a > worst) worst = a
    }
    return worst
  }

  // ----------------------------------------------------------------- sampling

  /** Sample index at or before world x, clamped to the live window. */
  kFor(x: number): number {
    const k = Math.floor(x / STEP)
    const lo = this.tailK
    const hi = this.headK - 2
    return k < lo ? lo : k > hi ? hi : k
  }

  yK(k: number): number { return this.ys[k & MASK] }
  angleK(k: number): number { return this.angles[k & MASK] }
  flagK(k: number): number { return this.flags[k & MASK] }
  kindK(k: number): number { return this.kinds[k & MASK] }

  /** Ground height at world x. */
  yAt(x: number): number {
    const k = this.kFor(x)
    const t = Math.min(1, Math.max(0, x / STEP - k))
    const a = this.ys[k & MASK]
    return a + (this.ys[(k + 1) & MASK] - a) * t
  }

  /** Tangent direction at world x, radians, y growing downward. */
  angleAt(x: number): number {
    const k = this.kFor(x)
    const t = Math.min(1, Math.max(0, x / STEP - k))
    const a = this.angles[k & MASK]
    // Neighbouring tangents never differ by anything near pi, so a plain lerp
    // is both correct and cheaper than a shortest-path one.
    return a + (this.angles[(k + 1) & MASK] - a) * t
  }

  /**
   * Curvature (d(angle)/ds) at world x. Positive means the ground is falling
   * away beneath you — a crest. This is what decides whether the rider leaves
   * the ground: a bead on a wire flies when `v^2 * curvature > g * cos(angle)`,
   * which is why speed, and only speed, turns a roller into a jump.
   */
  curvatureAt(x: number): number {
    const k = this.kFor(x)
    const lo = Math.max(this.tailK, k - 1)
    const hi = Math.min(this.headK - 1, k + 1)
    const da = this.angles[hi & MASK] - this.angles[lo & MASK]
    const ds = ((hi - lo) * STEP) / Math.max(0.35, Math.cos(this.angles[k & MASK]))
    return ds > 1e-6 ? da / ds : 0
  }

  flagsAt(x: number): number { return this.flags[this.kFor(x) & MASK] }
  kindAt(x: number): number { return this.kinds[this.kFor(x) & MASK] }

  /**
   * How good a lip this is to pop off, 0..1.
   *
   * A pop is worth full value on a takeoff face that is about to fall away, and
   * close to nothing in the bottom of a dip. Blending the flag with the actual
   * curvature just ahead means the window rewards *timing* rather than standing
   * on a particular sample.
   */
  lipQuality(x: number): number {
    const ahead = this.curvatureAt(x + 34)
    const here = this.curvatureAt(x + 6)
    const curve = Math.max(here, ahead)
    // 0.0022 rad/px is about the crest of a mid-sized roller.
    const fromCurve = Math.min(1, Math.max(0, curve / 0.0022))
    const onFace = (this.flagsAt(x) & FLAG_LIP) !== 0 ? 0.55 : 0
    const upslope = Math.min(1, Math.max(0, -this.angleAt(x) / 0.5)) * 0.35
    return Math.min(1, fromCurve * 0.8 + onFace + upslope * (onFace > 0 ? 1 : 0.4))
  }
}

/** Smoothstep, used for every slope-limited face. Flat at both ends. */
const ease = (t: number): number => t * t * (3 - 2 * t)
