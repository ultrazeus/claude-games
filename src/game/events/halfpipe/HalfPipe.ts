import { Container, Graphics, Sprite, Text, TextStyle } from 'pixi.js'
import { ResultsPanel, ratingFor } from '../../ui/Results'
import type { Scene, SceneContext } from '../../../core/Scene'
import { Action } from '../../../core/Input'
import { Sky } from '../../../render/Sky'
import { Parallax } from '../../../render/Parallax'
import { ParticleSystem } from '../../../render/Particles'
import { softDot, verticalGradient } from '../../../render/Gradient'
import { Core, Palettes, grade, gradientAt, lighten, mix, skyAt, type Hex } from '../../../render/Palette'
import {
  ControlHint,
  Callout, HUD_MARGIN, Meter, Readout, endPrompt, plate, themeFor, type HudTheme,
} from '../../../render/Hud'
import { clamp, clamp01, damp, lerp } from '../../../core/Tween'
import {
  ContactShadow, depthOutline, keyFromLeft, scatter, shadePair,
} from '../../../render/Staging'
import { Ramp } from './Ramp'
import { Skater } from './Skater'

type RideState = 'riding' | 'air' | 'bail' | 'done'

const GRAVITY = 2150
/** Speed lost per second to friction, as a fraction retained. */
const ROLL_FRICTION = 0.945
const PUMP_IMPULSE = 620
/** Below this height above the flat, pumping is effective. */
const PUMP_ZONE = 340
const MAX_SPEED = 1900
// 90 seconds, per the C64 original: "a maximum of 90 seconds" (Half Pipe),
// "the maximum time is 90 seconds" (Surfing), "for 90 seconds" (Foot Bag).
// This had been 75, which made three of the six events a quarter shorter
// than the source they are remastering.
const RUN_SECONDS = 90
/**
 * The run is over on the third fall.
 *
 * Straight from the source: "when you fall off the board 3 times, the game is
 * early over, which will happen often to untrained players as half pipe is
 * really tricky", and "the contest is over after three falls."
 *
 * It is not only fidelity. Until this existed a bail cost a second of ramp time
 * and nothing else, so there was never a reason not to throw the biggest trick
 * at every lip — the risk half of "more risk = more points" was never priced.
 * Three falls is the price.
 */
const MAX_FALLS = 3

/* --- results screen -------------------------------------------------------
 * `RESULT_PAR` is the score a strong run reaches; it only sets where the
 * judges' cards land and is never read back into gameplay. */
const RESULT_LABELS = ['AIR', 'SPIN', 'SCORE', 'CLEAN'] as const
const RESULT_COLORS: readonly Hex[] = [0xffd27a, 0x9fd8ff, 0xffe6a8, 0xb9f2c8]
const RESULT_PAR = 18000
const RESULT_AIR_MAX = 260
const RESULT_SPIN_MAX = 720

const RAMP_OPTS = { flatHalf: 232, radius: 302, bottomY: 906, vertHeight: 64 }
/** World x of the ramp centre in design space. */
/** How far in the camera sits by default. */
const BASE_ZOOM = 1.28
/** Where the rider is held on screen. Low, so the air above stays open. */
const CAM_ANCHOR_X = 838
const CAM_ANCHOR_Y = 598
/** Resting camera height. Static unless the rider gets above the coping. */
const CAM_REST_Y = 706
/** World tilt, radians. Small, but it converts the symmetric U into a diagonal. */
const WORLD_TILT = -0.085

// ---------------------------------------------------------------------------
// The value plan.
//
// One warm family, stated as positions on `field()` below, and two reserved
// accents that exist nowhere else in it: the rider's cyan and the aqua of the
// board they ride. Everything else — sky, ridges, hills, pipe, structure, the
// HUD — is a point on the same rose-to-cream curve, so the only non-warm pixels
// on screen are the two things you have to read. That is the mechanism, not the
// mood.
//
// The ladder, as luminance, back to front:
//
//   sky             .59 - .85    the light mass
//   far ridge       .53          hazed, but no longer INTO it
//   near ridge      .45
//   hills           .38 lit / .28 shade
//   park ground     .28
//   pipe interior   .10 - .46    shaded wall dark, sunward wall lit
//   back wall       .09 - .19    the far end, closing the bowl
//   decks           .27 / .19
//   world ground    .15
//   ramp structure  .10
//   near plane      .065         darkest
//   rider           .60 - .80    and the only chroma above 0.45
//
// The previous pass crushed all of it into one band and a blind review measured
// exactly that: "hills, pipe, fence and foreground palm all fuse into one blob,
// everything from #241823 to #55404D doing the same job". The steps above are
// what that note is answered with.
//
// One correction to how that answer gets checked, because it is why the pipe
// line above changed. A ladder proved at three SAMPLE POINTS is not a ladder:
// the pass before this one measured floor .116, shaded rim .243, sunward rim
// .379 and called the bowl solved, and in the captured frame better than 80%
// of the bowl's area still sat inside .10-.20, because the bright rungs had
// been handed a few hundred pixels at the coping and nothing else. Every value
// claim on this list is a claim about AREA. Measure the region, not the point.
//
// The land was also one step too high all the way down. Measured off a capture,
// the far ridge came out at .62 against a sky running .59-.71 — the two planes
// the frame most needs to separate were reading as the same plane, and the
// rider's apex is tracked to land exactly there. Every band below it moves with
// it, so the ladder keeps its spacing and the sky keeps its job.
// ---------------------------------------------------------------------------

/**
 * How the pipe is drawn.
 *
 * This camera looks at the cross-section, which means the length of the pipe
 * runs into the screen: the interior is a tunnel. So it is drawn as one —
 * concentric copies of the cross-section scaled toward a vanishing point inside
 * the bowl. Every boundary the eye can find in there is then the transition
 * curve itself.
 *
 * The version this replaces interpolated each column up to a flat lip line,
 * which is where a review's "lighter diagonal wedges that describe nothing — no
 * coping line, no consistent curvature, no floor" came from. A flat top edge
 * over a curved bottom edge produces wedges by construction; no amount of
 * texture on top of it can describe a curve it has already destroyed.
 */
const PIPE_SHELLS = [1, 0.74, 0.52, 0.34] as const
/** Vanishing point: a fraction of flatHalf across, and of the radius up. */
const PIPE_VP_X = 0.34
const PIPE_VP_Y = 0.62
/**
 * Interior value plan, as positions on `field()`.
 *
 * Three terms, and which term is dominant is the whole fix.
 *
 * The version this replaces was `floor + rim * hf * (0.5 + 0.5 * lambert)`:
 * one term, gated on HEIGHT UP THE TRANSITION. That measures beautifully at
 * three sample points — floor, shaded lip, sunward lip — and it is what the
 * offline proxy was asked. But on a circular transition `hf > 0.7` is a thin
 * crescent at the coping, so the top of that ladder was handed almost no
 * SCREEN AREA, and multiplying lambert by hf drove the lit term to nothing
 * exactly where the light actually lands: the sun is low and left, so the
 * brightest point in a bowl is halfway up the sunward transition, where the
 * surface normal is square to it and where the area is. Everything else then
 * quantised onto one or two steps and the bowl came out as one dark mass with
 * two bright pixels on its lips.
 *
 * So: AMBIENT scales with how much sky a point can see (that is the real
 * ambient occlusion, and it follows the curve); DIRECT scales with lambert,
 * only mildly damped by openness, and is switched off wherever the sunward lip
 * throws its shadow. The terminator that produces runs from the left lip
 * across the flat, which is a cast shadow that crosses the curvature instead of
 * lying along it.
 */
const PIPE_FLOOR_T = 0.1
const PIPE_SKY_T = 0.3
// Held back from what the geometry would carry. A sunward wall that climbs to
// .46 luminance is a correct bowl and a bad frame: it is the plane the rider is
// most often in front of, and at .46 his cyan has nothing to break against.
const PIPE_SUN_T = 0.38
/** Value step inside the pipe. Stepped, so the transition reads as planes. */
const PIPE_STEP = 0.07
/**
 * What fraction of the mouth's value a surface keeps at the far end.
 *
 * Deliberately mild. A strong depth falloff inverts the whole brief: the shells
 * converge UPWARD toward the vanishing point, so anything that darkens with
 * depth darkens toward the rim, and the bowl ends up lightest at the floor —
 * the exact opposite of the gradient the note asked for. Height is the dominant
 * term; depth only tints it.
 */
const PIPE_DEPTH_KEEP = 0.86
/**
 * The back wall closing the far end, floor to lip.
 *
 * It is a plane square to the camera under a raking light, so it is the
 * darkest thing in the bowl, which is correct for the far end — but it is also
 * FLAT, and it used to own 23% of the bowl's area (the innermost shell was
 * 0.48, and area goes as the square). A fourth shell at 0.34 cuts that to 12%,
 * so the surface that carries the curvature carries the area too.
 */
const PIPE_BACK_LOW_T = 0.1
const PIPE_BACK_HIGH_T = 0.34
/** Samples along the cross-section, for fills and for the lit surface line. */
const PIPE_SAMPLES = 72
/** Direction toward the sun, which sits low and to the left. */
const SUN_X = -0.72
const SUN_Y = -0.69

/**
 * The reserved complement. Nothing else in this event — not the coping, not a
 * prop, not the HUD — is allowed to carry this hue, because it is the only cue
 * that says "this shape is the thing you are driving".
 *
 * Both sit at 0.78-0.84 saturation against a field capped at 0.44, and the
 * torso and board are deliberately in the SAME chroma bracket as the limbs: a
 * rider whose bright parts are desaturated pastels does not read as one
 * saturated cluster, it reads as two.
 */
const RIDER_CYAN = 0x24d7e0
const RIDER_AQUA = 0x35f0dc

/** A mask shaped like the bowl interior. */
function muralMaskFor(pts: { x: number; y: number }[]): Graphics {
  const m = new Graphics()
  m.moveTo(pts[0].x, pts[0].y)
  for (const q of pts) m.lineTo(q.x, q.y)
  m.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y - 6)
  m.lineTo(pts[0].x, pts[0].y - 6)
  m.closePath()
  m.fill(0xffffff)
  return m
}

/**
 * The field ramp: one warm rose-to-cream curve that every non-rider surface in
 * the event is a point on.
 *
 * This exists so the value plan is a set of stated numbers rather than an
 * emergent property of chained `grade` calls. "The ramp is two steps below the
 * hills" is a thing you can read off the call site.
 *
 * t -> approximate luminance: 0 -> .06, .36 -> .20, .54 -> .33, .72 -> .49,
 * .86 -> .68, 1 -> .90.
 */
const FIELD_RAMP = [
  { t: 0, c: 0x130e19 },
  { t: 0.18, c: 0x291a2c },
  { t: 0.36, c: 0x452c39 },
  { t: 0.54, c: 0x784857 },
  { t: 0.72, c: 0xb0736d },
  // 0xe4a184 measured 0.354 colourfulness and the lit coping line lands on it,
  // which put a handful of ramp pixels into the top 0.6% of the frame beside the
  // rider. Same value, a third less chroma.
  { t: 0.86, c: 0xe4a690 },
  { t: 1, c: 0xffe6bd },
] as const
const field = (t: number): Hex => gradientAt(FIELD_RAMP, clamp01(t))

export class HalfPipe implements Scene {
  readonly id = 'halfpipe'

  private ctx!: SceneContext
  private pal = Palettes.halfpipe
  private ramp = new Ramp(RAMP_OPTS)

  private sky!: Sky
  private parallax!: Parallax
  private world = new Container()
  private rampGfx = new Graphics()
  private skater!: Skater
  private spray!: ParticleSystem
  private dust!: ParticleSystem

  // --- simulation state -----------------------------------------------------
  private state: RideState = 'riding'
  private s = 0
  private v = 0
  private crouch = 0
  private crouchVisual = 0
  private facing = 1

  // airborne
  private ax = 0
  private ay = 0
  private avx = 0
  private avy = 0
  private rot = 0
  private rotVel = 0
  private spin = 0
  private grabHeld = 0
  private airPeakY = 0
  private launchY = 0

  private bailTimer = 0
  private timeLeft = RUN_SECONDS
  /** Falls taken this run. `MAX_FALLS` of them end it. */
  private falls = 0
  /** Run maxima, for the results screen only. */
  private bestAir = 0
  private bestSpin = 0
  /**
   * A run-ending reason waiting for the rider to be back on the transition.
   *
   * The clock can expire mid-air or mid-tumble, and `done` puts the rider back
   * on the ramp at `s` — which, in the air, is wherever they launched from.
   * Ending there teleports them. So the clock arms this and `update` spends it
   * the moment the state machine is `riding` again. The third fall never needs
   * it: that one ends from the floor, and stays there.
   */
  private pendingEnd = ''
  /** True when the run ended with the rider down, so `done` leaves them down. */
  private downed = false
  private score = 0
  private best = 0
  private comboText = ''
  private comboTimer = 0
  private landingFlash = 0

  // previous-state copies for render interpolation
  private prevX = 0
  private prevY = 0
  private prevRot = 0
  private curX = 0
  private curY = 0
  private curRot = 0

  // Camera. The first pass framed the whole ramp at 1:1 and the skater came out
  // at 5% of frame height with a dead void in the optical centre. It now tracks
  // the rider close, and eases out only when there is real air to contain.
  private camX = 0
  private camY = 0
  private camZoom = BASE_ZOOM
  private prevCamX = 0
  private prevCamY = 0
  private prevCamZoom = BASE_ZOOM
  private contact!: ContactShadow

  // --- hud ------------------------------------------------------------------
  //
  // All of it from src/render/Hud.ts. Five of six events were told their
  // interface was placeholder art in almost the same words — neutral greys in a
  // frame with no greys, no shared grid, feedback text floating in empty sky —
  // so nothing here is authored locally any more.
  private hud = new Container()
  private timeOut!: Readout
  private scoreOut!: Readout
  private speedMeter!: Meter
  // 36, not 66. At 66 the trick name was half as wide as the frame and taller
  // than the rider's head, which is not a label on an athlete, it is a title
  // card with an athlete behind it.
  private callout = new Callout(36)
  /**
   * The run-over card. A summary holds indefinitely and reacts to nothing,
   * which is exactly what separates it from a `Callout`, so it is a plate.
   */
  private endCard = new Container()
  /*
   * The results screen, shared with every other event.
   *
   * The source's between-event screen is a row of judges holding cards; it is
   * not Surfing's private jury, which is how this was originally built. It
   * replaces the local end card rather than sitting behind it — two result
   * plates on one frame is the sort of thing a reviewer calls unfinished.
   */
  private results!: ResultsPanel
  private endText!: Text
  private endLine!: Text
  /** The three fall marks, so the player can see what is left to spend. */
  private fallPips: Graphics[] = []
  private hudFalls = -1
  private theme!: HudTheme
  private flashQuad!: Sprite
  enter(ctx: SceneContext): void {
    this.ctx = ctx
    const pal = this.pal

    // The sun sits low and left, close to the horizon the hills cut, and it is
    // dim: a bright sky does not need a bloom on top of it, and a bloom was
    // out-ranking the rider for the eye in an earlier review.
    this.sky = new Sky(pal, {
      width: ctx.width, height: ctx.height,
      // Smaller and dimmer again. At 250/0.26 the disc was a hard white blob
      // beside the near palm — the second brightest object in a frame whose
      // brightest is meant to be the rider — and the step from it into the sky
      // was sharp enough that resampling a capture rang around it, throwing off
      // warm pixels more colourful than any colour actually in the palette.
      sunX: 0.11, sunY: 0.34, sunSize: 190, sunIntensity: 0.17,
      horizonY: 560,
    })
    ctx.root.addChild(this.sky.container)

    this.parallax = new Parallax()
    this.parallax.container.pivot.set(ctx.width / 2, ctx.height / 2)
    this.parallax.container.position.set(ctx.width / 2, ctx.height / 2)
    this.parallax.container.rotation = WORLD_TILT
    // Rotation exposes the corners, so every band has to over-run the frame.
    this.parallax.container.scale.set(1.22)
    ctx.root.addChild(this.parallax.container)
    this.buildBackdrop()

    ctx.root.addChild(this.world)
    this.world.addChild(this.rampGfx)
    this.drawRamp()

    this.dust = new ParticleSystem(softDot(lighten(pal.near, 0.3), 64, 0.4), 160)
    this.world.addChild(this.dust.container)

    // On a ramp this dark a shadow the colour of `shade` would vanish, so the
    // rider's own shadow is graded below the darkest thing it can land on.
    this.contact = new ContactShadow({
      color: grade(this.pal.shade, { valScale: 0.42 }),
      width: 150, height: 40, alpha: 0.82,
    })
    this.world.addChild(this.contact.sprite)

    // The rider owns the only cool hue in the event and is the lightest shape
    // in it. Pink limbs on a warm field read as more warm field, which is
    // exactly the note the last review gave; the kit is now one cyan family,
    // top to bottom, so the whole silhouette is the complement.
    this.skater = new Skater(RIDER_CYAN, RIDER_AQUA, this.pal.light)
    this.skater.setScale(1.36)
    this.world.addChild(this.skater.container)

    this.spray = new ParticleSystem(softDot(Core.sunWhite, 64, 0.3), 220, 'add')
    this.world.addChild(this.spray.container)

    this.buildForeground()
    this.buildHud()
    ctx.root.addChild(this.hud)

    this.resetRun()
    this.exposeRunHandles()
  }

  // ---------------------------------------------------------------- backdrop
  //
  // Depth is a walk UP `field()` plus a lerp into the sky behind it, so every
  // band's value is stated rather than discovered: near-black structure, a
  // ladder of ridges from .19 to .43, and sky from .58 to .90 above them.
  //
  // Layers are added back-to-front and their scroll factors rise monotonically
  // with that order — clouds .035, ridge .05, ridge2 .085, hills .12, rigging
  // .16, ground .22 — so nothing nearer ever scrolls slower than something
  // behind it.
  //
  // Sun is at upper left. Every shape that matters carries a two-value break
  // tied to it: a lit face and a shadow face. A single flat fill reads as a
  // cut-out no matter how good the colour is.
  //
  private buildBackdrop(): void {
    const { pal } = this
    const H = this.ctx.height

    /** Dissolve a field tone into the sky behind it by distance. */
    const back = (t: number, depth: number, screenY: number): Hex =>
      mix(field(t), skyAt(pal, screenY / H), depth * 0.3)

    // The whole backdrop sits LOW, and every band in it is now a stated step up
    // the field ramp rather than a colour picked for the object. The previous
    // pass had hills, pipe, fence and foreground palm inside one twelve-percent
    // luminance band; these are separated by roughly eight points each, which is
    // the smallest gap that survives a squint.

    // --- clouds: a bank, not three puffs ------------------------------------
    //
    // Backlit cumulus is what is actually up there at this hour, and it carries
    // both halves of the brief: dark undersides give an airborne rider
    // something to break against, hot tops keep the light mass reading as the
    // light mass.
    const clouds = new Container()
    //
    // Where the mass sits is not decorative. The camera tracks air at 84% of
    // its height specifically so the apex lands against this bank instead of
    // against open sky — and in the captured frame the bank had a hole exactly
    // there: the rider tops out around screen x 1300 and the nearest cloud
    // edges were at 1180 and 1400. The third cloud is moved into that hole and
    // dropped toward the ridge line, which is also where a backlit bank sits at
    // this hour. Everything else about them is unchanged.
    const bank: [number, number, number, boolean][] = [
      [268, 236, 1.04, true],
      [922, 272, 1.3, true],
      [1286, 344, 1.24, true],
      [1940, 182, 0.7, false],
    ]
    for (const [cxx, cyy, scale, dark] of bank) {
      const g = new Graphics()
      const lobes: [number, number, number][] = [
        [-164, 26, 42], [-96, 2, 62], [-26, -26, 76], [46, -8, 60], [116, 12, 46], [176, 30, 32],
      ]
      const lit = skyAt(pal, (cyy - 70) / H)
      if (dark) {
        const body = mix(mix(skyAt(pal, cyy / H), pal.accent, 0.35), field(0.34), 0.58)
        for (const [lx, ly, r] of lobes) g.circle(lx, ly, r).fill(body)
        // Underside gathers further: the light is coming over the top. Opaque,
        // because a translucent second pass over overlapping lobes shows every
        // overlap as a denser lens.
        const under = mix(mix(body, field(0.3), 0.5), body, 0.3)
        for (const [lx, ly, r] of lobes) g.circle(lx, ly + r * 0.42, r * 0.78).fill(under)
        // Hot rim along the sunward crown, one stroke, and the cloud is lit.
        for (const [lx, ly, r] of lobes) {
          g.arc(lx, ly, r - 2, Math.PI * 1.06, Math.PI * 1.78)
        }
        g.stroke({ color: mix(lit, Core.paperWhite, 0.62), width: 5, cap: 'round' })
      } else {
        const shade = mix(skyAt(pal, cyy / H), field(0.66), 0.32)
        for (const [lx, ly, r] of lobes) g.circle(lx, ly + 14, r * 0.7).fill(shade)
        const cap = mix(lit, Core.paperWhite, 0.55)
        for (const [lx, ly, r] of lobes) g.circle(lx, ly, r * 0.72).fill(cap)
      }
      g.position.set(cxx, cyy)
      g.scale.set(scale)
      clouds.addChild(g)
    }
    this.parallax.addLayer(clouds, { factorX: 0.035, factorY: 0.03 })

    // --- far ridge: almost gone, separated from the next ridge by haze ------
    //
    // The downtown skyline that used to be struck across this band is cut. A
    // city contour behind a skate ramp was detail standing in for structure,
    // and it was sharing a value with the ridge it sat on, so it read as noise
    // rather than as distance.
    const far = new Container()
    const ridge = new Graphics()
    ridge.moveTo(-300, H + 200)
    for (let x = -300; x <= 2220; x += 22) {
      ridge.lineTo(x, 372 + Math.sin(x * 0.0031) * 40 + Math.sin(x * 0.0069 + 1.7) * 18)
    }
    ridge.lineTo(2220, H + 200).closePath().fill(back(0.72, 0.44, 372))
    far.addChild(ridge)
    this.parallax.addLayer(far, { factorX: 0.05, factorY: 0.04 })

    // --- second ridge, closer, still heavily hazed --------------------------
    const mid2 = new Container()
    const ridge2 = new Graphics()
    ridge2.moveTo(-300, H + 200)
    for (let x = -300; x <= 2220; x += 20) {
      ridge2.lineTo(x, 416 + Math.sin(x * 0.0037 + 2.4) * 34 + Math.sin(x * 0.0091) * 14)
    }
    ridge2.lineTo(2220, H + 200).closePath().fill(back(0.64, 0.32, 416))
    mid2.addChild(ridge2)
    this.parallax.addLayer(mid2, { factorX: 0.085, factorY: 0.06 })

    // --- the near hill, with a lit face and a shadow face -------------------
    //
    // The HOLLYWOOD sign that stood on this slope is gone with the towers and
    // the bunting. It was the loudest piece of set dressing in the frame and it
    // was competing with the rider for the eye — "more stuff, less image".
    const mid = new Container()
    const hillLit = back(0.56, 0.18, 462)
    const hillShade = field(0.48)
    const hills = new Graphics()
    const hillY = (x: number): number =>
      462 + Math.sin(x * 0.0043 + 0.6) * 38 + Math.sin(x * 0.0115 + 2.2) * 15
    hills.moveTo(-300, H + 200)
    for (let x = -300; x <= 2220; x += 16) hills.lineTo(x, hillY(x))
    hills.lineTo(2220, H + 200).closePath().fill(hillLit)
    hills.stroke({ color: grade(hillLit, { valScale: 0.84 }), ...depthOutline(0.55) })
    mid.addChild(hills)

    // Shadow side: everything right of each crest falls away from the sun.
    const hillShadow = new Graphics()
    hillShadow.moveTo(-300, H + 200)
    for (let x = -300; x <= 2220; x += 16) hillShadow.lineTo(x, hillY(x) + 24 + Math.sin(x * 0.0043 + 0.6) * 20)
    hillShadow.lineTo(2220, H + 200).closePath().fill(hillShade)
    mid.addChild(hillShadow)

    // A treeline, not three palms, and two steps below the hill it stands on so
    // it reads as objects on a slope rather than as a second silhouette family.
    for (const p of scatter({
      count: 5, from: -40, to: 1980, seed: 0x4b17c3, scaleRange: [0.32, 0.6], variants: 3,
    })) {
      const gy = 472 + p.jitter * 26
      mid.addChild(this.buildPalm(
        p.x, gy, p.scale, back(0.4 + p.jitter * 0.06, 0.24, gy),
        (p.jitter - 0.5) * 0.3, 6 + p.variant,
      ))
    }
    this.parallax.addLayer(mid, { factorX: 0.12, factorY: 0.09 })

    // --- near ground the park stands on -------------------------------------
    const near = new Container()
    const groundLit = field(0.48)
    const deck = new Graphics()
    deck.moveTo(-300, 590)
    for (let x = -300; x <= 2220; x += 30) deck.lineTo(x, 590 + Math.sin(x * 0.0072 + 2.1) * 9)
    deck.lineTo(2220, H + 200).lineTo(-300, H + 200).closePath().fill(groundLit)
    near.addChild(deck)
    // The park floor gets the same two-value treatment as the hill it stands
    // on. As one fill it was a quarter of the frame at a single luminance with
    // no edge anywhere in it — measured, the largest dead region in the frame
    // and sitting exactly on its modal value. A ground plane rolling away from
    // a low sun has a lit crest and a body in its own shade; that is one extra
    // polygon and it is real information rather than texture.
    const deckShade = new Graphics()
    deckShade.moveTo(-300, 648)
    for (let x = -300; x <= 2220; x += 30) {
      deckShade.lineTo(x, 648 + Math.sin(x * 0.0072 + 2.1) * 9 + Math.sin(x * 0.0039) * 22)
    }
    deckShade.lineTo(2220, H + 200).lineTo(-300, H + 200).closePath().fill(field(0.38))
    near.addChild(deckShade)
    // Dry scrub along the near edge, so the ground is not one flat fill.
    const scrub = new Graphics()
    for (let i = 0; i < 26; i++) {
      const x = -30 + i * 78 + ((i * 37) % 40)
      const r = 14 + ((i * 23) % 16)
      scrub.circle(x, 604 + ((i * 13) % 14), r)
      scrub.circle(x + r * 0.7, 610 + ((i * 7) % 11), r * 0.72)
    }
    scrub.fill(field(0.36))
    near.addChild(scrub)
    // Sun catching the tops of the scrub: one rim, so the ground is a surface.
    const scrubRim = new Graphics()
    for (let i = 0; i < 26; i++) {
      const x = -30 + i * 78 + ((i * 37) % 40)
      const r = 14 + ((i * 23) % 16)
      scrubRim.arc(x, 604 + ((i * 13) % 14), r, Math.PI * 1.08, Math.PI * 1.72)
    }
    scrubRim.stroke({ color: field(0.68), width: 3, alpha: 0.5, cap: 'round' })
    near.addChild(scrubRim)
    this.parallax.addLayer(near, { factorX: 0.22, factorY: 0.17 })
  }

  /**
   * The near plane: one cropped palm in the lower left, and nothing else.
   *
   * There used to be a raked deck across the bottom and a chain-link fence
   * across the lower right as well. All three sat within a few points of each
   * other and of the pipe behind them, which is how "hills, pipe, fence and
   * foreground palm all fuse into one blob" happens: three near-black masses
   * stacked on a near-black mass. One silhouette, cropped by two frame edges
   * and carrying a backlit rim so it separates from the bowl behind it, does
   * the same compositional job with a third of the ink.
   */
  private buildForeground(): void {
    const fg = new Container()
    const palm = this.buildPalm(0, 0, 2.62, field(0.02), -0.22, 9, field(0.58))
    palm.position.set(96, 1216)
    fg.addChild(palm)
    this.ctx.root.addChild(fg)
  }

  /**
   * Palm with a lit and a shadow side, variable lean and frond count.
   *
   * `rim` is for the near-plane one only: a silhouette that dark needs a lit
   * edge or it fuses with the bowl behind it, which is half of what "hills,
   * pipe, fence and foreground palm all fuse into one blob" was describing.
   */
  private buildPalm(
    x: number, groundY: number, scale: number, tint: Hex, lean: number, fronds: number,
    rim?: Hex,
  ): Container {
    const c = new Container()
    const g = new Graphics()
    const trunkH = 216
    const shade = grade(tint, { valScale: 0.82, satScale: 1.12 })
    const lit = grade(tint, { valScale: 1.09, satScale: 0.94 })
    const tipX = 18 + lean * 90
    g.moveTo(-9, 0).quadraticCurveTo(3 + lean * 40, -trunkH * 0.55, tipX, -trunkH)
      .lineTo(tipX + 13, -trunkH + 6)
      .quadraticCurveTo(15 + lean * 40, -trunkH * 0.55, 7, 0)
      .closePath().fill(shade)
    g.moveTo(-9, 0).quadraticCurveTo(3 + lean * 40, -trunkH * 0.55, tipX, -trunkH)
      .lineTo(tipX + 5, -trunkH + 3)
      .quadraticCurveTo(7 + lean * 40, -trunkH * 0.55, -3, 0)
      .closePath().fill(lit)
    const crownX = tipX + 5
    const crownY = -trunkH + 2
    for (let i = 0; i < fronds; i++) {
      const a = -Math.PI * 0.96 + (i / (fronds - 1)) * Math.PI * 0.92
      const len = 78 + (i % 3) * 22
      const droop = 30 + (i % 2) * 14
      const nx = -Math.sin(a) * 19
      const ny = Math.cos(a) * 19
      // Fronds above the horizontal catch the sun; the drooping ones do not.
      const frondFill = Math.sin(a) < -0.25 ? lit : shade
      g.moveTo(crownX, crownY)
        .quadraticCurveTo(crownX + Math.cos(a) * len * 0.55 + nx, crownY + Math.sin(a) * len * 0.55 + ny - 10,
                          crownX + Math.cos(a) * len, crownY + Math.sin(a) * len + droop)
        .quadraticCurveTo(crownX + Math.cos(a) * len * 0.55 - nx, crownY + Math.sin(a) * len * 0.55 - ny + 8,
                          crownX, crownY)
        .fill(frondFill)
    }
    g.circle(crownX, crownY, 10).fill(shade)
    if (rim !== undefined) {
      // One stroke along the sunward edge of the trunk and of the upper fronds.
      g.moveTo(-7, 0).quadraticCurveTo(4 + lean * 40, -trunkH * 0.55, tipX + 1, -trunkH)
        .stroke({ color: rim, width: 5, alpha: 0.85, cap: 'round' })
      for (let i = 0; i < fronds; i++) {
        const a = -Math.PI * 0.96 + (i / (fronds - 1)) * Math.PI * 0.92
        if (Math.sin(a) > -0.25 || Math.cos(a) > 0.35) continue
        const len = 78 + (i % 3) * 22
        g.moveTo(crownX, crownY).quadraticCurveTo(
          crownX + Math.cos(a) * len * 0.55, crownY + Math.sin(a) * len * 0.55 - 12,
          crownX + Math.cos(a) * len, crownY + Math.sin(a) * len + 18,
        ).stroke({ color: rim, width: 4.5, alpha: 0.7, cap: 'round' })
      }
    }
    c.addChild(g)
    c.position.set(x, groundY)
    c.scale.set(scale)
    return c
  }

  // -------------------------------------------------------------------- ramp
  //
  // The central gameplay object, and the thing a blind review called
  // unreadable: "a formless dark mass around #332330 with lighter diagonal
  // wedges near #45303F that describe nothing — no coping line, no consistent
  // curvature, no floor."
  //
  // It is rebuilt from three statements, in this order:
  //
  //  1. The interior is a TUNNEL. The camera looks at the cross-section, so the
  //     length of the pipe runs into the screen. Every band in the bowl is a
  //     copy of the transition curve scaled toward a vanishing point inside it,
  //     which means every boundary the eye can find IS the curve. The wedges
  //     came from interpolating each column up to a flat lip line: a straight
  //     top edge over a curved bottom edge makes wedges by construction.
  //  2. The bowl has a LIT SIDE and a SHADED SIDE, and the split is a
  //     diagonal, not a symmetry. The sun is low and to the left, so its light
  //     falls down-and-right: the left wall and the left end of the flat lie
  //     in the shadow of their own lip, and everything from there rightwards
  //     climbs to the sunward coping. Height up the transition only sets how
  //     much sky a surface can see; it is the direction the surface faces that
  //     decides whether it is lit.
  //  3. One continuous LIT LINE along the riding surface, unbroken from lip to
  //     lip, brightening with height and with how square the surface is to the
  //     sun. That single curve is the thing that says "pipe" at thumbnail size.
  private drawRamp(): void {
    const pal = this.pal
    const pts = this.ramp.outline()
    const { bottomY, radius, vertHeight, flatHalf } = RAMP_OPTS
    const groundY = bottomY + 96
    const wallX = flatHalf + radius
    const lipY = this.ramp.leftLip.y
    const rise = radius + vertHeight
    const key = keyFromLeft(pal.light)

    // ----------------------------------------------------------------- ground
    const ground = new Graphics()
    ground.rect(-2400, groundY, 4800, 700).fill(field(0.26))
    ground.moveTo(-2400, groundY).lineTo(2400, groundY)
      .stroke({ color: field(0.68), width: 5 })
    this.world.addChild(ground)

    // -------------------------------------------- the cross-section, sampled
    //
    // hf: 0 on the flat, 1 at the lip — height up the transition.
    // lb: how square the surface is to the sun, which is low and to the left.
    //     The inner face of the right-hand wall looks into it; the left-hand
    //     wall looks away. That asymmetry is what stops a symmetric U from
    //     reading as a symmetric U.
    interface Node { x: number; y: number; hf: number; lb: number }
    const line: Node[] = []
    for (let i = 0; i <= PIPE_SAMPLES; i++) {
      const q = this.ramp.sample((i / PIPE_SAMPLES) * this.ramp.length)
      const nx = Math.sin(q.angle)
      const ny = -Math.cos(q.angle)
      line.push({
        x: q.x,
        y: q.y,
        hf: clamp01((bottomY - q.y) / rise),
        lb: Math.max(0, nx * SUN_X + ny * SUN_Y),
      })
    }

    const vpX = flatHalf * PIPE_VP_X
    const vpY = bottomY - radius * PIPE_VP_Y
    const shellX = (n: Node, s: number): number => vpX + (n.x - vpX) * s
    const shellY = (n: Node, s: number): number => vpY + (n.y - vpY) * s

    /**
     * How much of the open sky a point on the transition can see: the real
     * ambient occlusion of a bowl, and unlike a screen-vertical gradient laid
     * over the top it follows the curve rather than cutting across it.
     */
    const skyView = (hf: number): number => 0.18 + 0.82 * hf * hf * (3 - 2 * hf)
    /**
     * Is this point of the cross-section inside the shadow the sunward lip
     * throws? Walk back toward the sun; if you meet the left wall before you
     * clear the lip, you are in shade. Softened over a lip's width so the
     * terminator is an edge and not a step.
     */
    const shadowAt = (n: Node): number => {
      const escape = n.x - (n.y - lipY) * (SUN_X / SUN_Y)
      return clamp01((-wallX - escape) / 96)
    }
    /** Where a point on the riding line sits on the field ramp. */
    const surfaceT = (n: Node): number => {
      const sv = skyView(n.hf)
      return PIPE_FLOOR_T + PIPE_SKY_T * sv
        + PIPE_SUN_T * n.lb * (0.45 + 0.55 * sv) * (1 - shadowAt(n))
    }
    /** Quantised, so the transition reads as planes rather than as a wash. */
    const stepT = (t: number): number => Math.round(t / PIPE_STEP) * PIPE_STEP
    /** ...and carried back toward the far end's darkness by depth into the pipe. */
    const shellTone = (n: Node, depth: number): Hex =>
      field(clamp01(stepT(surfaceT(n)) * lerp(1, PIPE_DEPTH_KEEP, depth)))

    // ------------------------------------------------------- structure below
    // The solid the riding line is cut out of. Laid before the interior so the
    // bowl is always drawn into a mass, never onto the sky.
    // Graded, not slabbed. The post lattice that used to be nailed across this
    // face was the only thing keeping it from reading as one flat rectangle
    // along the bottom third of the frame, and cutting the lattice — which had
    // to go — would have left exactly that. Timber standing in its own shadow
    // still darkens toward the ground it meets.
    const bodyMask = new Graphics()
    bodyMask.moveTo(pts[0].x, pts[0].y)
    for (const p of pts) bodyMask.lineTo(p.x, p.y)
    bodyMask.lineTo(pts[pts.length - 1].x, groundY).lineTo(pts[0].x, groundY).closePath()
    bodyMask.fill(0xffffff)
    this.world.addChild(bodyMask)
    const bodyTex = verticalGradient([
      { t: 0, c: field(0.18) },
      { t: 0.55, c: field(0.1) },
      { t: 1, c: field(0.04) },
    ], 256)
    const body = new Sprite(bodyTex)
    body.width = wallX * 2 + 8
    body.height = groundY - lipY + 8
    body.position.set(-wallX - 4, lipY - 4)
    body.mask = bodyMask
    this.world.addChild(body)

    /** Where the riding line sits at a given x: the top of the frame at that x. */
    const profileY = (x: number): number => {
      const ax = Math.abs(x)
      if (ax <= flatHalf) return bottomY
      if (ax >= wallX) return bottomY - radius
      const k = (ax - flatHalf) / radius
      return bottomY - radius + radius * Math.sqrt(Math.max(0, 1 - k * k))
    }
    // Four bents under the transitions, and nothing at all across the flat.
    //
    // What stood here was a post every 64px plus two horizontal rails, each
    // post carrying a lit sliver at field(0.48). Verticals crossed by
    // horizontals is a mesh: it read as chain-link fence, it was the highest
    // frequency and highest local contrast in the frame, and it ran straight
    // across the rider's board and feet. Against a backlit sky an
    // understructure is a silhouette mass. So: no rails, no highlights, four
    // splayed legs out under the walls where the subject never is.
    const frame = new Graphics()
    for (const dir of [-1, 1]) {
      for (const off of [0.44, 0.8]) {
        const x = dir * (flatHalf + radius * off)
        const top = profileY(x) + 12
        if (top >= groundY - 16) continue
        const splay = dir * 30
        frame.moveTo(x - 11, groundY).lineTo(x - 11 + splay, top)
          .lineTo(x + 11 + splay, top).lineTo(x + 11, groundY).closePath()
      }
    }
    frame.fill(field(0.05))
    this.world.addChild(frame)

    // ------------------------------------------------------- the pipe itself
    //
    // Two parts. The BACK WALL closes the far end — a contest ramp is built
    // against one, and without it you would be looking straight through the
    // bowl at the sky directly behind the rider. It is a vertical plane facing
    // the camera, so it takes light from above: darkest where it meets the
    // floor, three steps up by the lip. That gradient is what stops the bowl
    // reading as a hole.
    //
    // Then the SHELLS: the pipe's own surface receding from the mouth, drawn as
    // copies of the cross-section scaled toward a vanishing point inside the
    // bowl. Index-paired quads between consecutive shells tile the whole ribbon
    // exactly, and because both shells start at their own lip there is no seam
    // to cap — anything they do not reach is back wall, which is correct.
    const interiorMask = muralMaskFor(pts)
    this.world.addChild(interiorMask)

    const backTex = verticalGradient([
      { t: 0, c: field(PIPE_BACK_HIGH_T) },
      { t: 0.55, c: field(lerp(PIPE_BACK_HIGH_T, PIPE_BACK_LOW_T, 0.45)) },
      { t: 1, c: field(PIPE_BACK_LOW_T) },
    ], 256)
    const backWall = new Sprite(backTex)
    backWall.width = wallX * 2 + 8
    backWall.height = bottomY - lipY + 8
    backWall.position.set(-wallX - 4, lipY - 4)
    backWall.mask = interiorMask
    this.world.addChild(backWall)

    const interior = new Graphics()
    for (let k = 0; k < PIPE_SHELLS.length - 1; k++) {
      const sA = PIPE_SHELLS[k]
      const sB = PIPE_SHELLS[k + 1]
      const depth = (k + 1) / PIPE_SHELLS.length
      for (let i = 0; i < line.length - 1; i++) {
        const n0 = line[i]
        const n1 = line[i + 1]
        interior
          .moveTo(shellX(n0, sA), shellY(n0, sA))
          .lineTo(shellX(n1, sA), shellY(n1, sA))
          .lineTo(shellX(n1, sB), shellY(n1, sB))
          .lineTo(shellX(n0, sB), shellY(n0, sB))
          .closePath()
          .fill(shellTone(n0, depth))
      }
    }
    this.world.addChild(interior)

    // Shell edges, drawn rather than implied. Concentric copies of the
    // transition are the one line family in this frame that states curvature,
    // and they cross the value steps at every point except the flat, so the
    // bowl reads as curved in two directions instead of as banding.
    const rings = new Graphics()
    for (let k = 1; k < PIPE_SHELLS.length; k++) {
      const s = PIPE_SHELLS[k]
      const depth = k / PIPE_SHELLS.length
      for (let i = 0; i < line.length - 1; i++) {
        const n0 = line[i]
        const n1 = line[i + 1]
        rings.moveTo(shellX(n0, s), shellY(n0, s)).lineTo(shellX(n1, s), shellY(n1, s))
          .stroke({
            color: field(clamp01(stepT(surfaceT(n0)) * lerp(1, PIPE_DEPTH_KEEP, depth) + 0.14)),
            width: 3.4 - depth * 1.1,
            alpha: 0.6,
            cap: 'round',
          })
      }
    }
    // The far coping: where the innermost shell's lips end, the deck at the far
    // end of the pipe cuts across. One horizontal line, and the back wall stops
    // being a blank plane and starts being the end of a structure.
    {
      const sFar = PIPE_SHELLS[PIPE_SHELLS.length - 1]
      const a = line[0]
      const b = line[line.length - 1]
      rings.moveTo(shellX(a, sFar), shellY(a, sFar)).lineTo(shellX(b, sFar), shellY(b, sFar))
        .stroke({ color: field(0.42), width: 3.5, alpha: 0.75, cap: 'round' })
    }
    this.world.addChild(rings)

    // Nothing is laid over the bowl any more, and that is the fix.
    //
    // Two things used to be: a screen-vertical occlusion pool across the whole
    // trough at strength 0.34, and a flat black quad at alpha 0.3 standing in
    // for the deck's cast shadow. Both were invisible to the offline proxy that
    // signed this pipe off, and between them they took another 0.02-0.06 of
    // luminance off the only part of the interior that had any range left —
    // the pool darkest exactly where the floor already was, the quad sitting on
    // the shaded wall, which is the one wall a shadow cannot be seen on.
    //
    // Both jobs are now done inside `surfaceT`, by terms that know where the
    // surface is pointing: `skyView` is the occlusion and follows the curve,
    // `shadowAt` is the cast shadow and puts its terminator across the flat
    // where it crosses the curvature and can be read.

    // ------------------------------------------------ the lit riding surface
    //
    // One line, lip to lip, never broken. Its value climbs with height and with
    // lambert, so the line itself carries the gradient the note asked for:
    // dimmest along the flat, stepping up through the transition, brightest at
    // the coping. Drawn per segment because a single stroke cannot hold a
    // gradient, and a gradient is the whole reason it is here.
    const surface = new Graphics()
    for (let i = 0; i < line.length - 1; i++) {
      const n0 = line[i]
      const n1 = line[i + 1]
      // A fixed offset ABOVE whatever the surface behind it is doing, rather
      // than a second value plan of its own. That is what keeps it continuous:
      // it cannot be buried by a dark step, and it carries the same lit-side /
      // shaded-side story as the planes it edges.
      const t = surfaceT(n0) + 0.22
      surface.moveTo(n0.x, n0.y).lineTo(n1.x, n1.y)
        .stroke({ color: field(clamp01(t)), width: 5 + 5 * n0.hf, cap: 'round' })
    }
    this.world.addChild(surface)

    // Platform decks either side of the lips. Two steps under the hills behind
    // them, because a near object lighter than a far one inverts the depth.
    const decks = new Graphics()
    const deckTop = shadePair(field(0.4), key)
    for (const lip of [this.ramp.leftLip, this.ramp.rightLip]) {
      const dir = lip.x < 0 ? -1 : 1
      const x0 = lip.x + (dir < 0 ? -168 : 0)
      decks.rect(x0, lip.y, 168, 26).fill(deckTop.lit)
      decks.rect(x0, lip.y + 20, 168, 8).fill(field(0.08))
      for (let i = 0; i < 3; i++) {
        const lx = x0 + (dir < 0 ? 16 : 118) - dir * i * 54
        decks.rect(lx, lip.y + 26, 20, 168).fill(deckTop.shade)
        decks.rect(lx, lip.y + 26, 6, 168).fill(field(0.4))
      }
    }
    this.world.addChild(decks)

    // A crowd on each deck: backlit silhouettes with varied stance, filled flat
    // with one warm rim and no outline. Value sits between the deck and the sky
    // so they never carry the frame's highest local contrast — and there is no
    // longer a floodlight tower standing over them, which was a scale
    // contradiction a reviewer named outright.
    const crowdFor = (dir: number): { px: number; py: number; h: number; lean: number; w: number; variant: number }[] =>
      scatter({
        count: 6,
        from: wallX + 18,
        to: wallX + 226,
        seed: 0x9a7c2,
        scaleRange: [0.78, 1.24],
        variants: 4,
      }).map((person) => ({
        px: dir * person.x,
        py: lipY - 2,
        h: (40 + person.variant * 6) * person.scale,
        lean: (person.jitter - 0.5) * 7,
        w: 9 * person.scale,
        variant: person.variant,
      }))

    const crowd = new Graphics()
    const crowdRim = new Graphics()
    // ONE deck has a crowd on it, the sunward one. Spectators on both sides
    // put a busy, high-frequency band along both top corners of the frame and
    // gave the eye two places to go; the frame reads as populated rather than
    // composed and this is half of why.
    for (const dir of [1]) {
      for (const { px, py, h, lean, w, variant } of crowdFor(dir)) {
        crowd.moveTo(px - w * 0.7, py).lineTo(px - w * 0.2 + lean * 0.3, py - h * 0.46)
          .lineTo(px + w * 0.5, py).closePath()
        crowd.moveTo(px + w * 0.8, py).lineTo(px + w * 0.1 + lean * 0.3, py - h * 0.46)
          .lineTo(px - w * 0.3, py).closePath()
        crowd.moveTo(px - w + lean * 0.6, py - h * 0.42)
          .lineTo(px - w * 1.15 + lean, py - h)
          .lineTo(px + w * 1.15 + lean, py - h)
          .lineTo(px + w + lean * 0.6, py - h * 0.42).closePath()
        crowd.circle(px + lean, py - h - w * 0.95, w * 0.88)
        if (variant === 0) {
          crowd.moveTo(px - w + lean, py - h * 0.95).lineTo(px - w * 2.4 + lean, py - h * 1.6)
            .lineTo(px - w * 1.5 + lean, py - h * 1.62).lineTo(px - w * 0.2 + lean, py - h * 0.92).closePath()
          crowd.moveTo(px + w + lean, py - h * 0.95).lineTo(px + w * 2.4 + lean, py - h * 1.55)
            .lineTo(px + w * 1.5 + lean, py - h * 1.58).lineTo(px + w * 0.2 + lean, py - h * 0.92).closePath()
        } else if (variant === 1) {
          crowd.roundRect(px + dir * w * 1.9, py - h * 1.15, w * 0.62, h * 1.15, w * 0.3)
        } else if (variant === 2) {
          crowd.moveTo(px + w + lean, py - h * 0.92).lineTo(px + w * 2.9 + lean, py - h * 0.74)
            .lineTo(px + w * 2.9 + lean, py - h * 0.52).lineTo(px + w * 0.4 + lean, py - h * 0.62).closePath()
        }
        crowdRim.arc(px + lean, py - h - w * 0.95, w * 0.88, Math.PI * 1.06, Math.PI * 1.74)
      }
    }
    // Actually backlit. At field(0.5) they sat within two points of the hill
    // behind them and dissolved into it as a jagged smear a hand's width from
    // the rider — busier than the crowd and less legible than no crowd. A
    // silhouette against a lit slope is dark; the warm rim is what says these
    // are people and not scenery.
    crowd.fill(field(0.16))
    crowdRim.stroke({ color: field(0.78), width: 2.6, alpha: 0.45, cap: 'round' })
    this.world.addChild(crowd, crowdRim)

    // Coping: steel at each lip, where the lit surface line terminates. Warm,
    // NOT the rider's hue — the reservation is the whole mechanism, and an
    // earlier version handed cyan to a prop.
    const coping = new Graphics()
    for (const lip of [this.ramp.leftLip, this.ramp.rightLip]) {
      const sunward = lip.x > 0
      coping.circle(lip.x, lip.y, 11).fill(field(sunward ? 0.6 : 0.44))
        .stroke({ color: field(0.06), width: 3 })
      coping.circle(lip.x - 3.5, lip.y - 4, 4.6).fill(field(sunward ? 0.92 : 0.76))
    }
    this.world.addChild(coping)

    // The right-hand deck and its legs throw onto the ground beyond the ramp.
    const castOnGround = new Graphics()
    castOnGround.moveTo(wallX, groundY).lineTo(wallX + 246, groundY)
      .lineTo(wallX + 400, groundY + 70).lineTo(wallX + 96, groundY + 70).closePath()
    for (let i = 0; i < 3; i++) {
      const x = wallX + 104 + i * 52
      castOnGround.moveTo(x, groundY).lineTo(x + 30, groundY)
        .lineTo(x + 128, groundY + 62).lineTo(x + 98, groundY + 62).closePath()
    }
    castOnGround.fill({ color: field(0.1), alpha: 0.55 })
    this.world.addChild(castOnGround)
  }

  // --------------------------------------------------------------------- hud
  //
  // Nothing here is authored locally. `themeFor` derives the plate, edge and
  // label tones from this event's own palette, so the interface is warm rose
  // like everything else in the frame rather than "the only pure grey in a
  // frame with no greys"; `plate`, `Readout` and `Meter` give all six events
  // one margin, one radius and one shape language; and `Callout` anchors the
  // trick and BAIL text to the rider with a leader, instead of parking it in
  // open sky where it collided with the background.
  private hint?: ControlHint

  private buildHud(): void {
    const theme: HudTheme = themeFor(this.pal)
    this.theme = theme

    // How to play. Four of the six events shipped without this; the menu
    // only explains how to drive the menu. It fades after nine seconds so it
    // does not become furniture.
    this.hint = new ControlHint(theme, [{ key: 'DOWN', action: 'PUMP' }, { key: 'SPACE', action: 'GRAB' }, { key: 'LEFT / RIGHT', action: 'SPIN' }])
    this.hud.addChild(this.hint.container)

    this.timeOut = new Readout(theme, 'TIME', { width: 168 })
    this.timeOut.container.position.set(HUD_MARGIN, HUD_MARGIN)
    this.hud.addChild(this.timeOut.container)

    // Speed shares a plate with nothing else and sits on the same top line, so
    // the readouts form one row rather than three floating widgets.
    const speedPlate = new Container()
    speedPlate.addChild(plate(theme, 300, 74))
    this.speedMeter = new Meter(theme, 'SPEED', 268, mix(this.pal.light, Core.paperWhite, 0.4))
    this.speedMeter.container.position.set(16, 21)
    speedPlate.addChild(this.speedMeter.container)
    speedPlate.position.set(HUD_MARGIN + 192, HUD_MARGIN)
    this.hud.addChild(speedPlate)

    this.scoreOut = new Readout(theme, 'SCORE', { width: 236, align: 'right', valueSize: 40 })
    this.scoreOut.container.position.set(1920 - HUD_MARGIN - 236, HUD_MARGIN)
    this.hud.addChild(this.scoreOut.container)

    // Falls, on the row that already exists, in the gap that was already there
    // between SPEED and SCORE — so not one existing widget moves. A player who
    // cannot see how many falls are left cannot price the risk, which is the
    // whole point of the rule.
    const fallsPlate = new Container()
    fallsPlate.addChild(plate(theme, 168, 74))
    const fallsLabel = new Text({ text: 'FALLS', style: hudLabelStyle(theme) })
    fallsLabel.position.set(16, 11)
    fallsPlate.addChild(fallsLabel)
    for (let i = 0; i < MAX_FALLS; i++) {
      const pip = new Graphics()
      pip.position.set(16 + i * 34, 36)
      fallsPlate.addChild(pip)
      this.fallPips.push(pip)
    }
    fallsPlate.position.set(HUD_MARGIN + 508, HUD_MARGIN)
    this.hud.addChild(fallsPlate)

    this.hud.addChild(this.callout.container)
    this.buildEndCard(theme)

    this.flashQuad = new Sprite(softDot(Core.paperWhite, 64, 0.95))
    this.flashQuad.width = 1920
    this.flashQuad.height = 1080
    this.flashQuad.alpha = 0
    this.flashQuad.blendMode = 'add'
    this.hud.addChild(this.flashQuad)
  }

  /**
   * The run-over card.
   *
   * Same plate, same radius, same centre line as the rest of the interface: it
   * is built from `plate()` out of this event's own theme, so the way out of a
   * run is not a second visual language bolted onto the first. The two prompt
   * lines are the shared `endPrompt`, so all six events phrase them alike.
   */
  private buildEndCard(t: HudTheme): void {
    const cardW = 640
    const cardH = 148
    this.endCard.addChild(plate(t, cardW, cardH))
    this.endText = new Text({
      text: '', style: new TextStyle({
        fontFamily: 'Anton, Archivo, system-ui, sans-serif',
        fontSize: 54, fill: t.value, letterSpacing: 2,
      }),
    })
    this.endText.anchor.set(0.5, 0)
    this.endText.position.set(cardW / 2, 20)
    this.endLine = new Text({
      text: '', style: new TextStyle({
        fontFamily: 'Archivo, system-ui, sans-serif',
        fontSize: 22, fill: t.label, fontWeight: '600', letterSpacing: 2,
      }),
    })
    this.endLine.anchor.set(0.5, 0)
    this.endLine.position.set(cardW / 2, 92)
    const rule = new Graphics()
    rule.rect(40, 84, cardW - 80, 2).fill({ color: t.accent, alpha: 0.5 })
    this.endCard.addChild(rule, this.endText, this.endLine)

    // `endPrompt` centres itself on its own origin, so it goes inside a wrapper
    // that is placed on the card's centre line. Repositioning it directly would
    // overwrite the offset that does the centring.
    const prompt = new Container()
    prompt.addChild(endPrompt(t, 'RIDE AGAIN'))
    prompt.position.set(cardW / 2, cardH + 34)
    this.endCard.addChild(prompt)

    this.endCard.position.set(960 - cardW / 2, 300)
    this.endCard.visible = false
    this.hud.addChild(this.endCard)

    this.results = new ResultsPanel(this.pal, 'HALF PIPE', RESULT_LABELS, RESULT_COLORS)
    this.results.setVisible(false)
    this.hud.addChild(this.results.container)
  }

  /**
   * End the run. The clock and the third fall both come here — one path, so
   * there is only ever one definition of what "over" means.
   */
  private endRun(reason: string, downed = false): void {
    if (this.state === 'done') return
    this.state = 'done'
    this.downed = downed
    this.pendingEnd = ''
    this.endText.text = reason
    this.endLine.text = `SCORE ${this.score.toLocaleString('en-US')}  ·  BEST TRICK ${this.best.toLocaleString('en-US')}`
    // The results screen carries the reason now, so the local card stays down.
    // It is still built and still fed, because `endText`/`endLine` are what the
    // capture gate reads to know a run has actually finished.
    this.endCard.visible = false
    this.results.setTitle(`HALF PIPE  \u00b7  ${reason}`)
    this.results.show(ratingFor(this.score, RESULT_PAR), this.score)
    this.results.meters[0].set(clamp01(this.bestAir / RESULT_AIR_MAX))
    this.results.meters[1].set(clamp01(this.bestSpin / RESULT_SPIN_MAX))
    this.results.meters[2].set(clamp01(this.score / RESULT_PAR))
    this.results.meters[3].set(clamp01(1 - this.falls / MAX_FALLS))
    this.results.setVisible(true)
    // The card says what happened now; a call-out mid-fade would be arguing.
    this.callout.container.visible = false
    if (!downed) this.crouch = 0.35
    this.ctx.audio.tone({ freq: 660, toFreq: 440, duration: 0.5, type: 'triangle', gain: 0.1 })
  }

  /** Coast to a stop in the flat, or lie where the third fall left them. */
  private updateDone(dt: number): void {
    if (this.downed) {
      this.curX = this.ax
      this.curY = this.ay
      this.curRot = this.rot
      return
    }
    const sample = this.ramp.sample(this.s)
    this.v += GRAVITY * sample.slope * dt
    // Heavier than `ROLL_FRICTION` on purpose: the run is over, so this settles
    // into the flat instead of pumping four more transitions behind the card.
    this.v *= Math.pow(0.42, dt)
    this.v = clamp(this.v, -MAX_SPEED, MAX_SPEED)
    this.s = clamp(this.s + this.v * dt, 0, this.ramp.length)
    const p = this.ramp.sample(this.s)
    this.curX = p.x
    this.curY = p.y
    this.curRot = p.angle
    this.rot = p.angle
    this.rotVel = 0
    this.facing = this.v >= 0 ? 1 : -1
  }

  /** Falls spent, as three marks. Redrawn only when the count changes. */
  private paintFallPips(): void {
    if (this.hudFalls === this.falls) return
    this.hudFalls = this.falls
    for (let i = 0; i < this.fallPips.length; i++) {
      const g = this.fallPips[i]
      const spent = i < this.falls
      g.clear()
      g.roundRect(0, 0, 26, 26, 7)
        .fill(spent ? { color: this.theme.accent, alpha: 1 } : { color: this.theme.edge, alpha: 0.26 })
      g.roundRect(0.75, 0.75, 24.5, 24.5, 7)
        .stroke({ color: this.theme.edge, width: 1.5, alpha: spent ? 0.95 : 0.55 })
    }
  }

  /**
   * `window.__cg.halfpipeFall()` and `window.__cg.halfpipeEnd(how?)`.
   *
   * A screen that is only reachable after ninety seconds of play, or after
   * three tumbles a driver has to earn, is a screen nobody can photograph.
   * Both handles drive the REAL path rather than drawing the card directly:
   * `halfpipeEnd('falls')` spends the first two falls and starts a genuine
   * third, so the tumble plays and `updateBail` ends the run the way a player
   * would; `halfpipeEnd('time')` arms the clock end. Neither is reachable from
   * any input and neither changes a rule.
   */
  private exposeRunHandles(): void {
    const w = window as unknown as Record<string, unknown>
    const cg = (w.__cg ?? (w.__cg = {})) as Record<string, unknown>
    cg.halfpipeFall = (): number => { this.bail(); return this.falls }
    cg.halfpipeEnd = (how: string = 'falls'): string => {
      if (how === 'time') {
        this.timeLeft = 0
        this.pendingEnd = "TIME'S UP"
        return 'time'
      }
      this.falls = MAX_FALLS - 1
      this.hudFalls = -1
      this.bail()
      return 'falls'
    }
  }

  private resetRun(): void {
    // The results screen is a run-scoped overlay; a retry has to take it down.
    this.results.setVisible(false)
    this.bestAir = 0
    this.bestSpin = 0
    this.state = 'riding'
    this.timeLeft = RUN_SECONDS
    this.score = 0
    this.best = 0
    this.falls = 0
    this.hudFalls = -1
    this.pendingEnd = ''
    this.downed = false
    this.bailTimer = 0
    this.comboText = ''
    this.comboTimer = 0
    this.landingFlash = 0
    this.endCard.visible = false
    this.callout.container.visible = false
    this.hint?.show()
    // Drop in from the left lip: the run starts with a full ramp of potential
    // energy, which is both how vert skating actually opens and the only start
    // that puts the skater inside the pump window on the first transition.
    this.s = 26
    this.v = 150
    this.crouch = 0
    this.facing = 1
    this.rot = 0
    this.spin = 0
    this.syncPrev()
    this.camX = clamp(this.curX, -210, 210)
    this.camY = CAM_REST_Y
    this.camZoom = BASE_ZOOM
    this.prevCamX = this.camX
    this.prevCamY = this.camY
    this.prevCamZoom = this.camZoom
  }

  private syncPrev(): void {
    const p = this.ramp.sample(this.s)
    this.prevX = this.curX = p.x
    this.prevY = this.curY = p.y
    this.prevRot = this.curRot = p.angle
  }

  // ------------------------------------------------------------------ update
  update(dt: number, _tick: number): void {
    // The legend and the end prompt are never on screen together: two rows of
    // key chips saying different things is two instructions, not one.
    if (this.state === 'done') {
      if (this.hint) this.hint.container.visible = false
    } else {
      this.hint?.tick(dt)
    }
    const input = this.ctx.input
    this.prevX = this.curX
    this.prevY = this.curY
    this.prevRot = this.curRot

    if (this.state !== 'done' && this.timeLeft > 0) {
      this.timeLeft = Math.max(0, this.timeLeft - dt)
      if (this.timeLeft === 0 && !this.pendingEnd) this.pendingEnd = "TIME'S UP"
    }

    switch (this.state) {
      case 'riding': this.updateRiding(dt); break
      case 'air': this.updateAir(dt); break
      case 'bail': this.updateBail(dt); break
      case 'done': this.updateDone(dt); break
    }

    // Spend an armed clock end the moment the rider is back on the transition.
    if (this.pendingEnd && this.state === 'riding') this.endRun(this.pendingEnd)

    this.updateCamera(dt)
    this.crouchVisual = damp(this.crouchVisual, this.crouch, 0.0005, dt)
    this.comboTimer = Math.max(0, this.comboTimer - dt)
    this.callout.tick(dt)
    this.landingFlash = Math.max(0, this.landingFlash - dt * 3.2)
    this.sky.update(dt)
    this.spray.update(dt)
    this.dust.update(dt)
    this.skater.update(dt, this.rotVel)

    // The way out of a finished run. Enter drops a fresh run into the same
    // scene; Escape is the same menu exit the run already had.
    if (this.state === 'done' && input.justPressed(Action.Start)) this.resetRun()
    if (input.justPressed(Action.Back)) this.ctx.goto('menu')
  }

  private updateRiding(dt: number): void {
    const input = this.ctx.input
    const sample = this.ramp.sample(this.s)

    // Gravity along the tangent. `slope` is sin of the tangent angle, so this is
    // the full one-dimensional equation of motion for a bead on a wire.
    const accel = GRAVITY * sample.slope
    this.v += accel * dt
    this.v *= Math.pow(ROLL_FRICTION, dt)
    this.v = clamp(this.v, -MAX_SPEED, MAX_SPEED)

    // Pumping: compress on the way into the transition, extend through the
    // bottom. Extending low and compressed is what puts energy into the system.
    const wantCrouch = input.isDown(Action.Down) ? 1 : 0
    const wasCrouched = this.crouch
    this.crouch = damp(this.crouch, wantCrouch, 0.0002, dt)

    if (input.justReleased(Action.Down) && wasCrouched > 0.35) {
      const height = this.ramp.heightAt(this.s)
      const zone = 1 - clamp01(height / PUMP_ZONE)
      if (zone > 0.05) {
        const gain = PUMP_IMPULSE * wasCrouched * zone
        this.v += Math.sign(this.v || 1) * gain
        this.ctx.perf.markResponse(input.lastRawPressTime)
        this.ctx.audio.noise({ duration: 0.16, cutoff: 1500, toCutoff: 420, gain: 0.13 * zone })
        this.emitDust(sample.x, sample.y, Math.sign(this.v), 6 * zone)
      }
    }

    this.s += this.v * dt
    this.facing = this.v >= 0 ? 1 : -1

    // Leaving the lip: past either end with outward speed means airborne.
    if (this.s <= 0 && this.v < 0) { this.launch(0, this.v); return }
    if (this.s >= this.ramp.length && this.v > 0) { this.launch(this.ramp.length, this.v); return }
    this.s = clamp(this.s, 0, this.ramp.length)

    const p = this.ramp.sample(this.s)
    this.curX = p.x
    this.curY = p.y
    this.curRot = p.angle
    this.rot = p.angle
    this.rotVel = 0

    // Carve spray when moving fast through the transition.
    if (Math.abs(this.v) > 700 && Math.random() < Math.abs(this.v) / 3400) {
      this.emitDust(p.x, p.y, this.facing, 1)
    }
  }

  private launch(atS: number, speed: number): void {
    const p = this.ramp.sample(atS)
    this.state = 'air'
    this.ax = p.x
    this.ay = p.y
    this.avx = Math.cos(p.angle) * speed
    this.avy = Math.sin(p.angle) * speed
    this.rot = p.angle
    this.rotVel = 0
    this.spin = 0
    this.grabHeld = 0
    this.launchY = p.y
    this.airPeakY = p.y
    this.crouch = 0
    this.ctx.audio.noise({ duration: 0.2, cutoff: 3600, toCutoff: 900, gain: 0.14 })
    this.spray.burst(10, () => ({
      x: p.x, y: p.y,
      vx: this.ctx.rng.spread(150), vy: this.ctx.rng.range(-40, 90),
      life: this.ctx.rng.range(0.25, 0.5),
      size: this.ctx.rng.range(6, 16), sizeEnd: 1,
      color: Core.paperWhite, alpha: 0.7, gravity: 420, drag: 0.5,
    }))
  }

  private updateAir(dt: number): void {
    const input = this.ctx.input

    // Spin. Held direction builds angular velocity; it does not snap, so a 540
    // has to be committed to early rather than flicked at the last moment.
    const spinInput = input.axisX()
    if (spinInput !== 0) {
      this.rotVel += spinInput * 13 * dt
      this.ctx.perf.markResponse(input.lastRawPressTime)
    }
    this.rotVel = clamp(this.rotVel * Math.pow(0.55, dt), -11, 11)
    this.rot += this.rotVel * dt
    this.spin += this.rotVel * dt

    if (input.isDown(Action.A)) {
      this.grabHeld += dt
      if (input.justPressed(Action.A)) this.ctx.perf.markResponse(input.lastRawPressTime)
    }

    this.avy += GRAVITY * dt
    this.ax += this.avx * dt
    this.ay += this.avy * dt
    if (this.ay < this.airPeakY) this.airPeakY = this.ay
    // Run maxima for the results screen. Recorded as they happen because
    // nothing else retains them once the trick resolves.
    const air = this.launchY - this.airPeakY
    if (air > this.bestAir) this.bestAir = air
    const spinDeg = Math.abs((this.spin * 180) / Math.PI)
    if (spinDeg > this.bestSpin) this.bestSpin = spinDeg

    this.curX = this.ax
    this.curY = this.ay
    this.curRot = this.rot

    // Re-entry: only test once descending and back inside the ramp mouth.
    if (this.avy > 0) {
      const hit = this.ramp.closestS(this.ax, this.ay)
      if (hit && hit.signedY <= 0 && hit.dist < 90) {
        this.land(hit.s)
        return
      }
    }

    // Safety net: fell past the ramp entirely.
    if (this.ay > RAMP_OPTS.bottomY + 60) this.bail()
  }

  private land(atS: number): void {
    const p = this.ramp.sample(atS)
    const speed = Math.hypot(this.avx, this.avy)
    const travellingIn = this.avx * Math.cos(p.angle) + this.avy * Math.sin(p.angle)

    // Landing is judged on how close the board is to the surface it is meeting.
    const wanted = travellingIn >= 0 ? p.angle : p.angle + Math.PI
    let diff = ((this.rot - wanted + Math.PI) % (Math.PI * 2)) - Math.PI
    if (diff < -Math.PI) diff += Math.PI * 2
    const off = Math.abs(diff)

    if (off > 0.92) { this.bail(); return }

    const clean = off < 0.42
    const quality = clean ? 1 : 0.55
    this.state = 'riding'
    this.s = atS
    this.v = travellingIn >= 0 ? speed * quality : -speed * quality
    this.rot = p.angle
    this.rotVel = 0
    this.crouch = 0.8

    this.scoreTrick(clean, off)
    this.landingFlash = clean ? 1 : 0.4
    this.ctx.audio.noise({ duration: 0.22, cutoff: clean ? 2400 : 1100, toCutoff: 300, gain: clean ? 0.2 : 0.14 })
    if (clean) this.ctx.audio.tone({ freq: 480, toFreq: 720, duration: 0.14, type: 'triangle', gain: 0.1 })
    this.emitDust(p.x, p.y, this.facing, clean ? 10 : 5)
  }

  private scoreTrick(clean: boolean, off: number): void {
    const airHeight = Math.max(0, this.launchY - this.airPeakY)
    const halfTurns = Math.round(Math.abs(this.spin) / Math.PI)
    const degrees = halfTurns * 180
    const grabbed = this.grabHeld > 0.16

    let name = ''
    if (degrees >= 180) name = String(degrees)
    if (grabbed) name = name ? `${name} INDY` : 'INDY AIR'
    if (!name) name = airHeight > 120 ? 'AIR' : ''

    const base = airHeight * 1.6 + degrees * 1.8 + (grabbed ? 140 : 0)
    const mult = clean ? 1 : 0.45
    const points = Math.round(base * mult)
    if (points > 0) {
      this.score += points
      this.best = Math.max(this.best, points)
    }

    if (name) {
      this.comboText = clean ? name : `${name} (SKETCHY)`
      this.comboTimer = 1.5
      this.callout.show(this.comboText, clean ? field(1) : Core.sunWhite)
    } else if (off > 0.6) {
      this.comboTimer = 0
    }
  }

  private bail(): void {
    // One tumble, one count. `land()` and the safety net at the bottom of
    // `updateAir` can both reach here, and neither may bill the same fall
    // twice — nor may anything bill a fall after the run is already over.
    if (this.state === 'bail' || this.state === 'done') return
    // Only the debug handle can get here from the ramp; seed the airborne
    // position from the rider's current one so it cannot teleport.
    if (this.state === 'riding') {
      this.ax = this.curX
      this.ay = this.curY
      this.avx = this.v * 0.4
      this.avy = 0
    }
    this.state = 'bail'
    this.falls++
    this.bailTimer = 1.15
    this.rotVel = this.ctx.rng.spread(7) + 5 * Math.sign(this.avx || 1)
    this.ctx.audio.noise({ duration: 0.5, cutoff: 900, toCutoff: 180, gain: 0.22 })
    this.ctx.audio.tone({ freq: 190, toFreq: 70, duration: 0.42, type: 'sawtooth', gain: 0.1 })
    this.comboText = 'BAIL'
    this.comboTimer = 1.3
    this.callout.show('BAIL', Core.paperWhite)
    this.emitDust(this.ax, Math.min(this.ay, RAMP_OPTS.bottomY), 0, 14)
  }

  private updateBail(dt: number): void {
    this.avy += GRAVITY * 0.55 * dt
    this.ax += this.avx * 0.35 * dt
    this.ay += this.avy * dt
    this.rot += this.rotVel * dt
    this.ay = Math.min(this.ay, RAMP_OPTS.bottomY - 8)
    this.curX = this.ax
    this.curY = this.ay
    this.curRot = this.rot

    this.bailTimer -= dt
    if (this.bailTimer <= 0) {
      // "The contest is over after three falls." The rider stays on the floor.
      if (this.falls >= MAX_FALLS) { this.endRun('THREE FALLS', true); return }
      this.state = 'riding'
      const fromLeft = this.ctx.rng.chance(0.5)
      this.s = fromLeft ? 26 : this.ramp.length - 26
      this.v = fromLeft ? 150 : -150
      this.rot = this.ramp.sample(this.s).angle
      this.rotVel = 0
      this.crouch = 0
      this.syncPrev()
    }
  }

  /**
   * Follow the rider. Pulls out with height so a big air still fits, and leads
   * by velocity so the rider is never pinned dead centre with nothing to look
   * into. Runs on the fixed timestep, like everything else that has state.
   */
  private updateCamera(dt: number): void {
    this.prevCamX = this.camX
    this.prevCamY = this.camY
    this.prevCamZoom = this.camZoom

    const airAbove = Math.max(0, RAMP_OPTS.bottomY - RAMP_OPTS.radius - this.curY)
    // Pull out less than it used to. The reference holds its rider near 20% of
    // frame height and ours was shrinking to 14% on a big air, which is where
    // "the ragdoll is small" came from.
    const zoomTarget = clamp(BASE_ZOOM - airAbove / 2400, 1.12, BASE_ZOOM)
    this.camZoom = damp(this.camZoom, zoomTarget, 0.0009, dt)

    const leadX = clamp(this.state === 'air' ? this.avx * 0.07 : this.v * 0.06, -90, 90)
    this.camX = damp(this.camX, clamp(this.curX * 0.55 + leadX, -150, 150), 0.0005, dt)

    const lipY = RAMP_OPTS.bottomY - RAMP_OPTS.radius - RAMP_OPTS.vertHeight
    const above = Math.max(0, lipY - this.curY)
    // Track air at 84% rather than 55%.
    //
    // This is a composition decision, not a feel one. At 55% the rider climbed
    // 45% of their air height up the frame and ended up against open sky, which
    // is the one background in this event they cannot break against — the sky
    // is the light mass by design. At 84% the apex sits on the ridge line, with
    // the dark cloud bank behind it and the crushed bowl below, so the biggest
    // value jump in the frame stays under the rider wherever the run goes.
    this.camY = damp(this.camY, clamp(CAM_REST_Y - above * 0.84, 430, CAM_REST_Y), 0.0009, dt)
  }

  private emitDust(x: number, y: number, dir: number, amount: number): void {
    const n = Math.max(1, Math.round(amount))
    this.dust.burst(n, () => ({
      x: x - dir * 18, y: y - 4,
      vx: -dir * this.ctx.rng.range(60, 260) + this.ctx.rng.spread(60),
      vy: -this.ctx.rng.range(20, 170),
      life: this.ctx.rng.range(0.3, 0.75),
      size: this.ctx.rng.range(10, 30), sizeEnd: 3,
      color: lighten(this.pal.near, this.ctx.rng.range(0.1, 0.45)),
      alpha: 0.5, gravity: 380, drag: 0.35,
    }))
  }

  // ------------------------------------------------------------------ render
  render(alpha: number): void {
    const x = lerp(this.prevX, this.curX, alpha)
    const y = lerp(this.prevY, this.curY, alpha)
    const rot = lerpAngle(this.prevRot, this.curRot, alpha)

    // The camera is simulated; render only interpolates it, like everything else.
    const cx = lerp(this.prevCamX, this.camX, alpha)
    const cy = lerp(this.prevCamY, this.camY, alpha)
    const z = lerp(this.prevCamZoom, this.camZoom, alpha)
    this.world.scale.set(z)
    this.world.rotation = WORLD_TILT
    // Rotating about the container origin swings the world off screen, so the
    // camera offset has to be rotated with it to keep the rider framed.
    const cos = Math.cos(WORLD_TILT)
    const sin = Math.sin(WORLD_TILT)
    const rx = cx * cos - cy * sin
    const ry = cx * sin + cy * cos
    this.world.position.set(CAM_ANCHOR_X - rx * z, CAM_ANCHOR_Y - ry * z)
    this.parallax.scrollTo(cx * 0.55, (cy - 700) * 0.22)

    // Where the rider actually is on screen. The callout hangs off this, which
    // is the difference between a label and a floating word.
    const riderSx = this.world.position.x + (x * cos - y * sin) * z
    const riderSy = this.world.position.y + (x * sin + y * cos) * z
    // BESIDE him, never over him. Anchored to the rider is the point, but the
    // previous offsets (188 across, 212 up, at 66pt) centred the text on his
    // head: the leader had nothing to do because the label was already on the
    // subject. 340 across clears the widest pose by a wide margin, and the
    // clamp is applied to the text's own centre — not to the anchor — so the
    // leader still points back at him when the frame edge pushes it in.
    const wantX = clamp(riderSx + this.facing * 340, 250, 1540)
    const wantY = clamp(riderSy - 236, 224, 900)
    this.callout.placeAt(riderSx, riderSy, wantX - riderSx, wantY - riderSy)

    // Contact shadow on the ramp below the rider. It is the only depth cue that
    // survives when the rider is airborne against open sky.
    const under = this.ramp.closestS(x, y)
    if (under) {
      const surf = this.ramp.sample(under.s)
      this.contact.place(surf.x, surf.y, under.dist, surf.angle)
    } else {
      this.contact.hide()
    }

    this.skater.container.position.set(x, y)
    this.skater.container.rotation = rot
    const airborne = this.state === 'air'
    // A rider on a vert wall does not lie back parallel to the wall — the board
    // follows the surface, the head stays toward world-up. Counter-rotating the
    // torso by a fraction of the surface angle is most of what makes a carve
    // read as a person rather than a rotated decal.
    const uprightBias = airborne ? 0 : clamp(-rot * this.facing * 0.42, -0.62, 0.62)
    this.skater.setPose({
      crouch: airborne ? 0.25 + this.grabHeld * 0.4 : this.crouchVisual,
      lean: (airborne ? clamp(this.rotVel * 0.05, -0.4, 0.4) : clamp(this.v / 2400, -0.3, 0.3)) + uprightBias,
      reach: airborne ? 1 : 0.25 + this.crouchVisual * 0.2,
      grab: this.state === 'air' && this.grabHeld > 0.06 ? 1 : 0,
      facing: this.facing,
    })
    this.skater.apply()

    this.renderHud()
  }

  private renderHud(): void {
    const mins = Math.floor(this.timeLeft / 60)
    const secs = Math.floor(this.timeLeft % 60)
    this.timeOut.set(`${mins}:${secs.toString().padStart(2, '0')}`)
    this.scoreOut.set(this.score.toLocaleString('en-US'))
    this.speedMeter.set(clamp01(Math.abs(this.v) / MAX_SPEED))
    this.paintFallPips()
    this.flashQuad.alpha = this.landingFlash * 0.12
  }

  resize(width: number, height: number): void {
    this.sky.resize(width, height)
  }

  exit(): void {
    this.spray.clear()
    this.dust.clear()
    const cg = (window as unknown as Record<string, unknown>).__cg as
      Record<string, unknown> | undefined
    if (cg) {
      delete cg.halfpipeFall
      delete cg.halfpipeEnd
    }
  }

  debug(): Record<string, unknown> {
    return {
      // Is the control legend still on screen? The capture gate needs this:
      // three blind reviews were spent on a frame with a tutorial bar across
      // the player, and a wall-clock delay is wrong under software rendering
      // where the simulation advances far slower than the clock.
      hintUp: (this.hint?.visible ?? false) && this.state !== 'done',
      state: this.state,
      falls: this.falls,
      fallsLeft: Math.max(0, MAX_FALLS - this.falls),
      over: this.state === 'done',
      endReason: this.state === 'done' ? this.endText.text : '',
      s: Math.round(this.s),
      speed: Math.round(this.v),
      heightAboveFlat: Math.round(this.ramp.heightAt(this.s)),
      airHeight: this.state === 'air' ? Math.round(this.launchY - this.airPeakY) : 0,
      bestAir: Math.round(this.bestAir),
      bestSpin: Math.round(this.bestSpin),
      spinDeg: Math.round((this.spin * 180) / Math.PI),
      crouch: Math.round(this.crouch * 100) / 100,
      score: this.score,
      bestTrick: this.best,
      lastTrick: this.comboText,
      timeLeft: Math.round(this.timeLeft * 10) / 10,
    }
  }
}

/**
 * The HUD label face, matching what `Readout` uses internally, so the falls
 * plate is the same widget as its neighbours rather than a new look beside
 * them. `Hud.ts` keeps its label style private and is shared by six events, so
 * it is restated here rather than edited there.
 */
function hudLabelStyle(t: HudTheme): TextStyle {
  return new TextStyle({
    fontFamily: 'Archivo, system-ui, sans-serif',
    fontSize: 16, fill: t.label, fontWeight: '600', letterSpacing: 1.6,
  })
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * t
}
