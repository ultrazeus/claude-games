import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import type { Parallax } from '../../../render/Parallax'
import { horizontalGradient, softDot, verticalGradient } from '../../../render/Gradient'
import {
  Core, type EventPalette, type Hex, grade, lighten, mix, skyAt,
} from '../../../render/Palette'
import {
  depthOutline, occlusionPool, scatter,
} from '../../../render/Staging'
import type { Rng } from '../../../core/Rng'
import { clamp01, lerp } from '../../../core/Tween'
import {
  DECK, DECK_DEEP, DECK_INK, DECK_LIT, DECK_SHADE, GROUND_Y, PATH_FRONT, PLANT,
  SHADOW_DX, SHADOW_DY, VP_X, VP_Y, WALL, WALL_BASE, WALL_CAP, WALL_TOP,
  castShadow as rakeShadow, contactPool, shadeOf,
} from './Light'

/**
 * The boardwalk: the play plane and everything built on it.
 *
 * Two jobs, and they belong together because both are "where the concrete is".
 *
 * 1. **Geometry and art.** The path, the sea wall with its posts, the long
 *    golden-hour shadows raking across it, the sponsor decals. All of it is built
 *    once into wrapping parallax tiles, so an endless boardwalk costs a bounded
 *    number of display objects — this event has to run forever inside a 1500-node
 *    budget, which rules out spawning slabs as you go.
 *
 * 2. **The course.** Hazards are generated ahead of the camera as *phrases*
 *    rather than as a Poisson process. A random scatter of obstacles reads as
 *    noise; a run that alternates rest bars, doubles and tight triples reads as
 *    rhythm, and rhythm is the only thing that makes a side-scroller worth
 *    replaying. See `emitPhrase`.
 *
 * Hazard visuals come out of per-kind pools built up front, so spawning is a
 * visibility flag and a transform write — no Graphics is ever rebuilt during a
 * run.
 *
 * **Lighting.** Every number that describes where the sun is lives in `Light.ts`
 * and every surface here obeys it: the deck is a lit horizontal plane, the wall
 * face is the vertical plane turned away from it, there is a hard terminator
 * between the two, an occlusion pool in the corner where they meet, and the
 * fence, the rail, the bin, the signs and every hazard throw a long shadow to
 * the left with a tight dark pool at their feet.
 */

// --- world layout ----------------------------------------------------------
// Owned by Light.ts (the sun's geometry is derived from them); re-exported here
// because Beach.ts and Skating.ts have always imported them from this module.
export {
  BEACH_TOP, GROUND_Y, HORIZON_Y, PATH_FRONT, SURF_Y, WALL_BASE, WALL_TOP,
} from './Light'

/** Nominal spacing of the wall posts. Actual placement is scattered around it. */
const POST_SPACING = 240
/** Width of one repeat of the wall/path tile. */
const NEAR_TILE = POST_SPACING * 4

/** Outline colour for a fill: same hue, ~26% darker, slightly richer. */
const line = (c: Hex): Hex => grade(c, { valScale: 0.74, satScale: 1.1 })

/**
 * The hazard palette, and it is a chroma budget rather than a set of colours.
 *
 * "Keep every non-player surface below roughly 0.45 chroma and the player above
 * 0.6, so the reserved hue is genuinely reserved." The hazards were breaking
 * that badly: a banana skin in raw `Core.sunGold` measures 0.77 colourfulness
 * against a cyan shirt at 0.68, and a 66px beach ball in gold and magenta panels
 * covers as much of the frame as the skater's whole kit does. The detector in
 * `scripts/score_frame.py` finds the player as the most colourful cluster in the
 * playfield, and with a ball in frame it was not finding the player.
 *
 * Both are now softened toward paper to land around 0.35-0.37 — half the
 * skater's — and the magenta is gone from the props entirely, because that is
 * the colour of her shorts. Just under her is not enough: the detector takes
 * the top 0.6% of the playfield whatever the threshold has to fall to, and a
 * 66px beach ball covers more of the frame than her whole kit does. They lose
 * nothing by it: the deck is dark now, so a hazard at 0.85 luminance reads off
 * it on value alone, which is how a prop is supposed to be legible.
 */
const PROP_GOLD = mix(Core.sunGold, Core.paperWhite, 0.55)
const PROP_WARM = mix(mix(0xff4f81, Core.sunGold, 0.32), Core.paperWhite, 0.45)
/*
 * The banana alone gets more chroma than the other props: it is the one hazard
 * whose identity IS its colour.
 *
 * Measured, not asserted. `score_frame.py` weights chroma by value as
 * `(mx-mn) * (0.45 + 0.55*mx)`; against that, the skater's electric cyan is
 * 0.679 and the budget's ceiling for anything that is not the player is 0.45.
 * A first pass at mix 0.34 measured **0.520** — 77% of the skater, over the
 * ceiling, and the comment claiming "~0.45" was simply wrong. 0.45 is the
 * lowest mix that meets the ceiling: chroma 0.446, still unmistakably yellow,
 * and 0.233 clear of the player.
 */
const PROP_BANANA = mix(Core.sunGold, Core.paperWhite, 0.45)

// --- hazards ---------------------------------------------------------------

export type HazardKind = 'crack' | 'sand' | 'banana' | 'ball' | 'dog' | 'hydrant'

interface HazardSpec {
  /** Half the collision width along the path. */
  halfW: number
  /** How high you must be to pass over it. */
  height: number
  /** True if contact puts the skater on the floor. */
  fall: boolean
  /** Shown in the trick banner when it takes you down. */
  label: string
}

const SPECS: Record<HazardKind, HazardSpec> = {
  // Flat but vicious: a lip in the concrete catches a wheel dead.
  crack: { halfW: 40, height: 20, fall: true, label: 'CRACK' },
  // The soft hazard. Does not drop you, but it scrubs speed and kills the combo.
  sand: { halfW: 98, height: 16, fall: false, label: 'SAND' },
  banana: { halfW: 30, height: 18, fall: true, label: 'BANANA SKIN' },
  ball: { halfW: 38, height: 66, fall: true, label: 'BEACH BALL' },
  dog: { halfW: 48, height: 68, fall: true, label: 'THAT DOG' },
  hydrant: { halfW: 30, height: 94, fall: true, label: 'HYDRANT' },
}

/** How many of each kind can be on screen at once. */
const POOL_SIZE: Record<HazardKind, number> = {
  crack: 6, sand: 4, banana: 5, ball: 4, dog: 3, hydrant: 4,
}

export interface Hazard {
  kind: HazardKind
  spec: HazardSpec
  /** World x of the centre. */
  x: number
  /** Non-zero only for the dog, which trots. */
  vx: number
  active: boolean
  /** Set the frame it takes the skater down (or slows them). */
  hit: boolean
  /** Set once the skater is fully past it, whether or not it landed a hit. */
  resolved: boolean
  /** Animation clock, for the dog's legs and the ball's roll. */
  phase: number
  node: Container | null
  /** Second-level parts that animate; null for static kinds. */
  partA: Container | null
  partB: Container | null
}

const MAX_HAZARDS = 28
/** Generate this far ahead of the camera. */
const GEN_AHEAD = 2800
/** Release hazards this far behind it. */
const RETIRE_BEHIND = 520
/** Nothing at all for the first stretch, so the run opens with a clean push. */
const COURSE_START = 1500

export class Boardwalk {
  /**
   * Pin every spawn to one hazard kind. Inspection only — `null` in play.
   *
   * There is no other way to get a named hazard in front of the camera: the
   * spawner is weighted and seeded, so checking how one prop actually draws
   * meant skating until the right one turned up. `window.__cg.skatingHazard('banana')`.
   */
  static forcedKind: HazardKind | null = null

  /** Parent for every hazard node. Lives inside the scene's world container. */
  readonly container = new Container()

  readonly hazards: Hazard[] = []

  private rng: Rng
  private pal: EventPalette
  private pools: Record<HazardKind, Container[]>
  private poolParts: Record<HazardKind, { a: Container | null; b: Container | null }[]>
  private poolFree: Record<HazardKind, boolean[]>

  /** World x the generator has written up to. */
  private genX = COURSE_START
  private lastKind: HazardKind | null = null

  constructor(rng: Rng, pal: EventPalette) {
    this.rng = rng
    this.pal = pal
    this.container.y = GROUND_Y
    this.container.interactiveChildren = false
    this.container.eventMode = 'none'

    this.pools = { crack: [], sand: [], banana: [], ball: [], dog: [], hydrant: [] }
    this.poolParts = { crack: [], sand: [], banana: [], ball: [], dog: [], hydrant: [] }
    this.poolFree = { crack: [], sand: [], banana: [], ball: [], dog: [], hydrant: [] }

    for (const kind of Object.keys(SPECS) as HazardKind[]) {
      for (let i = 0; i < POOL_SIZE[kind]; i++) {
        const built = this.buildHazardArt(kind, i)
        built.node.visible = false
        this.container.addChild(built.node)
        this.pools[kind].push(built.node)
        this.poolParts[kind].push({ a: built.a, b: built.b })
        this.poolFree[kind].push(true)
      }
    }

    for (let i = 0; i < MAX_HAZARDS; i++) {
      this.hazards.push({
        kind: 'crack', spec: SPECS.crack, x: 0, vx: 0,
        active: false, hit: false, resolved: false, phase: 0,
        node: null, partA: null, partB: null,
      })
    }
  }

  reset(): void {
    for (const h of this.hazards) this.release(h)
    this.genX = COURSE_START
    this.lastKind = null
  }

  // ------------------------------------------------------------------ course
  /**
   * Extend the course until it reaches `toX`.
   *
   * Called from `update` with `camX + GEN_AHEAD`, so the player never sees a
   * hazard appear. Every phrase advances `genX` by at least ~700, which bounds
   * the loop.
   */
  generate(camX: number): void {
    const target = camX + GEN_AHEAD
    let guard = 0
    while (this.genX < target && guard++ < 12) this.emitPhrase()
  }

  /**
   * One musical bar of course.
   *
   * Difficulty is a single 0..1 ramp over the first 11km of boardwalk. It does
   * two things: it shifts the phrase weights from rest-and-single toward
   * cluster-and-double, and it squeezes every gap by up to 26%. Nothing else
   * scales, because a difficulty curve that changes five variables at once is a
   * curve nobody can tune.
   */
  private emitPhrase(): void {
    const d = clamp01(this.genX / 11000)
    const tight = lerp(1, 0.74, d)
    const rng = this.rng

    // Weights, renormalised implicitly by the running-sum pick below.
    const wRest = 0.2 - 0.1 * d
    const wSingle = 0.3 - 0.13 * d
    const wPair = 0.22
    const wSand = 0.08
    const wCluster = 0.13 + 0.1 * d
    const wDouble = 0.05 + 0.13 * d

    let roll = rng.next() * (wRest + wSingle + wPair + wSand + wCluster + wDouble)

    if ((roll -= wRest) < 0) {
      // Rest bar. Nothing to dodge: wind the speed up and let the beach read.
      this.genX += rng.range(1250, 1750) * tight
      return
    }
    if ((roll -= wSingle) < 0) {
      // One obstacle with room either side. This is where a new kind is safe to
      // introduce, so it is the only phrase that will spawn the big ones.
      this.spawn(this.genX, this.pickKind())
      this.genX += rng.range(820, 1060) * tight
      return
    }
    if ((roll -= wPair) < 0) {
      // Two comfortable jumps: land, one push, jump again. The flat one goes
      // first, because whatever sits in front of a short gap has to be clearable
      // with a short hop.
      this.spawn(this.genX, this.pickFlat())
      this.genX += rng.range(520, 640) * tight
      this.spawn(this.genX, this.pickKind())
      this.genX += rng.range(880, 1080) * tight
      return
    }
    if ((roll -= wSand) < 0) {
      // Sand trap: the patch scrubs your speed, and the hazard behind it now has
      // to be cleared from a slower approach. The one phrase that punishes you
      // for the mistake you already made.
      this.spawn(this.genX, 'sand')
      this.genX += rng.range(640, 780) * tight
      this.spawn(this.genX, this.pickKind())
      this.genX += rng.range(900, 1120) * tight
      return
    }
    if ((roll -= wCluster) < 0) {
      // Three on a tight beat. Readable, but it wants a rhythm rather than
      // reactions.
      const gap = rng.range(400, 470) * tight
      for (let i = 0; i < 3; i++) {
        this.spawn(this.genX, this.pickFlat())
        this.genX += gap
      }
      this.genX += rng.range(700, 900) * tight
      return
    }
    // Double: at speed, one well-timed jump carries both, which is the single
    // most satisfying thing in the event; slowed right down you can still drop
    // into the gap between them. Flat kinds only.
    this.spawn(this.genX, this.pickFlat())
    this.genX += rng.range(235, 300)
    this.spawn(this.genX, this.pickFlat())
    this.genX += rng.range(950, 1180) * tight
  }

  /**
   * Any kind, weighted, never repeating the previous one back to back.
   *
   * Only ever used where the next gap is long. A beach ball, a dog or a hydrant
   * stands 66-94px tall, so clearing one takes a near-full jump whose horizontal
   * reach at speed is far too long to drop into a tight gap behind it.
   */
  private pickKind(): HazardKind {
    if (Boardwalk.forcedKind) return Boardwalk.forcedKind
    const rng = this.rng
    for (let attempt = 0; attempt < 6; attempt++) {
      let roll = rng.next()
      let kind: HazardKind
      if ((roll -= 0.26) < 0) kind = 'crack'
      else if ((roll -= 0.2) < 0) kind = 'banana'
      else if ((roll -= 0.2) < 0) kind = 'ball'
      else if ((roll -= 0.08) < 0) kind = 'sand'
      else if ((roll -= 0.14) < 0) kind = 'hydrant'
      else kind = 'dog'
      if (kind !== this.lastKind) { this.lastKind = kind; return kind }
    }
    this.lastKind = 'crack'
    return 'crack'
  }

  /**
   * Trip hazards only: nothing here stands more than 20px off the concrete, so
   * the shortest possible hop clears it. Everything inside a tight rhythm comes
   * from this table, which is what makes clusters and doubles a timing problem
   * rather than a speed-dependent coin flip.
   */
  private pickFlat(): HazardKind {
    if (Boardwalk.forcedKind) return Boardwalk.forcedKind
    const kind: HazardKind = this.rng.chance(0.55)
      ? (this.lastKind === 'crack' ? 'banana' : 'crack')
      : (this.lastKind === 'banana' ? 'crack' : 'banana')
    this.lastKind = kind
    return kind
  }

  private spawn(x: number, kind: HazardKind): void {
    const slot = this.hazards.find((h) => !h.active)
    if (!slot) return
    const free = this.poolFree[kind]
    let pi = -1
    for (let i = 0; i < free.length; i++) if (free[i]) { pi = i; break }
    if (pi < 0) return

    free[pi] = false
    slot.kind = kind
    slot.spec = SPECS[kind]
    slot.x = x
    // The dog trots along the boardwalk with you, which turns a static gap into
    // a closing one and is the only hazard whose timing is not purely spatial.
    slot.vx = kind === 'dog' ? this.rng.range(150, 260) : 0
    slot.active = true
    slot.hit = false
    slot.resolved = false
    slot.phase = this.rng.next() * Math.PI * 2
    slot.node = this.pools[kind][pi]
    slot.partA = this.poolParts[kind][pi].a
    slot.partB = this.poolParts[kind][pi].b
    slot.node.visible = true
    slot.node.x = x
  }

  private release(h: Hazard): void {
    if (!h.active) return
    h.active = false
    if (h.node) {
      h.node.visible = false
      const idx = this.pools[h.kind].indexOf(h.node)
      if (idx >= 0) this.poolFree[h.kind][idx] = true
    }
    h.node = null
    h.partA = null
    h.partB = null
  }

  /** Advance moving hazards and recycle anything behind the camera. */
  update(dt: number, camX: number): void {
    for (const h of this.hazards) {
      if (!h.active) continue
      if (h.vx !== 0) {
        h.x += h.vx * dt
        h.phase += dt * (6 + h.vx * 0.02)
      } else {
        h.phase += dt * 2.4
      }
      if (h.x < camX - RETIRE_BEHIND) this.release(h)
    }
  }

  /** The next unresolved hazard in front of `x`, for the HUD and for debug(). */
  nearest(x: number): Hazard | null {
    let best: Hazard | null = null
    for (const h of this.hazards) {
      if (!h.active || h.resolved) continue
      if (h.x + h.spec.halfW < x) continue
      if (!best || h.x < best.x) best = h
    }
    return best
  }

  /** Position and animate hazard nodes. Transform writes only. */
  place(): void {
    for (const h of this.hazards) {
      if (!h.active || !h.node) continue
      h.node.x = h.x
      if (h.kind === 'dog' && h.partA && h.partB) {
        // Trot: fore and hind legs in antiphase, plus a small body bob.
        h.partA.rotation = Math.sin(h.phase) * 0.62
        h.partB.rotation = Math.sin(h.phase + Math.PI) * 0.62
        h.node.y = -Math.abs(Math.sin(h.phase * 2)) * 3
      } else if (h.kind === 'ball' && h.partA) {
        h.partA.rotation = h.phase * 0.7
        // The ball bounces; its shadow stays on the concrete.
        h.partA.y = -35 - Math.abs(Math.sin(h.phase * 1.6)) * 7
      } else if (h.kind === 'banana' && h.partA) {
        h.partA.rotation = Math.sin(h.phase * 0.7) * 0.05
      }
    }
  }

  // --------------------------------------------------------------- hazard art
  /**
   * One hazard's artwork. Everything here is full-colour, outlined in a darker
   * tint of its own fill, and carries two pieces of grounding: a long flat cast
   * shadow raking left with the key light, and a tight occlusion pool where it
   * meets the concrete. The pool is what stops the cast shadow reading as a
   * decal lying *next to* the object.
   */
  /**
   * Build one hazard's art on its own, for inspection.
   *
   * Finding a named prop in a live frame meant skating until it spawned and
   * then picking it out of the scene by colour, which kept latching onto the
   * skater's blonde hair instead. This returns the real Pixi nodes the game
   * uses — not an offline redraw, which this project has learned not to trust
   * for geometry.
   */
  inspectArt(kind: HazardKind, variant = 0): Container {
    // `node` is only the ground shadow; the prop itself comes back as the
    // separate `a`/`b` parts, which `spawn` parents into the scrolling layers.
    // Taking `node` alone renders a hazard's shadow and nothing else.
    // `node` now owns every part, so this is just the node.
    return this.buildHazardArt(kind, variant).node
  }

  private buildHazardArt(kind: HazardKind, variant: number): { node: Container; a: Container | null; b: Container | null } {
    const pal = this.pal
    const node = new Container()
    node.interactiveChildren = false
    const g = new Graphics()
    const shadow = new Graphics()
    const shadeColor = DECK_SHADE
    let a: Container | null = null
    let b: Container | null = null

    /** Cast shadow plus contact pool for an object `h` tall and `w` wide. */
    const ground = (w: number, h: number): void => {
      rakeShadow(shadow, 0, 0, w, h, shadeColor, 0.3)
      contactPool(shadow, 0, 0, w * 1.15, w * 0.3, shadeColor, 0.5)
    }

    switch (kind) {
      case 'crack': {
        // A split slab with a lifted lip on the near side. Graded against the
        // concrete it is cut into, not against the sand: on the old tan deck the
        // crack came out barely a step darker than the plane and the lip barely
        // a step lighter, and a hazard you have to hunt for is a bug.
        const dark = grade(DECK, { valScale: 0.42, satScale: 1.5 })
        const lip = mix(lighten(DECK, 0.5), pal.light, 0.4)
        // The raised lip's own shadow: short, because the lip is short.
        rakeShadow(shadow, -6, -4, 30, 12, shadeColor, 0.26)
        let x = -36 + variant * 3
        g.moveTo(x, -34)
        for (let i = 0; i < 7; i++) {
          x += 11
          g.lineTo(x, -34 + i * 10 + ((i + variant) % 2 === 0 ? 5 : -5))
        }
        g.stroke({ color: dark, width: 7, join: 'round', cap: 'round' })
        // Highlight along the raised edge, catching the low sun.
        g.moveTo(-34 + variant * 3, -30)
        let hx = -34 + variant * 3
        for (let i = 0; i < 7; i++) {
          hx += 11
          g.lineTo(hx, -30 + i * 10 + ((i + variant) % 2 === 0 ? 5 : -5))
        }
        g.stroke({ color: lip, width: 3, alpha: 0.9, join: 'round' })
        break
      }
      case 'sand': {
        // Sand blown over the wall and spilling across the path. Pale, flat,
        // with a soft scalloped leading edge so it never reads as a rectangle.
        const sandTop = grade(lighten(pal.near, 0.3), { satScale: 0.85 })
        const sandLine = line(sandTop)
        // A drift has a lee side: the sun-facing slope is the pale fill, the
        // left slope keeps a wedge of shade under it.
        contactPool(shadow, -46, 8, 76, 16, shadeColor, 0.3)
        g.moveTo(-104, -58)
        for (let i = 0; i <= 12; i++) {
          const t = i / 12
          const px = -104 + t * 208
          g.lineTo(px, -58 + Math.sin(t * Math.PI * 3 + variant) * 8 + Math.sin(t * Math.PI) * -12)
        }
        for (let i = 12; i >= 0; i--) {
          const t = i / 12
          const px = -104 + t * 208
          g.lineTo(px, 22 + Math.sin(t * Math.PI * 2.4 + variant * 1.7) * 9 + Math.sin(t * Math.PI) * 14)
        }
        g.closePath().fill(sandTop).stroke({ color: sandLine, width: 2.5, join: 'round' })
        // Drift ripples. The only interior detail any hazard gets.
        for (let i = 0; i < 4; i++) {
          const yy = -38 + i * 15
          g.moveTo(-80 + i * 9, yy).quadraticCurveTo(-10, yy - 7, 74 - i * 11, yy)
        }
        g.stroke({ color: sandLine, width: 2, alpha: 0.4 })
        break
      }
      case 'banana': {
        ground(16, 18)
        /*
         * A dropped peel seen from above, three strips splayed from a stem.
         *
         * It used to be a shallow 48x20 crescent plus two small curls, in a gold
         * mixed 55% toward paper for the chroma budget. A player's verdict on
         * that: "not visible as a banana but as some kind of stain" — which is
         * exactly right, because a flat pale crescent skimming past at speed has
         * no silhouette to read. The fix is mostly shape, not colour: a
         * three-lobed splay is unmistakable at a glance, and the asymmetric
         * lobes read as a peel even when it is half off the bottom of the
         * screen.
         *
         * The chroma budget still holds. `PROP_BANANA` sits at roughly 0.45 —
         * up from 0.35, so it is properly yellow rather than cream, and still
         * well under the skater's 0.6+. The reserved hue is reserved by being
         * cyan, not by everything else being washed out.
         */
        const skin = PROP_BANANA
        const inner = mix(skin, Core.paperWhite, 0.58)
        const ink = line(skin)
        const peel = new Graphics()

        // Three lobes: two splayed wide, one folded toward the viewer.
        const lobe = (path: (g: Graphics) => void): void => {
          path(peel)
          peel.fill(skin).stroke({ color: ink, width: 2.5, join: 'round' })
        }
        lobe((g) => g.moveTo(-3, -15)
          .quadraticCurveTo(-24, -15, -34, -2)
          .quadraticCurveTo(-30, -6, -22, -8)
          .quadraticCurveTo(-14, -11, -1, -9)
          .closePath())
        lobe((g) => g.moveTo(4, -15)
          .quadraticCurveTo(26, -16, 35, -4)
          .quadraticCurveTo(30, -8, 22, -10)
          .quadraticCurveTo(13, -12, 2, -10)
          .closePath())
        lobe((g) => g.moveTo(-3, -13)
          .quadraticCurveTo(-8, -2, 5, 3)
          .quadraticCurveTo(2, -4, 6, -13)
          .closePath())

        // The pale inner face of each strip, which is what says "peel" rather
        // than "three yellow leaves".
        peel.moveTo(-2, -12).quadraticCurveTo(-16, -11, -26, -4)
          .quadraticCurveTo(-16, -8, -1, -8).closePath().fill({ color: inner, alpha: 0.9 })
        peel.moveTo(3, -12).quadraticCurveTo(18, -12, 27, -6)
          .quadraticCurveTo(16, -9, 2, -9).closePath().fill({ color: inner, alpha: 0.9 })

        // Stem: a small nub and a short stalk. At 7x the first version was a
        // 12px disc in the middle of the splay and read as a coin sitting on
        // the peel rather than the point the strips hang from — the one part
        // of the silhouette that has to say "fruit".
        const stemInk = grade(skin, { valScale: 0.62, satScale: 1.2 })
        peel.ellipse(0, -15, 4, 3.4).fill(stemInk)
          .stroke({ color: ink, width: 1.8, join: 'round' })
        peel.moveTo(-1.6, -17).lineTo(-2.6, -23).lineTo(1.4, -23).lineTo(1.6, -17)
          .closePath().fill(stemInk).stroke({ color: ink, width: 1.8, join: 'round' })

        const holder = new Container()
        holder.addChild(peel)
        a = holder
        break
      }
      case 'ball': {
        ground(30, 58)
        const R = 33
        const ball = new Graphics()
        ball.circle(0, 0, R).fill(Core.paperWhite)
        // Three panels. Warm and white only: electric cyan is the skater's
        // reserved hue and nothing else in the frame is allowed to wear it.
        const panels: Hex[] = [
          PROP_WARM, PROP_GOLD, mix(Core.paperWhite, pal.light, 0.5),
        ]
        for (let i = 0; i < 3; i++) {
          const a0 = (i / 3) * Math.PI * 2 - 0.5
          ball.moveTo(0, 0)
            .arc(0, 0, R, a0, a0 + Math.PI / 3)
            .closePath()
            .fill(panels[i])
        }
        // Terminator: the left third of a sphere under a right-hand key light is
        // in shade. One flat shape, no gradient.
        ball.moveTo(0, -R)
          .arc(0, 0, R, -Math.PI / 2, Math.PI / 2, true)
          .quadraticCurveTo(-R * 0.18, 0, 0, -R)
          .closePath()
          .fill({ color: DECK_SHADE, alpha: 0.38 })
        // Not `line(pal.accent)`: a dark saturated magenta ring is the skater's
        // own hue worn by a prop, and it measured 0.48 chroma on its own.
        ball.circle(0, 0, R).stroke({ color: line(PROP_WARM), width: 3.5 })
        ball.circle(11, -13, 7).fill({ color: Core.paperWhite, alpha: 0.85 })
        const holder = new Container()
        holder.addChild(ball)
        holder.y = -R - 2
        a = holder
        break
      }
      case 'dog': {
        ground(38, 56)
        const coat = variant % 2 === 0 ? 0xe9b072 : 0xd9d2c0
        const coatLine = line(coat)
        const legs1 = new Graphics()
        const legs2 = new Graphics()
        for (const [lg, off] of [[legs1, -22], [legs2, 16]] as const) {
          lg.roundRect(-4, 0, 9, 24, 4).fill(grade(coat, { valScale: 0.86 })).stroke({ color: coatLine, width: 2.5 })
          lg.roundRect(6, 0, 9, 24, 4).fill(coat).stroke({ color: coatLine, width: 2.5 })
          lg.position.set(off, -32)
        }
        // Body, head, ears, tail — one shape each, no interior detail.
        const body = new Graphics()
        body.roundRect(-30, -58, 62, 30, 15).fill(coat).stroke({ color: coatLine, width: 3 })
        body.moveTo(28, -50).quadraticCurveTo(44, -46, 46, -62)
          .quadraticCurveTo(38, -54, 26, -56).closePath()
          .fill(coat).stroke({ color: coatLine, width: 2.5, join: 'round' })
        body.circle(-36, -62, 16).fill(coat).stroke({ color: coatLine, width: 3 })
        body.moveTo(-50, -60).quadraticCurveTo(-58, -56, -54, -46)
          .quadraticCurveTo(-46, -50, -44, -58).closePath()
          .fill(grade(coat, { valScale: 0.88, satScale: 1.15 }))
          .stroke({ color: coatLine, width: 2.5, join: 'round' })
        body.moveTo(-40, -74).quadraticCurveTo(-30, -84, -24, -70)
          .quadraticCurveTo(-32, -72, -36, -66).closePath()
          .fill(grade(coat, { valScale: 0.88, satScale: 1.15 }))
          .stroke({ color: coatLine, width: 2.5, join: 'round' })
        body.circle(-50, -62, 3.5).fill(line(coatLine))
        body.circle(-40, -67, 2.8).fill(line(coatLine))
        // Shaded flank: the side turned away from the sun.
        body.roundRect(-30, -58, 26, 30, 14).fill({ color: shadeOf(coat), alpha: 0.26 })
        // Rim down the sun-facing edge.
        body.moveTo(30, -56).quadraticCurveTo(34, -44, 30, -30)
          .stroke({ color: lighten(this.pal.light, 0.4), width: 3.5, alpha: 0.8, cap: 'round' })
        node.addChild(shadow, legs1, legs2, body)
        a = legs1
        b = legs2
        return { node, a, b }
      }
      case 'hydrant': {
        ground(22, 88)
        // Warm vermilion rather than the palette's magenta, and held under the
        // chroma ceiling. Hydrants are red; nothing says they have to be the
        // most colourful object in a frame with a person in it.
        const body = PROP_WARM
        const bodyLine = line(body)
        g.roundRect(-26, -12, 52, 12, 4).fill(grade(body, { valScale: 0.8 })).stroke({ color: bodyLine, width: 3 })
        g.roundRect(-19, -74, 38, 64, 10).fill(body).stroke({ color: bodyLine, width: 3.5 })
        g.roundRect(-27, -84, 54, 12, 5).fill(body).stroke({ color: bodyLine, width: 3 })
        g.moveTo(-15, -84).quadraticCurveTo(0, -102, 15, -84).closePath()
          .fill(body).stroke({ color: bodyLine, width: 3.5, join: 'round' })
        g.circle(0, -96, 5).fill(PROP_GOLD).stroke({ color: bodyLine, width: 2.5 })
        // Side caps and the rim light down the sun-facing edge.
        g.circle(22, -48, 9).fill(grade(body, { valScale: 0.88 })).stroke({ color: bodyLine, width: 2.5 })
        g.circle(-22, -48, 9).fill(grade(body, { valScale: 0.78 })).stroke({ color: bodyLine, width: 2.5 })
        // Terminator on the barrel: the left half turns away from the key.
        g.roundRect(-19, -74, 17, 64, 8).fill({ color: shadeOf(body), alpha: 0.4 })
        g.moveTo(15, -72).lineTo(15, -16).stroke({ color: lighten(pal.light, 0.35), width: 4, alpha: 0.85, cap: 'round' })
        break
      }
    }

    node.addChild(shadow, g)
    /*
     * Adopt the animated parts, if their case did not already parent them.
     *
     * Three patterns had grown here: the dog adds its own parts (so its legs
     * sit under its body), while banana and ball build theirs into a standalone
     * holder and assigned it to `a` — which nothing ever added to anything. The
     * result is a hazard that draws its ground shadow and nothing else, and
     * lands on screen as a dark smear on the deck. Two players' worth of
     * "it is not visible as a banana but as some kind of stain", and it was
     * never the artwork: the artwork was never in the scene graph.
     *
     * Only `a` can be set here: the dog is the one case that returns early,
     * which is exactly why it was the one hazard that rendered.
     */
    if (a) node.addChild(a)
    return { node, a, b }
  }

  // ----------------------------------------------------------------- the path
  /**
   * Build the play plane into the parallax stack.
   *
   * Three pieces, deliberately at three different repeat lengths so the eye
   * never locks onto a single period: the wall/post tile at 960, the railing
   * signs at 2880, and the planting in front at 760. Everything here is full
   * colour and outlined — this is the near band, and the whole point of the
   * backdrop falling away is that this does not.
   */
  buildPath(back: Parallax, front: Parallax, root: Container): void {
    // Static concrete. It does not move, so it is one sprite plus a handful of
    // Graphics no matter how far the run goes — and because it is screen-fixed,
    // it is the one place a true perspective construction can live.
    root.addChild(this.buildDeck())

    // --- wet patches -------------------------------------------------------
    // These scroll: a damp patch is a feature of the concrete, not of the eye.
    // Laid before the fence, so the shadows of the rail and the posts fall
    // across the water rather than the other way round.
    back.addWrappingLayer(() => this.buildWetTile(), {
      factorX: 1, wrapWidth: 1600, copies: 2,
    })

    // --- wall, posts, shadows, slab joints ---------------------------------
    back.addWrappingLayer((copy) => this.buildNearTile(copy), {
      factorX: 1, wrapWidth: NEAR_TILE, copies: 4,
    })

    // --- railing signage ---------------------------------------------------
    // Period-correct density of branding, invented marks. Mounted above the
    // rail, clear of the skater's head: a sign at body height behind the player
    // is the worst possible placement and a reviewer named it as such.
    back.addWrappingLayer(() => this.buildSignTile(), {
      factorX: 1, wrapWidth: 2880, copies: 2,
    })

    // --- planting in front of the path -------------------------------------
    // These two go into the FRONT stack, which the scene adds above the play
    // plane: the skater passes behind the ice plant and behind the palm, which
    // is what makes them read as foreground rather than as a painted strip.
    // The palm goes in FIRST, so the ice plant is drawn over the foot of its
    // trunk. That overlap is the whole rooting cue — a trunk that stops at the
    // bottom edge of the frame is a sprite, a trunk that disappears behind the
    // planting is a tree. Its scroll factor is within a whisker of the fringe's
    // so the two barely move against one another.
    front.addWrappingLayer((copy) => this.buildNearPlane(copy), {
      factorX: 1.3, wrapWidth: 2600, copies: 3,
    })
    front.addWrappingLayer((copy) => this.buildFringeTile(copy), {
      factorX: 1.26, wrapWidth: 760, copies: 4,
    })
  }

  /**
   * The concrete, screen-fixed.
   *
   * The largest object in the frame, and the one the value plan turns on. It
   * used to be built out of `pal.near` — the sand's own tan — and it came out
   * L* 72-88, which is *lighter* than the beach behind it. A neutral review read
   * the result exactly right: "the entire lower two-thirds is one undifferentiated
   * mud plane with props embossed into it."
   *
   * It is now `DECK`: a cool plum-grey at L* 36-54, a different temperature from
   * the sand and a 30-point step below it. The lighting work survives inside that
   * narrower, darker range — a grazed plane at the back, a hard terminator against
   * the wall, an occlusion pool in the corner, plank seams in real perspective —
   * but the plane as a whole is now a dark mass instead of a bright one.
   */
  private buildDeck(): Container {
    const pal = this.pal
    const c = new Container()

    // Horizontal plane: the low sun grazes the back of it near the kerb and it
    // falls away to the darkest step at the front, where the planting sits.
    // The graze is rationed to the back tenth of the plane. Run any wider and
    // it reaches the skater's own band, and a figure standing on a surface his
    // own value is the failure this whole pass exists to fix.
    // The light clearing the wall, in four steps. The corner at the foot of
    // the wall is occluded and dark; a hot warm band sits just in front of it
    // where the low sun finally reaches the concrete; the plane falls away
    // from there to the darkest step at the front lip. A ramp that started
    // bright at t=0 put its graze exactly where the occlusion pool below is
    // drawn, and the two cancelled.
    const deck = new Sprite(verticalGradient([
      { t: 0, c: mix(DECK_DEEP, DECK, 0.3) },
      { t: 0.1, c: DECK_LIT },
      { t: 0.26, c: mix(DECK_LIT, DECK, 0.62) },
      { t: 0.55, c: DECK },
      { t: 1, c: DECK_DEEP },
    ], 128))
    deck.width = 1920
    deck.height = PATH_FRONT - WALL_BASE
    deck.position.set(0, WALL_BASE)
    c.addChild(deck)

    // ...and the same plane lit *across* its width. A vertical ramp on its own
    // is depth, not light: it grades the concrete by how far away it is and
    // says nothing about where the sun is. The review's note was blunt — "the
    // biggest surface in the picture and it is lit by nothing" — so the sun
    // side of the deck now takes a warm graze and the side away from it gathers
    // a cool violet shadow. Two values across the width, two down the depth,
    // and the key light finally reaches the largest object in the frame.
    // Stops are placed against the *visible* window, not the authored one: the
    // deck is screen-fixed and at ZOOM 1.66 the camera only ever shows design
    // x 272..1428, so a ramp that peaked at t=1 would put its warm end off the
    // right edge of the frame and never be seen at all.
    const cross = new Sprite(horizontalGradient([
      { t: 0, c: grade(DECK_DEEP, { satScale: 1.25, hueShift: -6 }), a: 0.6 },
      { t: 0.14, c: grade(DECK_DEEP, { satScale: 1.25, hueShift: -6 }), a: 0.55 },
      { t: 0.42, c: DECK_DEEP, a: 0.12 },
      { t: 0.56, c: pal.light, a: 0.1 },
      { t: 0.7, c: mix(pal.light, Core.paperWhite, 0.2), a: 0.26 },
      { t: 1, c: mix(pal.light, Core.paperWhite, 0.2), a: 0.3 },
    ], 256))
    cross.width = 1920
    cross.height = PATH_FRONT - WALL_BASE
    cross.position.set(0, WALL_BASE)
    c.addChild(cross)

    // --- the warm rake ------------------------------------------------------
    // "B paints a low sun ... and then lights every plane identically — no
    // directional shadow anywhere, no warm rake across the deck."
    //
    // This is the rake. Two long wedges of sun lying on the concrete at exactly
    // the angle everything else in the frame throws its shadow, so the deck is
    // not one evenly graded plane but a plane with light on part of it. The
    // first one crosses the band the skater rides in, which means her own cast
    // shadow cuts a dark diagonal straight through a warm one — the whole point
    // of putting a light in the sky.
    //
    // Static, like the deck and the perspective seams it lies between. A wedge
    // this long would be drawn twice in the overlap of any wrapping layer, and
    // a semi-transparent shape composited twice is a hard-edged stripe.
    const rake = new Graphics()
    const rakeDrop = PATH_FRONT - WALL_BASE
    const rakeRun = rakeDrop * (SHADOW_DX / SHADOW_DY)
    for (const [x0, x1, a] of [[742, 968, 0.2], [1168, 1324, 0.14]] as const) {
      rake.moveTo(x0, WALL_BASE).lineTo(x1, WALL_BASE)
        .lineTo(x1 + rakeRun, PATH_FRONT).lineTo(x0 + rakeRun, PATH_FRONT)
        .closePath()
        .fill({ color: DECK_LIT, alpha: a })
    }
    c.addChild(rake)

    // The planting bed the path runs along, below the front lip. The darkest
    // value in the frame and the floor of the whole composition: the ice plant
    // in front of the camera is a scalloped silhouette whose troughs fall off
    // the bottom of the screen, so something under it has to guarantee that the
    // last strip of every frame is dark rather than showing bare concrete.
    const bed = new Sprite(verticalGradient([
      { t: 0, c: grade(PLANT, { valScale: 0.78, satScale: 1.2 }) },
      { t: 1, c: grade(PLANT, { valScale: 0.5, satScale: 1.3 }) },
    ], 64))
    bed.width = 1920
    bed.height = 1240 - PATH_FRONT
    bed.position.set(0, PATH_FRONT)
    c.addChild(bed)

    // --- plank seams, in perspective ---------------------------------------
    // Longitudinal boards run with the direction of travel, so they do not
    // scroll: they converge on a fixed point under the sun and stay there. The
    // transverse joints in the scrolling tile are what carry the motion.
    //
    // This fan is the frame's standing diagonal, and it is the reason the deck
    // had to get dark. Twenty-eight tapered quads converging on a point under
    // the sun, each with a lit chamfer on its sun side that a L* 42 plane can
    // actually carry: the bottom third of the frame is now a radial of lines all
    // pointing back at the light, rather than one more horizontal band. Widened
    // from 132px boards to 176px so each line reads as a line and not as tooth.
    const seams = new Graphics()
    const gapInk = DECK_INK
    const bevel = mix(lighten(DECK, 0.34), pal.light, 0.35)
    const deckFrontY = PATH_FRONT
    const backT = (WALL_BASE - VP_Y) / (deckFrontY - VP_Y)
    for (let i = 0; i <= 28; i++) {
      // Front-edge positions, wobbled so the boards are not all one width. The
      // span is wide enough that after convergence the seams still reach both
      // back corners of the deck; a narrower fan leaves the corners bare.
      const f = -1400 + i * 176 + Math.sin(i * 2.1) * 17
      const bx = VP_X + (f - VP_X) * backT
      const wF = 3.4 + Math.sin(i * 1.3) * 0.5
      const wB = wF * 0.36
      // A tapered quad, not a stroke: a constant-width line across a receding
      // plane is the thing that kills the perspective it is meant to build.
      seams.moveTo(f - wF, deckFrontY)
        .lineTo(f + wF, deckFrontY)
        .lineTo(bx + wB, WALL_BASE)
        .lineTo(bx - wB, WALL_BASE)
        .closePath()
        .fill({ color: gapInk, alpha: 0.55 })
      // The lit chamfer on the sun side of each gap.
      seams.moveTo(f + wF, deckFrontY)
        .lineTo(f + wF * 2.1, deckFrontY)
        .lineTo(bx + wB * 2.1, WALL_BASE)
        .lineTo(bx + wB, WALL_BASE)
        .closePath()
        .fill({ color: bevel, alpha: 0.34 })
    }
    c.addChild(seams)

    // --- the corner where the wall meets the concrete ----------------------
    // Tight, not broad: at 66px and 0.7 this pool swallowed the whole grazed
    // band it is supposed to sit above.
    const corner = occlusionPool({
      color: DECK, width: 1920, height: 30, strength: 0.5, direction: 'up',
    })
    corner.position.set(0, WALL_BASE)
    c.addChild(corner)
    // And the one where the planting meets it.
    const frontPool = occlusionPool({
      color: DECK, width: 1920, height: 120, strength: 0.75, direction: 'down',
    })
    frontPool.position.set(0, PATH_FRONT - 60)
    c.addChild(frontPool)

    const edges = new Graphics()
    // Kerb at the back of the path: the terminator between the vertical wall
    // and the horizontal deck, and the brightest line in the near band.
    edges.rect(0, WALL_BASE, 1920, 5).fill(DECK_INK)
    edges.rect(0, WALL_BASE + 5, 1920, 10).fill(lighten(DECK_LIT, 0.18))
    // Front lip.
    edges.rect(0, PATH_FRONT - 8, 1920, 8).fill(DECK_INK)
    c.addChild(edges)

    c.interactiveChildren = false
    c.eventMode = 'none'
    return c
  }

  /**
   * Wall face, capstone, posts, rail, and the shadows they throw.
   *
   * The posts are placed with `scatter()`. Identical width, spacing, value and
   * outline weight across a whole fence was called out by name as the textbook
   * tiled-sprite tell, so every post here differs in height, width, the weight
   * of its outline and the length of the shadow it casts.
   */
  private buildNearTile(copy: number): Container {
    const pal = this.pal
    const c = new Container()
    const g = new Graphics()

    // The silhouette band.
    //
    // "Push the whole midground down into backlit silhouette (wall, posts,
    // towers as one dark ~#4a3f52 band), let the sand and ocean keep the heat,
    // and the skater gets a rim and a real cast shadow for free."
    //
    // So every standing thing on this tile — wall, capstone, posts, rail, bin —
    // is graded out of `WALL` and nothing here is allowed above 0.26 relative
    // luminance except the capstone's top plane and the rim light. Against a
    // 0.78 sand band that is a silhouette; against the skater's 0.74 cyan it is
    // the value break the whole frame is built on.
    const wallFace = WALL
    // The capstone's top plane is the one part of the wall the sky still
    // reaches, and the only step between the light band and the dark one.
    const wallLit = WALL_CAP
    const wallLine = grade(wallFace, { valScale: 0.6, satScale: 1.25 })
    const postFill = grade(WALL, { valScale: 0.92, satScale: 1.06 })
    // The near band's own outline, and deliberately not `line()`.
    //
    // "Far lifeguard towers, mid fence posts and foreground rail all sit at the
    // same contrast, so the picture has layers but no space." The far crowd now
    // loses its outline into the haze; the fence is the nearest standing
    // structure in the frame and it takes the opposite treatment — an ink 54%
    // down from the post instead of 26%, so the rail reads as the hardest
    // linework in the picture and distance is something the eye can measure.
    const postLine = grade(postFill, { valScale: 0.46, satScale: 1.3 })
    const shadeColor = DECK_SHADE

    // --- the wall face -----------------------------------------------------
    // A vertical plane turned away from the key, so it is the darkest mass of
    // the mid stage — but it is a *plane*, not a fill. The camera push-in made
    // this the single largest uninterrupted area in the frame (roughly a fifth
    // of the frame height, running the full width), and a flat rectangle that
    // size is the thing a squint test collapses into mud.
    //
    // So: the sky bounces into the top of it just under the capstone's
    // terminator and it falls to a rich, saturated dark at the kerb, and the
    // courses of the blockwork are real courses with staggered head joints
    // rather than two ruled lines. Everything here is held at low contrast on
    // purpose — the rule is that nothing behind the play plane may out-rank the
    // player — but low contrast is not the same thing as no information.
    // The cool fill the last review asked for by name — "no cool fill in the
    // wall". A plane turned away from a warm key is lit by the only other
    // source there is, which is the violet sky above it, so the top of the face
    // takes a cool bounce and it falls to a rich saturated dark at the kerb.
    const face = new Sprite(verticalGradient([
      { t: 0, c: mix(grade(wallFace, { valScale: 1.2 }), skyAt(pal, 0.34), 0.22) },
      { t: 0.24, c: wallFace },
      { t: 0.7, c: grade(wallFace, { valScale: 0.82, satScale: 1.14 }) },
      { t: 1, c: grade(wallFace, { valScale: 0.6, satScale: 1.28 }) },
    ], 96))
    face.width = NEAR_TILE + 4
    face.height = WALL_BASE - WALL_TOP - 10
    face.position.set(-2, WALL_TOP + 10)

    // Blockwork. Four courses, head joints staggered half a block per course so
    // the pattern never lines up into a grid, and a lit chamfer under every bed
    // joint because a recessed joint on a plane lit from above has one.
    // BLOCK divides NEAR_TILE exactly, and no head joint is drawn at the tile's
    // right edge: a joint that lands on the wrap seam gets stroked by both
    // copies and shows up as a darker line every 960px, which is the wrapping
    // bug this file has had to fix twice already in other layers.
    const COURSE = 27
    const BLOCK = 120
    for (let r = 0; r < 4; r++) {
      const y = WALL_TOP + 18 + r * COURSE
      if (y > WALL_BASE - 14) break
      g.moveTo(-2, y).lineTo(NEAR_TILE + 2, y)
      for (let b = 0; b * BLOCK <= NEAR_TILE; b++) {
        const jx = b * BLOCK + (r % 2) * (BLOCK / 2)
        if (jx >= NEAR_TILE) continue
        g.moveTo(jx, y).lineTo(jx, Math.min(y + COURSE, WALL_BASE - 12))
      }
    }
    // Worth more contrast now the wall is dark: the blockwork was pitched to
    // read against an L* 38 brown, and at 0.26 on a 0.26-luminance violet it is
    // information the frame is paying for and not getting.
    g.stroke({ color: wallLine, width: 2, alpha: 0.38 })
    for (let r = 0; r < 4; r++) {
      const y = WALL_TOP + 18 + r * COURSE + 2
      if (y > WALL_BASE - 14) break
      g.moveTo(-2, y).lineTo(NEAR_TILE + 2, y)
    }
    g.stroke({ color: wallLit, width: 1.5, alpha: 0.24 })
    // Capstone: the lit top plane, and the hard terminator under it.
    g.rect(-2, WALL_TOP, NEAR_TILE + 4, 12).fill(wallLit)
    g.rect(-2, WALL_TOP + 12, NEAR_TILE + 4, 7).fill(grade(wallFace, { valScale: 0.6, satScale: 1.25 }))
    // Base shadow where the wall meets the concrete.
    g.rect(-2, WALL_BASE - 11, NEAR_TILE + 4, 11).fill({ color: shadeColor, alpha: 0.6 })

    // --- what the fence throws onto the concrete ---------------------------
    const shadows = new Graphics()
    // The two rails are continuous, so their shadows are two continuous bands
    // laid across the deck. Two rules keep them clean: each band spans exactly
    // one tile width, so consecutive copies abut instead of overlapping, and the
    // two thicknesses are chosen so the bands meet rather than cross. A
    // semi-transparent shape composited twice is a hard-edged stripe, and that
    // is a bug the ocean in this event was shipping.
    const railBand = (ry: number, thick: number): void => {
      const h = WALL_BASE - ry
      shadows.rect(h * SHADOW_DX, WALL_BASE + h * SHADOW_DY, NEAR_TILE, thick)
        .fill({ color: shadeColor, alpha: 0.2 })
    }
    // Thicknesses retuned for the steeper rake: at 20 degrees the two bands land
    // 15px apart instead of 8, and a gap between them reads as two stripes
    // rather than as the shadow of a railing. They now fall across the wheel
    // line, which gives the white skates a dark ledge to sit against.
    railBand(WALL_TOP - 18, 15)
    railBand(WALL_TOP - 40, 12)

    // Posts. Irregular pitch, irregular height, irregular outline weight.
    const posts = new Graphics()
    const slots = scatter({
      count: 4, from: 54, to: NEAR_TILE - 54, seed: 0x5ca11e + copy * 7717,
      scaleRange: [0.9, 1.14], variants: 3,
    })
    for (const s of slots) {
      const px = s.x
      const topY = WALL_TOP - 40 * s.scale - 14
      const halfW = 12 * lerp(0.9, 1.12, s.jitter)
      const postH = WALL_BASE - topY + 9
      // Long raking shadow from each post. Parallelograms 240px apart never
      // overlap however far they rake, so these can be as long as the hour wants.
      rakeShadow(shadows, px, WALL_BASE, halfW, postH, shadeColor, 0.32)
      // The pool at the foot of the post, which is the half of the job a cast
      // shadow on its own never does.
      contactPool(shadows, px, WALL_BASE + 2, halfW * 2.3, halfW * 0.7, shadeColor, 0.55)

      const ol = depthOutline(0.08 + s.jitter * 0.26)
      // Value varies too. Identical width, spacing, value and outline weight
      // across a run of posts is the tell; fixing only the spacing leaves it.
      // The whole range stays inside the silhouette band: a post is a dark
      // shape with a lit edge, never a lit shape with a dark edge.
      const pf = grade(postFill, { valScale: lerp(0.9, 1.04, s.jitter) })
      posts.roundRect(px - halfW, topY, halfW * 2, WALL_BASE - topY - 2, 4).fill(pf)
        .stroke({ color: postLine, width: ol.width, alpha: ol.alpha, join: 'round' })
      posts.roundRect(px - halfW - 3, topY - 9, halfW * 2 + 6, 11, 3).fill(grade(pf, { valScale: 1.14 }))
        .stroke({ color: postLine, width: ol.width * 0.9, alpha: ol.alpha })
      // Terminator down the post: everything but the seaward sliver is turned
      // away from the key, so the shaded side is most of the post.
      posts.rect(px - halfW + 1, topY + 2, halfW * 1.5, WALL_BASE - topY - 6)
        .fill({ color: shadeOf(pf), alpha: 0.5 })
      // Rim light down the seaward edge. This is the whole mechanism: a dark
      // band with one hot line down the sun side of every object in it reads as
      // backlit, and one flat dark band reads as a hole.
      posts.rect(px + halfW - 4.5, topY + 2, 4, WALL_BASE - topY - 8)
        .fill({ color: lighten(pal.light, 0.4), alpha: 0.92 })
      posts.rect(px - halfW - 3, topY - 9, halfW * 2 + 6, 2.5)
        .fill({ color: lighten(pal.light, 0.34), alpha: 0.7 })
    }

    // Slab joints: transverse, faint, and the only ground texture that scrolls.
    // They carry the speed read; the perspective seams in the static deck carry
    // the plane.
    const joints = new Graphics()
    for (let i = 0; i < 4; i++) {
      const jx = i * POST_SPACING + POST_SPACING / 2
      joints.moveTo(jx, WALL_BASE + 12).lineTo(jx - 118, PATH_FRONT)
    }
    // These run 63 degrees off horizontal and they scroll, so they are the one
    // moving diagonal on the deck. Worth more contrast now that the concrete is
    // dark enough to carry it.
    joints.stroke({ color: DECK_INK, width: 3, alpha: 0.5 })

    // Rail between the posts, at two heights.
    const rail = new Graphics()
    for (const ry of [WALL_TOP - 40, WALL_TOP - 18]) {
      rail.rect(-2, ry, NEAR_TILE + 4, 10).fill(grade(postFill, { valScale: 1.16, satScale: 1.05 }))
      rail.rect(-2, ry + 5, NEAR_TILE + 4, 5).fill({ color: shadeOf(postFill), alpha: 0.6 })
      rail.rect(-2, ry, NEAR_TILE + 4, 10).stroke({ color: postLine, width: 3.4, alpha: 1 })
      // Backlight along the top of each rail: the near band is the only depth
      // allowed a true specular, and it is what separates it from the fence
      // shadows lying on the wall behind it.
      rail.rect(-2, ry, NEAR_TILE + 4, 2).fill({ color: lighten(pal.light, 0.42), alpha: 0.85 })
    }

    // A litter bin on one tile in four, so the wall is not a pure rhythm.
    const props = new Graphics()
    if (copy % 4 === 1) {
      const bin = grade(DECK, { valScale: 0.8, satScale: 1.15 })
      const bx = POST_SPACING * 2 + 66
      rakeShadow(shadows, bx, WALL_BASE, 21, 70, shadeColor, 0.26)
      contactPool(shadows, bx, WALL_BASE + 2, 40, 12, shadeColor, 0.46)
      props.moveTo(bx - 21, WALL_BASE - 2).lineTo(bx - 17, WALL_BASE - 62)
        .lineTo(bx + 17, WALL_BASE - 62).lineTo(bx + 21, WALL_BASE - 2).closePath()
        .fill(bin).stroke({ color: line(bin), width: 3, join: 'round' })
      props.roundRect(bx - 21, WALL_BASE - 70, 42, 10, 4).fill(grade(bin, { valScale: 1.22 }))
        .stroke({ color: line(bin), width: 2.5 })
      props.moveTo(bx - 19, WALL_BASE - 60).lineTo(bx - 21, WALL_BASE - 4)
        .lineTo(bx - 6, WALL_BASE - 4).lineTo(bx - 8, WALL_BASE - 60).closePath()
        .fill({ color: shadeOf(bin), alpha: 0.45 })
      props.moveTo(bx + 15, WALL_BASE - 60).lineTo(bx + 19, WALL_BASE - 6)
        .stroke({ color: lighten(pal.light, 0.3), width: 3.5, alpha: 0.75 })
    }

    c.addChild(shadows, joints, face, g, rail, posts, props)
    c.interactiveChildren = false
    return c
  }

  /**
   * A patch of concrete the last wash over the wall left damp.
   *
   * The boardwalk below the fence was ~20% of the frame and entirely untouched
   * gradient. A wet patch is worth more than texture there: it is darker and
   * richer than the dry deck around it, which is a value break, and it holds the
   * only specular in the bottom half of the frame — which is most of the reason
   * to set the event at an hour when the sun is nearly on the water.
   *
   * Everything here stays well inside the tile. A semi-transparent shape that
   * crosses a wrap seam gets composited twice and reads as a hard edge.
   */
  private buildWetTile(): Container {
    const pal = this.pal
    const c = new Container()
    const damp = new Graphics()
    const pool = grade(DECK, { valScale: 0.72, satScale: 1.35 })
    damp.ellipse(560, 962, 330, 50).fill({ color: pool, alpha: 0.62 })
    // A rim: water has an edge where it stops, and without one the fill reads
    // as a smudge on the deck rather than as a puddle on it.
    damp.ellipse(560, 962, 330, 50)
      .stroke({ color: grade(pool, { valScale: 0.82, satScale: 1.2 }), width: 2.5, alpha: 0.75 })
    const pool2 = grade(DECK, { valScale: 0.74, satScale: 1.3 })
    damp.ellipse(880, 1000, 190, 28).fill({ color: pool2, alpha: 0.5 })
    damp.ellipse(880, 1000, 190, 28)
      .stroke({ color: grade(pool2, { valScale: 0.84, satScale: 1.2 }), width: 2, alpha: 0.6 })
    // The lit lip on the sun side of the puddle, where the water thins out.
    damp.moveTo(760, 946).quadraticCurveTo(870, 958, 872, 976)
      .stroke({ color: lighten(pal.light, 0.3), width: 3, alpha: 0.5 })
    c.addChild(damp)

    // Held right down. On the darker deck this reflection was the brightest
    // thing in the bottom half of the frame and it out-ranked the skater; a
    // specular is a highlight on a wet patch, not a light source.
    const spec = new Sprite(softDot(mix(pal.light, Core.paperWhite, 0.55), 128, 0.52))
    spec.anchor.set(0.5)
    spec.width = 224
    spec.height = 18
    spec.position.set(600, 954)
    spec.alpha = 0.3
    spec.blendMode = 'add'
    c.addChild(spec)

    const spec2 = new Sprite(softDot(mix(pal.light, Core.paperWhite, 0.5), 128, 0.1))
    spec2.anchor.set(0.5)
    spec2.width = 168
    spec2.height = 18
    spec2.position.set(906, 996)
    spec2.alpha = 0.2
    spec2.blendMode = 'add'
    c.addChild(spec2)

    c.interactiveChildren = false
    return c
  }

  /**
   * Painted signs mounted above the rail.
   *
   * Two rules from the review, both about focal rank: signage never sits at the
   * player's own height, and it never carries more local contrast than the thing
   * the player controls. So these are pushed most of the way toward the value of
   * the wall they hang over, and they live entirely above head height.
   */
  private buildSignTile(): Container {
    const pal = this.pal
    const c = new Container()
    const g = new Graphics()
    // Demoted, and this is the third time the note has been written about this
    // one object: "the flattest, highest-contrast graphic element in the
    // picture is a grey signboard reading 'OCEANIK' — a meaningless word parked
    // at the skater's eye line, out-competing her for attention."
    //
    // The previous grade put the board 20 points of value under the sand and
    // its lettering 38 points under the board, which is a poster. These boards
    // now sit 6 points under the sand they hang over, in the sand's own hue and
    // at two thirds its chroma, and the lettering is 12 points under the board.
    // They read as weathered paint on a distant hoarding — which is what a
    // signboard 40 metres behind the action looks like — and there is nothing
    // in them for the eye to land on.
    const board = grade(pal.near, { valScale: 0.94, satScale: 0.76, fog: pal.haze, fogAmount: 0.22 })
    const boardLit = mix(board, pal.light, 0.22)
    const shadeColor = shadeOf(pal.near)
    const style = (size: number, fill: Hex): TextStyle => new TextStyle({
      fontFamily: 'Anton, Archivo, system-ui, sans-serif',
      fontSize: size, fill, letterSpacing: size * 0.08,
    })
    // Ink barely off the board: the mark reads as a mark, not as a headline.
    const ink = grade(board, { valScale: 0.86, satScale: 1.12 })
    // One Graphics for every board, added once and up front. Re-adding the same
    // child inside the loop moves it to the top of the container and the boards
    // end up painted over their own lettering.
    c.addChild(g)
    // 'OCEANIK' is gone with the contrast. A meaningless invented word set in
    // 30px caps is a thing the eye tries to read and then resents; a place name
    // is furniture.
    const marks: [number, string][] = [
      [300, 'VENICE'], [1380, 'SUN DOG'], [2280, 'BAJA SURF CO'],
    ]
    const topY = WALL_TOP - 96
    const botY = WALL_TOP - 40
    for (const [x, text] of marks) {
      const t = new Text({ text, style: style(25, ink) })
      t.anchor.set(0.5, 0.5)
      const w = t.width + 46
      t.position.set(x + w / 2, (topY + botY) / 2)
      t.alpha = 0.6
      // Two stakes down onto the capstone, so the board stands on something.
      for (const sx of [x + 16, x + w - 16]) {
        // The stakes stand on the capstone, so they belong to the silhouette
        // band rather than to the board they carry.
        g.rect(sx - 4, botY, 8, WALL_TOP - botY + 6).fill(grade(WALL, { valScale: 0.98 }))
        // What the stake throws on the wall face below it.
        g.rect(sx - 26, WALL_TOP + 8, 9, 22).fill({ color: shadeColor, alpha: 0.2 })
      }
      g.roundRect(x, topY, w, botY - topY, 5).fill(board)
        .stroke({ color: ink, width: 2, alpha: 0.35 })
      // Lit top edge and shaded underside: even a signboard is a plane.
      g.rect(x + 2, topY + 2, w - 4, 6).fill({ color: boardLit, alpha: 0.6 })
      g.rect(x + 2, botY - 9, w - 4, 7).fill({ color: shadeColor, alpha: 0.32 })
      // The board's own shadow, thrown left and down onto the sand behind.
      g.moveTo(x - 60, topY + 10).lineTo(x - 6, topY + 4)
        .lineTo(x - 6, botY).lineTo(x - 56, botY + 6).closePath()
        .fill({ color: shadeColor, alpha: 0.12 })
      c.addChild(t)
    }
    c.interactiveChildren = false
    return c
  }

  /**
   * Ice plant and sea grass along the front edge.
   *
   * The deepest, most saturated band in the frame, and the only thing that crops
   * the composition. Two fixes from the review live here: the silhouette rides a
   * long undulation instead of running dead level, so the band edge is never a
   * horizontal line, and the tufts come out of `scatter()` rather than one
   * triangle stamped at a fixed interval.
   */
  private buildFringeTile(copy: number): Container {
    const c = new Container()
    const g = new Graphics()
    const pal = this.pal
    const leaf = PLANT
    // L* 36. It is a highlight *inside* the darkest mass, so it has to stay
    // under the concrete above it — a lit blade brighter than the deck would
    // reattach the near plane to the mid one.
    const leafLit = mix(grade(leaf, { valScale: 1.12, satScale: 0.8 }), pal.light, 0.12)
    const leafShade = grade(leaf, { valScale: 0.55, satScale: 1.3 })
    const W = 760

    // Long-wavelength undulation of the whole mass. Both harmonics complete a
    // whole number of cycles across the tile, so the silhouette wraps seamlessly.
    //
    // The amplitude is three times what it was. At +/-39px the top edge of the
    // near plane was a horizontal line with a ripple in it — one more band in a
    // stack of bands. At +/-78, over a period that lands about two and a half
    // times across the frame, it is a run of long slopes: the near mass climbs
    // to a sixth of the frame height at its crests and falls clean off the
    // bottom edge in its troughs, so the bottom of the composition is cropped by
    // something angled instead of by a straight line.
    const ridge = (x: number): number =>
      PATH_FRONT + 34
      - Math.sin((x / W) * Math.PI * 2) * 48
      - Math.sin((x / W) * Math.PI * 4 + 1.1) * 24

    g.moveTo(-4, 1240)
    for (let i = 0; i <= 46; i++) {
      const x = -4 + (i / 46) * (W + 8)
      g.lineTo(x, ridge(x))
    }
    g.lineTo(W + 4, 1240).closePath().fill(leaf)

    // Tufts. Irregular pitch, irregular height, three silhouettes.
    const tufts = scatter({
      count: 21, from: 6, to: W - 6, seed: 0x9e3779 + copy * 977,
      scaleRange: [0.62, 1.5], variants: 3,
    })
    for (const t of tufts) {
      const baseY = ridge(t.x) + 8
      const h = 40 * t.scale + t.jitter * 30
      const lean = (t.variant - 1) * 11 * (0.5 + t.jitter)
      const halfW = 8 * t.scale + 3
      const ol = depthOutline(0.1 + t.jitter * 0.3)
      const fill = t.variant === 0 ? leafLit : leaf
      if (t.variant === 2) {
        // A broader ice-plant pad rather than a blade.
        g.moveTo(t.x - halfW * 1.6, baseY)
          .quadraticCurveTo(t.x + lean, baseY - h * 1.1, t.x + halfW * 1.7, baseY)
          .closePath()
          .fill(fill)
          .stroke({ color: leafShade, width: ol.width * 0.7, alpha: ol.alpha * 0.5 })
      } else {
        g.moveTo(t.x - halfW, baseY)
          .quadraticCurveTo(t.x + lean * 0.5, baseY - h * 0.7, t.x + lean, baseY - h)
          .quadraticCurveTo(t.x + lean * 0.5 + 6, baseY - h * 0.6, t.x + halfW, baseY)
          .closePath()
          .fill(fill)
          .stroke({ color: leafShade, width: ol.width * 0.6, alpha: ol.alpha * 0.45 })
      }
      // Sun catching the tip of the blade on its seaward side.
      if (t.jitter > 0.5) {
        g.moveTo(t.x + lean * 0.8, baseY - h * 0.85)
          .quadraticCurveTo(t.x + lean * 0.6 + 4, baseY - h * 0.45, t.x + halfW * 0.7, baseY - h * 0.1)
          .stroke({ color: lighten(pal.light, 0.32), width: 2.4, alpha: 0.6 })
      }
    }
    // Ice-plant flowers. Warm gold, not the palette's magenta: the skater wears
    // the only two saturated hues the frame is allowed to spend, and a scatter of
    // pink dots across the near plane was quietly spending one of them.
    for (let i = 0; i < 4; i++) {
      const bx = ((i * 197 + copy * 83) % 740) + 10
      g.circle(bx, ridge(bx) + 30 + ((i * 29) % 20), 5)
        .fill({ color: mix(pal.light, Core.sunWhite, 0.4), alpha: 0.5 })
    }
    c.addChild(g)
    c.interactiveChildren = false
    return c
  }

  /**
   * The near plane: one leaning palm, rooted in the planting bed and cropped by
   * the top edge of the frame.
   *
   * This is the answer to "a horizontal stack cannot stage anything". Everything
   * else in the event is a band parallel to the bottom of the screen; this is a
   * dark diagonal that crosses all of them and passes in front of the skater's
   * own plane.
   *
   * **What was deleted, and why.** Three consecutive reviews named the same
   * object, the last one in these words:
   *
   *   "The trunkless black wedge. Those near-black palm fronds drop in from the
   *    top edge with no trunk, no origin, and land on top of the '1:30' timer.
   *    It reads as a stray asset layered at the wrong z, not a framing device.
   *    Either give it a trunk and root it in the scene, or delete it."
   *
   * Both halves are now done. The two cropped frond sprays that hung off limbs
   * running up out of the frame are **gone** — a limb whose origin is off-screen
   * is indistinguishable from an asset at the wrong z no matter how carefully it
   * is drawn, and no amount of bark solved that. What is left is one palm whose
   * trunk starts *below* the ice plant at the bottom of the frame and runs
   * unbroken, at 24 degrees off vertical, out through the top edge. Its crown is
   * 270px above the top of the frame, so no frond ever reaches the HUD.
   *
   * The layer is added to the front stack **before** the fringe, so the ice
   * plant is drawn over the foot of the trunk. That is the whole rooting cue:
   * the trunk does not stop at the bottom of the frame, it goes behind the
   * planting, which is where a palm on a boardwalk actually grows.
   */
  private buildNearPlane(copy: number): Container {
    const c = new Container()
    const pal = this.pal
    // Keyed into the dusk palette rather than left as a saturated green: it is
    // the only green in the picture, and a foreground element that shares no
    // temperature with the scene reads as pasted in from another file.
    const frond = mix(grade(PLANT, { valScale: 0.92, satScale: 0.54 }), pal.shade, 0.42)
    const frondDark = grade(frond, { valScale: 0.78, satScale: 1.08 })
    const bark = grade(PLANT, { valScale: 0.86, satScale: 0.62, hueShift: -88 })
    const barkInk = line(bark)
    const ink = line(frond)
    const rim = lighten(pal.light, 0.25)

    // Two tiles in three. The trunk is 60px of bark, so unlike a frond spray it
    // can never hide a hazard from the player.
    if (copy % 3 !== 1) {
      const trunk = new Graphics()
      // Below the ice plant's deepest trough, so the foot of the trunk is
      // covered by planting at every point of the fringe's undulation.
      const baseY = 1180
      const trunkH = 930
      // A real lean: 24 degrees off vertical, so the trunk itself is a diagonal
      // rather than one more axis-aligned edge.
      const leanX = 388
      const topY = baseY - trunkH

      // Root flare, drawn first and wide, so the trunk swells where it meets
      // the ground instead of ending in a parallel-sided stub.
      trunk.moveTo(-64, baseY)
        .quadraticCurveTo(-34, baseY - 86, -26, baseY - 150)
        .lineTo(24, baseY - 150)
        .quadraticCurveTo(36, baseY - 78, 66, baseY)
        .closePath()
        .fill(grade(bark, { valScale: 0.84, satScale: 1.15 }))

      trunk.moveTo(-30, baseY)
        .quadraticCurveTo(96, baseY - trunkH * 0.58, leanX + 30, topY)
        .lineTo(leanX + 66, topY + 20)
        .quadraticCurveTo(146, baseY - trunkH * 0.58, 22, baseY)
        .closePath()
        .fill(bark)
        .stroke({ color: barkInk, width: 4.5, join: 'round' })
      // Leaf scars up the trunk, tightening with height.
      for (let i = 2; i < 13; i++) {
        const t = i / 14
        const rx = -30 + t * (60 + leanX)
        trunk.moveTo(rx - 15, baseY - trunkH * t).lineTo(rx + 19, baseY - trunkH * t - 7)
      }
      trunk.stroke({ color: barkInk, width: 3, alpha: 0.5 })
      // Rim down the seaward side: the trunk is in the silhouette band too, and
      // the band only reads as backlit if every object in it keeps a lit edge.
      trunk.moveTo(22, baseY).quadraticCurveTo(146, baseY - trunkH * 0.58, leanX + 60, topY + 18)
        .stroke({ color: rim, width: 5, alpha: 0.55 })
      // The crown sits 270px clear of the top of the frame. It exists so the
      // trunk has somewhere to go, not so anything is seen of it.
      drawCrown(trunk, leanX + 48, topY + 10, 1.15, frond, frondDark, ink, rim)
      trunk.position.set(1250, 0)
      c.addChild(trunk)
    }

    c.interactiveChildren = false
    return c
  }
}

/**
 * A palm crown: a radial spray of drooping fronds for the top of a trunk.
 *
 * `tint`/`dark` alternate per frond so the cluster has two values inside it
 * rather than reading as one flat blob. The one-sided spray modes this used to
 * carry went with the trunkless boughs that used them.
 */
function drawCrown(
  g: Graphics, cx: number, cy: number, scale: number,
  tint: Hex, dark: Hex, ink: Hex, rim: Hex,
): void {
  const count = 9
  for (let i = 0; i < count; i++) {
    const ang = -Math.PI * 0.98 + (i / (count - 1)) * Math.PI * 0.96
    const len = (210 + (i % 3) * 56) * scale
    const droop = (74 + (i % 2) * 30) * scale
    const tipX = cx + Math.cos(ang) * len
    const tipY = cy + Math.sin(ang) * len + droop
    const nx = -Math.sin(ang) * 44 * scale
    const ny = Math.cos(ang) * 44 * scale
    g.moveTo(cx, cy)
      .quadraticCurveTo(cx + Math.cos(ang) * len * 0.55 + nx, cy + Math.sin(ang) * len * 0.55 + ny - 26, tipX, tipY)
      .quadraticCurveTo(cx + Math.cos(ang) * len * 0.55 - nx, cy + Math.sin(ang) * len * 0.55 - ny + 20, cx, cy)
      .fill(i % 2 === 0 ? tint : dark)
      .stroke({ color: ink, width: 3.5, join: 'round' })
    // The sun is behind this plane, so every frond keeps a lit edge on one side.
    if (i % 2 === 0) {
      g.moveTo(cx, cy)
        .quadraticCurveTo(cx + Math.cos(ang) * len * 0.55 - nx * 0.7, cy + Math.sin(ang) * len * 0.55 - ny * 0.7 + 14, tipX, tipY)
        .stroke({ color: rim, width: 2.6, alpha: 0.4 })
    }
  }
  g.circle(cx, cy, 24 * scale).fill(ink)
}
