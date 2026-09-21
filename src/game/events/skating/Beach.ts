import { Container, Graphics, Sprite } from 'pixi.js'
import type { Parallax } from '../../../render/Parallax'
import { radialGlow, softDot, verticalGradient } from '../../../render/Gradient'
import {
  Core, Palettes, type EventPalette, type Hex, grade, lighten, mix, skyAt,
} from '../../../render/Palette'
import { depthOutline, scatter } from '../../../render/Staging'
import { Rng } from '../../../core/Rng'
import { lerp } from '../../../core/Tween'
import {
  BEACH_TOP, HORIZON_Y, SAND, SUN_X, SUN_Y, SURF_Y, WALL, WALL_TOP,
  castShadow as rakeShadow, contactPool,
} from './Light'

/**
 * Everything behind the sea wall.
 *
 * Built as bands that differ by *rendering mode*, which is the structural trick
 * measured off OlliOlli World (refs/BAR-ANALYSIS.md §1.2). Value alone does not
 * carry depth in a scene this warm — nothing here is allowed to go dark — so the
 * bands separate by how much drawing they get:
 *
 *   clouds  — filled, opaque, three value steps: cool top, warm underlit belly
 *   far     — **unfilled linework directly on the sky**, ~12% contrast
 *   ocean   — filled bands only, hue locked to the sky, value ramping down
 *   beach   — filled, flat, one tint
 *   props   — filled silhouettes in a single monochrome tint with outlines
 *             whose weight falls with depth, plus a warm rim on the seaward edge
 *             and a long shadow raking left off every one of them
 *
 * On top of that runs the Alto's Odyssey rule: every layer is lerped toward the
 * sky gradient *sampled at that layer's own screen height*. That is what keeps
 * eight warm bands from turning to mud. The prop bands are the exception: they
 * are graded out of `WALL` instead, because a backlit crowd belongs to the
 * silhouette band with the sea wall and not to the sand it stands on.
 *
 * Every scrolling layer wraps. A layer added with a fixed extent would drift off
 * screen after a few hundred metres of boardwalk, and this event never ends.
 *
 * Two rules the whole file obeys, both learned the hard way from a blind review:
 *
 *   - **Nothing semi-transparent may cross a wrap seam.** Two copies of a
 *     wrapping tile abut; anything drawn past the tile edge is composited twice
 *     in the overlap and shows up as a hard-edged band. The sun glitter used to
 *     be a rectangle of additive light and its two vertical edges were visible
 *     straight through the water.
 *   - **Every object that sits on the sand casts.** A drawn sun and a shadowless
 *     world is the single thing a player reads as wrong without being able to
 *     name it.
 */
/**
 * The colour of every additive glare in the sky and on the water.
 *
 * Not `pal.light`. Two things wanted this changed. A review called out "a blown
 * specular flare on the water" as the thing the frame commits to instead of
 * committing to the light, and `pal.light` at 0.52 colourfulness is the second
 * most chromatic thing in the frame after the skater herself — which matters
 * because `scripts/score_frame.py` finds the player as the most colourful
 * cluster in the playfield, and glare pixels near the sun were being counted as
 * part of her. Halfway to `sunWhite` it measures 0.38, comfortably under the
 * skater's reservation, and it is what a sun path on water actually looks like:
 * bleached, not orange.
 */
const SUN_GLARE: Hex = mix(Palettes.skating.light, Core.sunWhite, 0.5)

export class Beach {
  private pal: EventPalette

  /** Sun glitter on the water. Positions fixed, alpha animated in render. */
  private glints: Sprite[] = []
  private glintPhase!: Float32Array
  private glintRate!: Float32Array
  private glintBase!: Float32Array
  private time = 0

  constructor(pal: EventPalette) {
    this.pal = pal
  }

  /**
   * Add every backdrop layer, strictly back to front.
   *
   * Order matters three times over: the sun's falloff goes behind the clouds so
   * they have something to be lit *against*, the sand has to be laid before the
   * surf so the foam washes over it rather than being buried by it, and the
   * props have to come last so the crowd sits in front of the water.
   */
  build(parallax: Parallax, seed: number): void {
    const rng = new Rng(seed)
    parallax.addLayer(this.buildSkyFalloff(), { factorX: 0, factorY: 0 })
    this.buildClouds(parallax)
    this.buildFarLinework(parallax)
    this.buildOcean(parallax)
    this.buildGlitter(parallax, rng)
    parallax.addLayer(this.buildSunBloom(), { factorX: 0, factorY: 0 })
    this.buildSand(parallax)
    this.buildSurf(parallax)
    // Two prop bands at different depths and different repeat lengths, so the
    // crowd never falls into a visible loop. Nearer means lower in the frame and
    // larger, which is the only depth cue a flat beach gets. The far one takes
    // more haze; the near one stands against the wall and takes less.
    // Both bands moved up with the sea wall's new capstone line (WALL_TOP), so
    // the near crowd still stands clear of it instead of being swallowed.
    this.buildProps(parallax, 0.26, 3200, 620, 0.58, 0.52)
    this.buildProps(parallax, 0.37, 2240, 664, 0.9, 0.3)
  }

  // --------------------------------------------------------------------- sky
  /**
   * Light falling off from the sun across the whole sky.
   *
   * Thirty-five percent of the frame was sky containing four identical ellipses
   * and nothing else. A sun with no falloff around it is a sticker; this is the
   * gradient that makes the upper-left corner of the frame a *distance from the
   * light* rather than an empty rectangle.
   */
  private buildSkyFalloff(): Container {
    const c = new Container()
    const glow = new Sprite(radialGlow(SUN_GLARE, 256, 1.15))
    glow.anchor.set(0.5)
    glow.width = 2900
    glow.height = 1900
    glow.position.set(SUN_X, SUN_Y + 40)
    glow.alpha = 0.26
    glow.blendMode = 'add'
    c.addChild(glow)
    // A cool counter-gradient in the far corner, so the sky has two ends — and
    // so the top of the frame stays a dark mass.
    //
    // Re-cut for the second push-in. At ZOOM 1.58 the only sky left in frame is
    // design y 380-452: a 72px sliver directly above the horizon, which is the
    // warmest, lightest end of the sky gradient and the part the sun's falloff
    // sits on. Ramping this band to nothing by y 500 would have handed the top
    // of the frame to a bright warm strip — one more horizontal band, and a
    // light one above a light sand band. It now holds most of its strength all
    // the way to the waterline (and its own bottom edge is under the horizon,
    // where the ocean covers it), so the visible sky reads as the dark top of
    // the three-mass plan while the sun's additive glow still warms the right.
    const cool = new Sprite(verticalGradient([
      { t: 0, c: mix(skyAt(this.pal, 0), 0x2a2d62, 0.55), a: 0.72 },
      { t: 0.55, c: mix(skyAt(this.pal, 0), 0x2a2d62, 0.55), a: 0.62 },
      { t: 1, c: mix(skyAt(this.pal, 0), 0x2a2d62, 0.55), a: 0.48 },
    ], 96))
    cool.width = 1920
    cool.height = 470
    c.addChildAt(cool, 0)
    c.interactiveChildren = false
    return c
  }

  // ------------------------------------------------------------------ clouds
  /**
   * Three ranks of cloud bank, each with real value structure.
   *
   * A cloud lit from below and behind has a cool top and a warm, bright belly,
   * and the reviewer asked for exactly that by name. Each bank is built as warm
   * underlit lobes first and a cooler mass laid over them and offset upward, so
   * the warm edge survives along the bottom — value, not opacity. Everything is
   * opaque: two semi-transparent lobes overlapping is how a cloud turns into a
   * pair of visible ellipse edges.
   */
  private buildClouds(parallax: Parallax): void {
    const ranks: [number, number, number, number, number][] = [
      // factorX, top y, thickness, count, seed
      // Moved down with the camera push-in: at their old heights the top rank
      // was cropped clean off the frame and only two of the three read.
      [0.010, 232, 15, 5, 0x1a7f31],
      [0.020, 300, 23, 4, 0x2b3c99],
      [0.034, 368, 31, 3, 0x77c51b],
    ]
    for (const [factor, topY, thick, count, seed] of ranks) {
      parallax.addWrappingLayer(() => {
        const c = new Container()
        const g = new Graphics()
        const banks = scatter({
          count, from: 60, to: 1860, seed, scaleRange: [0.7, 1.6], variants: 3,
        })
        for (const b of banks) {
          const y = topY + (b.jitter - 0.5) * 54
          const halfLen = (150 + b.variant * 58) * b.scale
          const h = thick * lerp(0.8, 1.3, b.jitter)
          const skyHere = skyAt(this.pal, y / 1080)
          // Warm belly: the sun is below these, and it is the reason the event
          // is set at this hour.
          const belly = mix(skyHere, this.pal.light, 0.62)
          const bellyHot = mix(skyHere, Core.sunWhite, 0.82)
          // Cool top: a few points darker and pushed toward the upper sky.
          const top = mix(grade(skyHere, { valScale: 0.94, satScale: 1.1 }), 0x6f73ad, 0.3)
          const topLit = mix(skyHere, Core.paperWhite, 0.34)

          // Belly lobes, drawn first and low.
          for (let i = 0; i < 3; i++) {
            const t = (i + 0.5) / 3
            const lx = b.x + lerp(-halfLen, halfLen, t) * 0.82
            g.ellipse(lx, y + h * 0.5, halfLen * lerp(0.5, 0.26, t), h * lerp(0.9, 0.6, t))
              .fill(i === 2 ? bellyHot : belly)
          }
          g.ellipse(b.x, y + h * 0.42, halfLen, h * 0.72).fill(belly)
          // The cool mass over them, offset up so the belly survives beneath.
          g.ellipse(b.x - halfLen * 0.04, y - h * 0.16, halfLen * 0.96, h * 0.84).fill(top)
          // Two irregular lobes on the upper profile, so the silhouette is not
          // one ellipse repeated at two scales.
          g.ellipse(b.x - halfLen * (0.18 + b.jitter * 0.3), y - h * (0.5 + b.jitter * 0.4),
            halfLen * (0.26 + b.jitter * 0.14), h * (0.5 + b.jitter * 0.3)).fill(top)
          g.ellipse(b.x + halfLen * (0.3 - b.jitter * 0.24), y - h * 0.62,
            halfLen * 0.2, h * 0.42).fill(top)
          // Lit edge along the sun-facing end and across the top of the lobes.
          g.ellipse(b.x + halfLen * 0.72, y - h * 0.24, halfLen * 0.2, h * 0.4).fill(topLit)
          g.ellipse(b.x - halfLen * (0.18 + b.jitter * 0.3), y - h * (0.62 + b.jitter * 0.4),
            halfLen * (0.2 + b.jitter * 0.1), h * 0.22).fill(topLit)
        }
        c.addChild(g)
        c.interactiveChildren = false
        return c
      }, { factorX: factor, wrapWidth: 1920, copies: 2 })
    }
  }

  // --------------------------------------------------------------------- far
  /**
   * The far band: a headland, a pier and two sails, drawn as **bare contours on
   * the sky with no fill behind them**. Measured off the reference at a 10-15%
   * delta from the sky colour, 1-2px wide. It is the cheapest depth cue in the
   * whole frame and the one that reads as hand-drawn rather than generated.
   */
  private buildFarLinework(parallax: Parallax): void {
    parallax.addWrappingLayer(() => {
      const c = new Container()
      const skyHere = skyAt(this.pal, HORIZON_Y / 1080)
      const ink = mix(skyHere, Core.softInk, 0.14)

      // Headland running out to a point, left of frame.
      const head = new Graphics()
      head.moveTo(-60, HORIZON_Y + 2)
      for (let x = -60; x <= 580; x += 16) {
        const t = (x + 60) / 640
        head.lineTo(x, HORIZON_Y + 2 - Math.sin((1 - t) * Math.PI * 0.62) * 46 * (1 - t * 0.35))
      }
      head.lineTo(580, HORIZON_Y + 2)
      head.stroke({ color: ink, width: 2, alpha: 0.85 })

      // A pier on stilts. Legs only, no deck fill — the deck is one line.
      const pier = new Graphics()
      pier.moveTo(1120, HORIZON_Y - 16).lineTo(1520, HORIZON_Y - 16)
      for (let x = 1136; x <= 1512; x += 34) {
        pier.moveTo(x, HORIZON_Y - 16).lineTo(x, HORIZON_Y + 5)
      }
      // A little pavilion at the head of it.
      pier.moveTo(1430, HORIZON_Y - 16).lineTo(1430, HORIZON_Y - 44)
        .lineTo(1478, HORIZON_Y - 56).lineTo(1512, HORIZON_Y - 42)
        .lineTo(1512, HORIZON_Y - 16)
      pier.stroke({ color: ink, width: 2, alpha: 0.78 })

      // Two sails. Triangles, unfilled, barely there.
      const sails = new Graphics()
      for (const [sx, sy, s] of [[780, HORIZON_Y + 16, 1], [1720, HORIZON_Y + 30, 1.3]] as const) {
        sails.moveTo(sx, sy).lineTo(sx + 3, sy - 40 * s).lineTo(sx + 21 * s, sy).closePath()
        sails.moveTo(sx - 9, sy).lineTo(sx + 27 * s, sy)
      }
      sails.stroke({ color: ink, width: 2, alpha: 0.6 })

      c.addChild(head, pier, sails)
      c.interactiveChildren = false
      return c
    }, { factorX: 0.045, wrapWidth: 1920, copies: 2 })
  }

  // ------------------------------------------------------------------- ocean
  /**
   * Water as five horizontal bands.
   *
   * These used to sit at L* 42-44 — as dark as the sky above them — which put
   * the top half of the frame in one flat dark mass and left the sand as a thin
   * light stripe rather than a light *mass*. A sea under a sunset is a mirror:
   * the far bands now come up to L* 60 and most of the way to the sky's own
   * colour, and only the near water keeps the palette's teal, at L* 46. Sky
   * dark, sea and sand light, boardwalk dark: three masses, roughly 29 / 28 / 43
   * percent of the frame.
   */
  private buildOcean(parallax: Parallax): void {
    parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      const bands = 5
      for (let i = 0; i < bands; i++) {
        const t = i / (bands - 1)
        const y0 = lerp(HORIZON_Y, SURF_Y, i / bands)
        const y1 = lerp(HORIZON_Y, SURF_Y, (i + 1) / bands)
        const skyHere = skyAt(this.pal, y0 / 1080)
        // Far band sits within a few percent of the sky; near band is the
        // deepest, most saturated water in the frame.
        const col = grade(this.pal.mid, {
          satScale: lerp(0.52, 1.0, t),
          valScale: lerp(1.42, 1.02, t),
          hueShift: lerp(-4, 8, t),
          fog: skyHere,
          fogAmount: lerp(0.66, 0.05, t),
        })
        g.rect(-4, y0, 1928, y1 - y0 + 1).fill(col)
      }
      // Swell lines: flat 2px strokes in the band's own lit tint, spaced wider
      // toward the horizon so the water reads as a receding plane. Every segment
      // is clamped inside the tile: a stroke that ran past the wrap width was
      // drawn a second time by the neighbouring copy, and a 28%-alpha line
      // composited twice is a visible seam every 1920px.
      for (let i = 0; i < 16; i++) {
        const t = Math.pow(i / 15, 1.7)
        const y = lerp(HORIZON_Y + 6, SURF_Y - 6, t)
        const w = 90 + i * 34
        const x0 = ((i * 613) % 1700) - 40
        seg(g, x0, x0 + w, y)
        seg(g, x0 + w + 180, x0 + w + 180 + w * 0.6, y)
      }
      g.stroke({ color: lighten(skyAt(this.pal, 0.75), 0.42), width: 2.5, alpha: 0.24 })
      c.addChild(g)
      c.interactiveChildren = false
      return c
    }, { factorX: 0.05, wrapWidth: 1920, copies: 2 })
  }

  /**
   * The sun's path on the water.
   *
   * Built as a stack of overlapping soft lobes that taper from a tight, bright
   * knot at the horizon to a broad dissolve at the shore. It used to be a single
   * stretched vertical-gradient sprite — which is a *rectangle*, and its two
   * vertical edges were plainly visible cutting through the water either side of
   * the glitter. Nothing here has a straight edge anywhere.
   *
   * Pinned to the screen rather than to the world, because a reflection does not
   * parallax — it follows the eye. That also means it never needs to wrap.
   */
  private buildGlitter(parallax: Parallax, rng: Rng): void {
    const c = new Container()

    const lobeTex = softDot(SUN_GLARE, 128, 0.04)
    for (let i = 0; i < 7; i++) {
      const t = i / 6
      const lobe = new Sprite(lobeTex)
      lobe.anchor.set(0.5)
      lobe.width = lerp(150, 470, t * t * 0.6 + t * 0.4)
      lobe.height = lerp(52, 128, t)
      lobe.position.set(SUN_X - t * 16, lerp(HORIZON_Y + 4, SURF_Y + 10, t))
      lobe.alpha = lerp(0.26, 0.04, t * t)
      lobe.blendMode = 'add'
      lobe.eventMode = 'none'
      c.addChild(lobe)
    }

    const tex = softDot(Core.sunWhite, 32, 0.25)
    const n = 46
    this.glintPhase = new Float32Array(n)
    this.glintRate = new Float32Array(n)
    this.glintBase = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      // Biased toward the horizon, where a real sun path is tightest.
      const t = Math.pow(rng.next(), 0.65)
      const y = lerp(HORIZON_Y + 4, SURF_Y - 4, t)
      const spread = lerp(34, 240, t)
      const s = new Sprite(tex)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      const size = lerp(7, 20, t) * rng.range(0.7, 1.3)
      s.width = size * 2.6
      s.height = size * 0.5
      s.position.set(SUN_X + rng.spread(spread), y)
      c.addChild(s)
      this.glints.push(s)
      this.glintPhase[i] = rng.next() * Math.PI * 2
      this.glintRate[i] = rng.range(1.6, 5.2)
      this.glintBase[i] = rng.range(0.35, 0.95)
    }
    c.interactiveChildren = false
    parallax.addLayer(c, { factorX: 0, factorY: 0 })
  }

  // -------------------------------------------------------------------- surf
  /** Two foam lines and the wet sand they leave behind. */
  private buildSurf(parallax: Parallax): void {
    parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      const foam = mix(Core.paperWhite, this.pal.haze, 0.28)
      // Outer break, thin and broken.
      for (let i = 0; i < 9; i++) {
        const x = i * 107 + 6
        const y = SURF_Y - 22 + Math.sin(i * 1.7) * 3
        g.moveTo(x, y).quadraticCurveTo(x + 32, y - 5, x + 66, y)
      }
      g.stroke({ color: foam, width: 4, alpha: 0.55, cap: 'round' })
      // Inner wash: a continuous scalloped ribbon, seamless across the tile.
      g.moveTo(-4, SURF_Y + 4)
      for (let i = 0; i <= 24; i++) {
        const x = (i / 24) * 968 - 4
        g.lineTo(x, SURF_Y + 4 - Math.sin((i / 24) * Math.PI * 6) * 5)
      }
      for (let i = 24; i >= 0; i--) {
        const x = (i / 24) * 968 - 4
        g.lineTo(x, SURF_Y + 22 + Math.sin((i / 24) * Math.PI * 4 + 1.1) * 6)
      }
      g.closePath().fill({ color: foam, alpha: 0.82 })
      c.addChild(g)
      c.interactiveChildren = false
      return c
    }, { factorX: 0.09, wrapWidth: 960, copies: 4 })
  }

  // -------------------------------------------------------------------- sand
  private buildSand(parallax: Parallax): void {
    const c = new Container()
    const pal = this.pal
    // Wet sand first: a mirror-bright strip where the wash has just pulled back.
    // At this hour it is the brightest thing below the sun.
    const wet = new Sprite(verticalGradient([
      { t: 0, c: mix(pal.light, Core.paperWhite, 0.45) },
      { t: 1, c: grade(SAND, { satScale: 0.6, valScale: 1.06 }) },
    ], 64))
    wet.width = 1920
    // Starts a little above the break so no sliver of sky survives between the
    // last ocean band and the first sand band.
    wet.height = BEACH_TOP + 46 - (SURF_Y - 6)
    wet.position.set(0, SURF_Y - 6)
    c.addChild(wet)

    // Dry sand. This is the light mass now, not a mid step: L* 82-85, held
    // almost flat and desaturated so it reads as one bright plane rather than as
    // another graded band. It gets its separation from what is in front of it —
    // a sea wall 44 points of lightness below it — not from its own gradient.
    const dry = new Sprite(verticalGradient([
      { t: 0, c: grade(SAND, { satScale: 0.62, valScale: 1.02, fog: pal.haze, fogAmount: 0.22 }) },
      { t: 1, c: grade(SAND, { satScale: 0.82, valScale: 0.99 }) },
    ], 128))
    dry.width = 1920
    dry.height = WALL_TOP + 20 - (BEACH_TOP + 44)
    dry.position.set(0, BEACH_TOP + 44)
    c.addChild(dry)
    c.interactiveChildren = false
    // Fixed extent is safe here: it is a full-width band with no features, so
    // it must not scroll at all.
    parallax.addLayer(c, { factorX: 0, factorY: 0 })

    // Sand texture that does scroll: shallow drift ridges, wrapping.
    parallax.addWrappingLayer(() => {
      const t = new Container()
      const g = new Graphics()
      const ridge = grade(SAND, { valScale: 0.9, satScale: 0.95 })
      // One stroke per row, kept entirely inside the tile: a ridge that bled
      // past the wrap width would be drawn twice in the overlap and show up as a
      // repeating dark band every 1280px.
      for (let i = 0; i < 14; i++) {
        const y = BEACH_TOP + 50 + (i % 7) * 14
        const x0 = ((i * 373) % 900) + 20
        g.moveTo(x0, y).quadraticCurveTo(x0 + 130, y - 6, x0 + 290, y)
      }
      g.stroke({ color: ridge, width: 3, alpha: 0.26 })
      t.addChild(g)
      t.interactiveChildren = false
      return t
    }, { factorX: 0.2, wrapWidth: 1280, copies: 3 })
  }

  // ------------------------------------------------------------------- props
  /**
   * The crowd on the sand.
   *
   * Every parasol, towel, cooler and sunbather in a band is collapsed to **one
   * tint**, with outlines whose weight and opacity come from `depthOutline` so
   * the far band's linework is thinner and fainter than the near band's. Only
   * the silhouettes read, which is exactly what the reference does with a whole
   * town. The one thing allowed to break the monotint is a warm rim down each
   * figure's seaward edge — that is not material, it is the sun behind them.
   *
   * Placement comes from `scatter()`, and every one of them throws a long
   * shadow left across the sand and gathers a pool at its own feet. The previous
   * pass had a drawn sun and not one shadow under an umbrella.
   */
  private buildProps(
    parallax: Parallax,
    factor: number, tileWidth: number, baseY: number, scale: number, depth: number,
  ): void {
    const pal = this.pal
    const skyHere = skyAt(pal, baseY / 1080)
    // The crowd joins the silhouette band.
    //
    // "Push the whole midground down into backlit silhouette (wall, posts,
    // towers as one dark ~#4a3f52 band), let the sand and ocean keep the heat."
    // So these are graded out of `WALL` — the same colour the sea wall, the
    // posts, the rail and the signage all come from — instead of out of the
    // sand they stand on. At golden hour everything between the camera and the
    // sun is a dark shape with a hot edge, and a beach crowd is no exception.
    //
    // Depth is still spent where it was: the near band lands at 0.34 relative
    // luminance and the far band at 0.42, so distance costs contrast as well as
    // size and "layers but no space" stays fixed. Both sit well under the
    // 0.48 break the skater carries, so nothing behind the play plane out-ranks
    // her — the rule this whole pass is built on.
    const tint = grade(WALL, {
      valScale: 0.95 + 0.78 * depth,
      satScale: 1.05 - 0.3 * depth,
      fog: skyHere,
      fogAmount: 0.85 * depth * depth,
      hueShift: 3,
    })
    // Interior separation is itself a depth cue: the near band keeps a readable
    // step between body and ink, the far band loses it into one silhouette.
    const ink = grade(tint, { valScale: 1 - 0.075 * (1 - depth), satScale: 1.06 })
    const rim = mix(pal.light, Core.paperWhite, 0.3)
    // Shadows on sand, faded back with the band's own depth.
    const shade = mix(grade(WALL, { valScale: 1.05, satScale: 1.2 }), skyHere, 0.16 + depth * 0.66)
    const ol = depthOutline(depth * 1.6 - 0.02)

    // One tile's worth of placement, fixed up front, then handed to every copy —
    // wrapping copies must be identical.
    const slots = scatter({
      count: Math.max(6, Math.round(tileWidth / 330)),
      from: 120, to: tileWidth - 180,
      seed: 0xb0a7 + Math.round(baseY) * 31,
      scaleRange: [0.74, 1.3],
      variants: 7,
    })

    parallax.addWrappingLayer(() => {
      const c = new Container()
      const g = new Graphics()
      // Every shadow first, every body second. One pass would let a near prop's
      // shadow be painted over the neighbour it should be falling behind.
      for (const s of slots) {
        const ps = scale * s.scale
        const y = baseY + (s.jitter - 0.5) * 26
        const [hw, h] = PROP_GROUND[s.variant]
        rakeShadow(g, s.x, y, hw * ps, h * ps, shade, 0.22)
        contactPool(g, s.x, y, hw * ps * 1.3, hw * ps * 0.34, shade, 0.34)
      }
      for (const s of slots) {
        const ps = scale * s.scale
        const y = baseY + (s.jitter - 0.5) * 26
        drawProp(g, s.variant, s.x, y, ps, s.jitter > 0.5 ? 1 : -1,
          tint, ink, rim, ol.width, ol.alpha)
      }
      c.addChild(g)
      c.interactiveChildren = false
      return c
    }, { factorX: factor, wrapWidth: tileWidth, copies: 2 })
  }

  /** Simulation clock for the glitter. */
  update(dt: number): void {
    this.time += dt
  }

  /** Twinkle. Alpha writes only; positions never change. */
  render(): void {
    const t = this.time
    for (let i = 0; i < this.glints.length; i++) {
      const s = Math.sin(t * this.glintRate[i] + this.glintPhase[i])
      // Sharpened so each glint is off most of the time and snaps on, which is
      // what sun on chop actually does.
      this.glints[i].alpha = this.glintBase[i] * Math.max(0, s) ** 2.2
    }
  }

  /**
   * The sun disc, drawn above the water but below the beach.
   *
   * Deliberately modest. A review ranked the focal order of this frame as sun
   * bloom, then the wipeout banner, then the HUD, and the player fourth — "the
   * player character loses to the weather". The sun is now a warm knot in the
   * sky rather than the brightest pixel in the frame.
   */
  buildSunBloom(): Container {
    const c = new Container()
    const glow = new Sprite(radialGlow(SUN_GLARE, 256, 1.9))
    glow.anchor.set(0.5)
    glow.width = 980
    glow.height = 980
    glow.position.set(SUN_X, HORIZON_Y - 132)
    glow.alpha = 0.14
    glow.blendMode = 'add'
    c.addChild(glow)
    c.interactiveChildren = false
    return c
  }
}

/** A swell-line segment, clipped so it never crosses the wrap seam. */
function seg(g: Graphics, x0: number, x1: number, y: number): void {
  const a = Math.max(x0, 6)
  const b = Math.min(x1, 1914)
  if (b - a < 12) return
  g.moveTo(a, y).lineTo(b, y)
}

/**
 * Half-width and height of each prop's silhouette, for the shadow it throws.
 * Indexed by the same variant number `drawProp` switches on.
 */
const PROP_GROUND: [number, number][] = [
  [62, 120], [18, 70], [50, 26], [13, 118], [24, 44], [30, 48], [34, 140],
]

/**
 * One beach prop, drawn into a shared Graphics.
 *
 * Kept as a free function taking explicit colours so the whole band is provably
 * one tint: there is no path through here that can introduce a second hue.
 */
function drawProp(
  g: Graphics, kind: number, x: number, y: number, s: number, flip: number,
  tint: Hex, ink: Hex, rim: Hex, olW: number, olA: number,
): void {
  const L = olW * s * 0.8
  switch (kind) {
    case 0: { // Parasol over a towel.
      const h = 96 * s
      g.rect(x - 2 * s, y - h, 4 * s, h).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(x - 62 * s, y - h + 8 * s)
      for (let i = 0; i <= 6; i++) {
        const t = i / 6
        g.lineTo(x - 62 * s + t * 124 * s, y - h + 8 * s + (i % 2 === 0 ? 0 : 7 * s))
      }
      g.lineTo(x, y - h - 26 * s).closePath().fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.ellipse(x + 26 * s, y - 3 * s, 46 * s, 8 * s).fill(ink)
      // Rim along the seaward edge of the canopy.
      g.moveTo(x, y - h - 26 * s).lineTo(x + 62 * s, y - h + 8 * s)
        .stroke({ color: rim, width: 3 * s, alpha: 0.8 })
      break
    }
    case 1: { // Sitting, knees up, facing the water.
      const hx = x
      g.ellipse(hx, y - 2 * s, 44 * s, 7 * s).fill(ink)
      g.circle(hx - 4 * s * flip, y - 62 * s, 13 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(hx - 14 * s, y - 6 * s).quadraticCurveTo(hx - 16 * s, y - 46 * s, hx - 2 * s, y - 52 * s)
        .lineTo(hx + 12 * s, y - 48 * s).quadraticCurveTo(hx + 14 * s, y - 16 * s, hx + 12 * s, y - 6 * s)
        .closePath().fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.moveTo(hx + 8 * s, y - 10 * s).quadraticCurveTo(hx + 40 * s * flip, y - 34 * s, hx + 34 * s * flip, y - 4 * s)
        .lineTo(hx + 6 * s, y - 2 * s).closePath().fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.moveTo(hx - 3 * s, y - 74 * s).quadraticCurveTo(hx + 12 * s * flip, y - 66 * s, hx + 6 * s * flip, y - 50 * s)
        .stroke({ color: rim, width: 3 * s, alpha: 0.75 })
      break
    }
    case 2: { // Lying flat on a towel.
      g.rect(x - 58 * s, y - 8 * s, 116 * s, 10 * s).fill(ink)
      g.roundRect(x - 44 * s, y - 22 * s, 88 * s, 16 * s, 8 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.circle(x - 52 * s * flip, y - 28 * s, 11 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(x + 40 * s, y - 30 * s).quadraticCurveTo(x + 58 * s, y - 26 * s, x + 52 * s, y - 12 * s)
        .stroke({ color: rim, width: 3 * s, alpha: 0.7 })
      break
    }
    case 3: { // Standing, hand shading the eyes.
      const h = 104 * s
      g.ellipse(x, y - 2 * s, 20 * s, 6 * s).fill(ink)
      g.circle(x, y - h, 13 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(x - 13 * s, y - h + 12 * s).lineTo(x + 13 * s, y - h + 12 * s)
        .lineTo(x + 10 * s, y - 42 * s).lineTo(x - 10 * s, y - 42 * s).closePath()
        .fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.rect(x - 11 * s, y - 44 * s, 9 * s, 44 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.rect(x + 3 * s, y - 44 * s, 9 * s, 44 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(x + 11 * s, y - h + 16 * s).quadraticCurveTo(x + 30 * s * flip, y - h + 4 * s, x + 18 * s * flip, y - h - 6 * s)
        .stroke({ color: ink, width: 5 * s, alpha: 0.9 })
      g.moveTo(x + 12 * s, y - h + 6 * s).lineTo(x + 11 * s, y - 46 * s)
        .stroke({ color: rim, width: 3.2 * s, alpha: 0.85 })
      break
    }
    case 4: { // Cooler box and a couple of cans.
      g.moveTo(x - 24 * s, y - 2 * s).lineTo(x - 20 * s, y - 34 * s)
        .lineTo(x + 20 * s, y - 34 * s).lineTo(x + 24 * s, y - 2 * s).closePath()
        .fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.roundRect(x - 24 * s, y - 42 * s, 48 * s, 10 * s, 4 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.rect(x + 30 * s, y - 16 * s, 8 * s, 14 * s).fill(tint).stroke({ color: ink, width: L, alpha: olA })
      g.moveTo(x + 20 * s, y - 34 * s).lineTo(x + 24 * s, y - 4 * s)
        .stroke({ color: rim, width: 3 * s, alpha: 0.8 })
      break
    }
    case 5: { // Deck chair.
      g.moveTo(x - 30 * s, y - 2 * s).lineTo(x + 4 * s, y - 46 * s)
        .lineTo(x + 22 * s, y - 40 * s).lineTo(x - 6 * s, y - 2 * s).closePath()
        .fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.moveTo(x + 4 * s, y - 46 * s).lineTo(x + 34 * s, y - 2 * s)
        .stroke({ color: ink, width: 3.5 * s, alpha: olA })
      g.moveTo(x - 26 * s, y - 2 * s).lineTo(x + 10 * s, y - 40 * s)
        .stroke({ color: rim, width: 3 * s, alpha: 0.65 })
      break
    }
    default: { // Lifeguard stand: a box on four raking legs.
      const h = 118 * s
      g.moveTo(x - 30 * s, y - 2 * s).lineTo(x - 18 * s, y - h)
        .lineTo(x - 10 * s, y - h).lineTo(x - 20 * s, y - 2 * s).closePath().fill(tint)
      g.moveTo(x + 30 * s, y - 2 * s).lineTo(x + 18 * s, y - h)
        .lineTo(x + 10 * s, y - h).lineTo(x + 20 * s, y - 2 * s).closePath().fill(tint)
      g.rect(x - 26 * s, y - h - 34 * s, 52 * s, 36 * s).fill(tint)
        .stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      g.moveTo(x - 32 * s, y - h - 34 * s).lineTo(x, y - h - 56 * s)
        .lineTo(x + 32 * s, y - h - 34 * s).closePath()
        .fill(tint).stroke({ color: ink, width: L, alpha: olA, join: 'round' })
      // The shaded side of the box, and the rim on the sun side.
      g.rect(x - 26 * s, y - h - 34 * s, 20 * s, 36 * s).fill({ color: ink, alpha: 0.5 })
      g.moveTo(x + 26 * s, y - h - 32 * s).lineTo(x + 26 * s, y - h + 2 * s)
        .stroke({ color: rim, width: 3.4 * s, alpha: 0.85 })
      break
    }
  }
}
